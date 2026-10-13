import type { AppState } from "../contracts/app-state.js";
import type { ProviderCommandContext } from "../contracts/gateway.js";
import { activeSessionDraftWorkspaceId } from "./composer.js";
import { activeLaunchWorkspaceId, launchDraft } from "./launch.js";

export function providerCommandContext(state: AppState): ProviderCommandContext | undefined {
  if (state.connection !== "connected" || (state.activeTerminalId && !state.newWorkspace)) return;
  const launchId = activeLaunchWorkspaceId(state);
  const draftId = activeSessionDraftWorkspaceId(state);
  const draft =
    state.newWorkspace?.launch ??
    (launchId ? launchDraft(state, launchId) : draftId ? state.sessionDrafts[draftId] : undefined);
  if (draft) {
    if (("kind" in draft && draft.kind !== "session") || !draft.providerId) return;
    const workspace = state.directory.workspaces.find(
      (item) => item.id === state.selectedWorkspaceId,
    );
    const project = state.directory.projects.find(
      (item) => item.id === state.newWorkspace?.projectId,
    );
    const cwd = state.newWorkspace ? project?.path : workspace?.directory;
    if (!cwd) return;
    return {
      draft: {
        providerId: draft.providerId,
        cwd,
        ...(draft.modelId ? { modelId: draft.modelId } : {}),
        ...(draft.modeId ? { modeId: draft.modeId } : {}),
        ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
      },
      workspaceId: state.newWorkspace
        ? `new:${state.newWorkspace.generation ?? 0}:${state.newWorkspace.baseRef ?? ""}`
        : (state.selectedWorkspaceId ?? ""),
    };
  }
  const agent = state.directory.agents.find((item) => item.id === state.selectedAgentId);
  if (agent)
    return {
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      ...(agent.providerId ? { providerId: agent.providerId } : {}),
    };
  return;
}

export function providerCommandContextKey(state: AppState): string {
  const context = providerCommandContext(state);
  return context ? JSON.stringify(context) : "";
}
