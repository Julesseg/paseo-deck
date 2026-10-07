import type { AppState, FocusArea } from "../contracts/app-state.js";
import { activeSessionDraftWorkspaceId, selectedComposerDraft } from "../state/composer.js";
import { activeLaunchWorkspaceId } from "../state/launch.js";
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
  readonly group: "Workspaces" | "Sessions" | "Tabs" | "Agent" | "Timeline" | "Application";
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
  | "new-tab"
  | "launch-profile"
  | "new-workspace-project"
  | "new-workspace-title"
  | "new-workspace-placement"
  | "new-workspace-base"
  | "session-setting"
  | "draft-setting"
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
export const targetWorkspaceId = (state: AppState): string | undefined =>
  state.focus === "tree"
    ? state.sidebarSelection?.kind === "workspace"
      ? state.sidebarSelection.id
      : undefined
    : state.selectedWorkspaceId;
const requireWorkspace = (state: AppState): string | undefined =>
  targetWorkspaceId(state) &&
  state.directory.workspaces.some(
    (workspace) => workspace.id === targetWorkspaceId(state) && !workspace.archived,
  )
    ? undefined
    : "Select an active workspace first";
const requireConnected = (state: AppState): string | undefined =>
  state.connection === "connected" ? undefined : "Reconnect to Paseo first";
const requireRemoteAgent = (state: AppState): string | undefined =>
  requireConnected(state) ?? requireAgent(state);

const requireNormalBuffer = (state: AppState): string | undefined =>
  !state.activeTerminalId &&
  ((state.focus === "composer" && state.composerMode === "normal") ||
    (state.focus === "timeline" && (state.timelineMode ?? "normal") === "normal"))
    ? undefined
    : "Available in Composer or Timeline Normal only";

export function newTabUnavailableReason(state: AppState): string | undefined {
  if (state.newWorkspace) return "Finish or cancel the New workspace composer first";
  const workspace = requireWorkspace(state);
  if (workspace) return workspace;
  if (state.modal.type !== "none") return "Close the dialog first";
  if (state.focus === "tree") return "Leave sidebar navigation first";
  if (state.focus === "composer" && state.composerMode !== "normal")
    return "Return to normal mode first";
  if (state.focus === "timeline" && state.activeTerminalId)
    return "Use Ctrl-S to leave Terminal input first";
  if (state.focus === "timeline" && !state.activeTerminalId && state.timelineMode === "visual")
    return "Leave visual mode first";
  return undefined;
}

