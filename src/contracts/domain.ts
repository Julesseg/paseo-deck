export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path?: string;
}

export interface WorkspaceRecord {
  id: string;
  projectId?: string;
  title: string;
  directory: string;
  archived: boolean;
}

export type AgentStatus =
  | "starting"
  | "running"
  | "idle"
  | "stopped"
  | "failed"
  | "archived"
  | "unknown";

export interface PermissionRequest {
  id: string;
  agentId: string;
  provider?: string;
  name?: string;
  kind?: string;
  title: string;
  /** Display-safe operation name derived at the gateway boundary. */
  operation?: string;
  workingDirectory?: string;
  arguments?: readonly string[];
  actions?: readonly { id: string; label: string; behavior?: string }[];
  description?: string;
  choices?: readonly string[];
}

export interface AgentRecord {
  id: string;
  workspaceId: string;
  title: string;
  status: AgentStatus;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
  modeId?: string;
  availableModeIds: readonly string[];
  availableThinkingLevels: readonly string[];
  pendingPermissions: readonly PermissionRequest[];
  needsAttention: boolean;
  parentAgentId?: string;
  archived: boolean;
  /** The daemon's most recent agent update timestamp, when it provides one. */
  lastActivityAt?: string;
  lastUsage?: UsageSummary;
}

export interface ModelOption {
  id: string;
  name: string;
  selectable: boolean;
  thinkingLevels: readonly string[];
}

export interface ProviderOption {
  id: string;
  name: string;
  ready: boolean;
  models: readonly ModelOption[];
  modeIds: readonly string[];
  defaultModelId?: string;
  defaultModeId?: string;
}

export interface DirectorySnapshot {
  projects: readonly ProjectRecord[];
  workspaces: readonly WorkspaceRecord[];
  agents: readonly AgentRecord[];
  providers: readonly ProviderOption[];
}

export type DirectoryUpdate =
  | { type: "snapshot"; snapshot: DirectorySnapshot }
  | { type: "project-upserted"; project: ProjectRecord }
  | { type: "project-removed"; projectId: string }
  | { type: "workspace-upserted"; workspace: WorkspaceRecord }
  | { type: "workspace-removed"; workspaceId: string }
  | { type: "agent-upserted"; agent: AgentRecord }
  | { type: "agent-removed"; agentId: string }
  | { type: "providers-replaced"; providers: readonly ProviderOption[] }
  | { type: "connection-changed"; state: ConnectionState; detail?: string };

export interface TimelineCursor {
  epoch: string;
  sequence: number;
}

interface TimelineBase {
  id: string;
  timestamp?: string;
  raw?: unknown;
}

export type TimelineItem =
  | (TimelineBase & { type: "user-message"; text: string })
  | (TimelineBase & {
      type: "assistant-message";
      messageId: string;
      text: string;
      streaming?: boolean;
      turnId?: string;
    })
  | (TimelineBase & { type: "reasoning"; text: string; collapsed?: boolean })
  | (TimelineBase & {
      type: "tool";
      callId: string;
      name: string;
      status: "running" | "completed" | "failed" | "canceled";
      summary?: string;
      output?: string;
      durationMs?: number;
      failureSummary?: string;
    })
  | (TimelineBase & { type: "error"; message: string; detail?: string })
  | (TimelineBase & { type: "permission"; request: PermissionRequest; resolved?: boolean })
  | (TimelineBase & {
      type: "turn";
      status: "started" | "completed" | "failed" | "canceled";
      detail?: string;
      startedAt?: string;
      completedAt?: string;
      durationMs?: number;
    })
  | (TimelineBase & { type: "unknown"; sourceType: string; summary: string });

export interface TimelineEvent {
  epoch: string;
  sequence: number;
  item: TimelineItem;
}

export type TimelineUpdate =
  | {
      type: "hydrated";
      agentId: string;
      items: readonly TimelineEvent[];
      cursor?: TimelineCursor;
    }
  | { type: "event"; agentId: string; event: TimelineEvent }
  | {
      type: "replaced";
      agentId: string;
      epoch: string;
      items: readonly TimelineEvent[];
      cursor?: TimelineCursor;
    }
  | { type: "restored"; agentId: string; missed: readonly TimelineEvent[] }
  | { type: "usage"; agentId: string; usage: UsageSummary }
  | { type: "error"; agentId: string; message: string; detail?: string };
