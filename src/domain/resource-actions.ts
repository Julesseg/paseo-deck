import type { AppState } from "../contracts/app-state.js";
import type { TerminalRecord } from "../contracts/terminal.js";

/** Availability uses captured identities, never today's Sidebar highlight or Active tab. */
export function resourceActionUnavailable(
  state: AppState,
  action: string,
  target: { agentId?: string; workspaceId?: string; terminalId?: string },
): string | undefined {
  if (state.connection !== "connected") return "Reconnect to Paseo first.";
  if (target.terminalId) {
    const terminal = Object.values(state.workspaceTerminals ?? {})
      .flat()
      .find((item) => item.id === target.terminalId);
    if (!terminal || (target.workspaceId && terminal.workspaceId !== target.workspaceId))
      return "Captured Terminal is no longer available.";
    if (
      !state.directory.workspaces.some((item) => item.id === terminal.workspaceId && !item.archived)
    )
      return "Captured Workspace is no longer available.";
    return;
  }
  if (target.agentId) {
    const agent = state.directory.agents.find((item) => item.id === target.agentId);
    if (!agent || agent.archived || agent.status === "archived")
      return "Captured Session is no longer available.";
    if (state.composer.detachedAgentIds.has(agent.id)) return "Captured Session is detached.";
    if (action === "stop" || action === "stop-agent") {
      if (agent.status === "stopped" || agent.status === "failed")
        return "Captured Session has already stopped.";
    }
    return;
  }
  if (target.workspaceId)
    return state.directory.workspaces.some(
      (item) => item.id === target.workspaceId && !item.archived,
    )
      ? undefined
      : "Captured Workspace is no longer available.";
  return "Select an eligible resource first.";
}

export function terminalDisplayName(terminal: TerminalRecord): string {
  return terminal.title ?? terminal.name;
}
