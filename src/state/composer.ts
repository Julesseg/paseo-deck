import type { AppState, ComposerState, SessionDraft } from "../contracts/app-state.js";
import { activeLaunchWorkspaceId, launchDraft } from "./launch.js";

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
  const launchId = activeLaunchWorkspaceId(state);
  if (launchId) {
    const draft = launchDraft(state, launchId);
    return draft.kind === "session" ? draft.prompt : draft.command;
  }
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

/** Whitespace and explicit settings edits are unsent work; default settings are not. */
export function draftHasUnsentWork(draft: SessionDraft & { command?: string }): boolean {
  return Boolean(
    draft.dirty || draft.settingsDirty || draft.prompt.length || draft.command?.length,
  );
}

export function hasUnsentWork(state: AppState): boolean {
  return (
    Object.values(state.sessionDrafts).some(draftHasUnsentWork) ||
    Object.values(state.composer.drafts).some((text) => text.length > 0) ||
    Object.values(state.launchDrafts ?? {}).some(draftHasUnsentWork) ||
    Boolean(
      state.newWorkspace &&
        (state.newWorkspace.title.length > 0 || draftHasUnsentWork(state.newWorkspace.launch)),
    )
  );
}
