import type {
  AppState,
  FocusArea,
  ModalState,
  TimelineNavigationState,
  TreeOrder,
} from "../contracts/app-state.js";
import { emptyDirectory } from "../contracts/app-state.js";
import type {
  AgentRecord,
  ConnectionState,
  DirectorySnapshot,
  DirectoryUpdate,
  PermissionRequest,
  TimelineCursor,
  TimelineEvent,
  TimelineItem,
  TimelineUpdate,
} from "../contracts/domain.js";
import { createComposerState } from "./composer.js";

export type AppAction =
  | { type: "directory"; update: DirectoryUpdate }
  | { type: "select-agent"; agentId?: string }
  | { type: "select-workspace"; workspaceId?: string }
  | { type: "select-project"; projectId?: string }
  | { type: "set-filter"; filter: string }
  | { type: "set-tree-order"; order: TreeOrder }
  | { type: "toggle-archived" }
  | { type: "toggle-attention-only" }
  | { type: "set-focus"; focus: FocusArea }
  | { type: "set-composer"; text: string }
  | { type: "navigate-composer-history"; direction: -1 | 1 }
  | { type: "set-composer-sending"; agentId: string; sending: boolean }
  | { type: "composer-sent"; agentId: string; prompt: string }
  | { type: "composer-detached"; agentId: string }
  | {
      type: "set-creation-default";
      workspaceId: string;
      value: AppState["creationDefaults"][string];
    }
  | { type: "open-modal"; modal: Exclude<ModalState, { type: "none" }> }
  | { type: "close-modal" }
  | { type: "toggle-expanded"; id: string }
  | { type: "reveal-workspace"; workspaceId: string }
  | {
      type: "set-timeline-navigation";
      agentId: string;
      following: boolean;
      anchor?: TimelineCursor;
    }
  | { type: "timeline"; update: TimelineUpdate }
  | { type: "permission-submitting"; agentId: string; requestId: string; allow: "allow" | "deny" }
  | { type: "permission-failed"; agentId: string; requestId: string; error: string }
  | { type: "permission-resolved"; agentId: string; requestId: string; allow?: boolean }
  | { type: "notify"; message: string; detail?: string; kind?: "info" | "error" }
  | { type: "clear-notification" };

const consumedCursors = Symbol("paseo-deck.consumed-cursors");
const MAX_CONSUMED_CURSORS = 4_096;

type InternalTimelineState = AppState["timeline"] & {
  [consumedCursors]?: ReadonlySet<string>;
};

export function createInitialState(): AppState {
  return {
    connection: "disconnected",
    directory: emptyDirectory(),
    expandedIds: new Set(),
    filter: "",
    treeOrder: "attention",
    showArchived: false,
    attentionOnly: false,
    focus: "tree",
    modal: { type: "none" },
    timeline: { items: [], loading: false, recoveryRevision: 0 },
    timelineNavigation: {},
    composer: createComposerState(),
    creationDefaults: {},
  };
}

function replaceById<T extends { id: string }>(items: readonly T[], item: T): readonly T[] {
  const index = items.findIndex((current) => current.id === item.id);
  return index === -1
    ? [...items, item]
    : items.map((current, at) => (at === index ? item : current));
}

function directoryUpdate(directory: DirectorySnapshot, update: DirectoryUpdate): DirectorySnapshot {
  switch (update.type) {
    case "snapshot":
      return update.snapshot;
    case "project-upserted":
      return { ...directory, projects: replaceById(directory.projects, update.project) };
    case "project-removed":
      return {
        ...directory,
        projects: directory.projects.filter((project) => project.id !== update.projectId),
      };
    case "workspace-upserted":
      return { ...directory, workspaces: replaceById(directory.workspaces, update.workspace) };
    case "workspace-removed":
      return {
        ...directory,
        workspaces: directory.workspaces.filter((workspace) => workspace.id !== update.workspaceId),
        agents: directory.agents.filter((agent) => agent.workspaceId !== update.workspaceId),
      };
    case "agent-upserted":
      return { ...directory, agents: replaceById(directory.agents, update.agent) };
    case "agent-removed":
      return {
        ...directory,
        agents: directory.agents.filter((agent) => agent.id !== update.agentId),
      };
    case "providers-replaced":
      return { ...directory, providers: update.providers };
    case "connection-changed":
      return directory;
  }
}

