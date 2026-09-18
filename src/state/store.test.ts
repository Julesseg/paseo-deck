import { describe, expect, it } from "vitest";
import type { DirectorySnapshot, TimelineEvent } from "../contracts/domain.js";
import { createInitialState, reduceApp } from "./store.js";
import { deriveTree } from "./tree.js";

const directory: DirectorySnapshot = {
  projects: [{ id: "project-a", name: "Alpha" }],
  workspaces: [
    { id: "workspace-a", projectId: "project-a", title: "Main", directory: "/a", archived: false },
    { id: "workspace-b", title: "Loose", directory: "/b", archived: false },
  ],
  agents: [
    {
      id: "agent-a",
      workspaceId: "workspace-a",
      title: "Build",
      status: "running",
      availableModeIds: [],
      availableThinkingLevels: [],
      pendingPermissions: [],
      needsAttention: false,
      archived: false,
    },
    {
      id: "agent-b",
      workspaceId: "workspace-b",
      title: "Watch",
      status: "idle",
      availableModeIds: [],
      availableThinkingLevels: [],
      pendingPermissions: [],
      needsAttention: false,
      archived: false,
    },
  ],
  providers: [],
};

const event = (sequence: number, item: TimelineEvent["item"]): TimelineEvent => ({
  epoch: "epoch-1",
  sequence,
  item,
});

describe("deriveTree", () => {
  it("groups unassigned workspaces under Other and filters agents", () => {
    const tree = deriveTree(directory, "watch");
    expect(tree.map((group) => group.name)).toEqual(["Other"]);
    expect(tree[0]?.workspaces[0]?.agents.map((agent) => agent.id)).toEqual(["agent-b"]);
  });
});

