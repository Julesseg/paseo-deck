import type { AppState, FocusArea } from "../contracts/app-state.js";
import { activeNotification, pendingPermissions } from "../state/store.js";
import type { UiIntent } from "./controller.js";

/**
 * The sole inventory of user-facing actions.  Views only render this data and
 * DeckController only resolves keys through it; neither keeps a second list of
 * labels, shortcuts, or availability guards.
 */
export interface DeckCommand {
  readonly id: string;
  readonly label: string;
  readonly group: "Sessions" | "Tabs" | "Agent" | "Timeline" | "Application";
  readonly shortcuts: readonly string[];
  /** Navigation remains discoverable in help but does not crowd the palette. */
  readonly palette?: boolean;
  readonly contexts?: readonly CommandContext[];
  readonly disabledReason?: (state: AppState) => string | undefined;
  readonly intent: (state: AppState) => UiIntent;
}

export type CommandContext =
  | FocusArea
  | "permission"
  | "confirm"
  | "notifications"
  | "filter"
  | "rename"
  | "create-agent"
  | "create-terminal"
  | "mode"
  | "thinking"
  | "error-details"
  | "palette"
  | "help";

export interface ResolvedCommand extends Omit<DeckCommand, "disabledReason"> {
  readonly disabledReason?: string;
}

const selectedAgent = (state: AppState): string | undefined => state.selectedAgentId;
const requireAgent = (state: AppState): string | undefined =>
  selectedAgent(state) ? undefined : "Select an active session first";
const requireWorkspace = (state: AppState): string | undefined =>
  state.selectedWorkspaceId &&
  state.directory.workspaces.some(
    (workspace) => workspace.id === state.selectedWorkspaceId && !workspace.archived,
  )
    ? undefined
    : "Select an active workspace first";
const requireConnected = (state: AppState): string | undefined =>
  state.connection === "connected" ? undefined : "Reconnect to Paseo first";
const requireRemoteAgent = (state: AppState): string | undefined =>
  requireConnected(state) ?? requireAgent(state);

