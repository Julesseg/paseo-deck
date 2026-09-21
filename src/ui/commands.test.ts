import { describe, expect, it } from "vitest";

import type { AppState } from "../contracts/app-state.js";
import { emptyDirectory } from "../contracts/app-state.js";
import {
  commandById,
  commandForKey,
  contextualHelp,
  deckCommands,
  resolvedCommands,
} from "./commands.js";
import { DeckController } from "./controller.js";

function state(): AppState {
  return {
    connection: "connected",
    recovery: { attempt: 0, directoryStale: false, timelineStale: false },
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
          availableThinkingLevels: ["low"],
          pendingPermissions: [],
          needsAttention: false,
          archived: false,
        },
      ],
    },
    selectedWorkspaceId: "w",
    selectedAgentId: "a",
    expandedIds: new Set(),
    filter: "",
    treeOrder: "attention",
    showArchived: false,
    attentionOnly: false,
    focus: "tree",
    modal: { type: "none" },
    timeline: { recoveryRevision: 0, items: [], loading: false },
    timelineNavigation: {},
    creationDefaults: {},
    notifications: [],
    composer: {
      drafts: { a: "keep this draft" },
      histories: {},
      historyIndexes: {},
      historyDrafts: {},
      sendingAgentIds: new Set(),
      detachedAgentIds: new Set(),
    },
  };
}

