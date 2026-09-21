import { describe, expect, it } from "vitest";

import type { AppState } from "../contracts/app-state.js";
import { emptyDirectory } from "../contracts/app-state.js";
import { terminalDisplayWidth } from "./text-safety.js";
import {
  activityForAgent,
  activityForAgents,
  deriveTreeRows,
  renderDashboard,
  timelineDisplay,
  timelineItemDisplay,
} from "./view-model.js";

function state(): AppState {
  return {
    connection: "connected",
    recovery: { attempt: 0, directoryStale: false, timelineStale: false },
    notifications: [],
    directory: {
      ...emptyDirectory(),
      projects: [{ id: "p", name: "Deck" }],
      workspaces: [
        { id: "w", projectId: "p", title: "Main", directory: "/deck", archived: false },
        { id: "other", title: "Loose", directory: "/tmp", archived: false },
      ],
      agents: [
        {
          id: "agent-123456",
          workspaceId: "w",
          title: "Build UI",
          status: "running",
          providerId: "openai",
          modelId: "gpt-5",
          thinkingLevel: "high",
          availableModeIds: [],
          availableThinkingLevels: [],
          pendingPermissions: [],
          needsAttention: true,
          archived: false,
        },
      ],
    },
    expandedIds: new Set(["p", "w", "other"]),
    selectedAgentId: "agent-123456",
    selectedWorkspaceId: "w",
    filter: "",
    treeOrder: "attention",
    showArchived: false,
    attentionOnly: false,
    focus: "tree",
    modal: { type: "none" },
    timeline: { recoveryRevision: 0, items: [], loading: false },
    timelineNavigation: {},
    creationDefaults: {},
    composer: {
      drafts: {},
      histories: {},
      historyIndexes: {},
      historyDrafts: {},
      sendingAgentIds: new Set(),
      detachedAgentIds: new Set(),
    },
  };
}

