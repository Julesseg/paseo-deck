import { describe, expect, it, vi } from "vitest";

import type { AppState } from "../contracts/app-state.js";
import { emptyDirectory } from "../contracts/app-state.js";
import type { RenderClock } from "./render-scheduler.js";
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
    treeOrder: "attention",
    showArchived: false,
    attentionOnly: false,
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

class FakeRenderClock implements RenderClock {
  current = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  private nextId = 1;

  now(): number {
    return this.current;
  }
  setTimeout(callback: () => void, delay: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delay, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }
  advance(milliseconds: number): void {
    this.current += milliseconds;
    for (const [id, timer] of this.timers) {
      if (timer.at > this.current) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
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
  it("keeps a streaming timeline following its newest content", async () => {
    const terminal = new RecordingTerminal(80, 12);
    const deck = new DeckTui(terminal, { ...state(), focus: "timeline" }, () => undefined);
    deck.start();
    for (let count = 1; count <= 20; count += 1) {
      deck.update({
        ...state(),
        focus: "timeline",
        timeline: {
          loading: false,
          items: Array.from({ length: count }, (_, sequence) => ({
            epoch: "stream",
            sequence,
            item: {
              id: `stream-${sequence}`,
              type: "assistant-message" as const,
              messageId: `stream-${sequence}`,
              text: `Newest ${sequence}`,
            },
          })),
        },
      });
    }
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("Newest 19");
  });

  it("brings explicit timeline boundaries and metadata-height tree selection into view", async () => {
    const terminal = new RecordingTerminal(80, 12);
    const base = state();
    const agents = Array.from({ length: 12 }, (_, index) => ({
      id: `agent-${index}`,
      workspaceId: "workspace",
      title: `Agent ${index}`,
      status: "idle" as const,
      providerId: "openai",
      modelId: "gpt",
      lastActivityAt: "2026-09-18T10:30:00Z",
      availableModeIds: [],
      availableThinkingLevels: [],
      pendingPermissions: [],
      needsAttention: false,
      archived: false,
    }));
    const treeState: AppState = {
      ...base,
      directory: {
        ...base.directory,
        projects: [{ id: "project", name: "Deck" }],
        workspaces: [
          {
            id: "workspace",
            projectId: "project",
            title: "Main",
            directory: "/deck",
            archived: false,
          },
        ],
        agents,
      },
      expandedIds: new Set(["project", "workspace"]),
      selectedAgentId: "agent-11",
    };
    const deck = new DeckTui(terminal, state(), () => undefined);
    deck.start();
    const { selectedAgentId: _selectedAgentId, ...unselectedTreeState } = treeState;
    deck.update(unselectedTreeState);
    await terminal.waitForRender();
    deck.update(treeState);
    await terminal.waitForRender();
    const treeViewport = terminal.viewport().slice(0, 8).join("\n");
    expect(treeViewport).toContain("Agent 11");
    expect(treeViewport).toContain("openai/gpt · 09/18 10:30");

    const timelineState: AppState = {
      ...treeState,
      focus: "timeline",
      timeline: {
        loading: false,
        items: Array.from({ length: 20 }, (_, sequence) => ({
          epoch: "timeline",
          sequence,
          item: {
            id: `event-${sequence}`,
            type: "user-message" as const,
            text: `Event ${sequence}`,
          },
        })),
      },
    };
    deck.update(timelineState);
    terminal.sendInput("G");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Event 19");
    terminal.sendInput("g");
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("Event 0");
  });

  it("makes focused panes and their contextual footer ASCII-visible", async () => {
    const terminal = new RecordingTerminal(100, 16);
    const deck = new DeckTui(terminal, state(), () => undefined);

    deck.start();
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("[TREE] Projects / workspaces");
    expect(terminal.viewport().join("\n")).toContain("Tree: ↑↓ ←→ g/G Tab");
    deck.update({ ...state(), focus: "timeline" });
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("[TIMELINE] Selected agent timeline");
    expect(terminal.viewport().join("\n")).toContain("Timeline: ↑↓ g/G Enter Tab");
    deck.update({ ...state(), focus: "composer" });
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("[COMPOSER] Prompt");
    expect(terminal.viewport().join("\n")).toContain("Composer: Esc Ctrl-P/N Enter");
  });

  it("keeps a named shortcut hint in the narrow supported footer", async () => {
    const terminal = new RecordingTerminal(30, 12);
    const deck = new DeckTui(terminal, state(), () => undefined);

    deck.start();
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("Tree j/k Tab · connected");
  });

  it("recovers the exact session shell after repeated minimum-size resize cycles", async () => {
    const terminal = new RecordingTerminal(80, 16);
    const base = state();
    const preserved: AppState = {
      ...base,
      selectedAgentId: "agent",
      expandedIds: new Set(["project", "workspace"]),
      focus: "composer",
      composer: { ...base.composer, drafts: { agent: "Keep this draft" } },
      timeline: {
        loading: false,
        items: Array.from({ length: 20 }, (_, sequence) => ({
          epoch: "resize",
          sequence,
          item: {
            id: `event-${sequence}`,
            type: "user-message" as const,
            text: `Event ${sequence}`,
          },
        })),
      },
      directory: {
        ...base.directory,
        projects: [{ id: "project", name: "Deck" }],
        workspaces: [
          {
            id: "workspace",
            projectId: "project",
            title: "Main",
            directory: "/deck",
            archived: false,
          },
        ],
        agents: [
          {
            id: "agent",
            workspaceId: "workspace",
            title: "Selected",
            status: "idle",
            availableModeIds: [],
            availableThinkingLevels: [],
            pendingPermissions: [],
            needsAttention: false,
            archived: false,
          },
        ],
      },
    };
    const intents: unknown[] = [];
    const deck = new DeckTui(terminal, preserved, (intent) => intents.push(intent));

    deck.update(preserved);
    deck.start();
    await terminal.waitForRender();
    deck.tui.scrollBy(-3);
    await terminal.waitForRender();
    const scrollTop = deck.tui.viewportTop;
    for (const [columns, rows] of [
      [29, 12],
      [30, 11],
      [80, 16],
      [29, 11],
      [80, 16],
    ] as const) {
      terminal.setSize(columns, rows);
      await terminal.waitForRender();
    }
    const viewport = terminal.viewport().join("\n");
    terminal.sendInput("x");
    await deck.stop();

    expect(viewport).toContain("Selected");
    expect(viewport).toContain("Keep this draft");
    expect(preserved.focus).toBe("composer");
    expect(preserved.selectedAgentId).toBe("agent");
    expect(preserved.expandedIds).toEqual(new Set(["project", "workspace"]));
    expect(deck.tui.viewportTop).toBe(scrollTop);
    expect(intents).toContainEqual({ type: "set-composer-text", text: "Keep this draftx" });
  });

  it("suspends an open overlay at minimum size and restores it from retained state", async () => {
    const terminal = new RecordingTerminal(80, 16);
    const modalState: AppState = { ...state(), modal: { type: "help" } };
    const deck = new DeckTui(terminal, state(), () => undefined);

    deck.start();
    deck.update(modalState);
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Paseo Deck keys");
    terminal.setSize(29, 12);
    await terminal.waitForRender();
    const minimumViewport = terminal.viewport().join("\n");
    expect(minimumViewport).toContain("Terminal too small");
    expect(minimumViewport).not.toContain("Paseo Deck keys");
    terminal.setSize(80, 16);
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("Paseo Deck keys");
    expect(modalState.modal).toEqual({ type: "help" });
  });

  it("shows a stable minimum-size screen at each unsupported threshold", async () => {
    const terminal = new RecordingTerminal(29, 12);
    const deck = new DeckTui(terminal, state(), () => undefined);

    deck.start();
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Terminal too small");
    expect(terminal.viewport().every((line) => terminalDisplayWidth(line) <= 29)).toBe(true);
    terminal.setSize(30, 11);
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Terminal too small");
    expect(terminal.viewport().every((line) => terminalDisplayWidth(line) <= 30)).toBe(true);
    terminal.setSize(30, 12);
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Prompt");
    await deck.stop();
  });
  it("shows tree counts and agent metadata only when the tree has room", async () => {
    const terminal = new RecordingTerminal(100, 16);
    const base = state();
    const treeState: AppState = {
      ...base,
      directory: {
        ...base.directory,
        projects: [{ id: "project", name: "Deck" }],
        workspaces: [
          {
            id: "workspace",
            projectId: "project",
            title: "Main",
            directory: "/deck",
            archived: false,
          },
        ],
        agents: [
          {
            id: "agent",
            workspaceId: "workspace",
            title: "Build",
            status: "running",
            providerId: "openai",
            modelId: "gpt",
            lastActivityAt: "2026-09-18T10:30:00Z",
            availableModeIds: [],
            availableThinkingLevels: [],
            pendingPermissions: [{ id: "permission", agentId: "agent", title: "Review" }],
            needsAttention: true,
            archived: false,
          },
        ],
      },
      expandedIds: new Set(["project", "workspace"]),
    };
    const deck = new DeckTui(terminal, treeState, () => undefined);

    deck.start();
    await terminal.waitForRender();
    const wideViewport = terminal.viewport().join("\n");
    expect(wideViewport).toContain("1 agent");
    expect(wideViewport).toContain("!1");
    expect(wideViewport).toContain("openai/gpt");
    expect(wideViewport).toContain("09/18 10:30");
    terminal.setSize(42, 16);
    await terminal.waitForRender();
    const narrowViewport = terminal.viewport().join("\n");
    expect(narrowViewport).not.toContain("!1");
    expect(narrowViewport).not.toContain("openai/gpt");
    expect(narrowViewport).not.toContain("09/18 10:30");
    await deck.stop();
  });

  it("batches streamed redraws while rendering the latest delta and focus change promptly", async () => {
    const terminal = new RecordingTerminal(80, 16);
    const clock = new FakeRenderClock();
    const deck = new DeckTui(terminal, state(), () => undefined, { renderClock: clock });
    const requestRender = vi.spyOn(deck.tui, "requestRender");
    const streamed = (text: string): AppState => ({
      ...state(),
      timeline: {
        loading: false,
        items: [
          {
            epoch: "e",
            sequence: 1,
            item: {
              id: "message",
              type: "assistant-message",
              messageId: "message",
              text,
            },
          },
        ],
      },
    });

    deck.start();
    await terminal.waitForRender();
    requestRender.mockClear();
    deck.update(streamed("first"));
    deck.update(streamed("second"));
    const latest = streamed("latest");
    deck.update(latest);
    expect(requestRender).toHaveBeenCalledTimes(1);

    clock.advance(16);
    await terminal.waitForRender();
    expect(requestRender).toHaveBeenCalledTimes(2);
    expect(terminal.viewport().join("\n")).toContain("latest");

    deck.update({ ...latest, focus: "composer" });
    expect(requestRender).toHaveBeenCalledTimes(3);
    await deck.stop();
  });

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
        notification: { kind: "info", message: "Directory refreshed." },
      },
      () => undefined,
    );

