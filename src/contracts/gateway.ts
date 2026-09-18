import type { AgentCommand, CommandResult } from "./commands.js";
import type { DirectorySnapshot, DirectoryUpdate, TimelineUpdate } from "./domain.js";

export interface Observation {
  release(): Promise<void>;
}

export interface PaseoGateway {
  connect(): Promise<void>;
  close(): Promise<void>;
  getDirectorySnapshot(): Promise<DirectorySnapshot>;
  observeDirectory(listener: (update: DirectoryUpdate) => void): Promise<Observation>;
  focusAgent(agentId: string, listener: (update: TimelineUpdate) => void): Promise<Observation>;
  execute(command: AgentCommand): Promise<CommandResult>;
}
