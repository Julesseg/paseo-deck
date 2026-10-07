import type { AgentCommand, CommandResult } from "./commands.js";
import type {
  DirectorySnapshot,
  DirectoryUpdate,
  TimelineUpdate,
  WorkspaceRecord,
} from "./domain.js";
import type { TerminalGateway } from "./terminal.js";

export interface Observation {
  release(): Promise<void>;
}

export interface WorkspaceCreateOptions {
  projectId: string;
  directory: string;
  title?: string;
}

export interface PaseoGateway extends TerminalGateway {
  createWorkspace(options: WorkspaceCreateOptions): Promise<WorkspaceRecord>;
  connect(): Promise<void>;
  close(): Promise<void>;
  getDirectorySnapshot(): Promise<DirectorySnapshot>;
  observeDirectory(listener: (update: DirectoryUpdate) => void): Promise<Observation>;
  focusAgent(agentId: string, listener: (update: TimelineUpdate) => void): Promise<Observation>;
  execute(command: AgentCommand): Promise<CommandResult>;
}
