import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import type { AppState, TreeOrder } from "../contracts/app-state.js";
import { createInitialState } from "../state/store.js";
import type { SymbolSet, ThemeId } from "../ui/capabilities.js";
import { adjustTreeWidth } from "../ui/layout.js";
import type { TargetArgument } from "./arguments.js";

export interface TargetPreferences {
  treeWidth?: number;
  treeOrder?: TreeOrder;
  showArchived?: boolean;
  expandedIds?: string[];
  openSessionIds?: Record<string, string[]>;
  activeSessionId?: string;
}
export interface Preferences {
  version: 1;
  global: { theme?: ThemeId; symbolSet?: SymbolSet };
  targets: Record<string, TargetPreferences>;
}
export interface LoadedPreferences {
  preferences: Preferences;
  warning?: string;
}
export interface PreferenceFileSystem {
  readFile(path: string): Promise<string>;
  writeAtomic(path: string, value: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** The small durable-write seam used by the Node adapter and its contract tests. */
export interface PreferenceFileHandle {
  writeFile(value: string, encoding: "utf8"): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface PreferenceFileOperations {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  open(path: string, flags: "w" | "r", mode?: number): Promise<PreferenceFileHandle>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
}
const empty = (): Preferences => ({ version: 1, global: {}, targets: {} });
const warning = "Could not load saved preferences; using defaults.";
const targetScopePattern = /^v1-[a-f0-9]{64}$/;

export function preferencesPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(
    environment.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "paseo-deck",
    "preferences.json",
  );
}

export function targetScope(target: TargetArgument): string {
  const identity =
    target.type === "default"
      ? "default"
      : target.type === "home"
        ? `home:${resolve(normalize(target.path))}`
        : `host:${normalizeHost(target.value)}`;
  return `v1-${createHash("sha256").update(identity).digest("hex")}`;
}
function normalizeHost(value: string): string {
  const raw = value.trim().toLowerCase();
  return raw.startsWith("tcp://") ? raw.slice(6).replace(/\/$/, "") : raw.replace(/\/$/, "");
}

const nodePreferenceFileOperations: PreferenceFileOperations = {
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  chmod,
  open: (path, flags, mode) => open(path, flags, mode),
  rename,
  rm: (path, options) => rm(path, options),
};

export function createNodePreferenceFileSystem(
  operations: PreferenceFileOperations = nodePreferenceFileOperations,
  platform: NodeJS.Platform = process.platform,
): PreferenceFileSystem {
  return {
    readFile: (path) => readFile(path, "utf8"),
    async writeAtomic(path, value) {
      const directory = dirname(path);
      await operations.mkdir(directory, { recursive: true, mode: 0o700 });
      await operations.chmod(directory, 0o700);
      const temporary = join(directory, `.preferences-${process.pid}-${randomUUID()}.tmp`);
      let renamed = false;
      try {
        const handle = await operations.open(temporary, "w", 0o600);
        try {
          await handle.writeFile(value, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await operations.rename(temporary, path);
        renamed = true;
        if (platform !== "win32") {
          const directoryHandle = await operations.open(directory, "r");
          try {
            await directoryHandle.sync();
          } finally {
            await directoryHandle.close();
          }
        }
      } finally {
        if (!renamed) await operations.rm(temporary, { force: true }).catch(() => undefined);
      }
    },
    remove: async (path) => {
      await operations.rm(path, { force: true });
    },
  };
}

export const nodePreferenceFileSystem = createNodePreferenceFileSystem();

export async function loadPreferences(
  fs: PreferenceFileSystem = nodePreferenceFileSystem,
  path = preferencesPath(),
): Promise<LoadedPreferences> {
  try {
    return { preferences: parsePreferences(JSON.parse(await fs.readFile(path))) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { preferences: empty() };
    return { preferences: empty(), warning };
  }
}

export interface PreferenceSessionOptions {
  fs?: PreferenceFileSystem;
  path?: string;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  onWarning?: (message: string) => void;
}

/** Owns one target's durable, privacy-filtered preference lifecycle. */
export class PreferenceSession {
  readonly preferences: Preferences;
  readonly warning: string | undefined;
  readonly scope: string;
  #state: AppState;
  #treeWidth: number;
  #global: Preferences["global"];
  #saved: string;
  #timer: unknown;
  #writing: Promise<void> | undefined;
  readonly #fs: PreferenceFileSystem;
  readonly #path: string;
  readonly #setTimeout: (callback: () => void, delay: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;
  readonly #onWarning: ((message: string) => void) | undefined;
  #saveWarningShown = false;

  private constructor(
    target: TargetArgument,
    loaded: LoadedPreferences,
    options: PreferenceSessionOptions,
  ) {
    this.preferences = loaded.preferences;
    this.warning = loaded.warning;
    this.scope = targetScope(target);
    this.#fs = options.fs ?? nodePreferenceFileSystem;
    this.#path = options.path ?? preferencesPath();
    this.#setTimeout = options.setTimeout ?? setTimeout;
    this.#clearTimeout =
      options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#onWarning = options.onWarning;
    this.#state = applyTargetPreferences(
      createInitialState(),
      this.preferences.targets[this.scope],
    );
    this.#treeWidth = this.preferences.targets[this.scope]?.treeWidth ?? 34;
    this.#global = this.preferences.global;
    this.#saved = this.encoded();
  }
  static async open(
    target: TargetArgument,
    options: PreferenceSessionOptions = {},
  ): Promise<PreferenceSession> {
    const fs = options.fs ?? nodePreferenceFileSystem;
    const loaded = await loadPreferences(fs, options.path);
    if (loaded.preferences.targets.legacy) {
      const scope = targetScope(target);
      loaded.preferences = {
        ...loaded.preferences,
        targets: { ...loaded.preferences.targets, [scope]: loaded.preferences.targets.legacy },
      };
      delete loaded.preferences.targets.legacy;
    }
    return new PreferenceSession(target, loaded, options);
  }
  initialState(): AppState {
    return this.#state;
  }
  treeWidth(): number {
    return this.#treeWidth;
  }
  requestedGlobal(): Preferences["global"] {
    return this.#global;
  }
  observe(state: AppState): void {
    this.#state = state;
    this.schedule();
  }
  present(value: { treeWidth: number; theme?: ThemeId; symbolSet?: SymbolSet }): void {
    this.#treeWidth = value.treeWidth;
    this.#global = {
      ...(value.theme
        ? { theme: value.theme }
        : this.#global.theme
          ? { theme: this.#global.theme }
          : {}),
      ...(value.symbolSet
        ? { symbolSet: value.symbolSet }
        : this.#global.symbolSet
          ? { symbolSet: this.#global.symbolSet }
          : {}),
    };
    this.schedule();
  }
  private current(): Preferences {
    return {
      ...this.preferences,
      version: 1,
      global: this.#global,
      targets: {
        ...this.preferences.targets,
        ...preferenceProjection(this.#state, this.#treeWidth, this.#global, this.scope).targets,
      },
    };
  }
  private encoded(): string {
    return JSON.stringify(this.current());
  }
  private schedule(): void {
    if (this.encoded() === this.#saved || this.#timer !== undefined) return;
    this.#timer = this.#setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, 150);
  }
  async flush(): Promise<void> {
    if (this.#timer !== undefined) {
      this.#clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#writing) return this.#writing;
    this.#writing = (async () => {
      while (this.encoded() !== this.#saved) {
        const encoded = this.encoded();
        try {
          await this.#fs.writeAtomic(this.#path, `${encoded}\n`);
          this.#saved = encoded;
        } catch {
          if (!this.#saveWarningShown) this.#onWarning?.("Could not save preferences.");
          this.#saveWarningShown = true;
          break;
        }
      }
    })().finally(() => {
      this.#writing = undefined;
    });
    return this.#writing;
  }
}

export async function resetPreferences(
  fs: PreferenceFileSystem = nodePreferenceFileSystem,
  path = preferencesPath(),
): Promise<void> {
  await fs.remove(path);
}
export async function savePreferences(
  preferences: Preferences,
  fs: PreferenceFileSystem = nodePreferenceFileSystem,
  path = preferencesPath(),
): Promise<void> {
  await fs.writeAtomic(path, `${JSON.stringify(preferences)}\n`);
}
export function parsePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object") throw new Error("invalid preferences");
  const record = value as Record<string, unknown>;
  if (record.version === 0) return migrateV0(record);
  if (record.version !== 1) throw new Error("unsupported preferences");
  return { version: 1, global: parseGlobal(record.global), targets: parseTargets(record.targets) };
}
function migrateV0(value: Record<string, unknown>): Preferences {
  const global = parseGlobal(value.global ?? value);
  const targets = parseTargets(value.targets);
  // v0 stored the active target's tree fields at the top level.
  if (Object.keys(targets).length === 0) {
    const target = parseTargetPreference(value);
    return { version: 1, global, targets: target ? { legacy: target } : {} };
  }
  return { version: 1, global, targets };
}
function parseGlobal(value: unknown): Preferences["global"] {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    ...(record.theme === "ember" || record.theme === "plain" ? { theme: record.theme } : {}),
    ...(record.symbolSet === "unicode" || record.symbolSet === "ascii"
      ? { symbolSet: record.symbolSet }
      : {}),
  };
}
function parseTargets(value: unknown): Preferences["targets"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      if (!targetScopePattern.test(key)) return [];
      const parsed = parseTargetPreference(item);
      return parsed ? [[key, parsed]] : [];
    }),
  );
}
function parseTargetPreference(value: unknown): TargetPreferences | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.treeWidth === "number" && Number.isFinite(record.treeWidth)
      ? { treeWidth: adjustTreeWidth(record.treeWidth, 0) }
      : {}),
    ...(record.treeOrder === "attention" || record.treeOrder === "alphabetical"
      ? { treeOrder: record.treeOrder }
      : {}),
    ...(typeof record.showArchived === "boolean" ? { showArchived: record.showArchived } : {}),
    ...(Array.isArray(record.expandedIds) &&
    record.expandedIds.every((id) => typeof id === "string")
      ? { expandedIds: [...new Set(record.expandedIds)] }
      : {}),
    ...(record.openSessionIds &&
    typeof record.openSessionIds === "object" &&
    !Array.isArray(record.openSessionIds)
      ? {
          openSessionIds: Object.fromEntries(
            Object.entries(record.openSessionIds as Record<string, unknown>).flatMap(
              ([workspaceId, ids]) =>
                Array.isArray(ids) && ids.every((id) => typeof id === "string")
                  ? [[workspaceId, Array.from(new Set(ids))]]
                  : [],
            ),
          ),
        }
      : {}),
    ...(typeof record.activeSessionId === "string"
      ? { activeSessionId: record.activeSessionId }
      : {}),
  };
}
export function preferenceProjection(
  state: AppState,
  treeWidth: number,
  global: Preferences["global"],
  scope: string,
): Preferences {
  return {
    version: 1,
    global,
    targets: {
      [scope]: {
        treeWidth: adjustTreeWidth(treeWidth, 0),
        treeOrder: state.treeOrder,
        showArchived: state.showArchived,
        expandedIds: [...state.expandedIds].sort(),
        ...(Object.keys(state.openSessionIds ?? {}).length
          ? {
              openSessionIds: Object.fromEntries(
                Object.entries(state.openSessionIds ?? {}).map(([workspaceId, ids]) => [
                  workspaceId,
                  [...ids],
                ]),
              ),
            }
          : {}),
        ...(state.activeSessionId ? { activeSessionId: state.activeSessionId } : {}),
      },
    },
  };
}
export function applyTargetPreferences(
  state: AppState,
  preference: TargetPreferences | undefined,
): AppState {
  if (!preference) return state;
  return {
    ...state,
    ...(preference.treeOrder ? { treeOrder: preference.treeOrder } : {}),
    ...(preference.showArchived === undefined ? {} : { showArchived: preference.showArchived }),
    ...(preference.expandedIds ? { expandedIds: new Set(preference.expandedIds) } : {}),
    ...(preference.openSessionIds ? { openSessionIds: preference.openSessionIds } : {}),
    ...(preference.activeSessionId ? { activeSessionId: preference.activeSessionId } : {}),
  };
}
