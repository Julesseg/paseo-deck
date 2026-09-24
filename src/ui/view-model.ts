import type { AppState } from "../contracts/app-state.js";
import type { AgentRecord, TimelineEvent, TimelineItem } from "../contracts/domain.js";
import type { TerminalRecord } from "../contracts/terminal.js";
import { selectedComposerDraft } from "../state/composer.js";
import { activeNotification } from "../state/store.js";
import { projectForWorkspace } from "../state/tree.js";
import { clipTerminalLine, sanitizeTerminalText, wrapTerminalText } from "./text-safety.js";

export type TreeRowKind = "project" | "workspace";
export type WorkspaceActivity = "attention" | "working" | "idle" | "done";
export type WorkspaceTab =
  | { kind: "session"; id: string; agent: AgentRecord }
  | { kind: "terminal"; id: string; terminal: TerminalRecord };

export function workspaceTabs(state: AppState): WorkspaceTab[] {
  const workspaceId = state.selectedWorkspaceId;
  if (!workspaceId) return [];
  return (state.tabOrder[workspaceId] ?? []).flatMap((key): WorkspaceTab[] => {
    if (key.startsWith("session:")) {
      const agent = state.directory.agents.find(
        (item) => item.id === key.slice(8) && item.workspaceId === workspaceId && !item.archived,
      );
      return agent ? [{ kind: "session", id: agent.id, agent }] : [];
    }
    const terminal = (state.workspaceTerminals?.[workspaceId] ?? []).find(
      (item) => item.id === key.slice(9) && item.workspaceId === workspaceId,
    );
    return terminal ? [{ kind: "terminal", id: terminal.id, terminal }] : [];
  });
}

export interface TreeRow {
  id: string;
  kind: TreeRowKind;
  label: string;
  depth: number;
  expanded?: boolean;
  selected: boolean;
  attention: boolean;
  /** Derived from sessions and terminals in the workspace. */
  activity?: WorkspaceActivity;
  /** The workspace currently shown in the main pane. */
  active?: boolean;
  /** Number of blank lines before this row, used for semantic grouping. */
  gapBefore?: number;
}

function needsIntervention(agent: AgentRecord): boolean {
  return agent.pendingPermissions.length > 0 || agent.needsAttention || agent.status === "failed";
}

export function activityForAgent(agent: AgentRecord): WorkspaceActivity {
  if (needsIntervention(agent)) return "attention";
  if (agent.status === "running" || agent.status === "starting") return "working";
  if (["stopped", "archived", "failed"].includes(agent.status)) return "done";
  return "idle";
}

export function activityForAgents(agents: readonly AgentRecord[]): WorkspaceActivity {
  if (agents.some(needsIntervention)) return "attention";
  if (agents.some((agent) => agent.status === "running" || agent.status === "starting"))
    return "working";
  if (agents.some((agent) => !["stopped", "archived", "failed"].includes(agent.status)))
    return "idle";
  return agents.length ? "done" : "idle";
}

export function activityForWorkspace(
  agents: readonly AgentRecord[],
  terminals: readonly TerminalRecord[],
  endedTerminalIds: ReadonlySet<string> = new Set(),
  hadResources = false,
): WorkspaceActivity {
  if (
    agents.some((agent) => !agent.archived && needsIntervention(agent)) ||
    terminals.some(
      (terminal) => !endedTerminalIds.has(terminal.id) && terminal.activity === "attention",
    )
  )
    return "attention";
  if (
    agents.some(
      (agent) => !agent.archived && (agent.status === "running" || agent.status === "starting"),
    ) ||
    terminals.some(
      (terminal) => !endedTerminalIds.has(terminal.id) && terminal.activity === "working",
    )
  )
    return "working";
  if (
    agents.some(
      (agent) => !agent.archived && !["stopped", "archived", "failed"].includes(agent.status),
    ) ||
    terminals.some((terminal) => !endedTerminalIds.has(terminal.id)) ||
    (agents.length === 0 && terminals.length === 0 && !hadResources)
  )
    return "idle";
  return "done";
}

