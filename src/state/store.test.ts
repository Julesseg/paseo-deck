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
      composerText: "keep this",
      modal: { type: "help" },
    });
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