function reconcileSelection(state: AppState, directory: DirectorySnapshot): AppState {
  const selectedAgent = directory.agents.find((agent) => agent.id === state.selectedAgentId);
  const selectedWorkspace = directory.workspaces.find(
    (workspace) => workspace.id === state.selectedWorkspaceId,
  );
  const selectedProject = directory.projects.find(
    (project) => project.id === state.selectedProjectId,
  );
  const next: AppState = {
    ...state,
    directory,
    timeline: selectedAgent ? state.timeline : { items: [], loading: false, recoveryRevision: 0 },
  };
  if (selectedAgent) next.selectedAgentId = selectedAgent.id;
  else delete next.selectedAgentId;
  if (selectedWorkspace) next.selectedWorkspaceId = selectedWorkspace.id;
  else delete next.selectedWorkspaceId;
  if (selectedProject) next.selectedProjectId = selectedProject.id;
  else delete next.selectedProjectId;

  // Directory delivery is eventually consistent. Keep an existing selection by
  // stable ID, and when that ID truly disappears choose the next surviving row
  // from the prior sibling order rather than jumping to an arbitrary snapshot row.
  if (!selectedWorkspace && state.selectedWorkspaceId) {
    const removed = state.directory.workspaces.find(
      (item) => item.id === state.selectedWorkspaceId,
    );
    const fallback = nearby(
      state.directory.workspaces,
      directory.workspaces,
      state.selectedWorkspaceId,
      (item) => item.projectId === removed?.projectId,
    );
    if (fallback) next.selectedWorkspaceId = fallback.id;
  }
  if (!selectedAgent && state.selectedAgentId) {
    const removed = state.directory.agents.find((item) => item.id === state.selectedAgentId);
    const fallback = nearby(
      state.directory.agents,
      directory.agents,
      state.selectedAgentId,
      (item) => item.workspaceId === removed?.workspaceId,
    );
    if (fallback) {
      next.selectedAgentId = fallback.id;
      next.selectedWorkspaceId = fallback.workspaceId;
    }
  }
  if (!selectedProject && state.selectedProjectId) {
    const fallback = nearby(
      state.directory.projects,
      directory.projects,
      state.selectedProjectId,
      () => true,
    );
    if (fallback) next.selectedProjectId = fallback.id;
  }
  return next;
}

function nearby<T extends { id: string }>(
  previous: readonly T[],
  current: readonly T[],
  removedId: string,
  matches: (item: T) => boolean,
): T | undefined {
  const candidates = previous.filter(matches);
  const start = Math.max(
    0,
    candidates.findIndex((item) => item.id === removedId),
  );
  for (const candidate of [
    ...candidates.slice(start + 1),
    ...candidates.slice(0, start).reverse(),
  ]) {
    const replacement = current.find((item) => item.id === candidate.id);
    if (replacement) return replacement;
  }
  // A snapshot may have no overlap with the prior list; its first sibling is still deterministic.
  return current.find(matches);
}

function revealWorkspaceIds(state: AppState, workspaceId: string): ReadonlySet<string> {
  const workspace = state.directory.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return state.expandedIds;
  const expandedIds = new Set(state.expandedIds);
  expandedIds.add(workspace.id);
  if (workspace.projectId) expandedIds.add(workspace.projectId);
  return expandedIds;
}

function eventKey(event: TimelineEvent): string {
  return `${event.epoch}:${event.sequence}`;
}

function mergeText(current: string, incoming: string): string {
  if (!current || incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming) || current === incoming) return current;
  return current + incoming;
}