export const deckCommands: readonly DeckCommand[] = [
  {
    id: "terminal-create",
    label: "Create named workspace terminal",
    group: "Sessions",
    shortcuts: [],
    contexts: ["tree", "timeline"],
    palette: true,
    disabledReason: (state) => (state.selectedWorkspaceId ? undefined : "Select a workspace first"),
    intent: (state) => ({
      type: "open-create-terminal",
      workspaceId: state.selectedWorkspaceId ?? "",
    }),
  },
  {
    id: "terminal-kill",
    label: "Terminate active terminal (confirm)",
    group: "Sessions",
    shortcuts: ["gk"],
    contexts: ["timeline", "tree"],
    palette: true,
    disabledReason: (state) => (state.activeTerminalId ? undefined : "No active terminal tab"),
    intent: () => ({ type: "kill-terminal" }),
  },
  {
    id: "tab-next",
    label: "Next tab",
    group: "Tabs",
    shortcuts: ["gt"],
    contexts: ["tree", "timeline"],
    palette: true,
    intent: () => ({ type: "switch-tab", direction: 1 }),
  },
  {
    id: "tab-previous",
    label: "Previous tab",
    group: "Tabs",
    shortcuts: ["gT"],
    contexts: ["tree", "timeline"],
    palette: true,
    intent: () => ({ type: "switch-tab", direction: -1 }),
  },
  {
    id: "dialog-cancel",
    label: "Cancel or close dialog",
    group: "Application",
    shortcuts: ["Esc"],
    contexts: [
      "permission",
      "confirm",
      "notifications",
      "filter",
      "rename",
      "create-agent",
      "palette",
      "help",
      "mode",
      "thinking",
      "error-details",
    ],
    palette: false,
    intent: () => ({ type: "close-modal" }),
  },
  {
    id: "palette-filter",
    label: "Type to filter commands",
    group: "Application",
    shortcuts: ["Type"],
    contexts: ["palette"],
    palette: false,
    intent: () => ({ type: "close-modal" }),
  },
  {
    id: "palette-run",
    label: "Run selected command",
    group: "Application",
    shortcuts: ["Enter"],
    contexts: ["palette"],
    palette: false,
    intent: () => ({ type: "close-modal" }),
  },
  {
    id: "text-edit",
    label: "Edit text",
    group: "Application",
    shortcuts: ["Type"],
    contexts: ["filter", "rename", "create-agent"],
    palette: false,
    intent: () => ({ type: "close-modal" }),
  },
  {
    id: "composer-leave",
    label: "Return to composer normal mode",
    group: "Application",
    shortcuts: ["Esc"],
    contexts: ["composer"],
    palette: false,
    intent: () => ({ type: "set-composer-mode", mode: "normal" }),
  },
  {
    id: "scroll-timeline-up",
    label: "Scroll timeline up",
    group: "Timeline",
    shortcuts: ["Ctrl-U"],
    palette: false,
    intent: () => ({ type: "scroll-timeline", direction: -1 }),
  },
  {
    id: "scroll-timeline-down",
    label: "Scroll timeline down",
    group: "Timeline",
    shortcuts: ["Ctrl-D"],
    palette: false,
    intent: () => ({ type: "scroll-timeline", direction: 1 }),
  },
  {
    id: "composer-history-previous",
    label: "Previous prompt draft",
    group: "Application",
    shortcuts: ["Ctrl-P"],
    contexts: ["composer"],
    palette: false,
    intent: () => ({ type: "navigate-composer-history", direction: -1 }),
  },
  {
    id: "composer-history-next",
    label: "Next prompt draft",
    group: "Application",
    shortcuts: ["Ctrl-N"],
    contexts: ["composer"],
    palette: false,
    intent: () => ({ type: "navigate-composer-history", direction: 1 }),
  },
  {
    id: "focus-composer",
    label: "Enter composer insert mode",
    group: "Application",
    shortcuts: ["i"],
    palette: false,
    intent: () => ({ type: "set-composer-mode", mode: "insert" }),
  },
  {
    id: "sidebar-navigation",
    label: "Navigate sidebar",
    group: "Sessions",
    shortcuts: ["n"],
    contexts: ["composer"],
    palette: false,
    intent: () => ({ type: "set-focus", focus: "tree" }),
  },
  {
    id: "timeline-navigation",
    label: "Navigate timeline",
    group: "Timeline",
    shortcuts: ["t"],
    contexts: ["composer"],
    palette: false,
    intent: () => ({ type: "set-focus", focus: "timeline" }),
  },
  {
    id: "open-selection",
    label: "Open or toggle selected session",
    group: "Sessions",
    shortcuts: ["Enter"],
    contexts: ["tree"],
    palette: false,
    intent: () => ({ type: "select-or-open" }),
  },
  {
    id: "toggle-timeline-selection",
    label: "Expand selected timeline item",
    group: "Timeline",
    shortcuts: ["Enter"],
    contexts: ["timeline"],
    palette: false,
    intent: () => ({ type: "toggle-selected-timeline-item" }),
  },
  {
    id: "quit",
    label: "Quit Paseo Deck",
    group: "Application",
    shortcuts: ["q", "Ctrl-C"],
    palette: false,
    intent: () => ({ type: "quit" }),
  },
  {
    id: "permission-allow",
    label: "Allow permission request",
    group: "Agent",
    shortcuts: ["a"],
    contexts: ["permission"],
    palette: false,
    intent: (state) => {
      const modal = state.modal;
      return modal.type === "permission"
        ? {
            type: "respond-permission",
            agentId: modal.agentId,
            requestId: modal.requestId,
            allow: true,
          }
        : { type: "close-modal" };
    },
  },
  {
    id: "permission-deny",
    label: "Deny permission request",
    group: "Agent",
    shortcuts: ["d"],
    contexts: ["permission"],
    palette: false,
    intent: (state) => {
      const modal = state.modal;
      return modal.type === "permission"
        ? {
            type: "respond-permission",
            agentId: modal.agentId,
            requestId: modal.requestId,
            allow: false,
          }
        : { type: "close-modal" };
    },
  },
  {
    id: "permission-previous",
    label: "Previous permission request",
    group: "Agent",
    shortcuts: ["h", "Left"],
    contexts: ["permission"],
    palette: false,
    intent: () => ({ type: "move-permission", direction: -1 }),
  },
  {
    id: "permission-next",
    label: "Next permission request",
    group: "Agent",
    shortcuts: ["l", "Right"],
    contexts: ["permission"],
    palette: false,
    intent: () => ({ type: "move-permission", direction: 1 }),
  },
  {
    id: "permission-retry",
    label: "Retry permission decision",
    group: "Agent",
    shortcuts: ["r"],
    contexts: ["permission"],
    palette: false,
    disabledReason: (state) => {
      const modal = state.modal;
      return modal.type === "permission" && modal.error && modal.lastDecision
        ? undefined
        : "No failed permission decision to retry";
    },
    intent: (state) => {
      const modal = state.modal;
      return modal.type === "permission" && modal.lastDecision
        ? {
            type: "retry-permission",
            agentId: modal.agentId,
            requestId: modal.requestId,
            allow: modal.lastDecision === "allow",
          }
        : { type: "close-modal" };
    },
  },
  {
    id: "confirm-dialog",
    label: "Confirm dialog action",
    group: "Agent",
    shortcuts: ["Enter"],
    contexts: ["confirm", "filter", "rename", "create-agent"],
    palette: false,
    intent: () => ({ type: "select-or-open" }),
  },
  {
    id: "notification-next",
    label: "Next notification",
    group: "Application",
    shortcuts: ["j", "Down"],
    contexts: ["notifications"],
    palette: false,
    intent: () => ({ type: "move-notification", direction: 1 }),
  },
  {
    id: "notification-previous",
    label: "Previous notification",
    group: "Application",
    shortcuts: ["k", "Up"],
    contexts: ["notifications"],
    palette: false,
    intent: () => ({ type: "move-notification", direction: -1 }),
  },
  {
    id: "notification-select",
    label: "Open selected notification",
    group: "Application",
    shortcuts: ["Enter"],
    contexts: ["notifications"],
    palette: false,
    disabledReason: (state) => (activeNotification(state) ? undefined : "No notification selected"),
    intent: (state) => ({
      type: "select-notification",
      id: activeNotification(state)?.id ?? -1,
    }),
  },
  {
    id: "move-previous",
    label: "Move selection up",
    group: "Sessions",
    shortcuts: ["k", "Up"],
    contexts: ["tree"],
    palette: false,
    intent: () => ({ type: "select-next", direction: -1 }),
  },
  {
    id: "move-next",
    label: "Move selection down",
    group: "Sessions",
    shortcuts: ["j", "Down"],
    contexts: ["tree"],
    palette: false,
    intent: () => ({ type: "select-next", direction: 1 }),
  },
  {
    id: "collapse",
    label: "Collapse selected branch",
    group: "Sessions",
    shortcuts: ["h", "Left"],
    contexts: ["tree"],
    palette: false,
    intent: () => ({ type: "collapse-or-expand", direction: -1 }),
  },
  {
    id: "expand",
    label: "Expand selected branch",
    group: "Sessions",
    shortcuts: ["l", "Right"],
    contexts: ["tree"],
    palette: false,
    intent: () => ({ type: "collapse-or-expand", direction: 1 }),
  },
  {
    id: "tree-start",
    label: "Go to first session",
    group: "Sessions",
    shortcuts: ["g"],
    contexts: ["tree"],
    palette: false,
    intent: () => ({ type: "select-boundary", boundary: "start" }),
  },
  {
    id: "tree-end",
    label: "Go to last session",
    group: "Sessions",
    shortcuts: ["G"],
    contexts: ["tree"],
    palette: false,
    intent: () => ({ type: "select-boundary", boundary: "end" }),
  },
  {
    id: "timeline-previous",
    label: "Move timeline selection up",
    group: "Timeline",
    shortcuts: ["k", "Up"],
    contexts: ["timeline"],
    palette: false,
    intent: () => ({ type: "move-timeline-selection", direction: -1 }),
  },
  {
    id: "timeline-next",
    label: "Move timeline selection down",
    group: "Timeline",
    shortcuts: ["j", "Down"],
    contexts: ["timeline"],
    palette: false,
    intent: () => ({ type: "move-timeline-selection", direction: 1 }),
  },
  {
    id: "timeline-start",
    label: "Go to timeline start",
    group: "Timeline",
    shortcuts: ["g"],
    contexts: ["timeline"],
    palette: false,
    intent: () => ({ type: "move-timeline-selection-boundary", boundary: "start" }),
  },
  {
    id: "timeline-end",
    label: "Go to timeline end",
    group: "Timeline",
    shortcuts: ["G"],
    contexts: ["timeline"],
    palette: false,
    intent: () => ({ type: "move-timeline-selection-boundary", boundary: "end" }),
  },
  {
    id: "previous-turn",
    label: "Previous turn boundary",
    group: "Timeline",
    shortcuts: ["["],
    contexts: ["timeline"],
    palette: false,
    intent: () => ({ type: "move-timeline-landmark", direction: -1, kind: "turn" }),
  },
  {
    id: "next-turn",
    label: "Next turn boundary",
    group: "Timeline",
    shortcuts: ["]"],
    contexts: ["timeline"],
    palette: false,
    intent: () => ({ type: "move-timeline-landmark", direction: 1, kind: "turn" }),
  },
  {
    id: "previous-error",
    label: "Previous timeline error",
    group: "Timeline",
    shortcuts: ["{"],
    contexts: ["timeline"],
    palette: false,
    intent: () => ({ type: "move-timeline-landmark", direction: -1, kind: "error" }),
  },
  {
    id: "next-error",
    label: "Next timeline error",
    group: "Timeline",
    shortcuts: ["}"],
    contexts: ["timeline"],
    palette: false,
    intent: () => ({ type: "move-timeline-landmark", direction: 1, kind: "error" }),
  },
  {
    id: "narrow-tree",
    label: "Narrow session tree",
    group: "Sessions",
    shortcuts: ["["],
    contexts: ["tree"],
    palette: false,
    intent: () => ({ type: "adjust-tree-width", delta: -2 }),
  },
  {
    id: "widen-tree",
    label: "Widen session tree",
    group: "Sessions",
    shortcuts: ["]"],
    contexts: ["tree"],
    palette: false,
    intent: () => ({ type: "adjust-tree-width", delta: 2 }),
  },
  {
    id: "command-palette",
    label: "Command palette",
    group: "Application",
    shortcuts: ["Ctrl-K", "Cmd-P"],
    intent: () => ({ type: "open-command-palette" }),
  },
  {
    id: "toggle-theme",
    label: "Toggle theme",
    group: "Application",
    shortcuts: [],
    intent: () => ({ type: "toggle-theme" }),
  },
  {
    id: "toggle-symbol-set",
    label: "Toggle symbol set",
    group: "Application",
    shortcuts: [],
    intent: () => ({ type: "toggle-symbol-set" }),
  },
  {
    id: "help",
    label: "Show contextual help",
    group: "Application",
    shortcuts: ["?"],
    intent: () => ({ type: "open-help" }),
  },
  {
    id: "refresh",
    label: "Refresh directory",
    group: "Application",
    shortcuts: ["r"],
    intent: () => ({ type: "refresh" }),
  },
  {
    id: "notifications",
    label: "Open notification history",
    group: "Application",
    shortcuts: ["N"],
    disabledReason: (state) => (state.notifications.length ? undefined : "No notifications"),
    intent: () => ({ type: "open-notifications" }),
  },
  {
    id: "retry",
    label: "Retry selected failure",
    group: "Application",
    shortcuts: ["R"],
    disabledReason: (state) => {
      const retry = activeNotification(state)?.retry;
      if (!retry) return "No retryable failure selected";
      return retry.type === "operation" ? requireConnected(state) : undefined;
    },
    intent: (state) => ({ type: "retry-notification", id: activeNotification(state)?.id ?? -1 }),
  },
  {
    id: "error-details",
    label: "Show selected error details",
    group: "Application",
    shortcuts: ["E"],
    disabledReason: (state) =>
      activeNotification(state)?.detail ? undefined : "No error details available",
    intent: (state) => {
      const notification = activeNotification(state);
      return {
        type: "open-error-details",
        message: notification?.message ?? "",
        detail: notification?.detail ?? "",
      };
    },
  },
  {
    id: "filter",
    label: "Filter sessions",
    group: "Sessions",
    shortcuts: ["/"],
    intent: () => ({ type: "open-filter" }),
  },
  {
    id: "create-agent",
    label: "Create agent",
    group: "Sessions",
    shortcuts: ["c"],
    contexts: ["tree"],
    disabledReason: (state) => requireConnected(state) ?? requireWorkspace(state),
    intent: (state) => ({
      type: "open-create-agent",
      workspaceId: state.selectedWorkspaceId ?? "",
      step: "provider",
    }),
  },
  {
    id: "permissions",
    label: "Review pending permissions",
    group: "Sessions",
    shortcuts: ["p"],
    disabledReason: (state) =>
      pendingPermissions(state).length ? undefined : "No pending permissions",
    intent: () => ({ type: "open-permissions" }),
  },
  {
    id: "toggle-order",
    label: "Toggle tree ordering",
    group: "Sessions",
    shortcuts: ["o"],
    contexts: ["tree"],
    intent: () => ({ type: "toggle-tree-order" }),
  },
  {
    id: "toggle-archived",
    label: "Toggle archived sessions",
    group: "Sessions",
    shortcuts: ["v"],
    intent: () => ({ type: "toggle-archived" }),
  },
  {
    id: "toggle-attention",
    label: "Toggle needs-attention filter",
    group: "Sessions",
    shortcuts: ["!"],
    intent: () => ({ type: "toggle-attention-only" }),
  },
  {
    id: "stop-agent",
    label: "Stop agent",
    group: "Agent",
    shortcuts: ["x"],
    disabledReason: requireRemoteAgent,
    intent: (state) => ({
      type: "open-confirmation",
      action: "stop",
      agentId: selectedAgent(state) ?? "",
    }),
  },
  {
    id: "archive-agent",
    label: "Archive agent",
    group: "Agent",
    shortcuts: ["A"],
    disabledReason: requireRemoteAgent,
    intent: (state) => ({
      type: "open-confirmation",
      action: "archive",
      agentId: selectedAgent(state) ?? "",
    }),
  },
  {
    id: "detach-agent",
    label: "Detach agent",
    group: "Agent",
    shortcuts: ["d"],
    disabledReason: requireRemoteAgent,
    intent: (state) => ({
      type: "open-confirmation",
      action: "detach",
      agentId: selectedAgent(state) ?? "",
    }),
  },
  {
    id: "rename-agent",
    label: "Rename agent",
    group: "Agent",
    shortcuts: ["e"],
    disabledReason: requireRemoteAgent,
    intent: (state) => ({ type: "open-rename", agentId: selectedAgent(state) ?? "" }),
  },
  {
    id: "model",
    label: "Change model",
    group: "Agent",
    shortcuts: ["m"],
    contexts: ["composer"],
    disabledReason: () => "Live model switching is unavailable for this session",
    intent: () => ({ type: "close-modal" }),
  },
  {
    id: "mode",
    label: "Change operational mode",
    group: "Agent",
    shortcuts: ["m"],
    contexts: ["tree"],
    disabledReason: (state) => {
      const agent = state.directory.agents.find((item) => item.id === selectedAgent(state));
      return (
        requireRemoteAgent(state) ??
        (agent?.availableModeIds.length ? undefined : "No modes available")
      );
    },
    intent: (state) => ({ type: "open-mode", agentId: selectedAgent(state) ?? "" }),
  },
  {
    id: "operational-mode",
    label: "Change operational mode",
    group: "Agent",
    shortcuts: ["o"],
    contexts: ["composer"],
    disabledReason: (state) => {
      const agent = state.directory.agents.find((item) => item.id === selectedAgent(state));
      return (
        requireRemoteAgent(state) ??
        (agent?.availableModeIds.length ? undefined : "No modes available")
      );
    },
    intent: (state) => ({ type: "open-mode", agentId: selectedAgent(state) ?? "" }),
  },
  {
    id: "thinking",
    label: "Change thinking level",
    group: "Agent",
    shortcuts: ["z", "t"],
    disabledReason: (state) => {
      const agent = state.directory.agents.find((item) => item.id === selectedAgent(state));
      return (
        requireRemoteAgent(state) ??
        (agent?.availableThinkingLevels.length ? undefined : "No thinking levels available")
      );
    },
    intent: (state) => ({ type: "open-thinking", agentId: selectedAgent(state) ?? "" }),
  },
  {
    id: "timeline-search",
    label: "Search timeline",
    group: "Timeline",
    shortcuts: ["Ctrl-F"],
    contexts: ["timeline"],
    disabledReason: (state) => (state.timeline.items.length ? undefined : "Timeline is empty"),
    intent: () => ({ type: "open-timeline-search" }),
  },
  {
    id: "timeline-copy",
    label: "Copy selected timeline item",
    group: "Timeline",
    shortcuts: ["y"],
    contexts: ["timeline"],
    disabledReason: (state) => (state.timeline.items.length ? undefined : "Timeline is empty"),
    intent: () => ({ type: "open-timeline-copy" }),
  },
];

