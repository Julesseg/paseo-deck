import type {
  TerminalCapture,
  TerminalCreateOptions,
  TerminalGateway,
  TerminalObservation,
  TerminalRecord,
  TerminalStreamUpdate,
} from "../contracts/terminal.js";
import { sanitizeTerminalText } from "./text-safety.js";

export type TerminalMode = "normal" | "insert";
export interface TerminalTab {
  terminal: TerminalRecord;
  mode: TerminalMode;
  lines: readonly string[];
  connected: boolean;
  stale: boolean;
}

/** Presentation/controller model for workspace terminals. Closing is never killing. */
export class TerminalTabs {
  readonly #tabs = new Map<string, TerminalTab>();
  readonly #observations = new Map<string, TerminalObservation>();
  #activeId: string | undefined;

  get activeId(): string | undefined {
    return this.#activeId;
  }
  get tabs(): readonly TerminalTab[] {
    return [...this.#tabs.values()];
  }
  get active(): TerminalTab | undefined {
    return this.#activeId ? this.#tabs.get(this.#activeId) : undefined;
  }

  async discover(
    gateway: TerminalGateway,
    workspaceId: string,
  ): Promise<readonly TerminalRecord[]> {
    const entries = await gateway.listTerminals(workspaceId);
    const ids = new Set(entries.map((entry) => entry.id));
    for (const [id, tab] of this.#tabs) {
      if (tab.terminal.workspaceId === workspaceId && !ids.has(id)) {
        this.#tabs.set(id, { ...tab, connected: false, stale: true });
        await this.#observations.get(id)?.release();
        this.#observations.delete(id);
      }
    }
    return entries;
  }

  async open(gateway: TerminalGateway, terminal: TerminalRecord): Promise<TerminalTab> {
    const existing = this.#tabs.get(terminal.id);
    if (existing?.connected) {
      this.#activeId = terminal.id;
      return existing;
    }
    const capture = await gateway.captureTerminal(terminal.id, { start: -2000 });
    const tab: TerminalTab = {
      terminal,
      mode: "normal",
      lines: safeLines(capture),
      connected: true,
      stale: false,
    };
    this.#tabs.set(terminal.id, tab);
    this.#activeId = terminal.id;
    const observation = await gateway.observeTerminal(terminal.id, (update) =>
      this.receive(update),
    );
    this.#observations.set(terminal.id, observation);
    return tab;
  }

  close(terminalId = this.#activeId): boolean {
    if (!terminalId || !this.#tabs.has(terminalId)) return false;
    void this.#observations.get(terminalId)?.release();
    this.#observations.delete(terminalId);
    this.#tabs.delete(terminalId);
    if (this.#activeId === terminalId) this.#activeId = this.tabs.at(-1)?.terminal.id;
    return true;
  }

  async create(
    gateway: TerminalGateway,
    workspaceId: string,
    options?: TerminalCreateOptions,
  ): Promise<TerminalTab> {
    return this.open(gateway, await gateway.createTerminal(workspaceId, options));
  }

  async reconnect(
    gateway: TerminalGateway,
    terminalId = this.#activeId,
  ): Promise<TerminalTab | undefined> {
    const tab = terminalId ? this.#tabs.get(terminalId) : undefined;
    if (!tab) return undefined;
    return this.open(gateway, tab.terminal);
  }

  async kill(gateway: TerminalGateway, terminalId = this.#activeId): Promise<void> {
    if (!terminalId) return;
    await gateway.killTerminal(terminalId);
    this.close(terminalId);
  }

  setMode(mode: TerminalMode): void {
    if (this.active) this.#tabs.set(this.active.terminal.id, { ...this.active, mode });
  }

  input(gateway: TerminalGateway, data: string): void {
    const tab = this.active;
    if (tab?.mode !== "insert") return;
    gateway.sendTerminalInput(tab.terminal.id, data);
  }

  scroll(lines: number): void {
    const tab = this.active;
    if (!tab) return;
    const visible = tab.lines.slice(Math.max(0, tab.lines.length - Math.max(1, lines)));
    this.#tabs.set(tab.terminal.id, { ...tab, lines: visible });
  }

  private receive(update: TerminalStreamUpdate): void {
    const tab = this.#tabs.get(update.terminalId);
    if (!tab) return;
    if (update.type === "exited") {
      this.#tabs.set(update.terminalId, { ...tab, connected: false, stale: true });
      return;
    }
    const incoming = update.type === "snapshot" ? update.lines : decode(update.data);
    this.#tabs.set(update.terminalId, {
      ...tab,
      lines:
        update.type === "snapshot"
          ? safeLines({ lines: incoming })
          : [...tab.lines, ...safeLines({ lines: incoming })],
      connected: true,
      stale: false,
    });
  }
}

function safeLines(capture: Pick<TerminalCapture, "lines">): string[] {
  return capture.lines.map((line) => sanitizeStreamText(line));
}
function decode(data: Uint8Array): string[] {
  return new TextDecoder().decode(data).split(/\r?\n/);
}
/** Stream data is untrusted: remove ANSI/OSC sequences before it reaches Deck's renderer. */
function sanitizeStreamText(value: string): string {
  const esc = String.fromCharCode(0x1b);
  return sanitizeTerminalText(
    value
      .replaceAll(new RegExp(`${esc}\\][^\\u0007]*(?:\\u0007|${esc}\\\\)`, "g"), "")
      .replaceAll(new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
      .replaceAll(new RegExp(`${esc}[()][0-2A-Z]`, "g"), ""),
  );
}