function mergeItem(current: TimelineItem, incoming: TimelineItem): TimelineItem | undefined {
  if (
    current.type === "assistant-message" &&
    incoming.type === "assistant-message" &&
    current.messageId === incoming.messageId
  ) {
    return {
      ...current,
      ...incoming,
      text: mergeText(current.text, incoming.text),
      ...(incoming.streaming === undefined && current.streaming !== undefined
        ? { streaming: current.streaming }
        : {}),
    };
  }
  if (current.type === "tool" && incoming.type === "tool" && current.callId === incoming.callId) {
    const output = incoming.output ?? current.output;
    const summary = incoming.summary ?? current.summary;
    return {
      ...current,
      ...incoming,
      ...(output !== undefined ? { output } : {}),
      ...(summary !== undefined ? { summary } : {}),
    };
  }
  if (current.type === "turn" && incoming.type === "turn" && current.id === incoming.id) {
    const startedAt = current.startedAt ?? incoming.startedAt;
    const completedAt = incoming.completedAt ?? current.completedAt;
    const durationMs =
      durationBetween(startedAt, completedAt) ?? incoming.durationMs ?? current.durationMs;
    return {
      ...current,
      ...incoming,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(incoming.detail === undefined && current.detail !== undefined
        ? { detail: current.detail }
        : {}),
    };
  }
  return undefined;
}

