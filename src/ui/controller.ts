import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { AppState, FocusArea, ModalState } from "../contracts/app-state.js";
import type { AgentCommand } from "../contracts/commands.js";
import { activeSessionDraftWorkspaceId } from "../state/composer.js";
import { activeLaunchWorkspaceId } from "../state/launch.js";
import { commandById, commandForKey } from "./commands.js";
import { isCharacter } from "./text-buffer.js";

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
  "_",
  "%",
  "(",
  ")",
  "{",
  "}",
] as const;

export type UiIntent =
  | { type: "open-new-workspace" }
  | { type: "open-new-workspace-project" }
  | { type: "open-new-workspace-title" }
  | { type: "open-new-workspace-placement" }
  | { type: "open-new-workspace-base" }
  | { type: "new-workspace-placement-choice"; placement: "local" | "worktree" }
  | { type: "new-workspace-base-choice"; ref: string }
  | { type: "new-workspace-project-choice"; projectId: string }
  | { type: "set-new-workspace-title"; title: string }
  | { type: "cancel-new-workspace" }
  | { type: "toggle-launch-kind" }
  | { type: "open-launch-profile" }
  | { type: "launch-profile-choice"; profileId: string }
  | { type: "submit-launch"; workspaceId: string; prompt: string }
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
  | { type: "timeline-word-search"; key: "*" | "#" | "g*" | "g#"; count: number }
  | { type: "timeline-visual"; selection: "character" | "line" }
  | { type: "timeline-search-text"; query: string; direction: -1 | 1 }
  | { type: "timeline-repeat-search"; direction: -1 | 1 }
  | { type: "timeline-yank"; rows?: boolean }
  | { type: "timeline-swap-endpoints" }
  | { type: "timeline-reselect" }
  | { type: "timeline-yank-motion"; key: string; count?: number; character?: string }
  | { type: "timeline-yank-object"; object: "line" | "event"; count?: number }
  | {
      type: "timeline-text-object";
      object: string;
      around: boolean;
      action: "yank" | "select";
      count: number;
    }
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
  | { type: "open-timeline-search"; direction?: -1 | 1 }
  | { type: "notify"; message: string; kind?: "info" | "error" }
  | { type: "create-choice"; choice: string };

export class DeckController {
  #tabPrefix = "";
  #timelineOperatorCount: number | undefined;
  #timelinePrefix = "";
  #timelineCount = "";
  #timelineSearchDirection: -1 | 1 = 1;
  constructor(
    private readonly getState: () => AppState,
    private readonly emit: (intent: UiIntent) => void,
  ) {}

  get hasPendingTimelineInput(): boolean {
    return Boolean(
      this.#timelinePrefix || this.#timelineCount || this.#timelineOperatorCount !== undefined,
    );
  }

  cancelPendingInput(): void {
    this.#tabPrefix = "";
    this.#timelinePrefix = "";
    this.#timelineCount = "";
    this.#timelineOperatorCount = undefined;
  }

