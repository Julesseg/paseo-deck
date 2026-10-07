import { describe, expect, it } from "vitest";

import type { AppState } from "../contracts/app-state.js";
import { emptyDirectory } from "../contracts/app-state.js";
import { DeckController } from "./controller.js";

function makeState(): AppState {
  return {
    connection: "connected",
    tabOrder: {},
    activeTabIds: {},
    sessionDrafts: {},
    recovery: { attempt: 0, directoryStale: false, timelineStale: false },
    notifications: [],
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

describe("DeckController keyboard seam", () => {
  it("opens New Tab only in normal mode outside the sidebar and modal", () => {
    const intents: unknown[] = [];
    let state = { ...makeState(), focus: "composer" as const, composerMode: "normal" as const };
    const controller = new DeckController(
      () => state,
      (intent) => intents.push(intent),
    );
    controller.invokeCommand("new-tab");
    expect(intents).toEqual([{ type: "open-new-tab", workspaceId: "w" }]);
    for (const variant of [
      { focus: "composer" as const, composerMode: "insert" as const },
      { focus: "composer" as const, composerMode: "visual" as const },
      { focus: "tree" as const, composerMode: "normal" as const },
      { focus: "timeline" as const, timelineMode: "visual" as const },
      {
        focus: "composer" as const,
        modal: { type: "create-agent" as const, workspaceId: "w", step: "prompt" as const },
      },
    ]) {
      state = { ...makeState(), ...variant } as typeof state;
      controller.handleKey("T");
    }
    expect(intents).toHaveLength(1);
  });

  it("lets the New Tab and setting pickers own their filter input", () => {
    const intents: unknown[] = [];
    let state: AppState = {
      ...makeState(),
      focus: "composer" as const,
      composerMode: "normal" as const,
      modal: { type: "new-tab" as const, workspaceId: "w" },
    };
    const controller = new DeckController(
      () => state,
      (intent) => intents.push(intent),
    );
    expect(controller.handleKey("i")).toBe(false);
    state = {
      ...state,
      modal: { type: "draft-setting", workspaceId: "w", setting: "model" },
    };
    expect(controller.handleKey("m")).toBe(false);
    expect(intents).toEqual([]);
  });

  it("keeps New Tab unavailable during direct Terminal input through the command palette", () => {
    const intents: unknown[] = [];
    const state: AppState = {
      ...makeState(),
      focus: "timeline",
      activeTerminalId: "terminal",
      terminalLines: { terminal: ["$ "] },
    };
    const controller = new DeckController(
      () => state,
      (intent) => intents.push(intent),
    );
    expect(controller.invokeCommand("new-tab")).toBe(false);
    controller.handleKey("T");
    expect(intents).toEqual([{ type: "terminal-input", data: "T" }]);
  });

  it("routes palette discard to the workspace draft from active or background tabs", () => {
    const intents: unknown[] = [];
    const state = {
      ...makeState(),
      focus: "composer" as const,
      composerMode: "normal" as const,
      activeTabIds: { w: "draft:w" as const },
      sessionDrafts: { w: { prompt: "hello" } },
    };
    const controller = new DeckController(
      () => state,
      (intent) => intents.push(intent),
    );
    controller.invokeCommand("discard-draft");
    expect(intents).toEqual([{ type: "discard-session-draft", workspaceId: "w" }]);
    const backgroundState: AppState = {
      ...state,
      activeTabIds: { w: "session:a" },
      focus: "timeline",
    };
    const backgroundController = new DeckController(
      () => backgroundState,
      (intent) => intents.push(intent),
    );
    backgroundController.invokeCommand("discard-draft");
    expect(intents.at(-1)).toEqual({ type: "discard-session-draft", workspaceId: "w" });
  });
  it("Sidebar does not own tab navigation sequences or counts", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => makeState(),
      (intent) => intents.push(intent),
    );
    for (const key of ["3", "g", "t", "g", "T"]) controller.handleKey(key);
    expect(intents).not.toContainEqual({ type: "switch-tab", direction: 1, count: 3 });
    expect(intents).not.toContainEqual({ type: "switch-tab", direction: -1 });
  });
  it("Terminal tab sequences are literal while Timeline Normal owns them", () => {
    const intents: unknown[] = [];
    let current: AppState = { ...makeState(), focus: "timeline", activeTerminalId: "terminal-1" };
    const controller = new DeckController(
      () => current,
      (intent) => intents.push(intent),
    );
    const input = ["3", "g", "t", "g", "T"];
    for (const key of input) controller.handleKey(key);
    expect(intents).toEqual(input.map((data) => ({ type: "terminal-input", data })));
    const { activeTerminalId: _activeTerminalId, ...sessionState } = current;
    current = sessionState;
    for (const key of ["g", "t"]) controller.handleKey(key);
    expect(intents.at(-1)).toEqual({ type: "switch-tab", direction: 1 });
  });
  it("Ctrl-S leaves direct Terminal input and Sidebar Escape returns", () => {
    const intents: unknown[] = [];
    let current: AppState = { ...makeState(), focus: "timeline", activeTerminalId: "terminal-1" };
    const controller = new DeckController(
      () => current,
      (intent) => {
        intents.push(intent);
        if (intent.type === "set-focus") current = { ...current, focus: intent.focus };
      },
    );
    controller.handleKey("\u0013");
    controller.handleKey("\u001b");
    expect(intents).toEqual([
      { type: "set-focus", focus: "tree" },
      { type: "set-focus", focus: "timeline" },
    ]);
  });
  it("uses global controls for region transitions", () => {
    const intents: unknown[] = [];
    let current: AppState = { ...makeState(), focus: "composer", composerMode: "normal" };
    const controller = new DeckController(
      () => current,
      (intent) => {
        intents.push(intent);
        if (intent.type === "set-focus") current = { ...current, focus: intent.focus };
        if (intent.type === "set-composer-mode")
          current = { ...current, composerMode: intent.mode };
      },
    );
    expect(controller.handleKey("i")).toBe(false);
    controller.handleKey("\u0013");
    controller.handleKey("\u001b");
    controller.handleKey("\u000b");
    expect(intents).toEqual([
      { type: "set-focus", focus: "tree" },
      { type: "set-focus", focus: "composer" },
      { type: "set-focus", focus: "timeline" },
    ]);
  });

  it("scrolls Timeline from every region with Ctrl-U", () => {
    for (const focus of ["composer", "tree", "timeline"] as const) {
      const intents: unknown[] = [];
      new DeckController(
        () => ({
          ...makeState(),
          focus,
          ...(focus === "composer" ? { composerMode: "normal" as const } : {}),
        }),
        (intent) => intents.push(intent),
      ).handleKey("\u0015");
      expect(intents).toEqual([{ type: "scroll-timeline", direction: -1 }]);
    }
  });

  it("keeps ordinary text literal in composer insert mode", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({ ...makeState(), focus: "composer", composerMode: "insert" }),
      (intent) => intents.push(intent),
    );
    expect(controller.handleKey("q")).toBe(false);
    expect(controller.handleKey("r")).toBe(false);
    expect(controller.handleKey("?")).toBe(false);
    expect(intents).toEqual([]);
    expect(controller.handleKey("\u0003")).toBe(true);
    expect(intents).toEqual([{ type: "quit" }]);
  });

  it("routes composer Vim editing keys to its buffer before session commands", () => {
    for (const mode of ["normal", "visual"] as const) {
      const intents: unknown[] = [];
      const controller = new DeckController(
        () => ({ ...makeState(), focus: "composer", composerMode: mode }),
        (intent) => intents.push(intent),
      );
      for (const key of ["h", "j", "k", "l", "w", "b", "0", "$", "x", "d", "a", "A", "I", "O"])
        expect(controller.handleKey(key)).toBe(false);
      if (mode === "visual") {
        for (const key of ["i", "n", "t", "d", "c", "y"])
          expect(controller.handleKey(key)).toBe(false);
      }
      expect(intents).toEqual([]);
    }
  });

  it("lets the composer own Visual entry and returns to Normal on Escape", () => {
    let current: AppState = { ...makeState(), focus: "composer", composerMode: "normal" };
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => current,
      (intent) => {
        intents.push(intent);
        if (intent.type === "set-composer-mode")
          current = { ...current, composerMode: intent.mode };
      },
    );
    expect(controller.handleKey("v")).toBe(false);
    current = { ...current, composerMode: "visual" };
    controller.handleKey("\u001b");
    expect(intents).toEqual([{ type: "set-composer-mode", mode: "normal" }]);
    expect(current.focus).toBe("composer");
  });

  it.each([
    ["\u0018", "stop"],
    ["\u0001", "archive"],
    ["d", "detach"],
  ] as const)("requires confirmation before %s operation", (key, action) => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () =>
        key === "d" ? makeState() : { ...makeState(), focus: "composer", composerMode: "normal" },
      (intent) => intents.push(intent),
    );

    controller.handleKey(key);

    expect(intents).toContainEqual({ type: "open-confirmation", action, agentId: "a" });
    expect(intents).not.toContainEqual(expect.objectContaining({ type: "command" }));
  });

  it("emits explicit allow and deny permission intents", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({
        ...makeState(),
        modal: {
          type: "permission",
          agentId: "a",
          requestId: "permission",
          queueIndex: 0,
          submitting: false,
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

  it("navigates a permission queue and retries only an explicit failed decision", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({
        ...makeState(),
        modal: {
          type: "permission",
          agentId: "a",
          requestId: "permission",
          queueIndex: 0,
          submitting: false,
          error: "offline",
          lastDecision: "deny",
        },
      }),
      (intent) => intents.push(intent),
    );

    controller.handleKey("h");
    controller.handleKey("l");
    controller.handleKey("r");

    expect(intents).toEqual([
      { type: "move-permission", direction: -1 },
      { type: "move-permission", direction: 1 },
      { type: "retry-permission", agentId: "a", requestId: "permission", allow: false },
    ]);
  });

  it("cancels a permission dialog without sending a decision", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({
        ...makeState(),
        modal: {
          type: "permission",
          agentId: "a",
          requestId: "permission",
          queueIndex: 0,
          submitting: false,
        },
      }),
      (intent) => intents.push(intent),
    );

    controller.handleKey("\u001b");

    expect(intents).toEqual([{ type: "close-modal" }]);
  });

  it("opens the New workspace composer from sidebar c", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => makeState(),
      (intent) => intents.push(intent),
    );

    controller.handleKey("c");

    expect(intents).toContainEqual({ type: "open-new-workspace" });
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

  it("forwards Ctrl+C to a running Terminal", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({
        ...makeState(),
        focus: "timeline",
        activeTerminalId: "terminal-1",
        terminalLines: { "terminal-1": ["$ "] },
      }),
      (intent) => intents.push(intent),
    );

    expect(controller.handleKey("\u0003")).toBe(true);
    expect(intents).toEqual([{ type: "terminal-input", data: "\u0003" }]);
  });

  it("keeps ordinary insert text local while preserving Ctrl-C quit", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({ ...makeState(), focus: "composer", composerMode: "insert" }),
      (intent) => intents.push(intent),
    );

    expect(controller.handleKey("x")).toBe(false);
    expect(controller.handleKey("q")).toBe(false);
    expect(controller.handleKey("\u0003")).toBe(true);
    expect(intents).toEqual([{ type: "quit" }]);
  });

  it("routes timeline navigation while consuming idle Enter", () => {
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

    expect(intents).toContainEqual({ type: "move-timeline-text", key: "j" });
    expect(intents).not.toContainEqual({ type: "move-timeline-text", key: "+" });
    expect(intents).not.toContainEqual({ type: "select-or-open" });
  });

  it("keeps source search and copy inert with an explicit empty timeline", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({ ...makeState(), focus: "timeline" }),
      (intent) => intents.push(intent),
    );

    controller.handleKey("\u0006");
    controller.handleKey("y");

    expect(intents).toEqual([]);
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
    ]);
  });

  it("routes buffer yank, Visual Block, and link commands", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({
        ...makeState(),
        focus: "timeline",
        timeline: {
          recoveryRevision: 0,
          loading: false,
          agentId: "agent",
          items: [
            { epoch: "e", sequence: 1, item: { id: "one", type: "user-message", text: "link" } },
          ],
        },
      }),
      (intent) => intents.push(intent),
    );
    for (const key of ["y", "i", "v", "g", "x", "\u0016"]) controller.handleKey(key);
    expect(intents).toEqual([
      { type: "timeline-yank-object", object: "event" },
      { type: "timeline-open-link" },
      { type: "timeline-visual", selection: "block" },
    ]);
  });

  it("moves through visible timeline lines while timeline metadata is loading", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({
        ...makeState(),
        focus: "timeline",
        timeline: {
          recoveryRevision: 0,
          loading: true,
          items: [
            {
              epoch: "e",
              sequence: 1,
              item: { id: "one", type: "user-message", text: "first\nsecond" },
            },
          ],
        },
      }),
      (intent) => intents.push(intent),
    );

    controller.handleKey("j");
    controller.handleKey("k");
    expect(intents).toEqual([
      { type: "move-timeline-text", key: "j" },
      { type: "move-timeline-text", key: "k" },
    ]);
  });

  it("routes counted and character-find Vim motions inside the timeline", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({
        ...makeState(),
        focus: "timeline",
        timeline: {
          recoveryRevision: 0,
          loading: false,
          items: [
            { epoch: "e", sequence: 1, item: { id: "one", type: "user-message", text: "one two" } },
          ],
        },
      }),
      (intent) => intents.push(intent),
    );
    for (const key of ["3", "j", "W", "g", "e", "f", "o", ";", ",", "H", "\u001b[D", "2", "G"])
      controller.handleKey(key);
    expect(intents).toEqual([
      { type: "move-timeline-text", key: "j", count: 3 },
      { type: "move-timeline-text", key: "W" },
      { type: "move-timeline-text", key: "ge" },
      { type: "timeline-find-character", key: "f", character: "o", count: 1 },
      { type: "timeline-repeat-find", reverse: false },
      { type: "timeline-repeat-find", reverse: true },
      { type: "timeline-viewport-motion", key: "H", count: 1 },
      { type: "move-timeline-text", key: "h" },
      { type: "move-timeline-text", key: "G", count: 2 },
    ]);
  });

  it("uses focus-scoped bracket pairs for turns and errors without leaking into editors", () => {
    const intents: unknown[] = [];
    const timeline = new DeckController(
      () => ({ ...makeState(), focus: "timeline" }),
      (intent) => intents.push(intent),
    );
    for (const key of ["[", "t", "]", "t", "[", "e", "]", "e"]) timeline.handleKey(key);
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

  it("does not cycle focus with Tab or Shift-Tab", () => {
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

    expect(intents).toEqual([]);
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

  it("reserves Ctrl-P for palette and removes Ctrl-N history alias", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({ ...makeState(), focus: "composer", composerMode: "insert" }),
      (intent) => intents.push(intent),
    );

    expect(controller.handleKey("\u0010")).toBe(true);
    expect(controller.handleKey("\u000e")).toBe(false);
    expect(intents).toEqual([{ type: "open-command-palette" }]);
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
        notifications: [{ id: 1, kind: "error", message: "Disconnected", detail: "socket closed" }],
        activeNotificationId: 1,
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

  it("retries the selected recoverable notification without leaking a global key", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({
        ...makeState(),
        activeNotificationId: 4,
        notifications: [{ id: 4, kind: "error", message: "Offline", retry: { type: "reconnect" } }],
      }),
      (intent) => intents.push(intent),
    );

    expect(controller.handleKey("R")).toBe(true);
    expect(intents).toEqual([{ type: "retry-notification", id: 4 }]);
  });

  it("browses notification history and routes selection, details, and retry contextually", () => {
    const intents: unknown[] = [];
    let current: AppState = {
      ...makeState(),
      notifications: [
        { id: 1, kind: "error", failureKind: "protocol", message: "Old", detail: "old detail" },
        {
          id: 2,
          kind: "error",
          failureKind: "command",
          message: "New",
          retry: { type: "operation", token: 8 },
        },
      ],
      activeNotificationId: 1,
      modal: { type: "notifications", index: 0 },
    };
    const controller = new DeckController(
      () => current,
      (intent) => {
        intents.push(intent);
        if (intent.type === "move-notification")
          current = { ...current, activeNotificationId: intent.direction > 0 ? 2 : 1 };
      },
    );

    controller.handleKey("j");
    controller.handleKey("R");
    controller.handleKey("\r");
    current = { ...current, activeNotificationId: 1, modal: { type: "notifications", index: 0 } };
    controller.handleKey("E");

    expect(intents).toContainEqual({ type: "move-notification", direction: 1 });
    expect(intents).toContainEqual({ type: "retry-notification", id: 2 });
    expect(intents).toContainEqual({ type: "select-notification", id: 2 });
    expect(intents).toContainEqual({
      type: "open-error-details",
      message: "Old",
      detail: "old detail",
    });
  });
});