export const deckCommands: readonly DeckCommand[] = [
  {
    id: "composer-submit",
    label: "Send composer text",
    group: "Agent",
    shortcuts: ["\\s"],
    contexts: ["composer"],
    palette: false,
    disabledReason: (state) =>
      selectedComposerDraft(state).trim() &&
      (activeLaunchWorkspaceId(state) ||
        activeSessionDraftWorkspaceId(state) ||
        state.selectedAgentId)
        ? undefined
        : "No prompt to send",
    intent: (state) => {
      const workspaceId = activeSessionDraftWorkspaceId(state);
      const prompt = selectedComposerDraft(state);
      const launchId = activeLaunchWorkspaceId(state);
      if (launchId) return { type: "submit-launch", workspaceId: launchId, prompt };
      return workspaceId
        ? { type: "submit-session-draft", workspaceId, prompt }
        : { type: "submit-composer", agentId: state.selectedAgentId ?? "", prompt };
    },
  },
  {
    id: "new-tab",
    label: "New Tab",
    group: "Tabs",
    shortcuts: ["Ctrl-T"],
    contexts: ["composer", "timeline"],
    palette: true,
    disabledReason: newTabUnavailableReason,
    intent: (state) => ({ type: "open-new-tab", workspaceId: state.selectedWorkspaceId ?? "" }),
  },
  {
    id: "discard-draft",
    label: "Discard session draft",
    group: "Tabs",
    shortcuts: ["gc"],
    contexts: ["composer", "timeline"],
    palette: true,
    disabledReason: (state) =>
      state.selectedWorkspaceId && state.sessionDrafts[state.selectedWorkspaceId]
        ? undefined
        : "No session draft in this workspace",
    intent: (state) => ({
      type: "discard-session-draft",
      workspaceId: state.selectedWorkspaceId ?? "",
    }),
  },
  {
    id: "terminal-create",
    label: "Create named workspace terminal",
    group: "Sessions",
    shortcuts: [],
    contexts: ["tree", "timeline"],
    palette: true,
    disabledReason: requireWorkspace,
    intent: (state) => ({
      type: "open-create-terminal",
      workspaceId: targetWorkspaceId(state) ?? "",
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
    contexts: ["timeline", "composer"],
    palette: true,
    disabledReason: requireNormalBuffer,
    intent: () => ({ type: "switch-tab", direction: 1 }),
  },
  {
    id: "tab-previous",
    label: "Previous tab",
    group: "Tabs",
    shortcuts: ["gT"],
    contexts: ["timeline", "composer"],
    palette: true,
    disabledReason: requireNormalBuffer,
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
      "new-tab",
      "draft-setting",
      "launch-profile",
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
    shortcuts: [],
    contexts: ["composer"],
    palette: false,
    intent: () => ({ type: "navigate-composer-history", direction: -1 }),
  },
  {
    id: "composer-history-next",
    label: "Next prompt draft",
    group: "Application",
    shortcuts: [],
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
    shortcuts: ["Ctrl-S"],
    palette: false,
    intent: () => ({ type: "set-focus", focus: "tree" }),
  },
  {
    id: "timeline-navigation",
    label: "Navigate timeline",
    group: "Timeline",
    shortcuts: ["Ctrl-K"],
    palette: false,
    intent: () => ({ type: "set-focus", focus: "timeline" }),
  },
  {
    id: "open-selection",
    label: "Activate highlighted Workspace",
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
    shortcuts: ["za"],
    contexts: ["timeline"],
    palette: false,
    disabledReason: (state) => (state.timeline.items.length ? undefined : "Timeline is empty"),
    intent: () => ({ type: "timeline-fold" }),
  },
  {
    id: "quit",
    label: "Quit Paseo Deck",
    group: "Application",
    shortcuts: ["Ctrl-C"],
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
      id:
        state.modal.type === "notifications"
          ? (state.modal.noticeId ?? state.notifications[state.modal.index]?.id ?? -1)
          : -1,
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
    label: "Go to first Sidebar row",
    group: "Sessions",
    shortcuts: ["gg"],
    contexts: ["tree"],
    palette: false,
    intent: () => ({ type: "select-boundary", boundary: "start" }),
  },
  {
    id: "tree-end",
    label: "Go to last Sidebar row",
    group: "Sessions",
    shortcuts: ["G"],
    contexts: ["tree"],
    palette: false,
    intent: () => ({ type: "select-boundary", boundary: "end" }),
  },
  {
    id: "timeline-previous",
    label: "Move timeline cursor up",
    group: "Timeline",
    shortcuts: ["k", "Up"],
    contexts: ["timeline"],
    palette: false,
    disabledReason: (state) => (state.timeline.items.length ? undefined : "Timeline is empty"),
    intent: () => ({ type: "move-timeline-text", key: "k" }),
  },
  {
    id: "timeline-next",
    label: "Move timeline cursor down",
    group: "Timeline",
    shortcuts: ["j", "Down"],
    contexts: ["timeline"],
    palette: false,
    disabledReason: (state) => (state.timeline.items.length ? undefined : "Timeline is empty"),
    intent: () => ({ type: "move-timeline-text", key: "j" }),
  },
  {
    id: "timeline-start",
    label: "Go to timeline start",
    group: "Timeline",
    shortcuts: ["gg"],
    contexts: ["timeline"],
    palette: false,
    disabledReason: (state) => (state.timeline.items.length ? undefined : "Timeline is empty"),
    intent: () => ({ type: "move-timeline-text", key: "gg" }),
  },
  {
    id: "timeline-end",
    label: "Go to timeline end",
    group: "Timeline",
    shortcuts: ["G"],
    contexts: ["timeline"],
    palette: false,
    disabledReason: (state) => (state.timeline.items.length ? undefined : "Timeline is empty"),
    intent: () => ({ type: "move-timeline-text", key: "G" }),
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
    label: "Narrow Sidebar",
    group: "Sessions",
    shortcuts: ["["],
    contexts: ["tree"],
    palette: false,
    intent: () => ({ type: "adjust-tree-width", delta: -2 }),
  },
  {
    id: "widen-tree",
    label: "Widen Sidebar",
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
    shortcuts: ["Ctrl-P"],
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
    id: "help",
    label: "Show contextual help",
    group: "Application",
    shortcuts: ["g?"],
    intent: () => ({ type: "open-help" }),
  },
  {
    id: "refresh",
    label: "Refresh directory",
    group: "Application",
    shortcuts: [],
    intent: () => ({ type: "refresh" }),
  },
  {
    id: "notifications",
    label: "Open notification history",
    group: "Application",
    shortcuts: [],
    disabledReason: (state) => (state.notifications.length ? undefined : "No notifications"),
    intent: () => ({ type: "open-notifications" }),
  },
  {
    id: "retry",
    label: "Retry selected failure",
    group: "Application",
    shortcuts: [],
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
    shortcuts: [],
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
    label: "Filter Project/Workspace names",
    group: "Sessions",
    shortcuts: ["/"],
    intent: () => ({ type: "open-filter" }),
  },
  {
    id: "new-workspace",
    label: "New workspace",
    group: "Workspaces",
    shortcuts: ["c"],
    contexts: ["tree"],
    disabledReason: (state) =>
      state.newWorkspace ? "Finish or cancel the New workspace composer first" : undefined,
    intent: () => ({ type: "open-new-workspace" }),
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
    label: "Show/hide archived Workspaces",
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
    contexts: ["composer", "timeline"],
    disabledReason: (state) => requireNormalBuffer(state) ?? requireRemoteAgent(state),
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
    contexts: ["composer", "timeline"],
    disabledReason: (state) => requireNormalBuffer(state) ?? requireRemoteAgent(state),
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
    id: "provider",
    label: "Change provider",
    group: "Sessions",
    shortcuts: ["mp"],
    contexts: ["composer", "timeline"],
    disabledReason: (state) =>
      !(activeSessionDraftWorkspaceId(state) || activeLaunchWorkspaceId(state))
        ? "Only Session drafts can change provider"
        : (state.focus === "composer" && state.composerMode !== "normal") ||
            (state.focus === "timeline" && state.timelineMode !== "normal")
          ? "Return to Normal mode first"
          : undefined,
    intent: () => ({ type: "open-session-setting", setting: "provider" }),
  },
  ...(
    [
      ["model", "model", "Change model", "mm"],
      ["operational-mode", "mode", "Change operational mode", "mo"],
      ["thinking", "thinking", "Change thinking level", "mt"],
    ] as const
  ).map(
    ([id, setting, label, shortcut]): DeckCommand => ({
      id,
      label,
      group: "Sessions",
      shortcuts: [shortcut],
      contexts: ["composer", "timeline"],
      disabledReason: (state) =>
        (state.focus === "composer" && state.composerMode !== "normal") ||
        (state.focus === "timeline" && state.timelineMode !== "normal")
          ? "Return to Normal mode first"
          : state.activeTerminalId
            ? "Select a Session"
            : undefined,
      intent: () => ({ type: "open-session-setting", setting }),
    }),
  ),
  {
    id: "timeline-search",
    label: "Search timeline",
    group: "Timeline",
    shortcuts: ["/"],
    contexts: ["timeline"],
    disabledReason: (state) => (state.timeline.items.length ? undefined : "Timeline is empty"),
    intent: () => ({ type: "open-timeline-search", direction: 1 }),
  },
  {
    id: "timeline-search-backward",
    label: "Search timeline backward",
    group: "Timeline",
    shortcuts: ["?"],
    contexts: ["timeline"],
    disabledReason: (state) => (state.timeline.items.length ? undefined : "Timeline is empty"),
    intent: () => ({ type: "open-timeline-search", direction: -1 }),
  },
  {
    id: "timeline-yank-line",
    label: "Yank line at cursor",
    group: "Timeline",
    shortcuts: ["Y", "yy"],
    contexts: ["timeline"],
    disabledReason: (state) => (state.timeline.items.length ? undefined : "Timeline is empty"),
    intent: () => ({ type: "timeline-yank-object", object: "line" }),
  },
  {
    id: "timeline-open-link",
    label: "Open link at cursor",
    group: "Timeline",
    shortcuts: ["gx"],
    contexts: ["timeline"],
    palette: false,
    intent: () => ({ type: "timeline-open-link" }),
  },
];

// A buffer owns Vim's unmodified keys. Application actions in the composer
// and timeline use one mnemonic backslash prefix, including disabled actions
// so help and the palette show the same binding as input dispatch.
const bufferShortcuts: Readonly<Record<string, readonly string[]>> = {
  "timeline-search": ["/"],
  quit: ["Ctrl-C"],
  "sidebar-navigation": ["Ctrl-S"],
  "timeline-navigation": ["Ctrl-K"],
  help: ["g?"],
  "new-tab": ["Ctrl-T"],
  "discard-draft": [],
  "terminal-kill": [],
  "tab-next": ["gt"],
  "tab-previous": ["gT"],
  "focus-composer": [],
  "composer-history-previous": [],
  "composer-history-next": [],
  refresh: [],
  notifications: [],
  retry: [],
  "error-details": [],
  filter: [],
  permissions: [],
  "toggle-archived": [],
  "toggle-attention": [],
  "stop-agent": ["Ctrl-X"],
  "archive-agent": ["Ctrl-A"],
  "detach-agent": [],
  "rename-agent": [],
  model: ["mm"],
  "operational-mode": ["mo"],
  thinking: ["mt"],
  "scroll-timeline-up": [],
  "scroll-timeline-down": [],
  "previous-turn": ["[t"],
  "next-turn": ["]t"],
  "previous-error": ["[e"],
  "next-error": ["]e"],
};

export function resolvedCommands(
  state: AppState,
  context: CommandContext = commandContext(state),
): readonly ResolvedCommand[] {
  return deckCommands
    .filter(
      (command) =>
        context !== "tree" ||
        ![
          "stop-agent",
          "archive-agent",
          "detach-agent",
          "rename-agent",
          "model",
          "mode",
          "operational-mode",
          "thinking",
        ].includes(command.id),
    )
    .filter((command) => !command.contexts || command.contexts.includes(context))
    .map((command) => {
      const { disabledReason: availability, ...definition } = command;
      const disabledReason = availability?.(state);
      const buffer =
        (context === "timeline" && !state.activeTerminalId) ||
        (context === "composer" && state.composerMode !== "insert");
      let shortcuts = buffer
        ? (bufferShortcuts[command.id] ?? command.shortcuts)
        : command.shortcuts;
      if (
        ["new-tab", "tab-next", "tab-previous", "stop-agent", "archive-agent"].includes(
          command.id,
        ) &&
        !(
          (context === "composer" && state.composerMode === "normal") ||
          (context === "timeline" &&
            !state.activeTerminalId &&
            (state.timelineMode ?? "normal") === "normal")
        )
      )
        shortcuts = [];
      if (
        context === "tree" &&
        ["refresh", "notifications", "retry", "error-details", "terminal-kill"].includes(command.id)
      )
        shortcuts = [];
      if (context === "notifications" && command.id === "retry") shortcuts = ["r"];
      return { ...definition, shortcuts, ...(disabledReason ? { disabledReason } : {}) };
    });
}

export function commandForKey(state: AppState, data: string): ResolvedCommand | undefined {
  const shortcut = data.startsWith("\\") && data.length === 2 ? data : shortcutForInput(data);
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
  const commands = resolvedCommands(state, context);
  if (context === "timeline" && state.activeTerminalId)
    return commands
      .filter((command) => ["sidebar-navigation", "tab-next", "tab-previous"].includes(command.id))
      .map(({ disabledReason: _disabledReason, ...command }) => ({
        ...command,
        shortcuts:
          command.id === "tab-next"
            ? ["Ctrl-Tab"]
            : command.id === "tab-previous"
              ? ["Ctrl-Shift-Tab"]
              : ["Ctrl-S"],
      }));
  return commands;
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
  if (data === "\u0013") return "Ctrl-S";
  if (data === "\u0014") return "Ctrl-T";
  if (data === "\u0018") return "Ctrl-X";
  if (data === "\u0001") return "Ctrl-A";
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

  return data.length === 1 ? data : undefined;
}
