import type { AppState, ComposerState } from "../contracts/app-state.js";

export type ComposerUnavailableReason =
  | "disconnected"
  | "missing"
  | "detached"
  | "archived"
  | "stopped"
  | "failed";

export type ComposerAvailability =
  | { canSend: true }
  | { canSend: false; reason: ComposerUnavailableReason };

export function createComposerState(): ComposerState {
  return {
    drafts: {},
    histories: {},
    historyIndexes: {},
    historyDrafts: {},
    sendingAgentIds: new Set(),
    detachedAgentIds: new Set(),
  };
}

export function selectedComposerDraft(state: AppState): string {
  const workspaceId = activeSessionDraftWorkspaceId(state);
  if (workspaceId) return state.sessionDrafts[workspaceId]?.prompt ?? "";
  return state.selectedAgentId ? (state.composer.drafts[state.selectedAgentId] ?? "") : "";
}

export function activeSessionDraftWorkspaceId(state: AppState): string | undefined {
  const id = state.selectedWorkspaceId;
  return id && state.sessionDrafts[id] && state.activeTabIds[id] === `draft:${id}` ? id : undefined;
}

export function composerAvailability(state: AppState, agentId: string): ComposerAvailability {
  if (state.connection !== "connected") return { canSend: false, reason: "disconnected" };
  if (state.composer.detachedAgentIds.has(agentId)) return { canSend: false, reason: "detached" };
  const agent = state.directory.agents.find((candidate) => candidate.id === agentId);
  if (!agent) return { canSend: false, reason: "missing" };
  if (agent.archived || agent.status === "archived") return { canSend: false, reason: "archived" };
  if (agent.status === "stopped") return { canSend: false, reason: "stopped" };
  if (agent.status === "failed") return { canSend: false, reason: "failed" };
  return { canSend: true };
}
