import type { AppState } from "../contracts/app-state.js";
import type { AgentRecord, TimelineEvent, TimelineItem } from "../contracts/domain.js";
import { selectedComposerDraft } from "../state/composer.js";

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
  attention: boolean;
  permissionCount: number;
}

const OTHER_ID = "__paseo_deck_other__";

function agentMatches(agent: AgentRecord, filter: string): boolean {
  return `${agent.title} ${agent.providerId ?? ""} ${agent.modelId ?? ""}`
    .toLocaleLowerCase()
    .includes(filter);
}

export function deriveTreeRows(state: AppState): TreeRow[] {
  const rows: TreeRow[] = [];
  const filter = state.filter.trim().toLocaleLowerCase();
  const workspacesByProject = new Map<string, typeof state.directory.workspaces>();
  for (const workspace of state.directory.workspaces.filter((item) => !item.archived)) {
    const key =
      workspace.projectId &&
      state.directory.projects.some((project) => project.id === workspace.projectId)
        ? workspace.projectId
        : OTHER_ID;
    workspacesByProject.set(key, [...(workspacesByProject.get(key) ?? []), workspace]);
  }
  const groups = [
    ...state.directory.projects.map((project) => ({ id: project.id, name: project.name })),
    ...(workspacesByProject.has(OTHER_ID) ? [{ id: OTHER_ID, name: "Other" }] : []),
  ];

  for (const group of groups) {
    const workspaces = workspacesByProject.get(group.id) ?? [];
    const visibleWorkspaces = workspaces.filter((workspace) => {
      const agents = state.directory.agents.filter(
        (agent) => agent.workspaceId === workspace.id && !agent.archived,
      );
      return (
        !filter ||
        workspace.title.toLocaleLowerCase().includes(filter) ||
        agents.some((agent) => agentMatches(agent, filter))
      );
    });
    if (filter && visibleWorkspaces.length === 0) continue;
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
        state.selectedProjectId === group.id &&
        state.selectedWorkspaceId === undefined &&
        state.selectedAgentId === undefined,
      attention: false,
      permissionCount: 0,
    });
    if (!expanded) continue;
    for (const workspace of visibleWorkspaces) {
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
      });
      if (!workspaceExpanded) continue;
      for (const agent of state.directory.agents.filter(
        (item) =>
          item.workspaceId === workspace.id &&
          !item.archived &&
          (!filter || agentMatches(item, filter)),
      )) {
        rows.push(agentRow(agent, state.selectedAgentId));
      }
    }
  }
  return rows;
}

function agentRow(agent: AgentRecord, selectedAgentId: string | undefined): TreeRow {
  return {
    id: agent.id,
    kind: "agent",
    label: `${agent.title} [${shortAgentId(agent.id)}]`,
    depth: 2,
    selected: agent.id === selectedAgentId,
    status: agent.status,
    providerModel: [agent.providerId, agent.modelId].filter(Boolean).join("/"),
    attention: agent.needsAttention,
    permissionCount: agent.pendingPermissions.length,
  };
}

export function shortAgentId(agentId: string): string {
  return agentId.slice(0, 8);
}

function clip(value: string, width: number): string {
  if (width <= 1) return value.slice(0, Math.max(0, width));
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

function wrap(value: string, width: number): string[] {
  if (width < 2) return [clip(value, width)];
  const words = value.replaceAll("\n", " ").split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + word.length + 1 <= width) line += ` ${word}`;
    else {
      lines.push(clip(line, width));
      line = word;
    }
  }
  if (line) lines.push(clip(line, width));
  return lines.length ? lines : [""];
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
  const bodyWidth = Math.max(12, width - 4);
  switch (item.type) {
    case "user-message":
      return ["You", ...wrap(item.text, bodyWidth).map((line) => `  ${line}`)];
    case "assistant-message":
      return ["Assistant", ...wrap(item.text, bodyWidth).map((line) => `  ${line}`)];
    case "reasoning": {
      const collapsed = item.collapsed ?? item.text.length > 180;
      if (collapsed && !expanded)
        return [
          `Reasoning (collapsed)  [Enter to expand]`,
          `  ${clip(item.text.replaceAll("\n", " "), bodyWidth)}`,
        ];
      return ["Reasoning", ...wrap(item.text, bodyWidth).map((line) => `  ${line}`)];
    }
    case "tool": {
      const summary = item.summary ?? item.output ?? "";
      if (!expanded && summary.length > 180)
        return [
          `Tool ${item.status}: ${item.name}  [Enter to expand]`,
          `  ${clip(summary, bodyWidth)}`,
        ];
      return [
        `Tool ${item.status}: ${item.name}`,
        ...wrap(summary || "No output", bodyWidth).map((line) => `  ${line}`),
      ];
    }
    case "error":
      return [
        `Error: ${item.message}`,
        ...(item.detail ? wrap(item.detail, bodyWidth).map((line) => `  ${line}`) : []),
      ];
    case "permission":
      return [
        `Permission ${item.resolved ? "resolved" : "needed"}: ${item.request.title}`,
        ...(item.request.description
          ? wrap(item.request.description, bodyWidth).map((line) => `  ${line}`)
          : []),
      ];
    case "turn":
      return [`Turn ${item.status}${item.detail ? `: ${item.detail}` : ""}`];
    case "unknown":
      return [`Unknown ${item.sourceType}: ${item.summary}`];
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
