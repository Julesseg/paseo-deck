import type { AppState, FocusArea, ModalState } from "../contracts/app-state.js";
import type { AgentCommand } from "../contracts/commands.js";
import { commandById, commandForKey } from "./commands.js";

export type UiIntent =
  | { type: "select-next"; direction: -1 | 1 }
  | { type: "select-boundary"; boundary: "start" | "end" }
  | { type: "collapse-or-expand"; direction: -1 | 1 }
  | { type: "select-or-open" }
  | { type: "set-focus"; focus: FocusArea }
  | { type: "open-help" }
  | { type: "open-command-palette" }
  | { type: "invoke-command"; id: string }
  | { type: "open-filter" }
  | { type: "toggle-tree-order" }
  | { type: "toggle-archived" }
  | { type: "toggle-attention-only" }
  | { type: "adjust-tree-width"; delta: -2 | 2 }
  | { type: "open-create-agent"; workspaceId: string; step: "provider" }
  | { type: "creation-back" }
  | { type: "open-confirmation"; action: "stop" | "archive" | "detach"; agentId: string }
  | { type: "open-rename"; agentId: string }
  | { type: "open-mode"; agentId: string }
  | { type: "open-thinking"; agentId: string }
  | { type: "open-error-details"; message: string; detail: string }
  | { type: "open-notifications" }
  | { type: "move-notification"; direction: -1 | 1 }
  | { type: "select-notification"; id: number }
  | { type: "open-permissions" }
  | { type: "move-permission"; direction: -1 | 1 }
  | { type: "retry-permission"; agentId: string; requestId: string; allow: boolean }
  | { type: "retry-notification"; id: number }
  | { type: "refresh" }
  | { type: "quit" }
  | { type: "close-modal" }
  | { type: "toggle-timeline-item"; itemId: string }
  | { type: "move-timeline-selection"; direction: -1 | 1 }
  | { type: "move-timeline-selection-boundary"; boundary: "start" | "end" }
  | { type: "move-timeline-landmark"; direction: -1 | 1; kind: "turn" | "error" }
  | {
      type: "set-timeline-navigation";
      agentId: string;
      following: boolean;
      anchor?: { epoch: string; sequence: number };
    }
  | { type: "toggle-selected-timeline-item" }
  | { type: "respond-permission"; agentId: string; requestId: string; allow: boolean }
  | { type: "command"; command: AgentCommand }
  | { type: "submit-composer"; agentId: string; prompt: string }
  | { type: "set-composer-text"; text: string }
  | { type: "navigate-composer-history"; direction: -1 | 1 }
  | { type: "open-timeline-search" }
  | { type: "open-timeline-copy" }
  | { type: "notify"; message: string; kind?: "info" | "error" }
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
    const global = commandForKey(state, data);
    if (data === "\u0003" && global?.id === "quit") return this.send(global.intent(state));
    // These two overlays are safe global escapes. They are intercepted before
    // every dialog/editor so opening and closing them cannot mutate its draft.
    if (global?.id === "command-palette" || global?.id === "help")
      return this.send(global.intent(state));
    if (state.modal.type === "permission") {
      if (state.modal.submitting) return true;
      return this.sendResolved(global, state);
    }
    if (state.modal.type === "notifications") {
      return this.sendResolved(global, state);
    }
    if (
      state.focus === "composer" &&
      global &&
      [
        "composer-leave",
        "composer-history-previous",
        "composer-history-next",
        "focus-next",
        "focus-previous",
      ].includes(global.id)
    )
      return this.send(global.intent(state));
    // Ctrl-K/Cmd-P are deliberately available while editing; all other normal
    // shortcuts belong to the editor until it yields focus.
    if (
      (isTextEditing(state.modal) || state.focus === "composer") &&
      global?.id === "command-palette"
    )
      return this.send(global.intent(state));
    if (isTextEditing(state.modal) || state.focus === "composer") return false;
    if (data === "\u001b") {
      if (state.modal.type !== "none") this.emit({ type: "close-modal" });
      return state.modal.type !== "none";
    }
    // Every non-text modal owns its own navigation (SelectList, confirmation,
    // and help), rather than letting tree bindings leak through the overlay.
    if (state.modal.type !== "none") return false;
    if (global) {
      return this.sendResolved(global, state);
    }
    return false;
  }

  invokeCommand(id: string): boolean {
    const command = commandById(this.getState(), id);
    if (!command || command.disabledReason) return false;
    return this.send(command.intent(this.getState()));
  }

  confirm(modal: Extract<ModalState, { type: "confirm" }>): void {
    const command = confirmedCommand(modal.action, modal.agentId);
    this.emit({ type: "command", command });
  }

  private send(intent: UiIntent): true {
    this.emit(intent);
    return true;
  }

  private sendResolved(command: ReturnType<typeof commandForKey>, state: AppState): boolean {
    if (!command) return false;
    if (command.disabledReason) return true;
    return this.send(command.intent(state));
  }
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
