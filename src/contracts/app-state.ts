import type {
  AgentRecord,
  ConnectionState,
  DirectorySnapshot,
  PermissionRequest,
  TimelineCursor,
  TimelineEvent,
  UsageSummary,
} from "./domain.js";

export type FocusArea = "tree" | "timeline" | "composer";

export type ModalState =
  | { type: "none" }
  | { type: "help" }
  | { type: "filter"; query: string }
  | {
      type: "confirm";
      action: "stop" | "archive" | "detach";
      agentId: string;
      draftWarning?: boolean;
    }
  | { type: "permission"; request: PermissionRequest }
  | {
      type: "create-agent";
      workspaceId: string;
      step: "provider" | "model" | "mode" | "thinking" | "prompt";
      providerId?: string;
      modelId?: string;
      modeId?: string;
      thinkingLevel?: string;
    }
  | { type: "rename"; agentId: string; value: string }
  | { type: "mode"; agentId: string }
  | { type: "thinking"; agentId: string }
  | { type: "error-details"; message: string; detail: string };

export interface FocusedTimelineState {
  agentId?: string;
  epoch?: string;
  cursor?: TimelineCursor;
  items: readonly TimelineEvent[];
  usage?: UsageSummary;
  loading: boolean;
  error?: string;
}

export interface NotificationState {
  message: string;
  detail?: string;
  kind: "info" | "error";
}

export interface ComposerState {
  drafts: Readonly<Record<string, string>>;
  histories: Readonly<Record<string, readonly string[]>>;
  historyIndexes: Readonly<Record<string, number>>;
  historyDrafts: Readonly<Record<string, string>>;
  sendingAgentIds: ReadonlySet<string>;
  detachedAgentIds: ReadonlySet<string>;
}

export interface AppState {
  connection: ConnectionState;
  directory: DirectorySnapshot;
  selectedProjectId?: string;
  selectedWorkspaceId?: string;
  selectedAgentId?: string;
  expandedIds: ReadonlySet<string>;
  filter: string;
  focus: FocusArea;
  modal: ModalState;
  timeline: FocusedTimelineState;
  composer: ComposerState;
  notification?: NotificationState;
}

export function emptyDirectory(): DirectorySnapshot {
  return { projects: [], workspaces: [], agents: [], providers: [] };
}

export function findSelectedAgent(state: AppState): AgentRecord | undefined {
  return state.directory.agents.find((agent) => agent.id === state.selectedAgentId);
}
