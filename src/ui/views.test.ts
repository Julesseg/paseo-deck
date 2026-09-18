import { describe, expect, it } from "vitest";

import type { AppState } from "../contracts/app-state.js";
import { emptyDirectory } from "../contracts/app-state.js";
import { RecordingTerminal } from "./terminal.js";
import { terminalDisplayWidth } from "./text-safety.js";
import { agentChoices, creationChoices, DeckTui, highlightFencedCode } from "./views.js";

function state(): AppState {
  return {
    connection: "connected",
    directory: {
      ...emptyDirectory(),
      providers: [
        {
          id: "ready",
          name: "Ready",
          ready: true,
          modeIds: ["plan"],
          models: [
            { id: "one", name: "One", selectable: true, thinkingLevels: ["low"] },
            { id: "hidden", name: "Hidden", selectable: false, thinkingLevels: [] },
          ],
        },
        {
          id: "not-ready",
          name: "Not ready",
          ready: false,
          modeIds: ["build"],
          models: [{ id: "two", name: "Two", selectable: true, thinkingLevels: ["high"] }],
        },
      ],
    },
    expandedIds: new Set(),
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

describe("creation picker choices", () => {
  it("limits every creation step to the selected provider and model", () => {
    expect(
      creationChoices(state(), { type: "create-agent", workspaceId: "w", step: "provider" }),
    ).toEqual([{ value: "ready", label: "Ready" }]);
    expect(
      creationChoices(state(), {
        type: "create-agent",
        workspaceId: "w",
        step: "model",
        providerId: "ready",
      }),
    ).toEqual([{ value: "one", label: "One" }]);
    expect(
      creationChoices(state(), {
        type: "create-agent",
        workspaceId: "w",
        step: "mode",
        providerId: "ready",
        modelId: "one",
      }),
    ).toEqual([{ value: "plan", label: "plan" }]);
    expect(
      creationChoices(state(), {
        type: "create-agent",
        workspaceId: "w",
        step: "thinking",
        providerId: "ready",
        modelId: "one",
      }),
    ).toEqual([{ value: "low", label: "low" }]);
  });

  it("falls back to provider discovery for an existing agent's mutable choices", () => {
    const base = state();
    const withAgent: AppState = {
      ...base,
      selectedAgentId: "agent",
      directory: {
        ...base.directory,
        agents: [
          {
            id: "agent",
            workspaceId: "workspace",
            title: "Agent",
            status: "idle",
            providerId: "ready",
            modelId: "one",
            availableModeIds: [],
            availableThinkingLevels: [],
            pendingPermissions: [],
            needsAttention: false,
            archived: false,
          },
        ],
      },
    };

    expect(agentChoices(withAgent, "mode")).toEqual([{ value: "plan", label: "plan" }]);
    expect(agentChoices(withAgent, "thinking")).toEqual([{ value: "low", label: "low" }]);
  });
});

describe("fenced code highlighter", () => {
  it("adds restrained ANSI styling without changing code text", () => {
    const [line] = highlightFencedCode('const answer = "READY";', "ts");

    expect(line).toContain("\u001b[");
    expect(line).toContain("const");
    expect(line).toContain("READY");
  });
});

describe("creation prompt", () => {
  it("submits the typed initial prompt as the next creation choice", async () => {
    const terminal = new RecordingTerminal();
    const intents: unknown[] = [];
    const deck = new DeckTui(terminal, state(), (intent) => intents.push(intent));
    deck.update({
      ...state(),
      modal: {
        type: "create-agent",
        workspaceId: "w",
        step: "prompt",
        providerId: "ready",
        modelId: "one",
      },
    });
    deck.start();

    terminal.sendInput("Reply READY");
    terminal.sendInput("\r");
    await deck.stop();

    expect(intents).toContainEqual({ type: "create-choice", choice: "Reply READY" });
  });
});

describe("DeckTui viewport and focus", () => {
  it("names the composer destination and its disabled reason", async () => {
    const terminal = new RecordingTerminal(80, 14);
    const base = state();
    const deck = new DeckTui(
      terminal,
      {
        ...base,
        selectedAgentId: "agent",
        directory: {
          ...base.directory,
          agents: [
            {
              id: "agent",
              workspaceId: "workspace",
              title: "Paused",
              status: "stopped",
              availableModeIds: [],
              availableThinkingLevels: [],
              pendingPermissions: [],
              needsAttention: false,
              archived: false,
            },
          ],
        },
      },
      () => undefined,
    );
    deck.start();
    await terminal.waitForRender();
    await deck.stop();
    expect(terminal.viewport().join("\n")).toContain("Prompt → Paused · stopped");
  });
  it("renders the unsent-draft preservation warning in destructive confirmation", async () => {
    const terminal = new RecordingTerminal(80, 14);
    const deck = new DeckTui(
      terminal,
      {
        ...state(),
        modal: { type: "confirm", action: "archive", agentId: "agent", draftWarning: true },
      },
      () => undefined,
    );
    deck.start();
    deck.update({
      ...state(),
      modal: { type: "confirm", action: "archive", agentId: "agent", draftWarning: true },
    });
    await terminal.waitForRender();
    await deck.stop();
    expect(terminal.viewport().join("\n")).toContain("unsent draft; it will be preserved");
  });
  it("shows mode and token context in the status line when space allows", async () => {
    const terminal = new RecordingTerminal(120, 18);
    const base = state();
    const deck = new DeckTui(
      terminal,
      {
        ...base,
        selectedAgentId: "agent",
        directory: {
          ...base.directory,
          agents: [
            {
              id: "agent",
              workspaceId: "workspace",
              title: "Agent",
              status: "idle",
              providerId: "ready",
              modelId: "one",
              modeId: "plan",
              thinkingLevel: "low",
              availableModeIds: [],
              availableThinkingLevels: [],
              pendingPermissions: [],
              needsAttention: false,
              archived: false,
            },
          ],
        },
        timeline: {
          agentId: "agent",
          loading: false,
          usage: { inputTokens: 12, outputTokens: 3, contextTokens: 15, contextWindow: 100 },
          items: [],
        },
      },
      () => undefined,
    );

    deck.start();
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain(
      "ready/one · plan · low · context 15/100 · in 12 · out 3",
    );
  });

  it("expands the selected collapsed timeline block with Enter", async () => {
    const terminal = new RecordingTerminal(70, 16);
    const deck = new DeckTui(
      terminal,
      {
        ...state(),
        focus: "timeline",
        timeline: {
          loading: false,
          items: [
            {
              epoch: "e",
              sequence: 1,
              item: { id: "reasoning", type: "reasoning", text: "thought ".repeat(50) },
            },
          ],
        },
      },
      () => undefined,
    );

    deck.start();
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("collapsed");
    terminal.sendInput("\r");
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).not.toContain("collapsed");
  });

  it("keeps the real tree, timeline, and composer in a narrow alternate screen", async () => {
    const terminal = new RecordingTerminal(42, 12);
    const deck = new DeckTui(terminal, state(), () => undefined);

    deck.start();
    await terminal.waitForRender();
    terminal.setSize(30, 12);
    await terminal.waitForRender();
    await deck.stop();

    const lines = terminal.viewport();
    expect(lines.join("\n")).toContain("Projects");
    expect(lines.join("\n")).toContain("Timeline");
    expect(lines.join("\n")).toContain("Prompt");
    expect(lines.every((line) => line.length <= 30)).toBe(true);
  });

  it("contains unsafe wide markdown deltas while retaining the surrounding panes", async () => {
    const terminal = new RecordingTerminal(42, 14);
    const base = state();
    const timeline = {
      agentId: "agent",
      loading: false,
      items: [
        {
          epoch: "e",
          sequence: 1,
          item: {
            id: "message",
            type: "assistant-message" as const,
            messageId: "message",
            text: "```ts\n\u001b[2J\tconstVeryLongIdentifier🙂\n```",
          },
        },
      ],
    };
    const deck = new DeckTui(
      terminal,
      {
        ...base,
        selectedAgentId: "agent",
        directory: {
          ...base.directory,
          agents: [
            {
              id: "agent",
              workspaceId: "workspace",
              title: "Streaming",
              status: "running",
              availableModeIds: [],
              availableThinkingLevels: [],
              pendingPermissions: [],
              needsAttention: false,
              archived: false,
            },
          ],
        },
        timeline,
      },
      () => undefined,
    );

    deck.start();
    await terminal.waitForRender();
    const wideLines = terminal.viewport();
    expect(wideLines.join("\n")).toContain("Projects");
    expect(wideLines.join("\n")).toContain("Prompt");
    expect(wideLines.every((line) => terminalDisplayWidth(line) <= 42)).toBe(true);
    terminal.setSize(30, 14);
    deck.update({
      ...base,
      selectedAgentId: "agent",
      directory: {
        ...base.directory,
        agents: [
          {
            id: "agent",
            workspaceId: "workspace",
            title: "Streaming",
            status: "running",
            availableModeIds: [],
            availableThinkingLevels: [],
            pendingPermissions: [],
            needsAttention: false,
            archived: false,
          },
        ],
      },
      timeline: {
        ...timeline,
        items: [
          {
            epoch: "e",
            sequence: 2,
            item: {
              id: "message",
              type: "assistant-message",
              messageId: "message",
              text: "```ts\n\u001b[2J\tconstVeryLongIdentifier🙂e\u0301🇫🇷1️⃣🙂\n```",
            },
          },
        ],
      },
    });
    await terminal.waitForRender();
    await deck.stop();

    const lines = terminal.viewport();
    expect(lines.join("\n")).toContain("Projects");
    expect(lines.join("\n")).toContain("Prompt");
    expect(lines.join("\n")).toContain("connected");
    expect(lines.join("\n")).toContain("␛[2J");
    expect(lines.every((line) => terminalDisplayWidth(line) <= 30)).toBe(true);
  });

  it("restores composer focus after replacing and closing an overlay", async () => {
    const terminal = new RecordingTerminal();
    const intents: unknown[] = [];
    const deck = new DeckTui(terminal, state(), (intent) => intents.push(intent));
    deck.start();
    deck.update({ ...state(), modal: { type: "help" }, focus: "composer" });
    deck.update({ ...state(), modal: { type: "none" }, focus: "composer" });
    terminal.sendInput("x");
    await deck.stop();

    expect(intents).toContainEqual({ type: "set-composer-text", text: "x" });
  });
});