describe("application store", () => {
  it("clears an agent focus when selecting its workspace or project", () => {
    let state = reduceApp(createInitialState(), {
      type: "directory",
      update: { type: "snapshot", snapshot: directory },
    });
    state = reduceApp(state, { type: "select-agent", agentId: "agent-a" });
    state = reduceApp(state, { type: "select-workspace", workspaceId: "workspace-a" });

    expect(state).toMatchObject({
      selectedProjectId: "project-a",
      selectedWorkspaceId: "workspace-a",
      timeline: { items: [], loading: false },
    });
    expect(state.selectedAgentId).toBeUndefined();

    state = reduceApp(state, { type: "select-agent", agentId: "agent-a" });
    state = reduceApp(state, { type: "select-project", projectId: "project-a" });

    expect(state).toMatchObject({
      selectedProjectId: "project-a",
      timeline: { items: [], loading: false },
    });
    expect(state.selectedWorkspaceId).toBeUndefined();
    expect(state.selectedAgentId).toBeUndefined();
  });

  it("upserts and removes directory entries while retaining a valid selection", () => {
    let state = reduceApp(createInitialState(), {
      type: "directory",
      update: { type: "snapshot", snapshot: directory },
    });
    state = reduceApp(state, { type: "select-agent", agentId: "agent-a" });
    state = reduceApp(state, {
      type: "directory",
      update: { type: "agent-removed", agentId: "agent-a" },
    });
    expect(state.selectedAgentId).toBeUndefined();
    expect(state.timeline.agentId).toBeUndefined();
  });

  it("keeps filter, modal and composer state as explicit user state", () => {
    let state = createInitialState();
    state = reduceApp(state, { type: "set-filter", filter: "codex" });
    state = reduceApp(state, { type: "set-composer", text: "keep this" });
    state = reduceApp(state, { type: "open-modal", modal: { type: "help" } });
    expect(state).toMatchObject({
      filter: "codex",
      composer: {
        drafts: {},
        histories: {},
        historyIndexes: {},
        historyDrafts: {},
        sendingAgentIds: new Set(),
      },
      modal: { type: "help" },
    });
  });

  it("keeps drafts and prompt history isolated by selected agent", () => {
    let state = reduceApp(createInitialState(), {
      type: "directory",
      update: { type: "snapshot", snapshot: directory },
    });
    state = reduceApp(state, { type: "select-agent", agentId: "agent-a" });
    state = reduceApp(state, { type: "set-composer", text: "first draft\nwith detail" });
    state = reduceApp(state, { type: "composer-sent", agentId: "agent-a", prompt: "first prompt" });
    state = reduceApp(state, { type: "set-composer", text: "unsaved a" });
    state = reduceApp(state, { type: "select-agent", agentId: "agent-b" });
    state = reduceApp(state, { type: "set-composer", text: "draft b" });
    state = reduceApp(state, { type: "select-agent", agentId: "agent-a" });
    expect(state.composer.drafts["agent-a"]).toBe("unsaved a");
    state = reduceApp(state, { type: "navigate-composer-history", direction: -1 });
    expect(state.composer.drafts["agent-a"]).toBe("first prompt");
    state = reduceApp(state, { type: "navigate-composer-history", direction: 1 });
    expect(state.composer.drafts["agent-a"]).toBe("unsaved a");
    state = reduceApp(state, { type: "select-agent", agentId: "agent-b" });
    expect(state.composer.drafts["agent-b"]).toBe("draft b");
  });

  it("preserves expansion and selected agent across snapshots, unrelated upserts, and filtering", () => {
    let state = reduceApp(createInitialState(), {
      type: "directory",
      update: { type: "snapshot", snapshot: directory },
    });
    state = reduceApp(state, { type: "toggle-expanded", id: "project-a" });
    state = reduceApp(state, { type: "toggle-expanded", id: "workspace-a" });
    state = reduceApp(state, { type: "select-agent", agentId: "agent-a" });
    state = reduceApp(state, { type: "set-filter", filter: "no match" });
    state = reduceApp(state, {
      type: "directory",
      update: { type: "snapshot", snapshot: directory },
    });
    const changed = directory.agents[1];
    if (!changed) throw new Error("fixture requires a second agent");
    state = reduceApp(state, {
      type: "directory",
      update: { type: "agent-upserted", agent: { ...changed, title: "Changed" } },
    });
    expect(state.selectedAgentId).toBe("agent-a");
    expect(state.expandedIds).toEqual(new Set(["project-a", "workspace-a"]));
    expect(state.filter).toBe("no match");
  });

  it.each([
    { type: "project-upserted", project: { id: "project-a", name: "Alpha renamed" } },
    {
      type: "workspace-upserted",
      workspace: {
        id: "workspace-a",
        projectId: "project-a",
        title: "Main renamed",
        directory: "/a",
        archived: false,
      },
    },
    {
      type: "agent-upserted",
      agent: {
        id: "agent-b",
        workspaceId: "workspace-b",
        title: "Watch renamed",
        status: "idle",
        availableModeIds: [],
        availableThinkingLevels: [],
        pendingPermissions: [],
        needsAttention: false,
        archived: false,
      },
    },
  ] as const)("preserves tree context through $type", (update) => {
    let state = reduceApp(createInitialState(), {
      type: "directory",
      update: { type: "snapshot", snapshot: directory },
    });
    state = reduceApp(state, { type: "reveal-workspace", workspaceId: "workspace-a" });
    state = reduceApp(state, { type: "select-agent", agentId: "agent-a" });
    state = reduceApp(state, { type: "directory", update });
    expect(state.selectedAgentId).toBe("agent-a");
    expect(state.selectedWorkspaceId).toBe("workspace-a");
    expect(state.expandedIds).toEqual(new Set(["project-a", "workspace-a"]));
  });

  it("chooses the next surviving sibling when a selected workspace or project disappears", () => {
    const expanded = new Set(["project-a"]);
    let state = reduceApp(
      { ...createInitialState(), expandedIds: expanded },
      { type: "directory", update: { type: "snapshot", snapshot: directory } },
    );
    state = reduceApp(state, { type: "select-workspace", workspaceId: "workspace-a" });
    state = reduceApp(state, {
      type: "directory",
      update: { type: "workspace-removed", workspaceId: "workspace-a" },
    });
    expect(state.selectedWorkspaceId).toBeUndefined();
    expect(state.selectedProjectId).toBe("project-a");
    state = reduceApp(state, { type: "select-project", projectId: "project-a" });
    state = reduceApp(state, {
      type: "directory",
      update: { type: "project-removed", projectId: "project-a" },
    });
    expect(state.selectedProjectId).toBeUndefined();
  });

  it("falls back to a sibling agent without requiring the workspace selection to disappear", () => {
    const first = directory.agents[0];
    if (!first) throw new Error("fixture requires an agent");
    const withSibling = {
      ...directory,
      agents: [...directory.agents, { ...first, id: "agent-a2", title: "Build two" }],
    };
    let state = reduceApp(createInitialState(), {
      type: "directory",
      update: { type: "snapshot", snapshot: withSibling },
    });
    state = reduceApp(state, { type: "select-agent", agentId: "agent-a" });
    state = reduceApp(state, {
      type: "directory",
      update: { type: "agent-removed", agentId: "agent-a" },
    });
    expect(state.selectedAgentId).toBe("agent-a2");
    expect(state.selectedWorkspaceId).toBe("workspace-a");
  });

  it("merges same-message assistant deltas and same-call tool updates", () => {
    let state = reduceApp(createInitialState(), { type: "select-agent", agentId: "agent-a" });
    state = reduceApp(state, {
      type: "timeline",
      update: {
        type: "event",
        agentId: "agent-a",
        event: event(1, {
          type: "assistant-message",
          id: "one",
          messageId: "message-1",
          text: "Hello",
        }),
      },
    });
    state = reduceApp(state, {
      type: "timeline",
      update: {
        type: "event",
        agentId: "agent-a",
        event: event(2, {
          type: "assistant-message",
          id: "two",
          messageId: "message-1",
          text: " world",
        }),
      },
    });
    state = reduceApp(state, {
      type: "timeline",
      update: {
        type: "event",
        agentId: "agent-a",
        event: event(3, {
          type: "tool",
          id: "tool-1",
          callId: "call-1",
          name: "git",
          status: "running",
        }),
      },
    });
    state = reduceApp(state, {
      type: "timeline",
      update: {
        type: "event",
        agentId: "agent-a",
        event: event(4, {
          type: "tool",
          id: "tool-2",
          callId: "call-1",
          name: "git",
          status: "completed",
          output: "ok",
        }),
      },
    });
    expect(state.timeline.items).toHaveLength(2);
    expect(state.timeline.items[0]?.item).toMatchObject({ text: "Hello world" });
    expect(state.timeline.items[1]?.item).toMatchObject({ status: "completed", output: "ok" });
    expect(state.timeline.cursor).toEqual({ epoch: "epoch-1", sequence: 4 });
  });

  it("does not replay a consumed cursor after assistant and tool coalescing", () => {
    let state = reduceApp(createInitialState(), { type: "select-agent", agentId: "agent-a" });
    const update = (sequence: number, item: TimelineEvent["item"]) =>
      reduceApp(state, {
        type: "timeline",
        update: { type: "event", agentId: "agent-a", event: event(sequence, item) },
      });

    state = update(1, {
      type: "assistant-message",
      id: "assistant-1",
      messageId: "message-1",
      text: "Ready",
    });
    state = update(2, {
      type: "assistant-message",
      id: "assistant-2",
      messageId: "message-1",
      text: " now",
    });
    state = update(3, {
      type: "tool",
      id: "tool-1",
      callId: "call-1",
      name: "git",
      status: "running",
    });
    state = update(4, {
      type: "tool",
      id: "tool-2",
      callId: "call-1",
      name: "git",
      status: "completed",
      output: "done",
    });
    state = update(2, {
      type: "assistant-message",
      id: "assistant-2",
      messageId: "message-1",
      text: " now",
    });
    state = update(4, {
      type: "tool",
      id: "tool-2",
      callId: "call-1",
      name: "git",
      status: "completed",
      output: "done",
    });

    expect(state.timeline.items).toHaveLength(2);
    expect(state.timeline.items[0]?.item).toMatchObject({ text: "Ready now" });
    expect(state.timeline.items[1]?.item).toMatchObject({ output: "done" });
  });

  it("deduplicates cursor events across hydration, restoration and reconnect", () => {
    let state = reduceApp(createInitialState(), { type: "select-agent", agentId: "agent-a" });
    const first = event(1, { type: "user-message", id: "first", text: "hello" });
    state = reduceApp(state, {
      type: "timeline",
      update: { type: "event", agentId: "agent-a", event: first },
    });
    state = reduceApp(state, {
      type: "timeline",
      update: {
        type: "hydrated",
        agentId: "agent-a",
        items: [first],
        cursor: { epoch: "epoch-1", sequence: 1 },
      },
    });
    state = reduceApp(state, {
      type: "timeline",
      update: {
        type: "restored",
        agentId: "agent-a",
        missed: [first, event(2, { type: "turn", id: "done", status: "completed" })],
      },
    });
    expect(state.timeline.items).toHaveLength(2);
    expect(state.timeline.cursor).toEqual({ epoch: "epoch-1", sequence: 2 });
  });

  it("replaces a timeline epoch and records permission resolutions without inferring a turn from idle", () => {
    const initialAgent = directory.agents[0];
    if (!initialAgent) throw new Error("fixture requires an initial agent");
    let state = reduceApp(createInitialState(), {
      type: "directory",
      update: { type: "snapshot", snapshot: directory },
    });
    state = reduceApp(state, { type: "select-agent", agentId: "agent-a" });
    state = reduceApp(state, {
      type: "timeline",
      update: {
        type: "replaced",
        agentId: "agent-a",
        epoch: "epoch-2",
        items: [
          event(1, {
            type: "permission",
            id: "permission",
            request: { id: "p1", agentId: "agent-a", title: "Run command" },
          }),
        ],
      },
    });
    state = reduceApp(state, {
      type: "directory",
      update: {
        type: "agent-upserted",
        agent: {
          ...initialAgent,
          status: "idle",
          pendingPermissions: [{ id: "p1", agentId: "agent-a", title: "Run command" }],
        },
      },
    });
    state = reduceApp(state, {
      type: "permission-resolved",
      agentId: "agent-a",
      requestId: "p1",
      allow: true,
    });
    expect(state.timeline.epoch).toBe("epoch-2");
    expect(state.timeline.items[0]?.item).toMatchObject({ type: "permission", resolved: true });
    expect(state.directory.agents[0]?.pendingPermissions).toEqual([]);
    expect(state.timeline.items.find((entry) => entry.item.type === "turn")).toBeUndefined();
  });

  it("prunes agents and clears the focused timeline when their workspace is removed", () => {
    let state = reduceApp(createInitialState(), {
      type: "directory",
      update: { type: "snapshot", snapshot: directory },
    });
    state = reduceApp(state, { type: "select-agent", agentId: "agent-a" });
    state = reduceApp(state, {
      type: "directory",
      update: { type: "workspace-removed", workspaceId: "workspace-a" },
    });

    expect(state.directory.agents.map((agent) => agent.id)).toEqual(["agent-b"]);
    expect(state.selectedAgentId).toBeUndefined();
    expect(state.timeline).toEqual({ items: [], loading: false });
  });
});
