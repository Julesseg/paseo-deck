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

export interface WorkspaceBaseRef {
  label: string;
  ref: string;
  remote: boolean;
}

export interface WorkspacePlacement {
  supportsWorktree: boolean;
  refs: readonly WorkspaceBaseRef[];
  defaultRef?: string;
}

export interface WorkspaceCreateOptions {
  projectId: string;
  directory: string;
  title?: string;
  baseRef?: string;
  firstAgentPrompt?: string;
}

export interface PaseoGateway extends TerminalGateway {
  getWorkspacePlacement(directory: string): Promise<WorkspacePlacement>;
  createWorkspace(options: WorkspaceCreateOptions): Promise<WorkspaceRecord>;
  connect(): Promise<void>;
  close(): Promise<void>;
  getDirectorySnapshot(): Promise<DirectorySnapshot>;
  observeDirectory(listener: (update: DirectoryUpdate) => void): Promise<Observation>;
  focusAgent(agentId: string, listener: (update: TimelineUpdate) => void): Promise<Observation>;
  execute(command: AgentCommand): Promise<CommandResult>;
}
