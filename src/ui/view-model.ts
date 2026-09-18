import type { AppState } from "../contracts/app-state.js";
import type { AgentRecord, TimelineEvent, TimelineItem } from "../contracts/domain.js";
import { selectedComposerDraft } from "../state/composer.js";
import { clipTerminalLine, sanitizeTerminalText, wrapTerminalText } from "./text-safety.js";

export type TreeRowKind = "project" | "workspace" | "agent";

export interface TreeRow {
  id: string;
  kind: TreeRowKind;
  label: string;
  depth: number;
  expanded?: boolean;
  selected: boolean;
  status?: string;
  providerModel?: string;
  activityLabel?: string;
  attention: boolean;
  permissionCount: number;
  agentCount?: number;
  attentionCount?: number;
}

const OTHER_ID = "__paseo_deck_other__";

function agentMatches(agent: AgentRecord, filter: string): boolean {
  return `${agent.title} ${agent.providerId ?? ""} ${agent.modelId ?? ""}`
    .toLocaleLowerCase()
    .includes(filter);
}

function needsIntervention(agent: AgentRecord): boolean {
  return agent.pendingPermissions.length > 0 || agent.needsAttention || agent.status === "failed";
}

function activityRank(agent: AgentRecord): number {
  if (agent.pendingPermissions.length > 0) return 4;
  if (agent.status === "failed") return 3;
  if (agent.needsAttention) return 2;
  return agent.status === "running" ? 1 : 0;
}

