import type { AppState, FocusArea, ModalState } from "../contracts/app-state.js";
import type { AgentCommand } from "../contracts/commands.js";

export type UiIntent =
  | { type: "select-next"; direction: -1 | 1 }
  | { type: "collapse-or-expand"; direction: -1 | 1 }
  | { type: "select-or-open" }
  | { type: "set-focus"; focus: FocusArea }
  | { type: "open-help" }
  | { type: "open-filter" }
  | { type: "open-create-agent"; workspaceId: string; step: "provider" }
  | { type: "open-confirmation"; action: "stop" | "archive" | "detach"; agentId: string }
  | { type: "open-rename"; agentId: string }
  | { type: "open-mode"; agentId: string }
  | { type: "open-thinking"; agentId: string }
  | { type: "open-error-details"; message: string; detail: string }
  | { type: "open-permissions" }
  | { type: "refresh" }
  | { type: "quit" }
  | { type: "close-modal" }
  | { type: "toggle-timeline-item"; itemId: string }
  | { type: "move-timeline-selection"; direction: -1 | 1 }
  | { type: "toggle-selected-timeline-item" }
  | { type: "respond-permission"; agentId: string; requestId: string; allow: boolean }
  | { type: "command"; command: AgentCommand }
  | { type: "submit-composer"; agentId: string; prompt: string }
  | { type: "set-composer-text"; text: string }
  | { type: "navigate-composer-history"; direction: -1 | 1 }
  | { type: "create-choice"; choice: string };

export class DeckController {
  constructor(
    private readonly getState: () => AppState,
    private readonly emit: (intent: UiIntent) => void,
  ) {}

  handleKey(data: string): boolean {
    const state = this.getState();
    // ProcessTerminal enables raw mode, so Ctrl+C is delivered as input rather
    // than raising SIGINT. It must remain a global escape hatch even while an
    // editor or modal owns the keyboard.
    if (data === "\u0003") return this.send({ type: "quit" });
    if (state.modal.type === "permission") {
      if (data === "a")
        this.emit({
          type: "respond-permission",
          agentId: state.modal.request.agentId,
          requestId: state.modal.request.id,
          allow: true,
        });
      else if (data === "d")
        this.emit({
          type: "respond-permission",
          agentId: state.modal.request.agentId,
          requestId: state.modal.request.id,
          allow: false,
        });
      else if (data === "\u001b") this.emit({ type: "close-modal" });
      else return false;
      return true;
    }
    if (state.focus === "composer" && data === "\u001b")
      return this.send({ type: "set-focus", focus: "tree" });
    if (state.focus === "composer" && data === "\u0010")
      return this.send({ type: "navigate-composer-history", direction: -1 });
    if (state.focus === "composer" && data === "\u000e")
      return this.send({ type: "navigate-composer-history", direction: 1 });
    if (isTextEditing(state.modal) || state.focus === "composer") return false;
    if (data === "\u001b") {
      if (state.modal.type !== "none") this.emit({ type: "close-modal" });
      return state.modal.type !== "none";
    }
    // Every non-text modal owns its own navigation (SelectList, confirmation,
    // and help), rather than letting tree bindings leak through the overlay.
    if (state.modal.type !== "none") return false;
    if (data === "j")
      return state.focus === "timeline"
        ? this.send({ type: "move-timeline-selection", direction: 1 })
        : this.send({ type: "select-next", direction: 1 });
    if (data === "k")
      return state.focus === "timeline"
        ? this.send({ type: "move-timeline-selection", direction: -1 })
        : this.send({ type: "select-next", direction: -1 });
    if (data === "h") return this.send({ type: "collapse-or-expand", direction: -1 });
    if (data === "l") return this.send({ type: "collapse-or-expand", direction: 1 });
    if (data === "\r")
      return state.focus === "timeline"
        ? this.send({ type: "toggle-selected-timeline-item" })
        : this.send({ type: "select-or-open" });
    if (data === "\t") return this.send({ type: "set-focus", focus: nextFocus(state.focus, 1) });
    if (data === "\u001b[Z")
      return this.send({ type: "set-focus", focus: nextFocus(state.focus, -1) });
    if (data === "i") return this.send({ type: "set-focus", focus: "composer" });
    if (data === "n" && state.selectedWorkspaceId)
      return this.send({
        type: "open-create-agent",
        workspaceId: state.selectedWorkspaceId,
        step: "provider",
      });
    if (data === "/") return this.send({ type: "open-filter" });
    if (data === "p") return this.send({ type: "open-permissions" });
    if (data === "r") return this.send({ type: "refresh" });
    if (data === "?") return this.send({ type: "open-help" });
    if (data === "E" && state.notification?.detail)
      return this.send({
        type: "open-error-details",
        message: state.notification.message,
        detail: state.notification.detail,
      });
    if (data === "q") return this.send({ type: "quit" });
    if (!state.selectedAgentId) return false;
    if (data === "x")
      return this.send({
        type: "open-confirmation",
        action: "stop",
        agentId: state.selectedAgentId,
      });
    if (data === "A")
      return this.send({
        type: "open-confirmation",
        action: "archive",
        agentId: state.selectedAgentId,
      });
    if (data === "d")
      return this.send({
        type: "open-confirmation",
        action: "detach",
        agentId: state.selectedAgentId,
      });
    if (data === "e") return this.send({ type: "open-rename", agentId: state.selectedAgentId });
    if (data === "m") return this.send({ type: "open-mode", agentId: state.selectedAgentId });
    if (data === "t") return this.send({ type: "open-thinking", agentId: state.selectedAgentId });
    return false;
  }

  confirm(modal: Extract<ModalState, { type: "confirm" }>): void {
    const command = confirmedCommand(modal.action, modal.agentId);
    this.emit({ type: "command", command });
  }

  private send(intent: UiIntent): true {
    this.emit(intent);
    return true;
  }
}

function nextFocus(focus: FocusArea, direction: -1 | 1): FocusArea {
  const order: FocusArea[] = ["tree", "timeline", "composer"];
  const index = order.indexOf(focus);
  return order[(index + direction + order.length) % order.length] ?? "tree";
}

function isTextEditing(modal: ModalState): boolean {
  return modal.type === "filter" || modal.type === "rename" || modal.type === "create-agent";
}

function confirmedCommand(action: "stop" | "archive" | "detach", agentId: string): AgentCommand {
  switch (action) {
    case "stop":
      return { type: "stop-agent", agentId };
    case "archive":
      return { type: "archive-agent", agentId };
    case "detach":
      return { type: "detach-agent", agentId };
  }
}