  private handleTimelineKey(data: string, state: AppState): boolean {
    const visual = state.timelineMode === "visual";
    const pending = this.#timelinePrefix;
    const hasCount = Boolean(this.#timelineCount) || this.#timelineOperatorCount !== undefined;
    const repetitions = (): number | undefined => {
      const value = hasCount
        ? Math.max(1, Number(this.#timelineCount || 1)) * (this.#timelineOperatorCount ?? 1)
        : undefined;
      this.#timelineCount = "";
      this.#timelineOperatorCount = undefined;
      return value;
    };
    const done = (intent?: UiIntent): boolean => {
      this.cancelPendingInput();
      return intent ? this.send(intent) : true;
    };
    if (data === "\u001b") {
      if (pending || hasCount) return done();
      return done(
        visual
          ? { type: "set-timeline-mode", mode: "normal" }
          : { type: "set-focus", focus: "composer" },
      );
    }
    if (data === "\r" || data === "\n") return done();
    const yank = pending.startsWith("y");
    const prefix = yank ? pending.slice(1) : pending;
    const motion = (key: string): boolean => {
      if (key === "%" && hasCount) return done();
      const count = repetitions();
      return done(
        yank
          ? { type: "timeline-yank-motion", key, ...(count === undefined ? {} : { count }) }
          : { type: "move-timeline-text", key, ...(count === undefined ? {} : { count }) },
      );
    };
    if (["f", "F", "t", "T"].includes(prefix)) {
      const count = repetitions() ?? 1;
      if (!isCharacter(data)) return done();
      return done(
        yank
          ? { type: "timeline-yank-motion", key: prefix, count, character: data }
          : {
              type: "timeline-find-character",
              key: prefix as "f" | "F" | "t" | "T",
              character: data,
              count,
            },
      );
    }
    if (prefix === "i" || prefix === "a") {
      if (
        ![
          "w",
          "W",
          "s",
          "p",
          "q",
          "b",
          "B",
          '"',
          "'",
          "`",
          "(",
          ")",
          "[",
          "]",
          "{",
          "}",
          "<",
          ">",
        ].includes(data)
      )
        return done();
      if (hasCount) return done();
      return done({
        type: "timeline-text-object",
        object: data,
        around: prefix === "a",
        action: yank ? "yank" : "select",
        count: 1,
      });
    }
    if (/^[0-9]$/u.test(data) && (data !== "0" || this.#timelineCount)) {
      this.#timelineCount += data;
      return true;
    }
    if (prefix === "g") {
      if (data === "?" && !yank && !hasCount) return done({ type: "open-help" });
      if (data === "v" && !yank && !hasCount) return done({ type: "timeline-reselect" });
      if (data === "x" && !yank && !visual && !hasCount)
        return done({ type: "timeline-open-link" });
      if ((data === "t" || data === "T") && !yank && !visual) {
        const count = repetitions();
        return done({
          type: "switch-tab",
          direction: data === "t" ? 1 : -1,
          ...(count === undefined ? {} : { count }),
        });
      }
      if (["g", "e", "E", "_", "0", "$", "^", "j", "k"].includes(data)) return motion(`g${data}`);
      return done();
    }
    if (prefix === "[" || prefix === "]") {
      if ((data === "t" || data === "e") && !yank && !visual && !hasCount)
        return done({
          type: "move-timeline-landmark",
          direction: prefix === "[" ? -1 : 1,
          kind: data === "t" ? "turn" : "error",
        });
      if (data === "[" || data === "]") return motion(prefix + data);
      return done();
    }
    if (prefix === "z")
      return done(data === "a" && !visual && !hasCount ? { type: "timeline-fold" } : undefined);
    if (pending && pending !== "y") return done();
    if (["g", "[", "]", "f", "F", "t", "T"].includes(data)) {
      this.#timelinePrefix = `${yank ? "y" : ""}${data}`;
      return true;
    }
    if ((yank || visual) && (data === "i" || data === "a")) {
      this.#timelinePrefix = `${yank ? "y" : ""}${data}`;
      return true;
    }
    if ((data === "y" || data === "Y") && state.timeline.items.length) {
      const count = repetitions() ?? 1;
      if (visual) return done(hasCount ? undefined : { type: "timeline-yank", rows: data === "Y" });
      if (data === "Y" || yank)
        return done({
          type: "timeline-yank-object",
          object: "line",
          ...(hasCount ? { count } : {}),
        });
      this.#timelineOperatorCount = hasCount ? count : undefined;
      this.#timelinePrefix = "y";
      return true;
    }
    const alias = (
      {
        "\u001b[A": "k",
        "\u001b[B": "j",
        "\u001b[C": "l",
        "\u001b[D": "h",
        "\u007f": "h",
        "\b": "h",
        " ": "l",
      } as Record<string, string>
    )[data];
    if (alias) return motion(alias);
    if (
      (timelineTextMotionKeys as readonly string[]).includes(data) ||
      data === "G" ||
      data === ";" ||
      data === ","
    )
      return motion(data);
    if (yank) return done();
    if (["H", "M", "L"].includes(data)) {
      if (data === "M" && hasCount) return done();
      const count = repetitions() ?? 1;
      return done({ type: "timeline-viewport-motion", key: data as "H" | "M" | "L", count });
    }
    if ((data === "v" || data === "V") && !hasCount)
      return done({ type: "timeline-visual", selection: data === "v" ? "character" : "line" });
    if ((data === "o" || data === "O") && visual && !hasCount)
      return done({ type: "timeline-swap-endpoints" });
    if (hasCount) return done();
    if (data === "/" || data === "?") {
      this.#timelineSearchDirection = data === "/" ? 1 : -1;
      return done({ type: "open-timeline-search", direction: this.#timelineSearchDirection });
    }
    if (data === "*" || data === "#") {
      this.#timelineSearchDirection = data === "*" ? 1 : -1;
      return done({ type: "timeline-word-search", key: data, count: 1 });
    }
    if (data === "n" || data === "N")
      return done({
        type: "timeline-repeat-search",
        direction:
          data === "n"
            ? this.#timelineSearchDirection
            : this.#timelineSearchDirection === 1
              ? -1
              : 1,
      });
    if (["\u0006", "\u0002", "\u001b[5~", "\u001b[6~"].includes(data))
      return done({
        type: "timeline-page",
        direction: data === "\u0006" || data === "\u001b[6~" ? 1 : -1,
      });
    if (data === "z" && !visual) {
      this.#timelinePrefix = "z";
      return true;
    }
    if (!visual) {
      const command = commandForKey(state, data);
      if (command && ["stop-agent", "archive-agent"].includes(command.id))
        return this.sendResolved(command, state);
    }
    return done();
  }

  handleKey(data: string): boolean {
    const state = this.getState();
    if (state.focus !== "timeline") {
      this.#timelinePrefix = "";
      this.#timelineCount = "";
    }
    if (state.activeTerminalId && state.focus === "timeline" && state.modal.type === "none") {
      if (matchesKey(data, "ctrl+s")) {
        if (isKeyRelease(data)) return true;
        this.cancelPendingInput();
        return this.send({ type: "set-focus", focus: "tree" });
      }
      if (matchesKey(data, "ctrl+tab") || matchesKey(data, "ctrl+shift+tab")) {
        if (isKeyRelease(data)) return true;
        return this.send({
          type: "switch-tab",
          direction: matchesKey(data, "ctrl+shift+tab") ? -1 : 1,
        });
      }
      return this.send({ type: "terminal-input", data });
    }
    // Outside direct Terminal input, Ctrl-C belongs to Deck before editors
    // and overlays can interpret it.
    if (data === "\u0003") return this.send({ type: "quit" });
    if (data === "\u0010") return this.send({ type: "open-command-palette" });
    if (data === "\u0013") {
      if (state.focus !== "tree") {
        this.cancelPendingInput();
        return this.send({ type: "set-focus", focus: "tree" });
      }
      return true;
    }
    if (data === "\u000b" && state.modal.type === "none") {
      if (
        state.selectedAgentId &&
        !activeSessionDraftWorkspaceId(state) &&
        !activeLaunchWorkspaceId(state) &&
        state.focus !== "timeline"
      ) {
        this.cancelPendingInput();
        return this.send({ type: "set-focus", focus: "timeline" });
      }
      return true;
    }
    if ((data === "\u0015" || data === "\u0004") && !state.activeTerminalId) {
      if (state.focus === "timeline" && (this.#timelinePrefix || this.#timelineCount)) {
        this.cancelPendingInput();
        return true;
      }
      return this.send({ type: "scroll-timeline", direction: data === "\u0015" ? -1 : 1 });
    }
    if (
      state.focus === "tree" &&
      state.modal.type === "none" &&
      this.#tabPrefix === "g" &&
      data === "?"
    ) {
      this.cancelPendingInput();
      return this.send({ type: "open-help" });
    }
    const normalBuffer =
      state.modal.type === "none" &&
      !state.activeTerminalId &&
      ((state.focus === "composer" && state.composerMode === "normal") ||
        (state.focus === "timeline" && (state.timelineMode ?? "normal") === "normal"));
    if (normalBuffer && ["\u0014", "\u0018", "\u0001"].includes(data)) {
      this.cancelPendingInput();
      return this.sendResolved(commandForKey(state, data), state);
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
    if (
      state.modal.type === "new-tab" ||
      state.modal.type === "draft-setting" ||
      state.modal.type === "launch-profile" ||
      state.modal.type === "new-workspace-project" ||
      state.modal.type === "new-workspace-placement" ||
      state.modal.type === "new-workspace-base" ||
      state.modal.type === "new-workspace-title"
    ) {
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
        if (state.newWorkspace) return this.send({ type: "cancel-new-workspace" });
        return true;
      }
      if (global?.id === "command-palette") return this.send(global.intent(state));
      if (mode === "insert") return false;
      // The composer owns all normal and visual bytes. Its Vim reducer handles
      // prefixes, motions, operators, selection, and edits together.
      if (mode === "visual" || mode === "normal") return false;
      return false;
    }
    if (isTextEditing(state.modal)) return false;
    // Timeline navigation is a rendered-text buffer. Keep its keys local
    // before resolving the broader command registry (where j/k/g/G/Enter/y
    // also have unrelated meanings in other regions).
    if (state.modal.type === "none" && state.focus === "timeline")
      return this.handleTimelineKey(data, state);
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
    if (modal.busy || modal.unavailableReason) return;
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
