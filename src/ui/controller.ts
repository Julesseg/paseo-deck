import type { AppState, FocusArea, ModalState } from "../contracts/app-state.js";
import type { AgentCommand } from "../contracts/commands.js";
import { activeSessionDraftWorkspaceId } from "../state/composer.js";
import { commandById, commandForKey, newTabUnavailableReason } from "./commands.js";

const timelineTextMotionKeys = [
  "h",
  "j",
  "k",
  "l",
  "w",
  "b",
  "e",
  "W",
  "B",
  "E",
  "0",
  "^",
  "$",
  "+",
  "-",
  "_",
  "|",
  "%",
] as const;
type TimelineTextMotionKey = (typeof timelineTextMotionKeys)[number];

export type UiIntent =
  | { type: "switch-tab"; direction: -1 | 1; count?: number | undefined }
  | { type: "open-terminal"; terminalId: string }
  | { type: "kill-terminal" }
  | { type: "kill-terminal-confirmed"; terminalId: string }
  | { type: "scroll-terminal"; direction: -1 | 1 }
  | { type: "reconnect-terminal" }
  | { type: "open-create-terminal"; workspaceId: string }
  | { type: "open-new-tab"; workspaceId: string }
  | {
      type: "new-tab-choice";
      choice: { kind: "session" } | { kind: "terminal" } | { kind: "profile"; profileId: string };
    }
  | { type: "discard-session-draft"; workspaceId: string }
  | { type: "discard-session-draft-confirmed"; workspaceId: string }
  | { type: "open-draft-setting"; setting: "provider" | "model" | "mode" | "thinking" }
  | { type: "draft-setting-choice"; choice: string }
  | { type: "submit-session-draft"; workspaceId: string; prompt: string }
  | { type: "quit-confirmed" }
  | { type: "set-terminal-name"; name: string }
  | { type: "submit-terminal-name" }
  | { type: "set-terminal-mode"; mode: "normal" | "insert" }
  | { type: "terminal-input"; data: string }
  | { type: "select-next"; direction: -1 | 1 }
  | { type: "select-boundary"; boundary: "start" | "end" }
  | { type: "collapse-or-expand"; direction: -1 | 1 }
  | { type: "select-or-open" }
  | { type: "set-focus"; focus: FocusArea }
  | { type: "set-composer-mode"; mode: "normal" | "insert" | "visual" }
  | { type: "set-timeline-mode"; mode: "normal" | "visual" }
  | { type: "scroll-timeline"; direction: -1 | 1 }
  | { type: "open-help" }
  | { type: "open-command-palette" }
  | { type: "invoke-command"; id: string }
  | { type: "open-filter" }
  | { type: "toggle-tree-order" }
  | { type: "toggle-archived" }
  | { type: "toggle-attention-only" }
  | { type: "adjust-tree-width"; delta: -2 | 2 }
  | { type: "toggle-theme" }
  | { type: "open-create-agent"; workspaceId: string; step: "provider" }
  | { type: "creation-back" }
  | {
      type: "open-confirmation";
      action: "stop" | "archive" | "detach" | "kill-terminal";
      agentId?: string;
      terminalId?: string;
    }
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
  | {
      type: "move-timeline-text";
      key: string;
      count?: number | undefined;
    }
  | {
      type: "timeline-find-character";
      key: "f" | "F" | "t" | "T";
      character: string;
      count: number;
    }
  | { type: "timeline-repeat-find"; reverse: boolean }
  | { type: "timeline-viewport-motion"; key: "H" | "M" | "L"; count: number }
  | { type: "timeline-page"; direction: -1 | 1 }
  | { type: "timeline-visual"; selection: "character" | "line" | "block" }
  | { type: "timeline-search-text"; query: string; direction: -1 | 1 }
  | { type: "timeline-repeat-search"; direction: -1 | 1 }
  | { type: "timeline-yank" }
  | { type: "timeline-yank-object"; object: "line" | "event" }
  | { type: "timeline-open-link" }
  | { type: "timeline-fold" }
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
  #tabPrefix = "";
  #tabCountPrefix = "";
  #timelinePrefix = "";
  #timelineCount = "";
  constructor(
    private readonly getState: () => AppState,
    private readonly emit: (intent: UiIntent) => void,
  ) {}

  handleKey(data: string): boolean {
    const state = this.getState();
    if (state.focus !== "timeline") {
      this.#timelinePrefix = "";
      this.#timelineCount = "";
    }
    // This must precede terminal passthrough as well as every editor, modal,
    // and focus branch. In raw mode Ctrl-C is Deck's unconditional exit key.
    if (data === "\u0003") return this.send({ type: "quit" });
    const tabNormalMode =
      state.modal.type === "none" &&
      (state.focus === "tree" ||
        (state.focus === "composer" && state.composerMode === "normal") ||
        (state.focus === "timeline" && state.activeTerminalId && state.terminalMode !== "insert"));
    const draftWorkspaceId = activeSessionDraftWorkspaceId(state);
    if (
      data === "T" &&
      (state.focus !== "timeline" || !!state.activeTerminalId) &&
      !this.#tabPrefix &&
      !newTabUnavailableReason(state) &&
      state.selectedWorkspaceId
    )
      return this.send({ type: "open-new-tab", workspaceId: state.selectedWorkspaceId });
    if (
      draftWorkspaceId &&
      state.modal.type === "none" &&
      state.focus === "composer" &&
      state.composerMode === "normal" &&
      ["p", "m", "z", "o"].includes(data)
    )
      return this.send({
        type: "open-draft-setting",
        setting: ({ p: "provider", m: "model", z: "thinking", o: "mode" } as const)[
          data as "p" | "m" | "z" | "o"
        ],
      });
    if (
      tabNormalMode &&
      !this.#tabPrefix &&
      /^[0-9]$/.test(data) &&
      (this.#tabCountPrefix || data !== "0")
    ) {
      this.#tabCountPrefix += data;
      return true;
    }
    if (tabNormalMode && data === "g" && this.#tabCountPrefix) {
      this.#tabPrefix = `g${this.#tabCountPrefix}`;
      this.#tabCountPrefix = "";
      return true;
    }
    if (data !== "g") this.#tabCountPrefix = "";
    if (tabNormalMode && this.#tabPrefix.startsWith("g")) {
      if (/^[0-9]$/.test(data)) {
        this.#tabPrefix += data;
        return true;
      }
      const countText = this.#tabPrefix.slice(1);
      this.#tabPrefix = "";
      if (data === "t" || data === "T") {
        this.#timelinePrefix = "";
        return this.send({
          type: "switch-tab",
          direction: data === "t" ? 1 : -1,
          ...(countText ? { count: Number(countText) } : {}),
        });
      }
      if (data === "c") {
        const workspaceId = state.selectedWorkspaceId;
        if (workspaceId && state.sessionDrafts[workspaceId])
          return this.send({ type: "discard-session-draft", workspaceId });
        return true;
      }
      if (data === "k" && state.activeTerminalId) return this.send({ type: "kill-terminal" });
    }
    if (
      state.activeTerminalId !== undefined &&
      state.terminalMode !== undefined &&
      state.terminalLines !== undefined &&
      state.focus === "timeline" &&
      state.modal.type === "none"
    ) {
      if (data === "\u001b")
        return state.terminalMode === "insert"
          ? this.send({ type: "set-terminal-mode", mode: "normal" })
          : this.send({ type: "set-focus", focus: "tree" });
      if (state.terminalMode === "insert") return this.send({ type: "terminal-input", data });
      if (data === "i") return this.send({ type: "set-terminal-mode", mode: "insert" });
      if (data === "q" || data === "n") return this.send({ type: "set-focus", focus: "tree" });
      if (data === "g") {
        this.#tabPrefix = "g";
        return true;
      }
      if (data === "\u001b[A" || data === "\u001b[B" || data === "\u0004" || data === "\u0015")
        return this.send({
          type: "scroll-terminal",
          direction: data === "\u001b[A" || data === "\u0015" ? -1 : 1,
        });
      if (data === "r") return this.send({ type: "reconnect-terminal" });
    }
    // ProcessTerminal enables raw mode, so Ctrl+C is delivered as input rather
    // than raising SIGINT. It must remain a global escape hatch even while an
    // editor or modal owns the keyboard.
    const global = commandForKey(state, data);
    // These two overlays are safe global escapes. They are intercepted before
    // every dialog/editor so opening and closing them cannot mutate its draft.
    if (
      global?.id === "command-palette" ||
      (global?.id === "help" && !(state.focus === "composer" && state.composerMode === "insert"))
    )
      return this.send(global.intent(state));
    if (state.modal.type === "permission") {
      if (state.modal.submitting) return true;
      return this.sendResolved(global, state);
    }
    if (state.modal.type === "notifications") {
      return this.sendResolved(global, state);
    }
    if (state.modal.type === "confirm") {
      if (data === "\u001b") return this.send({ type: "close-modal" });
      return false;
    }
    if (state.modal.type === "new-tab" || state.modal.type === "draft-setting") {
      if (data === "\u001b") return this.send({ type: "close-modal" });
      return false;
    }
    if (state.modal.type === "create-terminal") {
      if (data === "\r") return this.send({ type: "submit-terminal-name" });
      if (data === "\u001b") return this.send({ type: "close-modal" });
      if (data === "\u007f")
        return this.send({ type: "set-terminal-name", name: state.modal.name.slice(0, -1) });
      if (data.length === 1 && data >= " ")
        return this.send({ type: "set-terminal-name", name: state.modal.name + data });
      return true;
    }
    // Ctrl-K/Cmd-P, help, and quit are explicit global precedence paths. The
    // composer otherwise behaves like a Vim buffer: normal mode owns commands,
    // insert mode yields ordinary bytes to the editor.
    if (state.focus === "composer") {
      // Older integrations omitted the mode field; retain their editor-owned
      // behavior while newly-created application state is explicit normal mode.
      const mode = state.composerMode ?? "insert";
      if (data === "\u001b") {
        if (state.composerMode === undefined)
          return this.send({ type: "set-focus", focus: "tree" });
        if (mode !== "normal") return this.send({ type: "set-composer-mode", mode: "normal" });
        return true;
      }
      if (global?.id === "command-palette") return this.send(global.intent(state));
      if (mode === "insert") {
        if (global?.id === "composer-history-previous" || global?.id === "composer-history-next")
          return this.send(global.intent(state));
        if (data === "\u0015" || data === "\u0004" || data === "\u001b[5~" || data === "\u001b[6~")
          return this.send({
            type: "scroll-timeline",
            direction: data === "\u0004" || data === "\u001b[6~" ? 1 : -1,
          });
        if (data === "\u001b[1;5A" || data === "\u001b[1;5B")
          return this.send({ type: "scroll-timeline", direction: data === "\u001b[1;5A" ? -1 : 1 });
        return false;
      }
      if (mode === "visual") return false;
      if (data === "i") return this.send({ type: "set-composer-mode", mode: "insert" });
      if (data === "v") return this.send({ type: "set-composer-mode", mode: "visual" });
      if (data === "n") return this.send({ type: "set-focus", focus: "tree" });
      if (data === "t") return this.send({ type: "set-focus", focus: "timeline" });
      if (data === "g") {
        this.#tabPrefix = "g";
        return true;
      }
      if (data === "\u0015" || data === "\u0004" || data === "\u001b[5~" || data === "\u001b[6~")
        return this.send({
          type: "scroll-timeline",
          direction: data === "\u0004" || data === "\u001b[6~" ? 1 : -1,
        });
      if (data === "\u001b[1;5A" || data === "\u001b[1;5B")
        return this.send({ type: "scroll-timeline", direction: data === "\u001b[1;5A" ? -1 : 1 });
      if (/^[hjklwb0$xdaAIO]$/.test(data)) return false;
      if (global) return this.sendResolved(global, state);
      return false;
    }
    if (isTextEditing(state.modal)) return false;
    // Timeline navigation is a rendered-text buffer. Keep its keys local
    // before resolving the broader command registry (where j/k/g/G/Enter/y
    // also have unrelated meanings in other regions).
    if (state.modal.type === "none" && state.focus === "timeline") {
      const count = (): number | undefined => {
        const value = this.#timelineCount ? Math.max(1, Number(this.#timelineCount)) : undefined;
        this.#timelineCount = "";
        return value;
      };
      if (
        this.#timelinePrefix === "f" ||
        this.#timelinePrefix === "F" ||
        this.#timelinePrefix === "t" ||
        this.#timelinePrefix === "T"
      ) {
        const key = this.#timelinePrefix;
        this.#timelinePrefix = "";
        if (data.length === 1 && data >= " ")
          return this.send({
            type: "timeline-find-character",
            key,
            character: data,
            count: count() ?? 1,
          });
        this.#timelineCount = "";
        return true;
      }
      if (this.#timelinePrefix === "y" && data === "i") {
        this.#timelinePrefix = "yi";
        return true;
      }
      if (this.#timelinePrefix === "yi" && data === "v") {
        this.#timelinePrefix = "";
        this.#timelineCount = "";
        return this.send({ type: "timeline-yank-object", object: "event" });
      }
      if (this.#timelinePrefix === "y" && data === "y") {
        this.#timelinePrefix = "";
        this.#timelineCount = "";
        return this.send({ type: "timeline-yank-object", object: "line" });
      }
      if (this.#timelinePrefix === "g" && data === "x") {
        this.#timelinePrefix = "";
        this.#timelineCount = "";
        this.#tabPrefix = "";
        return this.send({ type: "timeline-open-link" });
      }
      if (this.#timelinePrefix === "g") {
        this.#timelinePrefix = "";
        if (data === "g")
          return this.send(
            state.timeline.items.length
              ? {
                  type: "move-timeline-text",
                  key: "gg",
                  ...(this.#timelineCount ? { count: count() } : {}),
                }
              : { type: "move-timeline-selection-boundary", boundary: "start" },
          );
        if (data === "G")
          return this.send(
            state.timeline.items.length
              ? { type: "move-timeline-text", key: "G" }
              : { type: "move-timeline-selection-boundary", boundary: "end" },
          );
        if (data === "e" || data === "E")
          return this.send({
            type: "move-timeline-text",
            key: `g${data}`,
            ...(this.#timelineCount ? { count: count() } : {}),
          });
        if (data === "t" || data === "T")
          return this.send({
            type: "switch-tab",
            direction: data === "t" ? 1 : -1,
            ...(this.#timelineCount ? { count: count() } : {}),
          });
      }
      if (/^[0-9]$/.test(data) && (data !== "0" || this.#timelineCount)) {
        this.#timelineCount += data;
        return true;
      }
      if (data === "g" || (data === "z" && state.timeline.items.length)) {
        this.#timelinePrefix = data;
        return true;
      }
      if (this.#timelinePrefix === "z") {
        this.#timelinePrefix = "";
        if (data === "a") return this.send({ type: "timeline-fold" });
      }
      this.#timelinePrefix = "";
      if (state.timeline.items.length && ["f", "F", "t", "T"].includes(data)) {
        this.#timelinePrefix = data;
        return true;
      }
      if (data === ";" || data === ",")
        return this.send({ type: "timeline-repeat-find", reverse: data === "," });
      if (state.timeline.items.length && ["H", "M", "L"].includes(data))
        return this.send({
          type: "timeline-viewport-motion",
          key: data as "H" | "M" | "L",
          count: count() ?? 1,
        });
      const arrow = (
        { "\u001b[A": "k", "\u001b[B": "j", "\u001b[C": "l", "\u001b[D": "h" } as Record<
          string,
          string
        >
      )[data];
      if (arrow && state.timeline.items.length)
        return this.send({
          type: "move-timeline-text",
          key: arrow,
          ...(this.#timelineCount ? { count: count() } : {}),
        });
      if (
        state.timeline.items.length &&
        (timelineTextMotionKeys as readonly string[]).includes(data)
      )
        return this.send({
          type: "move-timeline-text",
          key: data as TimelineTextMotionKey,
          ...(this.#timelineCount ? { count: count() } : {}),
        });
      if (data === "G" && state.timeline.items.length)
        return this.send({
          type: "move-timeline-text",
          key: "G",
          ...(this.#timelineCount ? { count: count() } : {}),
        });
      if (data === "G")
        return this.send({ type: "move-timeline-selection-boundary", boundary: "end" });
      if (data === "\r" && state.timeline.items.length)
        return this.send(
          state.timeline.items.length
            ? { type: "timeline-fold" }
            : { type: "toggle-selected-timeline-item" },
        );
      if (data === "y" && state.timeline.items.length) {
        if ((state.timelineMode ?? "normal") === "visual")
          return this.send({ type: "timeline-yank" });
        this.#timelinePrefix = "y";
        return true;
      }
      if (data === "Y" && state.timeline.items.length)
        return this.send({ type: "open-timeline-copy" });
      if (data === "n" || data === "N")
        return this.send({ type: "timeline-repeat-search", direction: data === "n" ? 1 : -1 });
      if (data === "\u0015" || data === "\u0004")
        return this.send({ type: "scroll-timeline", direction: data === "\u0015" ? -1 : 1 });
      if (state.timeline.items.length && data === "V")
        return this.send({ type: "timeline-visual", selection: "line" });
      if (state.timeline.items.length && data === "v")
        return this.send({ type: "timeline-visual", selection: "character" });
      if (state.timeline.items.length && data === "\u0016")
        return this.send({ type: "timeline-visual", selection: "block" });
    }
    if (state.modal.type === "none" && state.focus === "timeline" && data === "\u001b") {
      if ((state.timelineMode ?? "normal") === "visual")
        return this.send({ type: "set-timeline-mode", mode: "normal" });
      return this.send({ type: "set-focus", focus: "composer" });
    }
    if (state.modal.type === "none" && state.focus === "tree" && data === "\u001b")
      return this.send({
        type: "set-focus",
        focus: state.activeTerminalId ? "timeline" : "composer",
      });
    if (data === "\u001b") {
      if (state.modal.type !== "none") this.emit({ type: "close-modal" });
      return state.modal.type !== "none";
    }
    // Every non-text modal owns its own navigation (SelectList, confirmation,
    // and help), rather than letting tree bindings leak through the overlay.
    if (state.modal.type !== "none") return false;
    if (state.focus === "timeline" && !global && data === "/")
      return this.send({ type: "open-timeline-search" });
    if (state.focus === "timeline" && data === "V")
      return this.send({ type: "timeline-visual", selection: "line" });
    if (state.focus === "timeline" && data === "za") return this.send({ type: "timeline-fold" });
    if (
      state.focus === "timeline" &&
      !global &&
      ["h", "l", "w", "b", "e", "0", "^", "$"].includes(data)
    )
      return this.send({
        type: "move-timeline-text",
        key: data as "h" | "l" | "w" | "b" | "e" | "0" | "^" | "$",
      });
    if (this.#tabPrefix === "t" && data === "n") {
      this.#tabPrefix = "";
      if (state.selectedWorkspaceId)
        return this.send({ type: "open-create-terminal", workspaceId: state.selectedWorkspaceId });
      return true;
    }
    if (data === "\u0015" || data === "\u0004" || data === "\u001b[5~" || data === "\u001b[6~")
      return this.send({
        type: "scroll-timeline",
        direction: data === "\u0004" || data === "\u001b[6~" ? 1 : -1,
      });
    if (data === "\u001b[1;5A" || data === "\u001b[1;5B")
      return this.send({ type: "scroll-timeline", direction: data === "\u001b[1;5A" ? -1 : 1 });
    if (state.focus === "timeline" && state.timelineMode !== undefined && data === "v")
      return this.send({ type: "timeline-visual", selection: "character" });
    if (global) {
      if (data === "g") this.#tabPrefix = "g";
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
    if (modal.action === "quit") {
      this.emit({ type: "quit-confirmed" });
      return;
    }
    if (modal.action === "discard-draft") {
      if (modal.workspaceId)
        this.emit({ type: "discard-session-draft-confirmed", workspaceId: modal.workspaceId });
      return;
    }
    if (modal.action === "kill-terminal") {
      if (modal.terminalId)
        this.emit({ type: "kill-terminal-confirmed", terminalId: modal.terminalId });
      return;
    }
    if (!modal.agentId) return;
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