    deck.start();
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain(
      "ready/one · plan · low · context 15/100 · in 12 · out 3",
    );
    expect(terminal.viewport().join("\n")).toContain("Tree: ↑↓ ←→ g/G Tab");
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

  it("lists session triage keys in help", async () => {
    const terminal = new RecordingTerminal();
    const deck = new DeckTui(terminal, { ...state(), modal: { type: "help" } }, () => undefined);

    deck.start();
    await terminal.waitForRender();
    deck.update({ ...state(), modal: { type: "help" } });
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("o order · v archived · ! attention-only");
    await deck.stop();
  });

  it("lists bounded tree-width keys in help", async () => {
    const terminal = new RecordingTerminal();
    const deck = new DeckTui(terminal, state(), () => undefined);

    deck.start();
    deck.update({ ...state(), modal: { type: "help" } });
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("[ / ] tree width (18–48)");
  });

  it("applies tree-width keys locally and restores the expanded tree view", async () => {
    const terminal = new RecordingTerminal(80, 16);
    const base = state();
    const intents: unknown[] = [];
    const resizedState: AppState = {
      ...base,
      focus: "tree",
      selectedAgentId: "agent",
      composer: { ...base.composer, drafts: { agent: "draft" } },
      directory: {
        ...base.directory,
        projects: [{ id: "project", name: "Deck" }],
        workspaces: [
          {
            id: "workspace",
            projectId: "project",
            title: "Main",
            directory: "/deck",
            archived: false,
          },
        ],
        agents: [
          {
            id: "agent",
            workspaceId: "workspace",
            title: "Build",
            status: "idle",
            providerId: "openai",
            modelId: "gpt",
            availableModeIds: [],
            availableThinkingLevels: [],
            pendingPermissions: [],
            needsAttention: false,
            archived: false,
          },
        ],
      },
      expandedIds: new Set(["project", "workspace"]),
    };
    const deck = new DeckTui(terminal, resizedState, (intent) => intents.push(intent));

    deck.start();
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("openai/gpt");
    for (let index = 0; index < 50; index += 1) terminal.sendInput("[");
    await terminal.waitForRender();
    const narrowTree = terminal.viewport().slice(0, 8).join("\n");
    expect(narrowTree).not.toContain("openai/gpt");
    expect(narrowTree).toContain("No timeline selected");
    for (let index = 0; index < 50; index += 1) terminal.sendInput("]");
    await terminal.waitForRender();
    const wideTree = terminal.viewport().slice(0, 8).join("\n");
    expect(wideTree).toContain("openai/gpt");
    expect(wideTree).toContain("No timeline selected");
    deck.update({ ...resizedState, focus: "composer" });
    terminal.sendInput("x");
    await deck.stop();

    expect(intents).toContainEqual({ type: "set-composer-text", text: "draftx" });
  });
});
