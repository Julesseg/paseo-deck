import type {
  AgentRecord,
  ConnectionState,
  DirectorySnapshot,
  TimelineCursor,
  TimelineEvent,
  UsageSummary,
} from "./domain.js";
import type { TerminalProfile, TerminalRecord } from "./terminal.js";

export type FocusArea = "tree" | "timeline" | "composer";
export type ComposerMode = "normal" | "insert" | "visual";
export type TimelineMode = "normal" | "visual";
export type TerminalMode = "normal" | "insert";
export type TreeOrder = "attention" | "alphabetical";
export type SidebarSelection = { kind: "project" | "workspace"; id: string };
export type TabId = `session:${string}` | `terminal:${string}` | `draft:${string}`;
export interface SessionDraft {
  providerId?: string | undefined;
  modelId?: string | undefined;
  modeId?: string | undefined;
  thinkingLevel?: string | undefined;
  prompt: string;
  dirty?: boolean | undefined;
  settingsDirty?: boolean | undefined;
  error?: string | undefined;
  submitting?: boolean | undefined;
}

export type ModalState =
  | { type: "none" }
  | { type: "help" }
  | { type: "notifications"; index: number }
  | { type: "filter"; query: string }
  | { type: "create-terminal"; workspaceId: string; name: string; error?: string }
  | { type: "new-tab"; workspaceId: string; profiles?: readonly TerminalProfile[] }
  | {
      type: "draft-setting";
      workspaceId: string;
      setting: "provider" | "model" | "mode" | "thinking";
    }
  | {
      type: "confirm";
      action: "stop" | "archive" | "detach" | "kill-terminal" | "discard-draft" | "quit";
      agentId?: string;
      workspaceId?: string;
      terminalId?: string;
      draftWarning?: boolean;
    }
  | {
      type: "permission";
      agentId: string;
      requestId: string;
      queueIndex: number;
      submitting: boolean;
      lastDecision?: "allow" | "deny";
      error?: string;
    }
  | {
      type: "create-agent";
      workspaceId: string;
      step: "provider" | "model" | "mode" | "thinking" | "prompt" | "confirm";
      providerId?: string;
      modelId?: string;
      modeId?: string;
      thinkingLevel?: string;
      prompt?: string;
      error?: string;
      submitting?: boolean;
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
  /** Advances only when recovery replaces or restores history ordering. */
  recoveryRevision: number;
  error?: string;
}

/** Semantic scrollback intent, retained per agent without terminal line coordinates. */
export interface TimelineNavigationState {
  following: boolean;
  unread: number;
  anchor?: TimelineCursor;
}

export type RetryDescriptor = { type: "reconnect" } | { type: "operation"; token: number };

export type PaseoFailureKind =
  | "daemon-unavailable"
  | "authentication"
  | "protocol"
  | "subscription"
  | "command";

export interface NotificationState {
  id: number;
  message: string;
  detail?: string;
  kind: "info" | "error";
  retry?: RetryDescriptor;
  failureKind?: PaseoFailureKind;
}

/** Connection information owned by the application, not the transport. */
export interface ConnectionRecoveryState {
  attempt: number;
  since?: number;
  detail?: string;
  directoryStale: boolean;
  timelineStale: boolean;
}

export interface ComposerState {
  drafts: Readonly<Record<string, string>>;
  histories: Readonly<Record<string, readonly string[]>>;
  historyIndexes: Readonly<Record<string, number>>;
  historyDrafts: Readonly<Record<string, string>>;
  sendingAgentIds: ReadonlySet<string>;
  detachedAgentIds: ReadonlySet<string>;
}

export interface CreationDefaults {
  providerId: string;
  modelId: string;
  modeId?: string;
  thinkingLevel?: string;
}

export interface AppState {
  connection: ConnectionState;
  recovery: ConnectionRecoveryState;
  directory: DirectorySnapshot;
  selectedProjectId?: string;
  selectedWorkspaceId?: string;
  selectedAgentId?: string;
  /** The row highlighted in the sidebar. This is independent from the active session. */
  sidebarSelection?: SidebarSelection;
  /** Visible row order captured on entry to sidebar navigation. */
  sidebarOrder?: readonly string[];
  /** The session whose timeline/composer are active. */
  activeSessionId?: string;
  /** Current-run resource order, grouped by workspace. */
  tabOrder: Readonly<Record<string, readonly TabId[]>>;
  /** Last active resource per workspace during this run. */
  activeTabIds: Readonly<Record<string, TabId>>;
  sessionDrafts: Readonly<Record<string, SessionDraft>>;
  expandedIds: ReadonlySet<string>;
  filter: string;
  treeOrder: TreeOrder;
  showArchived: boolean;
  attentionOnly: boolean;
  focus: FocusArea;
  /** Vim mode for the composer; the composer is the resting region. */
  composerMode?: ComposerMode;
  /** Read-only timeline Vim mode while timeline navigation is active. */
  timelineMode?: TimelineMode;
  modal: ModalState;
  timeline: FocusedTimelineState;
  timelineNavigation: Readonly<Record<string, TimelineNavigationState>>;
  composer: ComposerState;
  /** Successful creation choices, isolated by workspace for the current run. */
  creationDefaults: Readonly<Record<string, CreationDefaults>>;
  /** Workspace terminals are presentation tabs, never session tabs. */
  workspaceTerminals?: Readonly<Record<string, readonly TerminalRecord[]>>;
  /** Workspaces observed with a resource during this run, including resources since removed. */
  workspaceHadResources?: ReadonlySet<string>;
  activeTerminalId?: string;
  terminalMode?: TerminalMode;
  terminalLines?: Readonly<Record<string, readonly string[]>>;
  terminalScrollTop?: Readonly<Record<string, number>>;
  staleTerminalIds?: ReadonlySet<string>;
  /** Bounded FIFO; notification is retained as the currently selected entry. */
  notifications: readonly NotificationState[];
  activeNotificationId?: number;
}

export function emptyDirectory(): DirectorySnapshot {
  return { projects: [], workspaces: [], agents: [], providers: [] };
}

export function findSelectedAgent(state: AppState): AgentRecord | undefined {
  return state.directory.agents.find((agent) => agent.id === state.selectedAgentId);
}
