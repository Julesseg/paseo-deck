import { resolveTerminalProfileLaunch } from "@getpaseo/protocol/terminal-profiles";
import type { AgentCommand, CommandResult } from "../contracts/commands.js";
import type { DirectorySnapshot, DirectoryUpdate, TimelineUpdate } from "../contracts/domain.js";
import type { Observation, PaseoGateway } from "../contracts/gateway.js";
import type {
  TerminalCreateOptions,
  TerminalProfile,
  TerminalRecord,
  TerminalStreamUpdate,
} from "../contracts/terminal.js";

/** Deterministic in-memory gateway for store and terminal UI tests. */
export class FakePaseoGateway implements PaseoGateway {
  private connected = false;
  private readonly directoryListeners = new Set<(update: DirectoryUpdate) => void>();
  private readonly timelineListeners = new Map<string, Set<(update: TimelineUpdate) => void>>();
  public readonly commands: AgentCommand[] = [];
  public releaseCount = 0;
  public terminals: TerminalRecord[] = [];
  public terminalProfiles: TerminalProfile[] = [];
  public readonly createdTerminals: Array<{
    workspaceId: string;
    options: TerminalCreateOptions | undefined;
  }> = [];
  public readonly terminalInput: Array<{ terminalId: string; data: string }> = [];
  private readonly terminalListeners = new Map<
    string,
    Set<(update: TerminalStreamUpdate) => void>
  >();

  public constructor(private snapshot: DirectorySnapshot) {}

  public async connect(): Promise<void> {
    this.connected = true;
  }

  public async close(): Promise<void> {
    this.connected = false;
    this.directoryListeners.clear();
    this.timelineListeners.clear();
  }

  public async getDirectorySnapshot(): Promise<DirectorySnapshot> {
    this.assertConnected();
    return this.snapshot;
  }

  public async observeDirectory(listener: (update: DirectoryUpdate) => void): Promise<Observation> {
    this.assertConnected();
    this.directoryListeners.add(listener);
    return this.observation(() => this.directoryListeners.delete(listener));
  }

  public async focusAgent(
    agentId: string,
    listener: (update: TimelineUpdate) => void,
  ): Promise<Observation> {
    this.assertConnected();
    const listeners = this.timelineListeners.get(agentId) ?? new Set();
    listeners.add(listener);
    this.timelineListeners.set(agentId, listeners);
    return this.observation(() => {
      listeners.delete(listener);
      if (listeners.size === 0) this.timelineListeners.delete(agentId);
    });
  }

  public async execute(command: AgentCommand): Promise<CommandResult> {
    this.assertConnected();
    this.commands.push(command);
    if (command.type === "create-agent")
      return { type: "agent-created", agentId: `fake-agent-${this.commands.length}` };
    if (command.type === "respond-permission")
      return { type: "permission-resolved", requestId: command.requestId };
    return { type: "ok" };
  }

  public async listTerminals(workspaceId: string): Promise<readonly TerminalRecord[]> {
    this.assertConnected();
    return this.terminals.filter((terminal) => terminal.workspaceId === workspaceId);
  }

  public async listTerminalProfiles(): Promise<readonly TerminalProfile[]> {
    this.assertConnected();
    return this.terminalProfiles;
  }

  public async createTerminal(
    workspaceId: string,
    options?: TerminalCreateOptions,
  ): Promise<TerminalRecord> {
    this.assertConnected();
    this.createdTerminals.push({ workspaceId, options });
    const terminal: TerminalRecord = {
      id: `fake-terminal-${this.terminals.length + 1}`,
      workspaceId,
      cwd: options?.cwd ?? "/",
      name: options?.name ?? "Terminal",
    };
    this.terminals.push(terminal);
    return terminal;
  }

  public async createProfileTerminal(
    workspaceId: string,
    profile: TerminalProfile,
  ): Promise<TerminalRecord> {
    return this.createTerminal(workspaceId, resolveTerminalProfileLaunch(profile, ""));
  }

  public async captureTerminal(
    terminalId: string,
  ): Promise<{ terminalId: string; lines: readonly string[]; totalLines: number }> {
    this.assertConnected();
    return { terminalId, lines: [], totalLines: 0 };
  }

  public sendTerminalInput(terminalId: string, data: string): void {
    this.terminalInput.push({ terminalId, data });
  }

  public async observeTerminal(
    terminalId: string,
    listener: (update: TerminalStreamUpdate) => void,
  ): Promise<Observation> {
    this.assertConnected();
    const listeners = this.terminalListeners.get(terminalId) ?? new Set();
    listeners.add(listener);
    this.terminalListeners.set(terminalId, listeners);
    return this.observation(() => {
      listeners.delete(listener);
    });
  }

  public async killTerminal(terminalId: string): Promise<void> {
    this.assertConnected();
    this.terminals = this.terminals.filter((terminal) => terminal.id !== terminalId);
    for (const listener of this.terminalListeners.get(terminalId) ?? [])
      listener({ type: "exited", terminalId });
  }

  public emitTerminal(update: TerminalStreamUpdate): void {
    for (const listener of this.terminalListeners.get(update.terminalId) ?? []) listener(update);
  }

  public emitDirectory(update: DirectoryUpdate): void {
    if (update.type === "snapshot") this.snapshot = update.snapshot;
    for (const listener of this.directoryListeners) listener(update);
  }

  public emitTimeline(agentId: string, update: TimelineUpdate): void {
    for (const listener of this.timelineListeners.get(agentId) ?? []) listener(update);
  }

  private observation(remove: () => void): Observation {
    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        remove();
        this.releaseCount += 1;
      },
    };
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error("Fake Paseo gateway is not connected.");
  }
}