describe("tree view model", () => {
  it.each([
    ["attention", { status: "idle", needsAttention: true, pendingPermissions: [] }],
    ["working", { status: "running", needsAttention: false, pendingPermissions: [] }],
    ["idle", { status: "idle", needsAttention: false, pendingPermissions: [] }],
    ["done", { status: "stopped", needsAttention: false, pendingPermissions: [] }],
  ] as const)("derives %s session activity", (expected, overrides) => {
    const base = state().directory.agents[0];
    if (!base) throw new Error("fixture requires an agent");
    const agent = { ...base, ...overrides };
    expect(activityForAgent(agent)).toBe(expected);
  });

  it("gives workspace attention precedence over working activity", () => {
    const base = state().directory.agents[0];
    if (!base) throw new Error("fixture requires an agent");
    expect(
      activityForAgents([
        { ...base, status: "running", needsAttention: false },
        { ...base, id: "attention", status: "idle", needsAttention: true },
      ]),
    ).toBe("attention");
  });

  it("keeps workspace identity and places unowned workspaces in Other", () => {
    const rows = deriveTreeRows(state());

    expect(rows.map((row) => `${row.kind}:${row.label}`)).toEqual([
      "project:Deck",
      "workspace:Main",
      "agent:Build UI [agent-12]",
      "project:Other",
      "workspace:Loose",
    ]);
    expect(rows[1]).toMatchObject({ id: "w", depth: 1 });
    expect(rows[2]).toMatchObject({ selected: true, attention: true });
  });

  it("keeps remote-backed workspaces keyboard-reachable under readable and Other groups", () => {
    const remoteState: AppState = {
      ...state(),
      directory: {
        ...emptyDirectory(),
        projects: [{ id: "remote:github.com/acme/paseo-deck", name: "acme/paseo-deck" }],
        workspaces: [
          {
            id: "workspace-remote",
            projectId: "remote:github.com/acme/paseo-deck",
            title: "Remote workspace",
            directory: "/tmp/paseo-deck",
            archived: false,
          },
          {
            id: "workspace-orphan",
            projectId: "remote:unknown",
            title: "Orphan workspace",
            directory: "/tmp/orphan",
            archived: false,
          },
        ],
        agents: [
          {
            id: "agent-orphan",
            workspaceId: "workspace-orphan",
            title: "Needs review",
            status: "idle",
            availableModeIds: [],
            availableThinkingLevels: [],
            pendingPermissions: [],
            needsAttention: true,
            archived: false,
          },
        ],
      },
      expandedIds: new Set([
        "remote:github.com/acme/paseo-deck",
        "workspace-remote",
        "workspace-orphan",
      ]),
      selectedAgentId: "agent-orphan",
      selectedWorkspaceId: "workspace-orphan",
    };

    expect(deriveTreeRows(remoteState)).toMatchObject([
      { kind: "project", id: "remote:github.com/acme/paseo-deck", label: "acme/paseo-deck" },
      { kind: "workspace", id: "workspace-remote" },
      { kind: "project", label: "Other" },
      { kind: "workspace", id: "workspace-orphan" },
      { kind: "agent", id: "agent-orphan", selected: true, attention: true },
    ]);
    expect(deriveTreeRows(remoteState).map((row) => row.label)).not.toContain(
      "remote:github.com/acme/paseo-deck",
    );

    const remoteFilterRows = deriveTreeRows({ ...remoteState, filter: "remote" });
    expect(remoteFilterRows).toMatchObject([
      { kind: "project", label: "acme/paseo-deck", expanded: true },
      { kind: "workspace", id: "workspace-remote", expanded: true },
    ]);

    const orphanFilterRows = deriveTreeRows({ ...remoteState, filter: "needs" });
    expect(orphanFilterRows).toMatchObject([
      { kind: "project", label: "Other", expanded: true },
      { kind: "workspace", id: "workspace-orphan", expanded: true },
      { kind: "agent", id: "agent-orphan", attention: true },
    ]);
  });

  it("orders attention work deterministically and exposes compact triage summaries", () => {
    const baseAgent = state().directory.agents[0];
    if (baseAgent === undefined) throw new Error("fixture requires an agent");
    const triageState: AppState = {
      ...state(),
      directory: {
        ...state().directory,
        agents: [
          {
            ...baseAgent,
            id: "running",
            title: "Zulu running",
            needsAttention: false,
            lastActivityAt: "2026-09-18T10:00:00.000Z",
          },
          {
            ...baseAgent,
            id: "failed",
            title: "Beta failed",
            status: "failed",
            needsAttention: false,
            lastActivityAt: "2026-09-18T09:00:00.000Z",
          },
          {
            ...baseAgent,
            id: "permission",
            title: "Alpha permission",
            status: "idle",
            needsAttention: true,
            pendingPermissions: [{ id: "p", agentId: "permission", title: "Approve" }],
            lastActivityAt: "2026-09-18T08:00:00.000Z",
          },
          {
            ...baseAgent,
            id: "recent",
            title: "Gamma recent",
            status: "idle",
            needsAttention: false,
            lastActivityAt: "2026-09-18T11:00:00.000Z",
          },
          {
            ...baseAgent,
            id: "older",
            title: "Delta older",
            status: "idle",
            needsAttention: false,
            lastActivityAt: "2026-09-18T07:00:00.000Z",
          },
        ],
      },
    };

    const rows = deriveTreeRows(triageState);
    expect(rows.filter((row) => row.kind === "agent").map((row) => row.id)).toEqual([
      "permission",
      "failed",
      "running",
      "recent",
      "older",
    ]);
    expect(rows[0]).toMatchObject({ agentCount: 5, attentionCount: 2 });
    expect(rows.find((row) => row.id === "permission")).toMatchObject({
      status: "idle",
      providerModel: "openai/gpt-5",
      activityLabel: "09/18 08:00",
    });

    expect(
      deriveTreeRows({ ...triageState, treeOrder: "alphabetical" })
        .filter((row) => row.kind === "agent")
        .map((row) => row.id),
    ).toEqual(["permission", "failed", "older", "recent", "running"]);
  });

  it("derives workspace activity with attention taking precedence and groups sessions", () => {
    const base = state().directory.agents[0];
    if (!base) throw new Error("fixture requires an agent");
    const rows = deriveTreeRows({
      ...state(),
      directory: {
        ...state().directory,
        projects: [{ id: "p", name: "Project" }],
        workspaces: [
          { id: "w", projectId: "p", title: "Workspace", directory: "/w", archived: false },
        ],
        agents: [
          { ...base, id: "working", status: "running", needsAttention: false },
          { ...base, id: "attention", status: "idle", needsAttention: true },
        ],
      },
      expandedIds: new Set(["p", "w"]),
    });
    expect(rows.find((row) => row.kind === "workspace")).toMatchObject({
      activity: "attention",
    });
    expect(
      rows
        .filter((row) => row.kind === "agent")
        .slice(1)
        .every((row) => row.gapBefore === 1),
    ).toBe(true);
  });

  it("filters to attention while retaining context, hides archived records, and omits empty groups", () => {
    const baseAgent = state().directory.agents[0];
    if (baseAgent === undefined) throw new Error("fixture requires an agent");
    const filteredState: AppState = {
      ...state(),
      directory: {
        ...state().directory,
        projects: [
          { id: "p", name: "Deck" },
          { id: "empty", name: "Empty" },
        ],
        workspaces: [
          ...state().directory.workspaces,
          { id: "quiet", projectId: "p", title: "Quiet", directory: "/quiet", archived: false },
        ],
        agents: [
          ...state().directory.agents,
          {
            ...baseAgent,
            id: "archived",
            title: "Archived alert",
            archived: true,
            status: "failed",
          },
        ],
      },
      attentionOnly: true,
    };

    expect(deriveTreeRows(filteredState).map((row) => row.id)).toEqual(["p", "w", "agent-123456"]);
    expect(deriveTreeRows({ ...filteredState, showArchived: true }).map((row) => row.id)).toEqual([
      "p",
      "w",
      "archived",
      "agent-123456",
    ]);
    expect(
      deriveTreeRows({ ...filteredState, attentionOnly: false }).map((row) => row.id),
    ).not.toContain("empty");
  });
});

