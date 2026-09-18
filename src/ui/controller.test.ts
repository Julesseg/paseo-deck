import { describe, expect, it } from "vitest";

import type { AppState } from "../contracts/app-state.js";
import { emptyDirectory } from "../contracts/app-state.js";
import { DeckController } from "./controller.js";

function makeState(): AppState {
  return {
    connection: "connected",
    directory: {
      ...emptyDirectory(),
      workspaces: [{ id: "w", title: "Workspace", directory: "/w", archived: false }],
      agents: [
        {
          id: "a",
          workspaceId: "w",
          title: "Agent",
          status: "idle",
          availableModeIds: ["plan"],
          availableThinkingLevels: ["low", "high"],
          pendingPermissions: [{ id: "permission", agentId: "a", title: "Read file" }],
          needsAttention: false,
          archived: false,
        },
      ],
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          ready: true,
          modeIds: ["plan"],
          models: [{ id: "gpt", name: "GPT", selectable: true, thinkingLevels: ["high"] }],
        },
      ],
    },
    expandedIds: new Set(["w"]),
    selectedWorkspaceId: "w",
    selectedAgentId: "a",
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
}

describe("DeckController keyboard seam", () => {
  it.each([
    ["x", "stop"],
    ["A", "archive"],
    ["d", "detach"],
  ] as const)("requires confirmation before %s operation", (key, action) => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => makeState(),
      (intent) => intents.push(intent),
    );

    controller.handleKey(key);

    expect(intents).toContainEqual({ type: "open-confirmation", action, agentId: "a" });
    expect(intents).not.toContainEqual(expect.objectContaining({ type: "command" }));
  });

  it("emits explicit allow and deny permission intents", () => {
    const intents: unknown[] = [];
    const permission = { id: "permission", agentId: "a", title: "Read file" };
    const controller = new DeckController(
      () => ({
        ...makeState(),
        modal: {
          type: "permission",
          request: permission,
        },
      }),
      (intent) => intents.push(intent),
    );

    controller.handleKey("a");
    controller.handleKey("d");

    expect(intents).toContainEqual({
      type: "respond-permission",
      agentId: "a",
      requestId: "permission",
      allow: true,
    });
    expect(intents).toContainEqual({
      type: "respond-permission",
      agentId: "a",
      requestId: "permission",
      allow: false,
    });
  });

  it("starts provider/model creation only for a selected workspace", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => makeState(),
      (intent) => intents.push(intent),
    );

    controller.handleKey("n");

    expect(intents).toContainEqual({
      type: "open-create-agent",
      workspaceId: "w",
      step: "provider",
    });
  });

  it("exposes tree triage controls outside editable fields", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => makeState(),
      (intent) => intents.push(intent),
    );

    controller.handleKey("o");
    controller.handleKey("v");
    controller.handleKey("!");

    expect(intents).toEqual([
      { type: "toggle-tree-order" },
      { type: "toggle-archived" },
      { type: "toggle-attention-only" },
    ]);
  });

  it("emits bounded tree-width adjustment intents outside editable fields", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => makeState(),
      (intent) => intents.push(intent),
    );

    controller.handleKey("[");
    controller.handleKey("]");

    expect(intents).toEqual([
      { type: "adjust-tree-width", delta: -2 },
      { type: "adjust-tree-width", delta: 2 },
    ]);
  });

  it("keeps global bindings away from editable fields", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({ ...makeState(), modal: { type: "rename", agentId: "a", value: "" } }),
      (intent) => intents.push(intent),
    );

    expect(controller.handleKey("q")).toBe(false);
    expect(intents).toEqual([]);
  });

  it("treats raw-mode Ctrl+C as a global quit even while editing", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({ ...makeState(), modal: { type: "rename", agentId: "a", value: "draft" } }),
      (intent) => intents.push(intent),
    );

    expect(controller.handleKey("\u0003")).toBe(true);
    expect(intents).toEqual([{ type: "quit" }]);
  });

  it("does not turn composer text into global shortcuts", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({ ...makeState(), focus: "composer" }),
      (intent) => intents.push(intent),
    );

    expect(controller.handleKey("x")).toBe(false);
    expect(controller.handleKey("q")).toBe(false);
    expect(intents).toEqual([]);
  });

  it("routes timeline navigation and Enter to a timeline-local selection", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({
        ...makeState(),
        focus: "timeline",
        timeline: {
          recoveryRevision: 0,
          loading: false,
          items: [
            {
              epoch: "e",
              sequence: 1,
              item: { id: "reasoning", type: "reasoning", text: "private thought" },
            },
          ],
        },
      }),
      (intent) => intents.push(intent),
    );

    controller.handleKey("j");
    controller.handleKey("\r");

    expect(intents).toContainEqual({ type: "move-timeline-selection", direction: 1 });
    expect(intents).toContainEqual({ type: "toggle-selected-timeline-item" });
    expect(intents).not.toContainEqual({ type: "select-or-open" });
  });

  it("opens source search and copy only from the timeline outside editors", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({ ...makeState(), focus: "timeline" }),
      (intent) => intents.push(intent),
    );

    controller.handleKey("\u0006");
    controller.handleKey("y");

    expect(intents).toEqual([{ type: "open-timeline-search" }, { type: "open-timeline-copy" }]);
  });

  it("treats arrows and g/G as their Vim navigation equivalents outside editors", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => makeState(),
      (intent) => intents.push(intent),
    );

    controller.handleKey("\u001b[A");
    controller.handleKey("\u001b[B");
    controller.handleKey("\u001b[D");
    controller.handleKey("\u001b[C");
    controller.handleKey("g");
    controller.handleKey("G");

    expect(intents).toEqual([
      { type: "select-next", direction: -1 },
      { type: "select-next", direction: 1 },
      { type: "collapse-or-expand", direction: -1 },
      { type: "collapse-or-expand", direction: 1 },
      { type: "select-boundary", boundary: "start" },
      { type: "select-boundary", boundary: "end" },
    ]);
  });

  it("keeps timeline g/G local while text editors retain arrow keys", () => {
    const timelineIntents: unknown[] = [];
    const timeline = new DeckController(
      () => ({ ...makeState(), focus: "timeline" }),
      (intent) => timelineIntents.push(intent),
    );
    timeline.handleKey("g");
    timeline.handleKey("G");
    timeline.handleKey("\u001b[A");

    const composer = new DeckController(
      () => ({ ...makeState(), focus: "composer" }),
      () => undefined,
    );
    expect(composer.handleKey("\u001b[A")).toBe(false);

    expect(timelineIntents).toEqual([
      { type: "move-timeline-selection-boundary", boundary: "start" },
      { type: "move-timeline-selection-boundary", boundary: "end" },
      { type: "move-timeline-selection", direction: -1 },
    ]);
  });

  it("uses focus-scoped bracket pairs for turns and errors without leaking into editors", () => {
    const intents: unknown[] = [];
    const timeline = new DeckController(
      () => ({ ...makeState(), focus: "timeline" }),
      (intent) => intents.push(intent),
    );
    timeline.handleKey("[");
    timeline.handleKey("]");
    timeline.handleKey("{");
    timeline.handleKey("}");
    const composer = new DeckController(
      () => ({ ...makeState(), focus: "composer" }),
      () => undefined,
    );

    expect(composer.handleKey("[")).toBe(false);
    expect(intents).toEqual([
      { type: "move-timeline-landmark", direction: -1, kind: "turn" },
      { type: "move-timeline-landmark", direction: 1, kind: "turn" },
      { type: "move-timeline-landmark", direction: -1, kind: "error" },
      { type: "move-timeline-landmark", direction: 1, kind: "error" },
    ]);
  });

  it("cycles focus forward and backward with Tab", () => {
    let current = makeState();
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => current,
      (intent) => {
        intents.push(intent);
        if (intent.type === "set-focus") current = { ...current, focus: intent.focus };
      },
    );

    controller.handleKey("\t");
    controller.handleKey("\t");
    controller.handleKey("\t");
    controller.handleKey("\u001b[Z");

    expect(intents).toEqual([
      { type: "set-focus", focus: "timeline" },
      { type: "set-focus", focus: "composer" },
      { type: "set-focus", focus: "tree" },
      { type: "set-focus", focus: "composer" },
    ]);
  });

  it("escapes composer editing without discarding its text", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({
        ...makeState(),
        focus: "composer",
        composer: { ...makeState().composer, drafts: { a: "keep this" } },
      }),
      (intent) => intents.push(intent),
    );

    expect(controller.handleKey("\u001b")).toBe(true);
    expect(intents).toEqual([{ type: "set-focus", focus: "tree" }]);
  });

  it("uses up and down for selected-agent prompt history while composing", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({ ...makeState(), focus: "composer" }),
      (intent) => intents.push(intent),
    );

    expect(controller.handleKey("\u0010")).toBe(true);
    expect(controller.handleKey("\u000e")).toBe(true);
    expect(intents).toEqual([
      { type: "navigate-composer-history", direction: -1 },
      { type: "navigate-composer-history", direction: 1 },
    ]);
  });

  it("leaves plain up and down available to the multiline editor", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({ ...makeState(), focus: "composer" }),
      (intent) => intents.push(intent),
    );

    expect(controller.handleKey("\u001b[A")).toBe(false);
    expect(controller.handleKey("\u001b[B")).toBe(false);
    expect(intents).toEqual([]);
  });

  it("opens notification details only when they exist", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({
        ...makeState(),
        notification: { kind: "error", message: "Disconnected", detail: "socket closed" },
      }),
      (intent) => intents.push(intent),
    );

    controller.handleKey("E");

    expect(intents).toContainEqual({
      type: "open-error-details",
      message: "Disconnected",
      detail: "socket closed",
    });
  });
});