describe("command registry", () => {
  it("exposes preference controls in the command palette", () => {
    expect(resolvedCommands(state()).map((command) => command.id)).toEqual(
      expect.arrayContaining(["toggle-theme", "toggle-symbol-set"]),
    );
  });
  it("has unique ids and shortcut/context pairs", () => {
    expect(new Set(deckCommands.map((command) => command.id)).size).toBe(deckCommands.length);
    const pairs = deckCommands.flatMap((command) =>
      command.shortcuts.map((key) => `${command.contexts?.join(",") ?? "all"}:${key}`),
    );
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("drives the same labels and keys in palette and contextual help", () => {
    const current = state();
    const palette = resolvedCommands(current);
    const help = contextualHelp(current);
    expect(help.map((command) => [command.label, command.shortcuts])).toEqual(
      palette.map((command) => [command.label, command.shortcuts]),
    );
  });

  it("reports selection, connection, capability, permission, and detail unavailability", () => {
    const {
      selectedWorkspaceId: _workspace,
      selectedAgentId: _agent,
      ...withoutSelection
    } = state();
    const disconnected: AppState = { ...withoutSelection, connection: "disconnected" };
    expect(commandById(disconnected, "create-agent")?.disabledReason).toContain("Reconnect");
    expect(commandById(disconnected, "stop-agent")?.disabledReason).toContain("Reconnect");
    expect(commandById(disconnected, "permissions")?.disabledReason).toContain("No pending");
    expect(commandById(disconnected, "error-details")?.disabledReason).toContain("No error");
    expect(
      commandById(
        {
          ...disconnected,
          notifications: [
            { id: 1, kind: "error", message: "Failed", retry: { type: "operation", token: 1 } },
          ],
          activeNotificationId: 1,
        },
        "retry",
      )?.disabledReason,
    ).toContain("Reconnect");
    const base = state();
    const agent = base.directory.agents[0];
    if (!agent) throw new Error("fixture agent missing");
    expect(
      commandById(
        { ...base, directory: { ...base.directory, agents: [{ ...agent, availableModeIds: [] }] } },
        "mode",
      )?.disabledReason,
    ).toContain("No modes");
  });

  it("uses composer-specific controls for model, thinking, and operational mode", () => {
    const current = { ...state(), focus: "composer" as const, composerMode: "normal" as const };
    expect(commandForKey(current, "m")?.disabledReason).toContain("model switching");
    expect(commandForKey(current, "z")?.id).toBe("thinking");
    expect(commandForKey(current, "o")?.id).toBe("operational-mode");
    expect(commandForKey({ ...current, focus: "tree" }, "o")?.id).toBe("toggle-order");
    expect(contextualHelp(current).map((command) => command.id)).toContain("operational-mode");
    expect(contextualHelp(current).map((command) => command.id)).not.toContain("mode");
    expect(
      resolvedCommands(current)
        .filter((command) => command.palette !== false)
        .map((command) => command.id),
    ).not.toContain("mode");
  });

  it("makes a direct key and palette invocation emit the identical confirmation intent", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => state(),
      (intent) => intents.push(intent),
    );
    controller.handleKey("x");
    controller.invokeCommand("stop-agent");
    expect(intents).toEqual([
      { type: "open-confirmation", action: "stop", agentId: "a" },
      { type: "open-confirmation", action: "stop", agentId: "a" },
    ]);
  });

  it("keeps direct and palette retry and error-detail intents identical", () => {
    const current: AppState = {
      ...state(),
      notifications: [
        {
          id: 7,
          kind: "error",
          message: "Failed",
          detail: "safe details",
          retry: { type: "operation", token: 1 },
        },
      ],
      activeNotificationId: 7,
    };
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => current,
      (intent) => intents.push(intent),
    );
    controller.handleKey("R");
    controller.invokeCommand("retry");
    controller.handleKey("E");
    controller.invokeCommand("error-details");
    expect(intents).toEqual([
      { type: "retry-notification", id: 7 },
      { type: "retry-notification", id: 7 },
      { type: "open-error-details", message: "Failed", detail: "safe details" },
      { type: "open-error-details", message: "Failed", detail: "safe details" },
    ]);
  });

  it("resolves Ctrl-K in an editor without leaking normal keys", () => {
    const intents: unknown[] = [];
    const controller = new DeckController(
      () => ({ ...state(), focus: "composer" }),
      (intent) => intents.push(intent),
    );
    expect(controller.handleKey("x")).toBe(false);
    expect(controller.handleKey("\u000b")).toBe(true);
    expect(intents).toEqual([{ type: "open-command-palette" }]);
  });

  it("keeps disabled palette items inert and recomputes availability from current state", () => {
    const { selectedAgentId: _agent, ...noAgent }: AppState = state();
    expect(commandForKey(noAgent, "x")?.disabledReason).toBe("Select an active session first");
    expect(commandForKey(state(), "x")?.disabledReason).toBeUndefined();
    const intents: unknown[] = [];
    new DeckController(
      () => noAgent,
      (intent) => intents.push(intent),
    ).invokeCommand("stop-agent");
    expect(intents).toEqual([]);
  });

  it.each([
    [
      {
        type: "permission" as const,
        agentId: "a",
        requestId: "p",
        queueIndex: 0,
        submitting: false,
      },
      "Allow permission request",
    ],
    [{ type: "confirm" as const, action: "stop" as const, agentId: "a" }, "Confirm dialog action"],
    [{ type: "notifications" as const, index: 0 }, "Next notification"],
    [{ type: "rename" as const, agentId: "a", value: "draft" }, "Edit text"],
    [{ type: "create-agent" as const, workspaceId: "w", step: "provider" as const }, "Edit text"],
  ])("derives dialog help rows from the registry", (modal, label) => {
    expect(contextualHelp({ ...state(), modal }).map((command) => command.label)).toContain(label);
  });

  it.each(["tree", "timeline"] as const)(
    "routes every enabled %s registry shortcut through its exact registry intent",
    (focus) => {
      const base = state();
      const current: AppState = {
        ...base,
        focus,
        timeline: {
          recoveryRevision: 0,
          loading: false,
          items: [
            {
              epoch: "e",
              sequence: 1,
              item: { id: "item", type: "user-message", text: "ready" },
            },
          ],
        },
      };
      for (const command of resolvedCommands(current).filter((item) => !item.disabledReason)) {
        for (const shortcut of command.shortcuts) {
          const input = terminalInput(shortcut);
          if (!input) continue;
          const intents: unknown[] = [];
          new DeckController(
            () => current,
            (intent) => intents.push(intent),
          ).handleKey(input);
          expect(intents, `${focus}:${command.id}:${shortcut}`).toEqual([command.intent(current)]);
        }
      }
    },
  );

  it("routes every permission modal shortcut through its registry intent and locks while submitting", () => {
    const current: AppState = {
      ...state(),
      modal: {
        type: "permission",
        agentId: "a",
        requestId: "p",
        queueIndex: 0,
        submitting: false,
        error: "offline",
        lastDecision: "deny",
      },
    };
    expectRegistryInputs(current, ["a", "d", "h", "\u001b[D", "l", "\u001b[C", "r", "\u001b"]);
    const intents: unknown[] = [];
    const locked = new DeckController(
      () => ({ ...current, modal: { ...current.modal, submitting: true } }),
      (intent) => intents.push(intent),
    );
    expect(locked.handleKey("a")).toBe(true);
    expect(intents).toEqual([]);
  });

  it("routes notification aliases and contextual retry/detail actions through the registry", () => {
    const current: AppState = {
      ...state(),
      modal: { type: "notifications", index: 0 },
      notifications: [
        {
          id: 7,
          kind: "error",
          message: "Failed",
          detail: "safe detail",
          retry: { type: "operation", token: 1 },
        },
      ],
      activeNotificationId: 7,
    };
    expectRegistryInputs(current, ["j", "\u001b[B", "k", "\u001b[A", "\r", "E", "R", "\u001b"]);
  });
});

function expectRegistryInputs(state: AppState, inputs: readonly string[]): void {
  for (const input of inputs) {
    const command = commandForKey(state, input);
    if (!command) throw new Error(`missing command for ${JSON.stringify(input)}`);
    const intents: unknown[] = [];
    new DeckController(
      () => state,
      (intent) => intents.push(intent),
    ).handleKey(input);
    expect(intents, `${command.id}:${JSON.stringify(input)}`).toEqual([command.intent(state)]);
  }
}

function terminalInput(shortcut: string): string | undefined {
  const inputs: Readonly<Record<string, string>> = {
    "Ctrl-K": "\u000b",
    "Cmd-P": "\u001bp",
    "Ctrl-F": "\u0006",
    "Ctrl-C": "\u0003",
    "Shift-Tab": "\u001b[Z",
    Tab: "\t",
    Enter: "\r",
    Up: "\u001b[A",
    Down: "\u001b[B",
    Left: "\u001b[D",
    Right: "\u001b[C",
  };
  return inputs[shortcut] ?? (shortcut.length === 1 ? shortcut : undefined);
}