export function deriveTreeRows(state: AppState): TreeRow[] {
  const rows: TreeRow[] = [];
  const filter = state.filter.trim().toLocaleLowerCase();
  const workspaces = state.directory.workspaces.filter(
    (workspace) => state.showArchived || !workspace.archived,
  );
  const frozenOrder =
    state.focus === "tree" && state.sidebarOrder
      ? new Map(state.sidebarOrder.map((id, index) => [id, index]))
      : undefined;
  const compareFrozen = (left: string, right: string): number =>
    frozenOrder
      ? (frozenOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (frozenOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
      : 0;
  const projects = [...state.directory.projects].sort(
    (left, right) =>
      compareFrozen(left.id, right.id) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
  const activity = (workspaceId: string): WorkspaceActivity =>
    activityForWorkspace(
      state.directory.agents.filter((agent) => agent.workspaceId === workspaceId),
      state.workspaceTerminals?.[workspaceId] ?? [],
      state.staleTerminalIds,
      state.workspaceHadResources?.has(workspaceId),
    );
  const rank: Record<WorkspaceActivity, number> = { attention: 0, working: 1, idle: 2, done: 3 };
  const sorted = (items: typeof workspaces) =>
    [...items].sort(
      (left, right) =>
        compareFrozen(left.id, right.id) ||
        (state.treeOrder === "attention"
          ? rank[activity(left.id)] - rank[activity(right.id)]
          : 0) ||
        left.title.localeCompare(right.title) ||
        left.id.localeCompare(right.id),
    );
  const visible = (items: typeof workspaces, projectMatches = false) =>
    sorted(
      items.filter((workspace) => {
        const matches =
          !filter ||
          projectMatches ||
          workspace.title.toLocaleLowerCase().includes(filter) ||
          workspace.id.toLocaleLowerCase().includes(filter) ||
          workspace.directory.toLocaleLowerCase().includes(filter);
        return matches && (!state.attentionOnly || activity(workspace.id) === "attention");
      }),
    );
  const appendWorkspace = (workspace: (typeof workspaces)[number], depth: number): void => {
    rows.push({
      id: workspace.id,
      kind: "workspace",
      label: workspace.title,
      depth,
      selected:
        state.sidebarSelection?.kind === "workspace"
          ? state.sidebarSelection.id === workspace.id
          : !state.sidebarSelection && state.selectedWorkspaceId === workspace.id,
      attention: activity(workspace.id) === "attention",
      activity: activity(workspace.id),
      active: workspace.id === state.selectedWorkspaceId,
      gapBefore: rows.at(-1)?.kind === "workspace" ? 1 : 0,
    });
  };
  for (const project of projects) {
    const projectMatches =
      Boolean(filter) &&
      (project.name.toLocaleLowerCase().includes(filter) ||
        project.id.toLocaleLowerCase().includes(filter));
    const children = visible(
      workspaces.filter((workspace) => projectForWorkspace(projects, workspace)?.id === project.id),
      projectMatches,
    );
    if (children.length === 0 && !projectMatches) continue;
    const expanded = Boolean(filter) || state.expandedIds.has(project.id);
    rows.push({
      id: project.id,
      kind: "project",
      label: project.name,
      depth: 0,
      expanded,
      selected:
        state.sidebarSelection?.kind === "project" && state.sidebarSelection.id === project.id,
      attention: false,
    });
    if (expanded) for (const workspace of children) appendWorkspace(workspace, 1);
  }
  const roots = workspaces.filter((workspace) => !projectForWorkspace(projects, workspace));
  for (const workspace of visible(roots)) appendWorkspace(workspace, 0);
  return rows;
}

export function shortAgentId(agentId: string): string {
  return agentId.slice(0, 8);
}

function clip(value: string, width: number): string {
  if (width <= 1) return value.slice(0, Math.max(0, width));
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

export function timelineDisplay(
  events: readonly TimelineEvent[],
  width: number,
  expanded: ReadonlySet<string>,
  chrome?: TimelineChrome,
): string[] {
  return events.flatMap((event) =>
    timelineItemDisplay(event.item, width, expanded.has(event.item.id), chrome),
  );
}

/** App-owned separators only; timeline payloads remain unmodified. */
export interface TimelineChrome {
  bullet: string;
  ellipsis: string;
  divider: string;
}

const unicodeTimelineChrome: TimelineChrome = { bullet: "·", ellipsis: "…", divider: "─" };

export function timelineItemDisplay(
  item: TimelineItem,
  width: number,
  expanded: boolean,
  chrome: TimelineChrome = unicodeTimelineChrome,
): string[] {
  const bodyWidth = Math.max(1, width - 2);
  const body = (value: string): string[] =>
    wrapTerminalText(value, bodyWidth).map((line) =>
      clipTerminalLine(`  ${line}`, width, chrome.ellipsis),
    );
  const heading = (value: string): string =>
    clipTerminalLine(sanitizeTerminalText(value), width, chrome.ellipsis);
  const stamp = item.timestamp ? ` ${chrome.bullet} ${item.timestamp.slice(11, 16)}` : "";
  const duration = (value: number | undefined): string =>
    value === undefined ? "" : ` ${chrome.bullet} ${(value / 1000).toFixed(1)}s`;
  switch (item.type) {
    case "user-message":
      return [heading(`You${stamp}`), ...body(item.text)];
    case "assistant-message":
      return [
        heading(
          `Assistant${item.streaming ? ` ${chrome.bullet} streaming${chrome.ellipsis}` : ""}${stamp}`,
        ),
        ...body(item.text),
      ];
    case "reasoning": {
      const collapsed = item.collapsed ?? item.text.length > 180;
      if (collapsed && !expanded)
        return [
          heading("Reasoning (collapsed)  [Enter to expand]"),
          ...body(item.text.replaceAll("\n", " ")).slice(0, 1),
        ];
      return [heading(`Reasoning${stamp}`), ...body(item.text)];
    }
    case "tool": {
      const output = item.output ?? item.summary ?? "";
      const summary = item.summary ?? output.split("\n")[0] ?? "";
      const detail = item.detail;
      const kindLabel = detail ? toolDetailLabel(detail.kind) : undefined;
      const structuredSummary = detail ? toolDetailSummary(detail) : undefined;
      const preview =
        detail?.diff ??
        (detail?.kind === "command" || detail?.kind === "file-read" || detail?.kind === "file-write"
          ? (structuredSummary ?? output)
          : (detail?.content ?? output));
      const displaySummary = structuredSummary ?? summary;
      if (!expanded && output.length > 180)
        return [
          heading(
            `Tool ${item.status}: ${item.name}${kindLabel ? ` ${chrome.bullet} ${kindLabel}` : ""}${duration(item.durationMs)}${item.failureSummary ? ` ${chrome.bullet} ${item.failureSummary}` : ""}  [Enter to expand]`,
          ),
          ...body(displaySummary || "No output").slice(0, 1),
        ];
      return [
        heading(
          `Tool ${item.status}: ${item.name}${kindLabel ? ` ${chrome.bullet} ${kindLabel}` : ""}${duration(item.durationMs)}${item.failureSummary ? ` ${chrome.bullet} ${item.failureSummary}` : ""}`,
        ),
        ...body(preview || displaySummary || "No output"),
      ];
    }
    case "error":
      return [
        heading(
          `Error: ${item.message}${item.detail && !expanded ? "  [Enter to expand]" : ""}${stamp}`,
        ),
        ...(item.detail ? (expanded ? body(item.detail) : body(item.detail).slice(0, 1)) : []),
      ];
    case "permission":
      return [
        heading(`Permission ${item.resolved ? "resolved" : "needed"}: ${item.request.title}`),
        ...(item.request.description ? body(item.request.description) : []),
      ];
    case "turn":
      return [
        heading(
          `${chrome.divider}${chrome.divider} Turn ${item.status}${duration(item.durationMs)}${(item.completedAt ?? item.startedAt) ? ` ${chrome.bullet} ${(item.completedAt ?? item.startedAt)?.slice(11, 16)}` : ""}${item.detail ? `: ${item.detail}` : ""} ${chrome.divider}${chrome.divider}`,
        ),
      ];
    case "unknown":
      return [heading(`Unknown ${item.sourceType}: ${item.summary}`)];
  }
}

function toolDetailLabel(
  kind: NonNullable<Extract<TimelineItem, { type: "tool" }>["detail"]>["kind"],
): string {
  switch (kind) {
    case "command":
      return "command";
    case "file-read":
      return "read";
    case "file-write":
      return "write";
    case "subagent":
      return "subagent";
    case "worktree":
      return "worktree";
    default:
      return kind;
  }
}

function toolDetailSummary(
  detail: NonNullable<Extract<TimelineItem, { type: "tool" }>["detail"]>,
): string | undefined {
  return (
    detail.command ??
    detail.path ??
    detail.query ??
    detail.url ??
    detail.description ??
    detail.label
  );
}

export function renderDashboard(
  state: AppState,
  width: number,
  height: number,
  expandedTimelineItems: ReadonlySet<string>,
): string[] {
  const leftWidth =
    width < 70 ? Math.max(24, Math.floor(width * 0.36)) : Math.max(25, Math.floor(width * 0.3));
  const rightWidth = Math.max(12, width - leftWidth - 3);
  const bodyHeight = Math.max(4, height - 4);
  const treeLines = [
    "Projects / workspaces",
    ...deriveTreeRows(state).map((row) => {
      const marker = row.selected ? ">" : " ";
      const branch =
        row.kind === "project"
          ? row.expanded
            ? "▾"
            : "▸"
          : ({ attention: "A", working: "W", idle: "I", done: "D" } as const)[
              row.activity ?? "idle"
            ];
      return `${marker}${"  ".repeat(row.depth)}${branch} ${row.label}`;
    }),
  ];
  const selected = state.directory.agents.find((agent) => agent.id === state.selectedAgentId);
  const detail =
    width >= 70 && selected
      ? `${selected.providerId ?? "unknown"}/${selected.modelId ?? "unknown"}${selected.thinkingLevel ? ` · ${selected.thinkingLevel}` : ""}`
      : "";
  const timelineLines = [
    `Active session timeline${selected ? ` · ${selected.title} [${shortAgentId(selected.id)}]` : ""}`,
    ...(state.recovery?.timelineStale ? ["Timeline is stale while Paseo reconnects…"] : []),
    ...(detail ? [detail] : []),
    ...timelineDisplay(state.timeline.items, rightWidth, expandedTimelineItems),
  ];
  const lines: string[] = [];
  for (let index = 0; index < bodyHeight; index += 1)
    lines.push(
      `${clip(treeLines[index] ?? "", leftWidth).padEnd(leftWidth)} │ ${clip(timelineLines[index] ?? "", rightWidth)}`,
    );
  lines.push("─".repeat(Math.max(1, width)));
  lines.push(clip(`Prompt: ${selectedComposerDraft(state) || "Type a follow-up…"}`, width));
  const permissionCount = state.directory.agents.reduce(
    (total, agent) => total + agent.pendingPermissions.length,
    0,
  );
  const notification = activeNotification(state);
  lines.push(
    clip(
      `${state.connection === "reconnecting" ? `reconnecting #${state.recovery.attempt}${state.recovery.directoryStale ? " · stale" : ""}` : state.connection}${width >= 70 ? ` · ${detail || "no agent selected"} · permissions ${permissionCount}` : ""}${notification ? ` · ${notification.kind}${notification.failureKind ? `/${notification.failureKind}` : ""}: ${notification.message}${notification.detail ? " · E details" : ""}${notification.retry ? " · R retry" : ""}${state.notifications.length > 1 ? ` · ${state.notifications.length} notices` : ""}` : ""}`,
      width,
    ),
  );
  return lines;
}