export function resolvedCommands(
  state: AppState,
  context: CommandContext = commandContext(state),
): readonly ResolvedCommand[] {
  return deckCommands
    .filter((command) => !command.contexts || command.contexts.includes(context))
    .map((command) => {
      const { disabledReason: availability, ...definition } = command;
      const disabledReason = availability?.(state);
      return { ...definition, ...(disabledReason ? { disabledReason } : {}) };
    });
}

export function commandForKey(state: AppState, data: string): ResolvedCommand | undefined {
  const shortcut = shortcutForInput(data);
  if (!shortcut) return undefined;
  return resolvedCommands(state).find((command) => command.shortcuts.includes(shortcut));
}

export function commandById(state: AppState, id: string): ResolvedCommand | undefined {
  return resolvedCommands(state).find((command) => command.id === id);
}

export function contextualHelp(
  state: AppState,
  context: CommandContext = commandContext(state),
): readonly ResolvedCommand[] {
  return resolvedCommands(state, context);
}

export function commandContext(state: AppState): CommandContext {
  // Help is a view-only overlay over the current pane; it must describe the
  // underlying interaction rather than itself.
  return state.modal.type === "none" || state.modal.type === "help"
    ? state.focus
    : state.modal.type;
}

export function shortcutForInput(data: string): string | undefined {
  if (data === "\u001b") return "Esc";
  if (data === "\u000b") return "Ctrl-K";
  if (data === "\u0006") return "Ctrl-F";
  if (data === "\u001b[A") return "Up";
  if (data === "\u001b[B") return "Down";
  if (data === "\u001b[C") return "Right";
  if (data === "\u001b[D") return "Left";
  if (data === "\r") return "Enter";
  if (data === "\u0003") return "Ctrl-C";
  if (data === "\u0010") return "Ctrl-P";
  if (data === "\u000e") return "Ctrl-N";
  if (data === "\u0015") return "Ctrl-U";
  if (data === "\u0004") return "Ctrl-D";
  // Most terminal emulators encode Cmd-P as ESC+p. Do not consume ordinary p.
  if (data === "\u001bp") return "Cmd-P";
  return data.length === 1 ? data : undefined;
}
