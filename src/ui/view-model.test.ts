import { describe, expect, it } from "vitest";

import type { AppState } from "../contracts/app-state.js";
import { emptyDirectory } from "../contracts/app-state.js";
import { deriveTreeRows, renderDashboard, timelineDisplay } from "./view-model.js";

function state(): AppState {
  return {
    connection: "connected",
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
    focus: "tree",
    modal: { type: "none" },
    timeline: { items: [], loading: false },
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
});

describe("timeline display", () => {
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
});

describe("narrow dashboard", () => {
  it("retains tree, timeline, and composer while omitting secondary details", () => {
    const dashboard = renderDashboard(state(), 58, 18, new Set());

    expect(dashboard.join("\n")).toContain("Projects / workspaces");
    expect(dashboard.join("\n")).toContain("Selected agent timeline");
    expect(dashboard.join("\n")).toContain("Prompt:");
    expect(dashboard.join("\n")).not.toContain("openai/gpt-5");
  });
});
