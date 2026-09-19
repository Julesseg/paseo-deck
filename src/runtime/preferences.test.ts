import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInitialState } from "../state/store.js";
import {
  applyTargetPreferences,
  createNodePreferenceFileSystem,
  loadPreferences,
  PreferenceSession,
  parsePreferences,
  preferenceProjection,
  resetPreferences,
  targetScope,
} from "./preferences.js";

const validScope = `v1-${"a".repeat(64)}`;
const portablePath = (path: string): string => path.replaceAll("\\", "/");

describe("preferences", () => {
  it("writes atomically with a synced file and parent directory", async () => {
    const calls: string[] = [];
    const fs = createNodePreferenceFileSystem(
      {
        mkdir: async (path, options) => {
          calls.push(`mkdir ${portablePath(path)} ${options.mode.toString(8)}`);
        },
        chmod: async (path, mode) => {
          calls.push(`chmod ${portablePath(path)} ${mode.toString(8)}`);
        },
        open: async (path, flags, mode) => {
          const displayedPath = portablePath(path);
          calls.push(`open ${displayedPath} ${flags}${mode ? ` ${mode.toString(8)}` : ""}`);
          return {
            writeFile: async (value, encoding) => {
              calls.push(`write ${value} ${encoding}`);
            },
            sync: async () => {
              calls.push(`sync ${displayedPath}`);
            },
            close: async () => {
              calls.push(`close ${displayedPath}`);
            },
          };
        },
        rename: async (from, to) => {
          calls.push(`rename ${portablePath(from)} ${portablePath(to)}`);
        },
        rm: async (path) => {
          calls.push(`rm ${portablePath(path)}`);
        },
      },
      "linux",
    );

    await fs.writeAtomic("/prefs/preferences.json", "saved");

    expect(calls).toHaveLength(10);
    expect(calls[0]).toBe("mkdir /prefs 700");
    expect(calls[1]).toBe("chmod /prefs 700");
    expect(calls[2]).toMatch(/^open \/prefs\/\.preferences-.+\.tmp w 600$/);
    expect(calls.slice(3, 6)).toEqual([
      "write saved utf8",
      expect.stringMatching(/^sync \/prefs\/\.preferences-.+\.tmp$/),
      expect.stringMatching(/^close \/prefs\/\.preferences-.+\.tmp$/),
    ]);
    expect(calls[6]).toMatch(/^rename \/prefs\/\.preferences-.+\.tmp \/prefs\/preferences\.json$/);
    expect(calls.slice(7)).toEqual(["open /prefs r", "sync /prefs", "close /prefs"]);
  });

  it("closes and removes the temporary file when an atomic write fails", async () => {
    const calls: string[] = [];
    const fs = createNodePreferenceFileSystem(
      {
        mkdir: async () => {
          calls.push("mkdir");
        },
        chmod: async () => {
          calls.push("chmod");
        },
        open: async (path) => {
          const displayedPath = portablePath(path);
          calls.push(`open ${displayedPath}`);
          return {
            writeFile: async () => {
              calls.push("write");
              throw new Error("disk full");
            },
            sync: async () => {
              calls.push("sync");
            },
            close: async () => {
              calls.push(`close ${displayedPath}`);
            },
          };
        },
        rename: async () => {
          calls.push("rename");
        },
        rm: async (path) => {
          calls.push(`rm ${portablePath(path)}`);
          throw new Error("cleanup failure");
        },
      },
      "linux",
    );

    await expect(fs.writeAtomic("/prefs/preferences.json", "saved")).rejects.toThrow("disk full");

    expect(calls).toEqual([
      "mkdir",
      "chmod",
      expect.stringMatching(/^open \/prefs\/\.preferences-.+\.tmp$/),
      "write",
      expect.stringMatching(/^close \/prefs\/\.preferences-.+\.tmp$/),
      expect.stringMatching(/^rm \/prefs\/\.preferences-.+\.tmp$/),
    ]);
  });

  it("retains file sync and rename without a directory sync on Windows", async () => {
    const calls: string[] = [];
    const fs = createNodePreferenceFileSystem(
      {
        mkdir: async () => {
          calls.push("mkdir");
        },
        chmod: async () => {
          calls.push("chmod");
        },
        open: async (path, flags) => {
          const displayedPath = portablePath(path);
          calls.push(`open ${displayedPath} ${flags}`);
          return {
            writeFile: async () => {
              calls.push("write");
            },
            sync: async () => {
              calls.push(`sync ${displayedPath}`);
            },
            close: async () => {
              calls.push(`close ${displayedPath}`);
            },
          };
        },
        rename: async () => {
          calls.push("rename");
        },
        rm: async () => undefined,
      },
      "win32",
    );

    await fs.writeAtomic("/prefs/preferences.json", "saved");

    expect(calls).toContain("rename");
    expect(calls).toContainEqual(expect.stringMatching(/^sync \/prefs\/\.preferences-.+\.tmp$/));
    expect(calls).not.toContain("open /prefs r");
    expect(calls).not.toContain("sync /prefs");
  });

  it.skipIf(process.platform === "win32")(
    "round trips through the real atomic filesystem with private POSIX modes",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "paseo-deck-preferences-"));
      const path = join(directory, "nested", "preferences.json");
      try {
        await createNodePreferenceFileSystem().writeAtomic(path, '{"version":1}\n');
        expect(await createNodePreferenceFileSystem().readFile(path)).toBe('{"version":1}\n');
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await stat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("strictly persists only the safe presentation projection", () => {
    const base = createInitialState();
    const state = {
      ...base,
      treeOrder: "alphabetical" as const,
      showArchived: true,
      expandedIds: new Set(["project", "workspace"]),
      selectedAgentId: "SELECTION_MARKER",
      filter: "FILTER_MARKER",
      composer: {
        ...base.composer,
        drafts: { agent: "DRAFT_MARKER" },
        histories: { agent: ["HISTORY_MARKER"] },
        historyDrafts: { agent: "HISTORY_DRAFT_MARKER" },
      },
      directory: {
        projects: [{ id: "project", name: "PROJECT_MARKER", path: "PASSWORD_MARKER" }],
        workspaces: [
          {
            id: "workspace",
            projectId: "project",
            title: "WORKSPACE_MARKER",
            directory: "DIRECTORY_MARKER",
            archived: false,
          },
        ],
        agents: [
          {
            id: "agent",
            workspaceId: "workspace",
            title: "AGENT_MARKER",
            status: "running" as const,
            providerId: "PROVIDER_MARKER",
            modelId: "MODEL_MARKER",
            availableModeIds: [],
            availableThinkingLevels: [],
            pendingPermissions: [],
            needsAttention: false,
            archived: false,
          },
        ],
        providers: [
          {
            id: "provider",
            name: "PROVIDER_RECORD_MARKER",
            ready: true,
            models: [],
            modeIds: [],
          },
        ],
      },
      timeline: {
        recoveryRevision: 0,
        loading: false,
        items: [
          {
            epoch: "epoch",
            sequence: 1,
            item: { id: "item", type: "user-message" as const, text: "TIMELINE_MARKER" },
          },
        ],
      },
      notifications: [
        { id: 1, message: "NOTIFICATION_MARKER", detail: "ERROR_MARKER", kind: "error" as const },
      ],
    };
    const value = preferenceProjection(
      state,
      33,
      { theme: "ember", symbolSet: "unicode" },
      "scope",
    );
    expect(value).toEqual({
      version: 1,
      global: { theme: "ember", symbolSet: "unicode" },
      targets: {
        scope: {
          treeWidth: 33,
          treeOrder: "alphabetical",
          showArchived: true,
          expandedIds: ["project", "workspace"],
        },
      },
    });
    const bytes = JSON.stringify(value);
    for (const marker of [
      "SELECTION_MARKER",
      "FILTER_MARKER",
      "DRAFT_MARKER",
      "HISTORY_MARKER",
      "HISTORY_DRAFT_MARKER",
      "PROJECT_MARKER",
      "PASSWORD_MARKER",
      "WORKSPACE_MARKER",
      "DIRECTORY_MARKER",
      "AGENT_MARKER",
      "PROVIDER_MARKER",
      "MODEL_MARKER",
      "PROVIDER_RECORD_MARKER",
      "TIMELINE_MARKER",
      "NOTIFICATION_MARKER",
      "ERROR_MARKER",
    ])
      expect(bytes).not.toContain(marker);
  });

  it("round trips v1, drops unknown fields, and migrates v0", () => {
    expect(
      parsePreferences({
        version: 1,
        global: { theme: "plain", password: "no" },
        targets: { [validScope]: { treeWidth: 999, expandedIds: ["w", "w"], prompt: "no" } },
        secret: true,
      }),
    ).toEqual({
      version: 1,
      global: { theme: "plain" },
      targets: { [validScope]: { treeWidth: 48, expandedIds: ["w"] } },
    });
    expect(
      parsePreferences({
        version: 0,
        global: { symbolSet: "ascii" },
        targets: { [validScope]: { showArchived: true } },
      }),
    ).toEqual({
      version: 1,
      global: { symbolSet: "ascii" },
      targets: { [validScope]: { showArchived: true } },
    });
  });

  it("drops raw target identities before any preference bytes are written", async () => {
    let bytes = JSON.stringify({
      version: 1,
      global: {},
      targets: {
        "host:PASSWORD_MARKER": { treeWidth: 48 },
        [targetScope({ type: "default" })]: { treeWidth: 24 },
      },
    });
    const fs = {
      readFile: async () => bytes,
      writeAtomic: async (_path: string, value: string) => {
        bytes = value;
      },
      remove: async () => undefined,
    };
    const session = await PreferenceSession.open({ type: "default" }, { fs, path: "/p" });
    expect(session.treeWidth()).toBe(24);
    session.present({ treeWidth: 26 });
    await session.flush();

    expect(bytes).not.toContain("PASSWORD_MARKER");
    expect(JSON.parse(bytes).targets).toEqual({
      [targetScope({ type: "default" })]: expect.objectContaining({ treeWidth: 26 }),
    });
  });

  it("uses defaults for missing, corrupt, and future files", async () => {
    const missing = await loadPreferences({
      readFile: async () => {
        const error = Object.assign(new Error(), { code: "ENOENT" });
        throw error;
      },
      writeAtomic: async () => undefined,
      remove: async () => undefined,
    });
    expect(missing).toEqual({ preferences: { version: 1, global: {}, targets: {} } });
    const invalid = await loadPreferences({
      readFile: async () => '{"version":2}',
      writeAtomic: async () => undefined,
      remove: async () => undefined,
    });
    expect(invalid.warning).toBeTruthy();
    expect(invalid.preferences.targets).toEqual({});
  });

  it("isolates normalized targets and ignores passwords", () => {
    expect(targetScope({ type: "home", path: "/tmp/a/../a" })).toBe(
      targetScope({ type: "home", path: "/tmp/a" }),
    );
    expect(targetScope({ type: "host", value: "TCP://Example.COM:6767/" })).toBe(
      targetScope({ type: "host", value: "example.com:6767" }),
    );
    expect(targetScope({ type: "host", value: "a:1" })).not.toBe(
      targetScope({ type: "host", value: "b:1" }),
    );
  });

  it("seeds persisted expansion before hydration without retaining unrelated state", () => {
    const state = applyTargetPreferences(createInitialState(), {
      treeOrder: "alphabetical",
      expandedIds: ["project", "workspace"],
    });
    expect(state.expandedIds).toEqual(new Set(["project", "workspace"]));
    expect(state.composer.drafts).toEqual({});
  });

  it("serializes a blocked timer write with shutdown flush and retains the newest snapshot", async () => {
    let release: (() => void) | undefined;
    const writes: string[] = [];
    const session = await PreferenceSession.open(
      { type: "default" },
      {
        path: "/preferences.json",
        fs: {
          readFile: async () => {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          },
          writeAtomic: async (_path, value) => {
            writes.push(value);
            if (writes.length === 1)
              await new Promise<void>((resolve) => {
                release = resolve;
              });
          },
          remove: async () => undefined,
        },
      },
    );
    session.present({ treeWidth: 30, theme: "ember", symbolSet: "unicode" });
    const first = session.flush();
    session.present({ treeWidth: 42, theme: "plain", symbolSet: "ascii" });
    const shutdown = session.flush();
    release?.();
    await Promise.all([first, shutdown]);
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1] ?? "{}")).toMatchObject({
      global: { theme: "plain", symbolSet: "ascii" },
      targets: expect.any(Object),
    });
    expect(writes[1]).toContain('"treeWidth":42');
  });

  it("coalesces debounce work, deduplicates identical snapshots, and cancels a pending timer on flush", async () => {
    const callbacks: (() => void)[] = [];
    const cleared: unknown[] = [];
    const writes: string[] = [];
    const session = await PreferenceSession.open(
      { type: "default" },
      {
        path: "/preferences.json",
        setTimeout: (callback) => {
          callbacks.push(callback);
          return callbacks.length;
        },
        clearTimeout: (handle) => {
          cleared.push(handle);
        },
        fs: {
          readFile: async () => {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          },
          writeAtomic: async (_path, value) => {
            writes.push(value);
          },
          remove: async () => undefined,
        },
      },
    );

    session.present({ treeWidth: 30 });
    session.present({ treeWidth: 32 });
    expect(callbacks).toHaveLength(1);
    callbacks[0]?.();
    await session.flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"treeWidth":32');

    session.observe(session.initialState());
    expect(callbacks).toHaveLength(1);
    session.present({ treeWidth: 34 });
    expect(callbacks).toHaveLength(2);
    await session.flush();
    expect(cleared).toContain(2);
    expect(writes).toHaveLength(2);
  });

  it("warns once and remains usable when a save fails", async () => {
    const warnings: string[] = [];
    const session = await PreferenceSession.open(
      { type: "default" },
      {
        path: "/preferences.json",
        onWarning: (message) => warnings.push(message),
        fs: {
          readFile: async () => {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          },
          writeAtomic: async () => {
            throw new Error("secret /path");
          },
          remove: async () => undefined,
        },
      },
    );
    session.present({ treeWidth: 36 });
    await session.flush();
    await session.flush();
    expect(warnings).toEqual(["Could not save preferences."]);
  });

  it("resets only the preference file and returns defaults on the next load", async () => {
    let removed = "";
    const fs = {
      readFile: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      writeAtomic: async () => undefined,
      remove: async (path: string) => {
        removed = path;
      },
    };
    await resetPreferences(fs, "/only-preferences.json");
    expect(removed).toBe("/only-preferences.json");
    expect((await loadPreferences(fs, "/only-preferences.json")).preferences).toEqual({
      version: 1,
      global: {},
      targets: {},
    });
  });

  it("keeps A and B target state isolated while sharing a global choice", async () => {
    let bytes: string | undefined;
    const fs = {
      readFile: async () => {
        if (bytes) return bytes;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      writeAtomic: async (_: string, value: string) => {
        bytes = value;
      },
      remove: async () => undefined,
    };
    const a = await PreferenceSession.open({ type: "host", value: "a:1" }, { fs, path: "/p" });
    a.present({ treeWidth: 26, theme: "plain", symbolSet: "ascii" });
    a.observe({
      ...a.initialState(),
      treeOrder: "alphabetical",
      showArchived: true,
      expandedIds: new Set(["pa", "wa"]),
    });
    await a.flush();
    const b = await PreferenceSession.open({ type: "host", value: "b:1" }, { fs, path: "/p" });
    b.present({ treeWidth: 44, theme: "plain", symbolSet: "ascii" });
    b.observe({ ...b.initialState(), expandedIds: new Set(["pb"]) });
    await b.flush();
    const restored = await PreferenceSession.open(
      { type: "host", value: "a:1" },
      { fs, path: "/p" },
    );
    expect(restored.initialState()).toMatchObject({
      treeOrder: "alphabetical",
      showArchived: true,
    });
    expect(restored.initialState().expandedIds).toEqual(new Set(["pa", "wa"]));
    expect(restored.treeWidth()).toBe(26);
    expect(JSON.parse(bytes ?? "{}").targets).toHaveProperty(
      targetScope({ type: "host", value: "b:1" }),
    );
  });

  it("migrates v0 top-level tree fields into the opened target", async () => {
    const session = await PreferenceSession.open(
      { type: "default" },
      {
        fs: {
          readFile: async () =>
            JSON.stringify({
              version: 0,
              treeWidth: 40,
              treeOrder: "alphabetical",
              expandedIds: ["p"],
            }),
          writeAtomic: async () => undefined,
          remove: async () => undefined,
        },
        path: "/p",
      },
    );
    expect(session.treeWidth()).toBe(40);
    expect(session.initialState().expandedIds).toEqual(new Set(["p"]));
  });
});
