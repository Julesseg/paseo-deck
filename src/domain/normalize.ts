import type {
  AgentRecord,
  AgentStatus,
  DirectorySnapshot,
  ModelOption,
  PermissionRequest,
  ProjectRecord,
  ProviderOption,
  UsageSummary,
  WorkspaceRecord,
} from "../contracts/domain.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function status(value: unknown): AgentStatus {
  const allowed: readonly AgentStatus[] = [
    "starting",
    "running",
    "idle",
    "stopped",
    "failed",
    "archived",
    "unknown",
  ];
  return typeof value === "string" && allowed.includes(value as AgentStatus)
    ? (value as AgentStatus)
    : "unknown";
}

function usage(value: unknown): UsageSummary | undefined {
  const source = record(value);
  const result: UsageSummary = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cachedTokens",
    "contextTokens",
    "contextWindow",
  ] as const) {
    if (typeof source[key] === "number") result[key] = source[key];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizePermission(value: unknown, agentId: string): PermissionRequest {
  const source = record(value);
  const id = text(source.id, `${agentId}:unknown-permission`);
  return {
    id,
    agentId: text(source.agentId, agentId),
    title: text(source.title, text(source.name, "Permission required")),
    ...(text(source.description) ? { description: text(source.description) } : {}),
    choices: strings(source.choices ?? source.actions),
  };
}

export function normalizeProject(value: unknown): ProjectRecord | undefined {
  const source = record(value);
  const id = text(source.projectId, text(source.id, text(source.projectKey)));
  if (!id) return undefined;
  return {
    id,
    name: text(source.name, text(source.projectName, id)),
    ...(text(source.path) ? { path: text(source.path) } : {}),
  };
}

export function normalizeWorkspace(value: unknown): WorkspaceRecord | undefined {
  const source = record(value);
  const id = text(source.id);
  if (!id) return undefined;
  const directory = text(source.directory, text(source.path, id));
  return {
    id,
    ...(text(source.projectId) ? { projectId: text(source.projectId) } : {}),
    title: text(source.title, text(source.name, directory)),
    directory,
    archived: source.archived === true,
  };
}

export function normalizeAgent(value: unknown): AgentRecord | undefined {
  const source = record(value);
  const id = text(source.id);
  const workspaceId = text(source.workspaceId);
  if (!id || !workspaceId) return undefined;
  const lastUsage = usage(source.lastUsage ?? source.usage);
  return {
    id,
    workspaceId,
    title: text(source.title, text(source.name, id)),
    status: status(source.status),
    ...(text(source.providerId ?? source.provider)
      ? { providerId: text(source.providerId ?? source.provider) }
      : {}),
    ...(text(source.modelId ?? source.model)
      ? { modelId: text(source.modelId ?? source.model) }
      : {}),
    ...(text(source.thinkingLevel ?? source.thinkingOptionId)
      ? { thinkingLevel: text(source.thinkingLevel ?? source.thinkingOptionId) }
      : {}),
    ...(text(source.modeId ?? source.mode) ? { modeId: text(source.modeId ?? source.mode) } : {}),
    availableModeIds: strings(source.availableModeIds ?? source.modes),
    availableThinkingLevels: strings(source.availableThinkingLevels ?? source.thinkingLevels),
    pendingPermissions: list(source.pendingPermissions).map((permission) =>
      normalizePermission(permission, id),
    ),
    needsAttention: source.needsAttention === true,
    ...(text(source.parentAgentId) ? { parentAgentId: text(source.parentAgentId) } : {}),
    archived: source.archived === true,
    ...(lastUsage ? { lastUsage } : {}),
  };
}

function normalizeModel(value: unknown): ModelOption | undefined {
  const source = record(value);
  const id = text(source.id);
  if (!id) return undefined;
  return {
    id,
    name: text(source.name, id),
    selectable: source.selectable !== false,
    thinkingLevels: strings(source.thinkingLevels),
  };
}

export function normalizeProvider(value: unknown): ProviderOption | undefined {
  const source = record(value);
  const id = text(source.id);
  if (!id) return undefined;
  return {
    id,
    name: text(source.name, id),
    ready: source.ready === true,
    models: list(source.models)
      .map(normalizeModel)
      .filter((item): item is ModelOption => item !== undefined),
    modeIds: strings(source.modeIds ?? source.modes),
    ...(text(source.defaultModelId) ? { defaultModelId: text(source.defaultModelId) } : {}),
    ...(text(source.defaultModeId) ? { defaultModeId: text(source.defaultModeId) } : {}),
  };
}

export function normalizeDirectory(value: unknown): DirectorySnapshot {
  const source = record(value);
  return {
    projects: list(source.projects)
      .map(normalizeProject)
      .filter((item): item is ProjectRecord => item !== undefined),
    workspaces: list(source.workspaces)
      .map(normalizeWorkspace)
      .filter((item): item is WorkspaceRecord => item !== undefined),
    agents: list(source.agents)
      .map(normalizeAgent)
      .filter((item): item is AgentRecord => item !== undefined),
    providers: list(source.providers)
      .map(normalizeProvider)
      .filter((item): item is ProviderOption => item !== undefined),
  };
}