function activityTimestamp(agent: AgentRecord): number {
  if (agent.lastActivityAt === undefined) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(agent.lastActivityAt);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

function compareAgents(
  left: AgentRecord,
  right: AgentRecord,
  order: AppState["treeOrder"],
): number {
  if (order === "alphabetical")
    return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  return (
    activityRank(right) - activityRank(left) ||
    activityTimestamp(right) - activityTimestamp(left) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
  );
}

function compactActivity(timestamp: string | undefined): string | undefined {
  if (timestamp === undefined || Number.isNaN(Date.parse(timestamp))) return undefined;
  const [date, time] = timestamp.split("T");
  if (date === undefined || time === undefined) return undefined;
  return `${date.slice(5).replace("-", "/")} ${time.slice(0, 5)}`;
}

export function deriveTreeRows(state: AppState): TreeRow[] {
  const rows: TreeRow[] = [];
  const filter = state.filter.trim().toLocaleLowerCase();
  const workspacesByProject = new Map<string, typeof state.directory.workspaces>();
  for (const workspace of state.directory.workspaces.filter(
    (item) => state.showArchived || !item.archived,
  )) {
    const key =
      workspace.projectId &&
      state.directory.projects.some((project) => project.id === workspace.projectId)
        ? workspace.projectId
        : OTHER_ID;
    workspacesByProject.set(key, [...(workspacesByProject.get(key) ?? []), workspace]);
  }
  const groups = [
    ...state.directory.projects
      .filter(
        (project) =>
          workspacesByProject.has(project.id) ||
          state.selectedProjectId === project.id ||
          (Boolean(filter) && project.name.toLocaleLowerCase().includes(filter)),
      )
      .map((project) => ({ id: project.id, name: project.name })),
    ...(workspacesByProject.has(OTHER_ID) ? [{ id: OTHER_ID, name: "Other" }] : []),
  ];

  for (const group of groups) {
    const workspaces = workspacesByProject.get(group.id) ?? [];
    const visibleWorkspaces = workspaces.filter((workspace) => {
      const agents = state.directory.agents.filter(
        (agent) =>
          agent.workspaceId === workspace.id &&
          (state.showArchived || !agent.archived) &&
          (!state.attentionOnly || needsIntervention(agent)) &&
          (!filter || agentMatches(agent, filter)),
      );
      const workspaceMatches = workspace.title.toLocaleLowerCase().includes(filter);
      if (state.attentionOnly) return agents.length > 0;
      return !filter || workspaceMatches || agents.length > 0;
    });
    const groupMatches = Boolean(filter) && group.name.toLocaleLowerCase().includes(filter);
    const selected = state.selectedProjectId === group.id;
    if (visibleWorkspaces.length === 0 && !groupMatches && !selected) continue;
    // Orphaned workspaces should remain discoverable; unlike a user project the
    // synthetic Other group has no persisted expansion identity.
    const expanded = Boolean(filter) || group.id === OTHER_ID || state.expandedIds.has(group.id);
    rows.push({
      id: group.id,
      kind: "project",
      label: group.name,
      depth: 0,
      expanded,
      selected:
        selected && state.selectedWorkspaceId === undefined && state.selectedAgentId === undefined,
      attention: false,
      permissionCount: 0,
      agentCount: visibleWorkspaces.flatMap((workspace) =>
        state.directory.agents.filter(
          (agent) => agent.workspaceId === workspace.id && (state.showArchived || !agent.archived),
        ),
      ).length,
      attentionCount: visibleWorkspaces.flatMap((workspace) =>
        state.directory.agents.filter(
          (agent) =>
            agent.workspaceId === workspace.id &&
            needsIntervention(agent) &&
            (state.showArchived || !agent.archived),
        ),
      ).length,
    });
    if (!expanded) continue;
    for (const workspace of visibleWorkspaces) {
      const workspaceAllAgents = state.directory.agents.filter(
        (agent) => agent.workspaceId === workspace.id && (state.showArchived || !agent.archived),
      );
      const workspaceExpanded = Boolean(filter) || state.expandedIds.has(workspace.id);
      rows.push({
        id: workspace.id,
        kind: "workspace",
        label: workspace.title,
        depth: 1,
        expanded: workspaceExpanded,
        selected: state.selectedWorkspaceId === workspace.id && state.selectedAgentId === undefined,
        attention: false,
        permissionCount: 0,
        agentCount: workspaceAllAgents.length,
        attentionCount: workspaceAllAgents.filter(needsIntervention).length,
      });
      if (!workspaceExpanded) continue;
      const workspaceAgents = state.directory.agents
        .filter(
          (item) =>
            item.workspaceId === workspace.id &&
            (state.showArchived || !item.archived) &&
            (!state.attentionOnly || needsIntervention(item)) &&
            (!filter || agentMatches(item, filter)),
        )
        .sort((left, right) => compareAgents(left, right, state.treeOrder));
      for (const agent of workspaceAgents) {
        rows.push(agentRow(agent, state.selectedAgentId));
      }
    }
  }
  return rows;
}

function agentRow(agent: AgentRecord, selectedAgentId: string | undefined): TreeRow {
  const activityLabel = compactActivity(agent.lastActivityAt);
  return {
    id: agent.id,
    kind: "agent",
    label: `${agent.title} [${shortAgentId(agent.id)}]`,
    depth: 2,
    selected: agent.id === selectedAgentId,
    status: agent.status,
    providerModel: [agent.providerId, agent.modelId].filter(Boolean).join("/"),
    attention: needsIntervention(agent),
    permissionCount: agent.pendingPermissions.length,
    ...(activityLabel === undefined ? {} : { activityLabel }),
  };
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
): string[] {
  return events.flatMap((event) =>
    timelineItemDisplay(event.item, width, expanded.has(event.item.id)),
  );
}

export function timelineItemDisplay(
  item: TimelineItem,
  width: number,
  expanded: boolean,
): string[] {
  const bodyWidth = Math.max(1, width - 2);
  const body = (value: string): string[] =>
    wrapTerminalText(value, bodyWidth).map((line) => clipTerminalLine(`  ${line}`, width));
  const heading = (value: string): string => clipTerminalLine(sanitizeTerminalText(value), width);
  const stamp = item.timestamp ? ` · ${item.timestamp.slice(11, 16)}` : "";
  const duration = (value: number | undefined): string =>
    value === undefined ? "" : ` · ${(value / 1000).toFixed(1)}s`;
  switch (item.type) {
    case "user-message":
      return [heading(`You${stamp}`), ...body(item.text)];
    case "assistant-message":
      return [
        heading(`Assistant${item.streaming ? " · streaming…" : ""}${stamp}`),
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
      if (!expanded && output.length > 180)
        return [
          heading(
            `Tool ${item.status}: ${item.name}${duration(item.durationMs)}${item.failureSummary ? ` · ${item.failureSummary}` : ""}  [Enter to expand]`,
          ),
          ...body(summary || "No output").slice(0, 1),
        ];
      return [
        heading(
          `Tool ${item.status}: ${item.name}${duration(item.durationMs)}${item.failureSummary ? ` · ${item.failureSummary}` : ""}`,
        ),
        ...body(output || "No output"),
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
          `── Turn ${item.status}${duration(item.durationMs)}${(item.completedAt ?? item.startedAt) ? ` · ${(item.completedAt ?? item.startedAt)?.slice(11, 16)}` : ""}${item.detail ? `: ${item.detail}` : ""} ──`,
        ),
      ];
    case "unknown":
      return [heading(`Unknown ${item.sourceType}: ${item.summary}`)];
  }
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
      const branch = row.kind === "agent" ? "•" : row.expanded ? "▾" : "▸";
      const flags =
        row.kind === "agent"
          ? `${row.permissionCount ? " ✓" : ""}${row.attention ? " !" : ""}${row.status ? ` ${row.status}` : ""}`
          : "";
      return `${marker}${"  ".repeat(row.depth)}${branch} ${row.label}${flags}`;
    }),
  ];
  const selected = state.directory.agents.find((agent) => agent.id === state.selectedAgentId);
  const detail =
    width >= 70 && selected
      ? `${selected.providerId ?? "unknown"}/${selected.modelId ?? "unknown"}${selected.thinkingLevel ? ` · ${selected.thinkingLevel}` : ""}`
      : "";
  const timelineLines = [
    `Selected agent timeline${selected ? ` · ${selected.title} [${shortAgentId(selected.id)}]` : ""}`,
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
  lines.push(
    clip(
      `${state.connection}${width >= 70 ? ` · ${detail || "no agent selected"} · permissions ${permissionCount}` : ""}${state.notification ? ` · ${state.notification.kind}: ${state.notification.message}${state.notification.detail ? " · E details" : ""}` : ""}`,
      width,
    ),
  );
  return lines;
}
