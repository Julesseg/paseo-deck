import type { AgentCommand, CommandResult } from "../contracts/commands.js";
import type { DirectorySnapshot, DirectoryUpdate, TimelineUpdate } from "../contracts/domain.js";
import type { Observation, PaseoGateway } from "../contracts/gateway.js";

/** Deterministic in-memory gateway for store and terminal UI tests. */
export class FakePaseoGateway implements PaseoGateway {
  private connected = false;
  private readonly directoryListeners = new Set<(update: DirectoryUpdate) => void>();
  private readonly timelineListeners = new Map<string, Set<(update: TimelineUpdate) => void>>();
  public readonly commands: AgentCommand[] = [];
  public releaseCount = 0;

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
