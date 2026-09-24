import { describe, expect, it } from "vitest";

import type { AppState } from "../contracts/app-state.js";
import { emptyDirectory } from "../contracts/app-state.js";
import { terminalDisplayWidth } from "./text-safety.js";
import {
  activityForAgent,
  activityForAgents,
  activityForWorkspace,
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
    expect(activityForAgent({ ...base, ...overrides })).toBe(expected);
  });

  it("aggregates sessions and terminals with attention, working, idle, done priority", () => {
    const base = state().directory.agents[0];
    if (!base) throw new Error("fixture requires an agent");
    const working = {
      id: "t",
      workspaceId: "w",
      cwd: "/w",
      name: "build",
      activity: "working" as const,
    };
    expect(activityForAgents([])).toBe("idle");
    expect(activityForWorkspace([], [])).toBe("idle");
    expect(activityForWorkspace([], [], new Set(), true)).toBe("done");
    expect(
      activityForWorkspace([{ ...base, status: "stopped", needsAttention: false }], [working]),
    ).toBe("working");
    expect(activityForWorkspace([{ ...base, needsAttention: true }], [working])).toBe("attention");
    expect(
      activityForWorkspace(
        [{ ...base, status: "archived", archived: true }],
        [working],
        new Set(["t"]),
      ),
    ).toBe("done");
  });

  it("contains project and workspace rows only, sorted by activity and title", () => {
    const base = state();
    const agent = base.directory.agents[0];
    if (!agent) throw new Error("fixture requires an agent");
    const rows = deriveTreeRows({
      ...base,
      focus: "composer",
      directory: {
        ...base.directory,
        projects: [
          { id: "z", name: "Zulu" },
          { id: "a", name: "Alpha" },
        ],
        workspaces: [
          { id: "idle", projectId: "a", title: "A idle", directory: "/idle", archived: false },
          {
            id: "working",
            projectId: "a",
            title: "Z working",
            directory: "/working",
            archived: false,
          },
          { id: "done", projectId: "z", title: "Done", directory: "/done", archived: false },
        ],
        agents: [
          { ...agent, workspaceId: "working", needsAttention: false },
          { ...agent, id: "ended", workspaceId: "done", status: "stopped", needsAttention: false },
        ],
      },
      expandedIds: new Set(["a", "z"]),
    });
    expect(rows.map((row) => `${row.kind}:${row.id}`)).toEqual([
      "project:a",
      "workspace:working",
      "workspace:idle",
      "project:z",
      "workspace:done",
    ]);
    expect(rows.find((row) => row.id === "idle")?.activity).toBe("idle");
    expect(rows.find((row) => row.id === "done")?.activity).toBe("done");
  });

  it("filters by project and workspace identity, never by a hidden session", () => {
    const base = state();
    expect(deriveTreeRows({ ...base, filter: "Build UI" })).toEqual([]);
    expect(deriveTreeRows({ ...base, filter: "deck" }).map((row) => row.id)).toEqual(["p", "w"]);
    expect(deriveTreeRows({ ...base, filter: "Main" }).map((row) => row.id)).toEqual(["p", "w"]);
    expect(deriveTreeRows({ ...base, attentionOnly: true }).map((row) => row.id)).toEqual([
      "p",
      "w",
    ]);
  });

  it("holds row order while the sidebar is focused and applies the new order after leaving", () => {
    const base = state();
    const agent = base.directory.agents[0];
    if (!agent) throw new Error("fixture requires an agent");
    const workspace = { id: "b", projectId: "p", title: "Beta", directory: "/b", archived: false };
    const changed: AppState = {
      ...base,
      sidebarOrder: ["p", "w", "b", "other"],
      sidebarSelection: { kind: "workspace", id: "w" },
      directory: {
        ...base.directory,
        workspaces: [...base.directory.workspaces, workspace],
        agents: [{ ...agent, workspaceId: "b", needsAttention: true }],
      },
    };
    expect(deriveTreeRows(changed).map((row) => row.id)).toEqual(["p", "w", "b", "other"]);
    expect(deriveTreeRows(changed).find((row) => row.selected)?.id).toBe("w");
    expect(deriveTreeRows({ ...changed, focus: "composer" }).map((row) => row.id)).toEqual([
      "p",
      "b",
      "w",
      "other",
    ]);
    expect(
      deriveTreeRows({ ...changed, focus: "composer", treeOrder: "alphabetical" }).map(
        (row) => row.id,
      ),
    ).toEqual(["p", "b", "w", "other"]);
  });

  it("keeps newly revealed workspaces under their project without applying pending reorder", () => {
    const base = state();
    const agent = base.directory.agents[0];
    if (!agent) throw new Error("fixture requires an agent");
    const changed: AppState = {
      ...base,
      sidebarOrder: ["p", "w", "other"],
      directory: {
        ...base.directory,
        workspaces: [
          ...base.directory.workspaces,
          { id: "new", projectId: "p", title: "New", directory: "/new", archived: false },
        ],
        agents: [{ ...agent, workspaceId: "new", needsAttention: true }],
      },
    };
    expect(deriveTreeRows(changed).map((row) => row.id)).toEqual(["p", "w", "new", "other"]);
    expect(deriveTreeRows({ ...changed, expandedIds: new Set() }).map((row) => row.id)).toEqual([
      "p",
      "other",
    ]);
    expect(deriveTreeRows(changed).find((row) => row.id === "w")?.selected).toBe(true);
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

  it("drops raw SGR from non-Markdown timeline fields", () => {
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
    expect(lines.join("\n")).toContain("unsafe");
    expect(lines.join("\n")).not.toContain("␛[");
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
