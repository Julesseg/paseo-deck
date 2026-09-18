import { describe, expect, it } from "vitest";
import { type AppState, emptyDirectory, findSelectedAgent } from "./app-state.js";

describe("application state contracts", () => {
  it("starts with an empty directory", () => {
    expect(emptyDirectory()).toEqual({ projects: [], workspaces: [], agents: [], providers: [] });
  });

  it("finds the selected agent by its stable id", () => {
    const state: AppState = {
      connection: "connected",
      directory: {
        projects: [],
        workspaces: [],
        providers: [],
        agents: [
          {
            id: "agent-1",
            workspaceId: "workspace-1",
            title: "Review",
            status: "running",
            availableModeIds: [],
            availableThinkingLevels: [],
            pendingPermissions: [],
            needsAttention: false,
            archived: false,
          },
        ],
      },
      selectedAgentId: "agent-1",
      expandedIds: new Set(),
      filter: "",
      treeOrder: "attention",
      showArchived: false,
      attentionOnly: false,
      focus: "tree",
      modal: { type: "none" },
      timeline: { recoveryRevision: 0, items: [], loading: false },
      timelineNavigation: {},
      composer: {
        drafts: {},
        histories: {},
        historyIndexes: {},
        historyDrafts: {},
        sendingAgentIds: new Set(),
        detachedAgentIds: new Set(),
      },
    };

    expect(findSelectedAgent(state)?.title).toBe("Review");
  });
});
