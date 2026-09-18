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
    focus: "tree",
    modal: { type: "none" },
    timeline: { items: [], loading: false },
    composerText: "",
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

  it("keeps global bindings away from editable fields", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({ ...makeState(), modal: { type: "rename", agentId: "a", value: "" } }),
      (intent) => intents.push(intent),
    );

    expect(controller.handleKey("q")).toBe(false);
    expect(intents).toEqual([]);
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

  it("escapes composer editing without discarding its text", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({ ...makeState(), focus: "composer", composerText: "keep this" }),
      (intent) => intents.push(intent),
    );

    expect(controller.handleKey("\u001b")).toBe(true);
    expect(intents).toEqual([{ type: "set-focus", focus: "tree" }]);
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