function durationBetween(
  startedAt: string | undefined,
  completedAt: string | undefined,
): number | undefined {
  if (startedAt === undefined || completedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isNaN(start) || Number.isNaN(end) || end < start ? undefined : end - start;
}

function appendTimeline(
  items: readonly TimelineEvent[],
  event: TimelineEvent,
  consumed: ReadonlySet<string>,
): readonly TimelineEvent[] {
  if (consumed.has(eventKey(event))) return items;
  const cleared = terminalTurn(event.item)
    ? items.map((current) =>
        current.item.type === "assistant-message" && current.item.turnId === event.item.id
          ? { ...current, item: { ...current.item, streaming: false } }
          : current,
      )
    : items;
  const associated = associateAssistant(cleared, event);
  const mergeAt = cleared.findIndex(
    (current) => mergeItem(current.item, associated.item) !== undefined,
  );
  if (mergeAt !== -1) {
    const current = cleared.at(mergeAt);
    const merged = current ? mergeItem(current.item, associated.item) : undefined;
    if (current && merged) {
      return cleared.map((item, index) =>
        index === mergeAt ? { ...current, item: merged } : item,
      );
    }
  }
  return [...cleared, associated].sort(
    (left, right) => left.epoch.localeCompare(right.epoch) || left.sequence - right.sequence,
  );
}

function terminalTurn(item: TimelineItem): item is Extract<TimelineItem, { type: "turn" }> {
  return item.type === "turn" && item.status !== "started";
}

function associateAssistant(items: readonly TimelineEvent[], event: TimelineEvent): TimelineEvent {
  if (event.item.type !== "assistant-message") return event;
  const open = [...items]
    .reverse()
    .find((candidate) => candidate.item.type === "turn" && candidate.item.status === "started");
  if (open?.item.type !== "turn") return event;
  return { ...event, item: { ...event.item, turnId: open.item.id, streaming: true } };
}

function consumedOf(timeline: AppState["timeline"]): ReadonlySet<string> {
  return (timeline as InternalTimelineState)[consumedCursors] ?? new Set();
}

function consume(
  cursors: ReadonlySet<string>,
  events: readonly TimelineEvent[],
): ReadonlySet<string> {
  const next = new Set(cursors);
  for (const event of events) next.add(eventKey(event));
  while (next.size > MAX_CONSUMED_CURSORS) {
    const oldest = next.values().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

function appendEvents(
  items: readonly TimelineEvent[],
  events: readonly TimelineEvent[],
  consumed: ReadonlySet<string>,
): { items: readonly TimelineEvent[]; consumed: ReadonlySet<string> } {
  let nextItems = items;
  let nextConsumed = consumed;
  for (const event of events) {
    nextItems = appendTimeline(nextItems, event, nextConsumed);
    nextConsumed = consume(nextConsumed, [event]);
  }
  return { items: nextItems, consumed: nextConsumed };
}

function advanceCursor(
  current: TimelineCursor | undefined,
  events: readonly TimelineEvent[],
  reported?: TimelineCursor,
): TimelineCursor | undefined {
  let cursor = current;
  const consider = (candidate: TimelineCursor): void => {
    if (cursor === undefined || cursor.epoch !== candidate.epoch) {
      cursor = candidate;
      return;
    }
    if (candidate.sequence > cursor.sequence) cursor = candidate;
  };
  for (const event of events) consider({ epoch: event.epoch, sequence: event.sequence });
  if (reported !== undefined) consider(reported);
  return cursor;
}

type TimelineChanges = {
  agentId?: string | undefined;
  epoch?: string | undefined;
  cursor?: AppState["timeline"]["cursor"] | undefined;
  items?: AppState["timeline"]["items"];
  usage?: AppState["timeline"]["usage"] | undefined;
  loading?: boolean;
  error?: string | undefined;
  recoveryRevision?: number;
};

function timelineWith<T extends AppState["timeline"]>(
  base: T,
  changes: TimelineChanges,
  consumed = consumedOf(base),
): AppState["timeline"] {
  const next = { ...base, ...changes } as AppState["timeline"];
  if (next.cursor === undefined) delete next.cursor;
  if (next.error === undefined) delete next.error;
  if (next.epoch === undefined) delete next.epoch;
  if (next.usage === undefined) delete next.usage;
  if (next.agentId === undefined) delete next.agentId;
  Object.defineProperty(next, consumedCursors, { value: consumed, enumerable: false });
  return next;
}

function focusMatches(state: AppState, agentId: string): boolean {
  return state.selectedAgentId === agentId && state.timeline.agentId === agentId;
}

function timelineNavigation(state: AppState, agentId: string): TimelineNavigationState {
  return state.timelineNavigation[agentId] ?? { following: true, unread: 0 };
}

function withUnreadForNewEntries(
  state: AppState,
  agentId: string,
  before: readonly TimelineEvent[],
  after: readonly TimelineEvent[],
): AppState {
  const navigation = timelineNavigation(state, agentId);
  const known = new Set(before.map(timelineIdentity));
  const unread = after.reduce(
    (total, event) => total + (known.has(timelineIdentity(event)) ? 0 : 1),
    0,
  );
  if (navigation.following || unread === 0) return state;
  return {
    ...state,
    timelineNavigation: {
      ...state.timelineNavigation,
      [agentId]: { ...navigation, unread: navigation.unread + unread },
    },
  };
}

function timelineIdentity(event: TimelineEvent): string {
  const item = event.item;
  if (item.type === "assistant-message") return `assistant:${item.messageId}`;
  if (item.type === "tool") return `tool:${item.callId}`;
  return `${item.type}:${item.id}`;
}

function applyTimeline(state: AppState, update: TimelineUpdate): AppState {
  if (update.type === "hydrated") {
    if (state.selectedAgentId !== update.agentId) return state;
    const appended = appendEvents(state.timeline.items, update.items, consumedOf(state.timeline));
    const cursor = advanceCursor(state.timeline.cursor, update.items, update.cursor);
    return withUnreadForNewEntries(
      {
        ...state,
        timeline: timelineWith(
          state.timeline,
          {
            agentId: update.agentId,
            items: appended.items,
            ...(cursor === undefined ? {} : { cursor, epoch: cursor.epoch }),
            loading: false,
            error: undefined,
          },
          appended.consumed,
        ),
      },
      update.agentId,
      state.timeline.items,
      appended.items,
    );
  }
  if (update.type === "replaced") {
    if (state.selectedAgentId !== update.agentId) return state;
    const appended = appendEvents([], update.items, new Set());
    const cursor = advanceCursor(undefined, update.items, update.cursor);
    return withUnreadForNewEntries(
      {
        ...state,
        timeline: timelineWith(
          state.timeline,
          {
            agentId: update.agentId,
            epoch: update.epoch,
            items: appended.items,
            ...(cursor === undefined ? {} : { cursor }),
            loading: false,
            recoveryRevision: state.timeline.recoveryRevision + 1,
            error: undefined,
          },
          appended.consumed,
        ),
      },
      update.agentId,
      state.timeline.items,
      appended.items,
    );
  }
  if (update.type === "event" || update.type === "restored") {
    if (update.type === "event" && !focusMatches(state, update.agentId)) return state;
    if (update.type === "restored" && state.selectedAgentId !== update.agentId) return state;
    const additions = update.type === "event" ? [update.event] : update.missed;
    const appended = appendEvents(state.timeline.items, additions, consumedOf(state.timeline));
    const cursor = advanceCursor(state.timeline.cursor, additions);
    return withUnreadForNewEntries(
      {
        ...state,
        timeline: timelineWith(
          state.timeline,
          {
            agentId: update.agentId,
            items: appended.items,
            ...(cursor === undefined ? {} : { cursor, epoch: cursor.epoch }),
            loading: false,
            ...(update.type === "restored"
              ? { recoveryRevision: state.timeline.recoveryRevision + 1 }
              : {}),
          },
          appended.consumed,
        ),
      },
      update.agentId,
      state.timeline.items,
      appended.items,
    );
  }
  if (update.type === "usage") {
    if (!focusMatches(state, update.agentId)) return state;
    return { ...state, timeline: timelineWith(state.timeline, { usage: update.usage }) };
  }
  if (update.type === "error" && focusMatches(state, update.agentId)) {
    return {
      ...state,
      timeline: timelineWith(state.timeline, { error: update.message, loading: false }),
      notification: {
        kind: "error",
        message: update.message,
        ...(update.detail ? { detail: update.detail } : {}),
      },
    };
  }
  return state;
}

function resolvePermission(agent: AgentRecord, requestId: string): AgentRecord {
  return {
    ...agent,
    pendingPermissions: agent.pendingPermissions.filter((request) => request.id !== requestId),
  };
}

function permissionKey(agentId: string, requestId: string): string {
  return `${agentId}\u0000${requestId}`;
}

function resolveTimelinePermission(
  items: readonly TimelineEvent[],
  requestId: string,
): readonly TimelineEvent[] {
  return items.map((event) => {
    if (event.item.type !== "permission" || event.item.request.id !== requestId) return event;
    return { ...event, item: { ...event.item, resolved: true } };
  });
}

function permissionModalAfterResolution(
  state: AppState,
  directory: DirectorySnapshot,
  resolvedAgentId: string,
  resolvedRequestId: string,
): AppState["modal"] {
  if (
    state.modal.type !== "permission" ||
    state.modal.agentId !== resolvedAgentId ||
    state.modal.requestId !== resolvedRequestId
  )
    return state.modal;
  const queue = pendingPermissions({ ...state, directory });
  if (queue.length === 0) return { type: "none" };
  const index = Math.min(state.modal.queueIndex ?? 0, queue.length - 1);
  const request = queue[index];
  if (!request) return { type: "none" };
  return {
    type: "permission",
    agentId: request.agentId,
    requestId: request.id,
    queueIndex: index,
    submitting: false,
  };
}

function reconcilePermissionRemovals(state: AppState, directory: DirectorySnapshot): AppState {
  const previous = pendingPermissions(state);
  const current = new Set(
    pendingPermissions({ ...state, directory }).map((request) =>
      permissionKey(request.agentId, request.id),
    ),
  );
  const removed = previous.filter(
    (request) => !current.has(permissionKey(request.agentId, request.id)),
  );
  if (removed.length === 0) return { ...state, directory };
  let next: AppState = { ...state, directory };
  for (const request of removed) {
    const timeline =
      next.timeline.agentId === request.agentId
        ? timelineWith(next.timeline, {
            items: resolveTimelinePermission(next.timeline.items, request.id),
          })
        : next.timeline;
    next = {
      ...next,
      timeline,
      modal: permissionModalAfterResolution(next, next.directory, request.agentId, request.id),
    };
  }
  return next;
}

export function reduceApp(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "directory": {
      const directory = directoryUpdate(state.directory, action.update);
      const connection: ConnectionState =
        action.update.type === "connection-changed" ? action.update.state : state.connection;
      const selected = reconcileSelection(state, directory);
      const permissionsReconciled = reconcilePermissionRemovals(state, directory);
      return {
        ...selected,
        modal: permissionsReconciled.modal,
        timeline:
          selected.timeline.agentId === permissionsReconciled.timeline.agentId
            ? permissionsReconciled.timeline
            : selected.timeline,
        connection,
      };
    }
    case "select-agent": {
      const agent = state.directory.agents.find((candidate) => candidate.id === action.agentId);
      const agentId = action.agentId?.trim();
      const next: AppState = {
        ...state,
        timeline: agentId
          ? { agentId, items: [], loading: true, recoveryRevision: 0 }
          : { items: [], loading: false, recoveryRevision: 0 },
        focus: "timeline",
      };
      if (agentId) next.selectedAgentId = agent?.id ?? agentId;
      else delete next.selectedAgentId;
      if (agent?.workspaceId) {
        next.selectedWorkspaceId = agent.workspaceId;
        next.expandedIds = revealWorkspaceIds(state, agent.workspaceId);
      }
      return next;
    }
    case "select-workspace": {
      const workspace = state.directory.workspaces.find(
        (candidate) => candidate.id === action.workspaceId,
      );
      const project = state.directory.projects.find(
        (candidate) => candidate.id === workspace?.projectId,
      );
      const next: AppState = {
        ...state,
        timeline: { items: [], loading: false, recoveryRevision: 0 },
        focus: "tree",
      };
      if (action.workspaceId) next.selectedWorkspaceId = action.workspaceId;
      else delete next.selectedWorkspaceId;
      if (project) next.selectedProjectId = project.id;
      else delete next.selectedProjectId;
      delete next.selectedAgentId;
      return next;
    }
    case "select-project": {
      const next: AppState = {
        ...state,
        timeline: { items: [], loading: false, recoveryRevision: 0 },
        focus: "tree",
      };
      if (action.projectId) next.selectedProjectId = action.projectId;
      else delete next.selectedProjectId;
      delete next.selectedWorkspaceId;
      delete next.selectedAgentId;
      return next;
    }
    case "set-filter":
      return { ...state, filter: action.filter };
    case "set-tree-order":
      return { ...state, treeOrder: action.order };
    case "toggle-archived":
      return { ...state, showArchived: !state.showArchived };
    case "toggle-attention-only":
      return { ...state, attentionOnly: !state.attentionOnly };
    case "set-focus":
      return { ...state, focus: action.focus };
    case "set-composer": {
      const agentId = state.selectedAgentId;
      if (!agentId) return state;
      const historyIndexes = { ...state.composer.historyIndexes };
      const historyDrafts = { ...state.composer.historyDrafts };
      delete historyIndexes[agentId];
      delete historyDrafts[agentId];
      return {
        ...state,
        composer: {
          ...state.composer,
          drafts: { ...state.composer.drafts, [agentId]: action.text },
          historyIndexes,
          historyDrafts,
        },
      };
    }
    case "navigate-composer-history": {
      const agentId = state.selectedAgentId;
      if (!agentId) return state;
      const history = state.composer.histories[agentId] ?? [];
      if (history.length === 0) return state;
      const current = state.composer.historyIndexes[agentId] ?? -1;
      const index = Math.max(-1, Math.min(history.length - 1, (current ?? -1) - action.direction));
      const historyDrafts = { ...state.composer.historyDrafts };
      if (current === -1 && index !== -1)
        historyDrafts[agentId] = state.composer.drafts[agentId] ?? "";
      const text = index === -1 ? (historyDrafts[agentId] ?? "") : (history[index] ?? "");
      if (index === -1) delete historyDrafts[agentId];
      return {
        ...state,
        composer: {
          ...state.composer,
          drafts: { ...state.composer.drafts, [agentId]: text },
          historyIndexes: { ...state.composer.historyIndexes, [agentId]: index },
          historyDrafts,
        },
      };
    }
    case "set-composer-sending": {
      const sendingAgentIds = new Set(state.composer.sendingAgentIds);
      if (action.sending) sendingAgentIds.add(action.agentId);
      else sendingAgentIds.delete(action.agentId);
      return { ...state, composer: { ...state.composer, sendingAgentIds } };
    }
    case "composer-sent": {
      const previousComposer = state.composer;
      const history = previousComposer.histories[action.agentId] ?? [];
      const histories = {
        ...previousComposer.histories,
        [action.agentId]: history[0] === action.prompt ? history : [action.prompt, ...history],
      };
      const drafts = { ...previousComposer.drafts };
      if (drafts[action.agentId] === action.prompt) drafts[action.agentId] = "";
      const sendingAgentIds = new Set(previousComposer.sendingAgentIds);
      sendingAgentIds.delete(action.agentId);
      const historyIndexes = { ...previousComposer.historyIndexes };
      delete historyIndexes[action.agentId];
      const historyDrafts = { ...previousComposer.historyDrafts };
      delete historyDrafts[action.agentId];
      const composer = {
        ...previousComposer,
        drafts,
        histories,
        sendingAgentIds,
        historyIndexes,
        historyDrafts,
      };
      return {
        ...state,
        composer,
      };
    }
    case "composer-detached": {
      const detachedAgentIds = new Set(state.composer.detachedAgentIds);
      detachedAgentIds.add(action.agentId);
      return { ...state, composer: { ...state.composer, detachedAgentIds } };
    }
    case "set-creation-default":
      return {
        ...state,
        creationDefaults: { ...state.creationDefaults, [action.workspaceId]: action.value },
      };
    case "open-modal":
      return { ...state, modal: action.modal };
    case "close-modal":
      return { ...state, modal: { type: "none" } };
    case "toggle-expanded": {
      const expandedIds = new Set(state.expandedIds);
      if (expandedIds.has(action.id)) expandedIds.delete(action.id);
      else expandedIds.add(action.id);
      return { ...state, expandedIds };
    }
    case "reveal-workspace": {
      return { ...state, expandedIds: revealWorkspaceIds(state, action.workspaceId) };
    }
    case "set-timeline-navigation": {
      const current = timelineNavigation(state, action.agentId);
      return {
        ...state,
        timelineNavigation: {
          ...state.timelineNavigation,
          [action.agentId]: {
            following: action.following,
            unread: action.following ? 0 : current.unread,
            ...(action.following || action.anchor === undefined ? {} : { anchor: action.anchor }),
          },
        },
      };
    }
    case "timeline": {
      const next = applyTimeline(state, action.update);
      if (
        action.update.type === "event" &&
        action.update.event.item.type === "permission" &&
        action.update.event.item.resolved
      )
        return reduceApp(next, {
          type: "permission-resolved",
          agentId: action.update.agentId,
          requestId: action.update.event.item.request.id,
        });
      return next;
    }
    case "permission-submitting":
      return state.modal.type === "permission" &&
        state.modal.agentId === action.agentId &&
        state.modal.requestId === action.requestId
        ? {
            ...state,
            modal: { ...state.modal, submitting: true, lastDecision: action.allow },
          }
        : state;
    case "permission-failed":
      return state.modal.type === "permission" &&
        state.modal.agentId === action.agentId &&
        state.modal.requestId === action.requestId
        ? { ...state, modal: { ...state.modal, submitting: false, error: action.error } }
        : state;
    case "permission-resolved": {
      const directory = {
        ...state.directory,
        agents: state.directory.agents.map((agent) =>
          agent.id === action.agentId ? resolvePermission(agent, action.requestId) : agent,
        ),
      };
      const timeline =
        state.timeline.agentId === action.agentId
          ? timelineWith(state.timeline, {
              items: resolveTimelinePermission(state.timeline.items, action.requestId),
            })
          : state.timeline;
      return {
        ...state,
        directory,
        timeline,
        modal: permissionModalAfterResolution(state, directory, action.agentId, action.requestId),
      };
    }
    case "notify":
      return {
        ...state,
        notification: {
          message: action.message,
          kind: action.kind ?? "info",
          ...(action.detail ? { detail: action.detail } : {}),
        },
      };
    case "clear-notification": {
      const next = { ...state };
      delete next.notification;
      return next;
    }
  }
}

export function pendingPermissions(state: AppState): readonly PermissionRequest[] {
  return state.directory.agents
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .flatMap((agent) =>
      agent.pendingPermissions.slice().sort((left, right) => left.id.localeCompare(right.id)),
    );
}