describe("timeline display", () => {
  it.each([
    [
      { id: "user", type: "user-message", text: "hello", timestamp: "2026-09-18T10:00:00Z" },
      "You · 10:00",
    ],
    [
      {
        id: "assistant",
        type: "assistant-message",
        messageId: "m",
        text: "partial",
        streaming: true,
        timestamp: "2026-09-18T10:01:00Z",
      },
      "streaming…",
    ],
    [{ id: "reason", type: "reasoning", text: "x".repeat(200) }, "collapsed"],
    [
      {
        id: "tool",
        type: "tool",
        callId: "c",
        name: "git",
        status: "failed",
        durationMs: 1200,
        failureSummary: "denied",
        output: "line one\n  line two",
      },
      "git · 1.2s · denied",
    ],
    [{ id: "error", type: "error", message: "bad", detail: "details" }, "Enter to expand"],
    [
      { id: "permission", type: "permission", request: { id: "p", agentId: "a", title: "Read" } },
      "Permission needed",
    ],
    [
      {
        id: "turn",
        type: "turn",
        status: "completed",
        startedAt: "2026-09-18T10:00:00Z",
        completedAt: "2026-09-18T10:00:03Z",
        durationMs: 3000,
      },
      "Turn completed · 3.0s · 10:00",
    ],
    [
      { id: "unknown", type: "unknown", sourceType: "new", summary: "payload" },
      "Unknown new: payload",
    ],
  ] as const)("renders %s safely", (item, expected) => {
    expect(
      timelineDisplay([{ epoch: "e", sequence: 1, item }], 80, new Set()).join("\n"),
    ).toContain(expected);
  });

  it("renders unknown events safely and collapses long reasoning by default", () => {
    const lines = timelineDisplay(
      [
        {
          epoch: "e",
          sequence: 1,
          item: { id: "u", type: "unknown", sourceType: "new", summary: "payload" },
        },
        { epoch: "e", sequence: 2, item: { id: "r", type: "reasoning", text: "x".repeat(300) } },
      ],
      70,
      new Set(),
    );

    expect(lines.join("\n")).toContain("Unknown new: payload");
    expect(lines.join("\n")).toContain("Reasoning (collapsed)");
  });

  it("expands long reasoning, tool output, and error details without losing useful content", () => {
    const longReasoning = timelineItemDisplay(
      { id: "reason", type: "reasoning", text: "thinking ".repeat(40) },
      80,
      true,
    ).join("\n");
    const longTool = {
      id: "tool",
      type: "tool" as const,
      callId: "call",
      name: "shell",
      status: "completed" as const,
      summary: "short summary",
      output: `first line\n  ${"indented output ".repeat(20)}\n  final indented line`,
    };
    const collapsedTool = timelineItemDisplay(longTool, 80, false).join("\n");
    const expandedTool = timelineItemDisplay(longTool, 80, true).join("\n");
    const expandedError = timelineItemDisplay(
      { id: "error", type: "error", message: "failed", detail: "first line\n  final detail" },
      80,
      true,
    ).join("\n");

    expect(longReasoning).toContain("thinking");
    expect(longReasoning).not.toContain("collapsed");
    expect(collapsedTool).toContain("short summary");
    expect(collapsedTool).toContain("[Enter to expand]");
    expect(expandedTool).toContain("indented output");
    expect(expandedTool).toContain("final indented line");
    expect(expandedError).toContain("final detail");
    expect(expandedError).not.toContain("[Enter to expand]");
  });

  it("keeps unsafe wide tool output inside a narrow timeline pane", () => {
    const lines = timelineDisplay(
      [
        {
          epoch: "e",
          sequence: 1,
          item: {
            id: "tool",
            type: "tool",
            callId: "call",
            name: "\u001b[2Jcommand",
            status: "completed",
            output: "\u001b[2J\tveryLongIdentifier🙂e\u0301",
          },
        },
      ],
      12,
      new Set(),
    );

    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.join("\n")).toContain("␛[2J");
    expect(lines.every((line) => terminalDisplayWidth(line) <= 12)).toBe(true);
  });

  it("renders structured tool kinds and diff previews", () => {
    const command = timelineItemDisplay(
      {
        id: "command",
        type: "tool",
        callId: "command",
        name: "shell",
        status: "completed",
        output: "ok",
        detail: { kind: "command", command: "npm run check" },
      },
      60,
      false,
    ).join("\n");
    const diff = timelineItemDisplay(
      {
        id: "diff",
        type: "tool",
        callId: "diff",
        name: "edit",
        status: "completed",
        output: "@@ -1 +1 @@\n-old\n+new",
        detail: { kind: "file-write", path: "src/file.ts", diff: "@@ -1 +1 @@\n-old\n+new" },
      },
      60,
      true,
    ).join("\n");

    expect(command).toContain("command");
    expect(command).toContain("npm run check");
    expect(diff).toContain("write");
    expect(diff).toContain("+new");
  });

  it("renders raw SGR from non-Markdown timeline fields as inert text", () => {
    const lines = timelineDisplay(
      [
        {
          epoch: "e",
          sequence: 1,
          item: {
            id: "tool",
            type: "tool",
            callId: "call",
            name: "\u001b[31munsafe",
            status: "failed",
            output: "failed",
          },
        },
        {
          epoch: "e",
          sequence: 2,
          item: { id: "error", type: "error", message: "\u001b[32munsafe" },
        },
      ],
      30,
      new Set(),
    );

    expect(lines.join("\n")).not.toContain("\u001b[");
    expect(lines.join("\n")).toContain("␛[31munsafe");
    expect(lines.join("\n")).toContain("␛[32munsafe");
  });
});

describe("narrow dashboard", () => {
  it("retains tree, timeline, and composer while omitting secondary details", () => {
    const dashboard = renderDashboard(state(), 58, 18, new Set());

    expect(dashboard.join("\n")).toContain("Projects / workspaces");
    expect(dashboard.join("\n")).toContain("Active session timeline");
    expect(dashboard.join("\n")).toContain("Prompt:");
    expect(dashboard.join("\n")).not.toContain("openai/gpt-5");
  });
});
