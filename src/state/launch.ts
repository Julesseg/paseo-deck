import type { AppState, LaunchDraft } from "../contracts/app-state.js";

export function launchDraft(state: AppState, workspaceId: string): LaunchDraft {
  const existing = state.launchDrafts?.[workspaceId];
  if (existing) return existing;
  const defaults = state.creationDefaults[workspaceId];
  const provider =
    state.directory.providers.find((item) => item.id === defaults?.providerId && item.ready) ??
    state.directory.providers.find((item) => item.ready);
  const validDefaults = defaults?.providerId === provider?.id ? defaults : undefined;
  const model =
    provider?.models.find((item) => item.id === validDefaults?.modelId && item.selectable) ??
    provider?.models.find((item) => item.id === provider.defaultModelId && item.selectable) ??
    provider?.models.find((item) => item.selectable);
  return {
    kind: "session",
    prompt: "",
    command: "",
    providerId: provider?.id,
    modelId: model?.id,
    modeId: validDefaults?.modeId ?? provider?.defaultModeId,
    thinkingLevel: validDefaults?.thinkingLevel ?? model?.defaultThinkingLevel,
  };
}

export function activeLaunchWorkspaceId(state: AppState): string | undefined {
  const id = state.selectedWorkspaceId;
  if (
    !id ||
    !state.directory.workspaces.some((workspace) => workspace.id === id && !workspace.archived)
  )
    return undefined;
  const pending = state.launchDrafts?.[id];
  if (pending && (pending.submitting || pending.createdAgentId || pending.createdTerminal))
    return id;
  const sessions = state.directory.agents.some(
    (agent) => agent.workspaceId === id && !agent.archived,
  );
  const terminals = state.workspaceTerminals?.[id]?.some(
    (terminal) => !state.staleTerminalIds?.has(terminal.id),
  );
  return !sessions && !terminals && !state.sessionDrafts[id] ? id : undefined;
}
