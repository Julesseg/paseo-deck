import { describe, expect, it, vi } from "vitest";

import type { AppState } from "../contracts/app-state.js";
import { emptyDirectory } from "../contracts/app-state.js";
import type { TimelineEvent } from "../contracts/domain.js";
import { reduceApp } from "../state/store.js";
import type { TerminalAppearance } from "./capabilities.js";
import type { RenderClock } from "./render-scheduler.js";
import { RecordingTerminal } from "./terminal.js";
import { terminalDisplayWidth } from "./text-safety.js";
import { DeckTheme } from "./theme.js";
import {
  agentChoices,
  composerControlRow,
  creationChoices,
  DeckTui,
  highlightFencedCode,
} from "./views.js";

function state(): AppState {
  return {
    connection: "connected",
    tabOrder: {},
    activeTabIds: {},
    recovery: { attempt: 0, directoryStale: false, timelineStale: false },
    notifications: [],
    directory: {
      ...emptyDirectory(),
      workspaces: [{ id: "w", title: "Workspace label", directory: "/workspace", archived: false }],
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
  it.each([
    { step: "provider" as const },
    { step: "model" as const, providerId: "ready" },
    { step: "mode" as const, providerId: "ready", modelId: "one" },
    { step: "thinking" as const, providerId: "ready", modelId: "one" },
  ])("renders the $step creation choice picker as a compact surfaced window", async (form) => {
    const terminal = new RecordingTerminal(100, 28);
    const uiState: AppState = {
      ...state(),
      modal: { type: "create-agent", workspaceId: "w", ...form },
    };
    const deck = new DeckTui(terminal, uiState, () => undefined, {
      appearance: {
        color: "truecolor",
        unicode: true,
        theme: "ember",
        palette: "terminal",
        background: [28, 25, 23],
        symbols: "unicode",
      },
    });
    deck.update(uiState);
    deck.start();
    await terminal.waitForRender();
    const lines = terminal.viewport();
    const top = lines.findIndex((line) =>
      line.includes(`Choose ${form.step === "thinking" ? "thinking level" : form.step}`),
    );
    const left = lines[top]?.indexOf("┌") ?? -1;
    const right = lines[top]?.lastIndexOf("┐") ?? -1;
    const backgrounds = terminal.viewportBackgrounds();
    await deck.stop();

    expect(top).toBeGreaterThan(0);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right - left + 1).toBeLessThan(65);
    expect(lines[top + 1]?.[left]).toBe("│");
    expect(backgrounds[top]?.[left + 1]).toBeDefined();
    expect(lines.join("\n")).not.toContain("Up/Down select");
    expect(lines.join("\n")).not.toContain("Enter choose");
  });

  it.each([
    { type: "mode" as const, title: "Choose mode" },
    { type: "thinking" as const, title: "Choose thinking level" },
  ])(
    "uses the same bordered window and current value for in-session $type controls",
    async ({ type, title }) => {
      const terminal = new RecordingTerminal(100, 28);
      const base = state();
      const uiState: AppState = {
        ...base,
        selectedAgentId: "agent",
        directory: {
          ...base.directory,
          agents: [
            {
              id: "agent",
              workspaceId: "w",
              title: "Agent",
              status: "idle",
              providerId: "ready",
              modelId: "one",
              modeId: "full-access",
              thinkingLevel: "high",
              availableModeIds: ["plan", "full-access"],
              availableThinkingLevels: ["low", "high"],
              pendingPermissions: [],
              needsAttention: false,
              archived: false,
            },
          ],
        },
        modal: { type, agentId: "agent" },
      };
      const deck = new DeckTui(terminal, uiState, () => undefined);
      deck.update(uiState);
      deck.start();
      await terminal.waitForRender();
      const lines = terminal.viewport();
      await deck.stop();

      const top = lines.find((line) => line.includes(title));
      expect(top).toContain("┌");
      expect(top).toContain("┐");
      expect(lines.join("\n")).toContain("│");
      expect(lines.join("\n")).toContain(type === "mode" ? "→ full-access" : "→ high");
    },
  );

  it("keeps a long filtered picker selectable and framed at the smallest supported viewport", async () => {
    const terminal = new RecordingTerminal(52, 12);
    const uiState: AppState = {
      ...state(),
      directory: {
        ...state().directory,
        providers: Array.from({ length: 20 }, (_, index) => ({
          id: `provider-${index}`,
          name: `Provider ${index}`,
          ready: true,
          modeIds: [],
          models: [],
        })),
      },
      modal: { type: "create-agent", workspaceId: "w", step: "provider" },
    };
    const deck = new DeckTui(terminal, uiState, () => undefined);
    deck.update(uiState);
    deck.start();
    for (let index = 0; index < 19; index += 1) terminal.sendInput("\u001b[B");
    await terminal.waitForRender();
    const lines = terminal.viewport();
    await deck.stop();

    expect(lines.join("\n")).toContain("> Provider 19");
    expect(lines.some((line) => line.includes("┌ Choose provider"))).toBe(true);
    expect(lines.some((line) => line.includes("└"))).toBe(true);
    expect(lines.every((line) => terminalDisplayWidth(line) <= 52)).toBe(true);
  });

  it("limits every creation step to the selected provider and model", () => {
    expect(
      creationChoices(state(), { type: "create-agent", workspaceId: "w", step: "provider" }),
    ).toEqual([
      { value: "ready", label: "Ready", disabled: false },
      {
        value: "not-ready",
        label: "Not ready",
        disabled: true,
        description: "unavailable: not ready",
      },
    ]);
    expect(
      creationChoices(state(), {
        type: "create-agent",
        workspaceId: "w",
        step: "model",
        providerId: "ready",
      }),
    ).toEqual([
      { value: "one", label: "One", disabled: false },
      {
        value: "hidden",
        label: "Hidden",
        disabled: true,
        description: "unavailable: not selectable",
      },
    ]);
    expect(
      creationChoices(state(), {
        type: "create-agent",
        workspaceId: "w",
        step: "mode",
        providerId: "ready",
        modelId: "one",
      }),
    ).toEqual([{ value: "plan", label: "plan", disabled: false }]);
    expect(
      creationChoices(state(), {
        type: "create-agent",
        workspaceId: "w",
        step: "thinking",
        providerId: "ready",
        modelId: "one",
      }),
    ).toEqual([{ value: "low", label: "low", disabled: false }]);
  });

  it("marks unavailable choices explicitly instead of deriving disabled state from prose", () => {
    const choices = creationChoices(state(), {
      type: "create-agent",
      workspaceId: "w",
      step: "provider",
    });

    expect(choices).toContainEqual(expect.objectContaining({ value: "not-ready", disabled: true }));
    expect(choices).toContainEqual(expect.objectContaining({ value: "ready", disabled: false }));
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

describe("composer controls", () => {
  it("windows a mixed tab row around the active resource and swaps its content", async () => {
    const terminal = new RecordingTerminal(70, 18);
    const base = state();
    const agents = Array.from({ length: 8 }, (_, index) => ({
      id: `agent-${index + 1}`,
      workspaceId: "w",
      title: `Work-${index + 1}-long-title`,
      status: "idle" as const,
      availableModeIds: [],
      availableThinkingLevels: [],
      pendingPermissions: [],
      needsAttention: false,
      archived: false,
    }));
    const order = [
      ...agents.map((agent) => `session:${agent.id}` as const),
      "terminal:terminal-1" as const,
    ];
    let current: AppState = {
      ...base,
      directory: { ...base.directory, agents },
      selectedWorkspaceId: "w",
      selectedAgentId: "agent-4",
      activeSessionId: "agent-4",
      tabOrder: { w: order },
      activeTabIds: { w: "session:agent-4" },
      workspaceTerminals: {
        w: [{ id: "terminal-1", workspaceId: "w", cwd: "/workspace", name: "build" }],
      },
      timeline: {
        recoveryRevision: 0,
        agentId: "agent-4",
        loading: false,
        items: [
          {
            epoch: "e",
            sequence: 1,
            item: { id: "message", type: "user-message", text: "session sample" },
          },
        ],
      },
    };
    const deck = new DeckTui(terminal, current, () => undefined, {
      appearance: { color: "none", unicode: true, theme: "plain", symbols: "unicode" },
    });
    deck.start();
    await terminal.waitForRender();
    const sessionView = terminal.viewport().join("\n");
    expect(sessionView).toContain("Work-4-long-title");
    expect(sessionView).toContain("session sample");
    expect(sessionView).toMatch(/….*Work-4-long-title.*…/);
    const {
      selectedAgentId: _selectedAgentId,
      activeSessionId: _activeSessionId,
      ...withoutSession
    } = current;
    current = {
      ...withoutSession,
      activeTerminalId: "terminal-1",
      activeTabIds: { w: "terminal:terminal-1" },
      terminalLines: { "terminal-1": ["terminal sample"] },
    };
    deck.update(current);
    await terminal.waitForRender();
    await deck.stop();
    const terminalView = terminal.viewport().join("\n");
    expect(terminalView).toContain("build");
    expect(terminalView).toContain("terminal sample");
    expect(terminalView).toContain("terminal build");
    expect(terminalView).not.toContain("session sample");
    expect(terminalView).not.toContain("Prompt →");
    expect(terminalView).not.toContain("Session activity");
  });

  it("renders separate pills with a distinct active background and no tab rule", async () => {
    const terminal = new RecordingTerminal(100, 28);
    const base = state();
    const agents = ["Atlas", "Harbor"].map((title, index) => ({
      id: `agent-${index}`,
      workspaceId: "w",
      title,
      status: "idle" as const,
      availableModeIds: [],
      availableThinkingLevels: [],
      pendingPermissions: [],
      needsAttention: false,
      archived: false,
    }));
    const deck = new DeckTui(
      terminal,
      {
        ...base,
        directory: { ...base.directory, agents },
        selectedWorkspaceId: "w",
        selectedAgentId: "agent-1",
        activeSessionId: "agent-1",
        tabOrder: { w: ["session:agent-0", "session:agent-1"] },
        activeTabIds: { w: "session:agent-1" },
      },
      () => undefined,
      {
        appearance: {
          color: "truecolor",
          unicode: true,
          theme: "ember",
          palette: "terminal",
          background: [28, 25, 23],
          symbols: "unicode",
        },
      },
    );
    deck.start();
    await terminal.waitForRender();
    const row = terminal.viewport().findIndex((line) => line.includes("Atlas"));
    const line = terminal.viewport()[row] ?? "";
    const backgrounds = terminal.viewportBackgrounds()[row] ?? [];
    await deck.stop();

    expect(line).toContain(" • Atlas   • Harbor ");
    expect(backgrounds[line.indexOf("Atlas")]).toBeDefined();
    expect(backgrounds[line.indexOf("Harbor")]).toBeDefined();
    expect(backgrounds[line.indexOf("Atlas")]).not.toBe(backgrounds[line.indexOf("Harbor")]);
    expect(terminal.viewport()[row + 1]).not.toMatch(/─{5}/);
  });

  it("reserves the trailing ellipsis when one active title fills the strip", async () => {
    const terminal = new RecordingTerminal(70, 18);
    const base = state();
    const agents = ["VeryLong".repeat(20), "Next"].map((title, index) => ({
      id: `agent-${index}`,
      workspaceId: "w",
      title,
      status: "idle" as const,
      availableModeIds: [],
      availableThinkingLevels: [],
      pendingPermissions: [],
      needsAttention: false,
      archived: false,
    }));
    const current: AppState = {
      ...base,
      directory: { ...base.directory, agents },
      selectedWorkspaceId: "w",
      selectedAgentId: "agent-0",
      activeSessionId: "agent-0",
      tabOrder: { w: ["session:agent-0", "session:agent-1"] },
      activeTabIds: { w: "session:agent-0" },
    };
    const deck = new DeckTui(terminal, current, () => undefined, {
      appearance: { color: "none", unicode: true, theme: "plain", symbols: "unicode" },
    });
    deck.start();
    await terminal.waitForRender();
    const tabRow = terminal.viewport().find((line) => line.includes("VeryLong"));
    await deck.stop();
    expect(tabRow).toBeDefined();
    expect(tabRow?.match(/…/g)).toHaveLength(2);
    expect(tabRow).toMatch(/….*VeryLong.*…│/);
    expect(tabRow).not.toContain("Next");
  });

  it("places the tab strip, timeline, and one-piece composer inside the main-pane frame", async () => {
    const terminal = new RecordingTerminal(160, 28);
    const current = {
      ...state(),
      focus: "composer" as const,
      composerMode: "normal" as const,
      selectedAgentId: "agent",
      activeSessionId: "agent",
      directory: {
        ...state().directory,
        agents: [
          {
            id: "agent",
            workspaceId: "w",
            title: "Agent",
            status: "idle" as const,
            pendingPermissions: [],
            needsAttention: false,
            archived: false,
            availableModeIds: [],
            availableThinkingLevels: [],
          },
        ],
      },
    };
    const deck = new DeckTui(terminal, current, () => undefined, {
      appearance: { color: "none", unicode: true, theme: "plain", symbols: "unicode" },
    });
    deck.start();
    await terminal.waitForRender();
    const lines = terminal.viewport();
    await deck.stop();

    expect(lines[0]).toContain("┌");
    expect(lines.at(-1)).toContain("└");
    expect(lines.join("\n")).toContain("Agent");
    expect(lines.join("\n")).toContain("NORMAL Prompt");
    expect(lines.join("\n")).not.toMatch(/\n─{8,}\n/);
  });

  it("keeps all essential key cues visible in a narrow row", () => {
    const row = composerControlRow(
      {
        ...state(),
        focus: "composer",
        composerMode: "normal",
      },
      new DeckTheme({ color: "none", unicode: false, theme: "plain", symbols: "ascii" }),
      18,
    );
    expect(row).toContain("[m]");
    expect(row).toContain("[z]");
    expect(row).toContain("[o]");
    expect(terminalDisplayWidth(row)).toBeLessThanOrEqual(18);
  });

  it("keeps Paseo-specific control cues while the status edge omits ordinary Vim instructions", async () => {
    const terminal = new RecordingTerminal(100, 16);
    const deck = new DeckTui(
      terminal,
      { ...state(), focus: "composer", composerMode: "normal" },
      () => undefined,
      {
        appearance: { color: "none", unicode: false, theme: "plain", symbols: "ascii" },
      },
    );

    deck.start();
    await terminal.waitForRender();
    const rendered = terminal.viewport().join("\n");
    await deck.stop();

    expect(rendered).toContain("[m]");
    expect(rendered).toContain("[z]");
    expect(rendered).toContain("[o]");
    expect(rendered).not.toContain("Composer NORMAL:");
    expect(rendered).not.toContain("Sidebar:");
    expect(rendered).not.toContain("Timeline NORMAL:");
  });

  it("keeps no-color pickers and notifications free of ordinary key instructions", async () => {
    const terminal = new RecordingTerminal(100, 18);
    const base = state();
    const deck = new DeckTui(
      terminal,
      { ...base, modal: { type: "create-agent", workspaceId: "w", step: "provider" } },
      () => undefined,
      { appearance: { color: "none", unicode: false, theme: "plain", symbols: "ascii" } },
    );

    deck.start();
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).not.toMatch(/Up\/Down|Enter choose|Esc back/);

    deck.update({
      ...base,
      notifications: [{ id: 1, kind: "error", message: "Offline", detail: "Details" }],
      activeNotificationId: 1,
      modal: { type: "notifications", index: 0 },
    });
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("E details");
    expect(terminal.viewport().join("\n")).not.toMatch(/j\/k browse|Enter select|Esc close/);
  });

  it("submits in Normal mode and preserves a multiline draft in Insert mode", async () => {
    const base = state();
    const current: AppState = {
      ...base,
      focus: "composer",
      composerMode: "normal",
      selectedAgentId: "agent",
      directory: {
        ...base.directory,
        agents: [
          {
            id: "agent",
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
    };
    const intents: unknown[] = [];
    const terminal = new RecordingTerminal();
    const deck = new DeckTui(terminal, current, (intent) => intents.push(intent));
    deck.start();
    deck.update(current);
    await terminal.waitForRender();
    terminal.sendInput("hello");
    terminal.sendInput("\r");
    await terminal.waitForRender();
    expect(intents).toContainEqual({ type: "submit-composer", agentId: "agent", prompt: "hello" });
    deck.update({ ...current, composerMode: "insert" });
    terminal.sendInput("line one");
    terminal.sendInput("\r");
    terminal.sendInput("line two");
    await terminal.waitForRender();
    expect(intents).toContainEqual({ type: "set-composer-text", text: "line one\nline two" });
    await deck.stop();
  });

  it("labels the active composer chrome and mutes it without a mode label when inactive", async () => {
    const terminal = new RecordingTerminal(80, 18);
    const active = { ...state(), focus: "composer" as const, composerMode: "normal" as const };
    const deck = new DeckTui(terminal, active, () => undefined, {
      appearance: { color: "none", unicode: false, theme: "plain", symbols: "ascii" },
    });
    deck.update(active);
    deck.start();
    await terminal.waitForRender();
    const activeRender = terminal.viewport().join("\n");
    const inactive = { ...active, focus: "tree" as const };
    deck.update(inactive);
    await terminal.waitForRender();
    const inactiveRender = terminal.viewport().join("\n");
    await deck.stop();

    expect(activeRender).toContain("NORMAL Prompt");
    expect(inactiveRender).not.toContain("NORMAL Prompt");
    expect(inactiveRender).toContain("Prompt");
  });
});

describe("fenced code highlighter", () => {
  it("adds restrained ANSI styling without changing code text", () => {
    const [line] = highlightFencedCode('const answer = "READY";', "ts");

    expect(line).toContain("\u001b[");
    expect(line).toContain("const");
    expect(line).toContain("READY");
  });

  it("keeps fenced code readable without SGR when the theme is plain", () => {
    const [line] = highlightFencedCode(
      'const answer = "READY";',
      "ts",
      new DeckTheme({ color: "none", unicode: false, theme: "plain", symbols: "ascii" }),
    );

    expect(line).toBe('const answer = "READY";');
  });
});

describe("terminal appearance", () => {
  it("renders workspace activity as monochrome letters without sidebar metadata", async () => {
    const terminal = new RecordingTerminal(100, 22);
    const base = state();
    const agent = {
      id: "session",
      workspaceId: "attention",
      title: "Hidden session",
      status: "idle" as const,
      availableModeIds: [],
      availableThinkingLevels: [],
      pendingPermissions: [],
      needsAttention: true,
      archived: false,
    };
    const uiState: AppState = {
      ...base,
      directory: {
        ...base.directory,
        workspaces: ["attention", "working", "idle", "done"].map((id) => ({
          id,
          title: id.slice(0, 1).toUpperCase() + id.slice(1),
          directory: `/${id}`,
          archived: false,
        })),
        agents: [
          agent,
          { ...agent, id: "ended", workspaceId: "done", status: "stopped", needsAttention: false },
        ],
      },
      workspaceTerminals: {
        working: [
          {
            id: "term",
            workspaceId: "working",
            name: "build",
            cwd: "/working",
            activity: "working",
          },
        ],
      },
    };
    const deck = new DeckTui(terminal, uiState, () => undefined, {
      appearance: { color: "none", unicode: false, theme: "plain", symbols: "ascii" },
    });
    deck.start();
    await terminal.waitForRender();
    const sidebar = terminal
      .viewport()
      .map((line) => line.slice(0, 34))
      .join("\n");
    await deck.stop();
    expect(sidebar).toMatch(/A Attention/);
    expect(sidebar).toMatch(/W Working/);
    expect(sidebar).toMatch(/I Idle/);
    expect(sidebar).toMatch(/D Done/);
    expect(sidebar).not.toContain("Hidden session");
    expect(sidebar).not.toContain("/working");
  });

  it("paints an unlabeled sidebar frame through unused viewport rows", async () => {
    const terminal = new RecordingTerminal(100, 22);
    const deck = new DeckTui(terminal, state(), () => undefined, {
      appearance: { color: "truecolor", unicode: true, theme: "ember", symbols: "unicode" },
    });
    deck.start();
    await terminal.waitForRender();
    deck.update(state());
    await terminal.waitForRender();
    const lines = terminal.viewport();
    const backgrounds = terminal.viewportBackgrounds();
    await deck.stop();

    expect(lines.every((line) => line.startsWith("│"))).toBe(true);
    expect(
      backgrounds.every((line) => line.slice(0, 34).every((color) => color === "#1f1d1b")),
    ).toBe(true);
  });

  it("shows an active workspace without exposing session rows in the sidebar", async () => {
    const terminal = new RecordingTerminal(100, 22);
    const base = state();
    const activeState: AppState = {
      ...base,
      selectedWorkspaceId: "workspace",
      sidebarSelection: { kind: "workspace", id: "workspace" },
      directory: {
        ...base.directory,
        projects: [{ id: "project", name: "Project" }],
        workspaces: [
          {
            id: "workspace",
            projectId: "project",
            title: "Workspace",
            directory: "/workspace",
            archived: false,
          },
        ],
        agents: [
          {
            id: "agent-active",
            workspaceId: "workspace",
            title: "Active session",
            status: "idle",
            availableModeIds: [],
            availableThinkingLevels: [],
            pendingPermissions: [],
            needsAttention: false,
            archived: false,
          },
        ],
      },
      expandedIds: new Set(["project"]),
    };
    const deck = new DeckTui(terminal, activeState, () => undefined, {
      appearance: { color: "truecolor", unicode: true, theme: "ember", symbols: "unicode" },
    });
    deck.start();
    await terminal.waitForRender();
    const rendered = terminal.viewport().join("\n");
    const workspaceRow = terminal.viewport().findIndex((line) => line.includes("● Workspace"));
    expect(rendered).toContain("Active session");
    expect(terminal.viewportBackgrounds()[workspaceRow]?.[4]).toBe("#332e27");
    expect(terminal.viewport().slice(0, 5).join("\n")).not.toContain("agent-active");
    await deck.stop();
  });

  it("uses adaptive sidebar and composer surfaces without painting the main-pane base", async () => {
    const terminal = new RecordingTerminal(100, 28);
    const deck = new DeckTui(terminal, state(), () => undefined, {
      appearance: {
        color: "truecolor",
        unicode: true,
        theme: "ember",
        palette: "terminal",
        background: [240, 230, 220],
        symbols: "unicode",
      },
    });

    deck.start();
    await terminal.waitForRender();
    await deck.stop();

    const output = terminal.writes.join("");
    expect(output).toContain("\u001b[48;2;232;222;212m");
    expect(output).toContain("\u001b[48;2;226;216;207m");
    expect(output).not.toContain("\u001b[43m");
  });

  it("renders the connected host and dismisses the narrow sidebar overlay on main-pane focus", async () => {
    const terminal = new RecordingTerminal(52, 18);
    const deck = new DeckTui(terminal, state(), () => undefined, {
      paseoHost: "tcp://paseo.example:6767",
    });
    deck.start();
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Projects / workspaces");

    deck.update({ ...state(), focus: "timeline" });
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Active session timeline");
    await deck.stop();

    const wideTerminal = new RecordingTerminal(100, 18);
    const wideDeck = new DeckTui(wideTerminal, state(), () => undefined, {
      paseoHost: "tcp://paseo.example:6767",
    });
    wideDeck.start();
    await wideTerminal.waitForRender();
    expect(wideTerminal.viewport().join("\n")).toContain("paseo.exa");
    await wideDeck.stop();
  });

  it("renders semantic empty states without colour or Unicode dependencies", async () => {
    const terminal = new RecordingTerminal(80, 18);
    const uiState = { ...state(), filter: "missing" };
    const deck = new DeckTui(terminal, uiState, () => undefined, {
      appearance: { color: "none", unicode: false, theme: "plain", symbols: "ascii" },
    });
    deck.update(uiState);
    deck.start();
    await terminal.waitForRender();
    const rendered = terminal.viewport().join("\n");
    await deck.stop();

    expect(rendered).toContain("No projects or workspaces match");
    expect(rendered).toContain("No timeline selected");
    expect(rendered).not.toMatch(/[▾▸•✓]/u);
    // pi-tui emits its own reset/reverse-video housekeeping for cursor focus.
    // Deck's semantic style boundary is asserted SGR-free in theme.test.ts.
    expect(terminal.writes.join("")).not.toContain("\u001b[38;");
  });

  it("prioritises the tree and timeline over secondary details at narrow widths", async () => {
    const terminal = new RecordingTerminal(52, 18);
    const deck = new DeckTui(terminal, state(), () => undefined);
    deck.start();
    await terminal.waitForRender();
    const rendered = terminal.viewport().join("\n");
    await deck.stop();

    expect(rendered).toContain("Projects / workspaces");
    expect(rendered).toContain("Active session timeline");
    expect(rendered).not.toContain("context ");
  });

  it("uses ASCII-only chrome inside a creation modal and minimum-size state", async () => {
    const appearance = {
      color: "none" as const,
      unicode: true,
      theme: "plain" as const,
      symbols: "ascii" as const,
    };
    const terminal = new RecordingTerminal(52, 18);
    const modalState = {
      ...state(),
      modal: { type: "create-agent" as const, workspaceId: "w", step: "provider" as const },
    };
    const deck = new DeckTui(terminal, modalState, () => undefined, { appearance });
    deck.update(modalState);
    deck.start();
    await terminal.waitForRender();
    const modalLines = terminal.viewport();
    terminal.setSize(20, 10);
    await terminal.waitForRender();
    const tinyLines = terminal.viewport();
    await deck.stop();

    expect(modalLines.join("\n")).not.toMatch(/[▾▸•✓…─↑↓←→—]/u);
    expect(tinyLines.join("\n")).toContain("Terminal too small");
    expect(modalLines.every((line) => terminalDisplayWidth(line) <= 52)).toBe(true);
    expect(tinyLines.every((line) => terminalDisplayWidth(line) <= 20)).toBe(true);
  });

  it("keeps permission payload text intact while ASCII-normalising Deck chrome", async () => {
    const terminal = new RecordingTerminal(52, 18);
    const base = state();
    const uiState: AppState = {
      ...base,
      directory: {
        ...base.directory,
        agents: [
          {
            id: "agent",
            workspaceId: "w",
            title: "Agent",
            status: "idle",
            pendingPermissions: [
              {
                id: "permission",
                agentId: "agent",
                title: "Run → command with a very long remote payload that needs clipping",
                description: "Payload • must remain unchanged and also needs clipping",
              },
            ],
            needsAttention: true,
            archived: false,
            availableModeIds: [],
            availableThinkingLevels: [],
          },
        ],
      },
      selectedAgentId: "agent",
      modal: {
        type: "permission",
        agentId: "agent",
        requestId: "permission",
        queueIndex: 0,
        submitting: false,
      },
    };
    const deck = new DeckTui(terminal, uiState, () => undefined, {
      appearance: { color: "none", unicode: true, theme: "plain", symbols: "ascii" },
    });
    deck.update(uiState);
    deck.start();
    await terminal.waitForRender();
    const rendered = terminal.viewport().join("\n");
    await deck.stop();

    expect(rendered).toContain("Run → command");
    expect(rendered).toContain("Payload • must remain");
    expect(rendered).toContain("a allow - d deny");
    expect(rendered).toContain("...");
    expect(rendered).not.toContain("…");
    expect(terminal.viewport().every((line) => terminalDisplayWidth(line) <= 52)).toBe(true);
  });

  it("preserves remote tree, status, composer, and notification labels in ASCII mode", async () => {
    const terminal = new RecordingTerminal(100, 18);
    const base = state();
    const uiState: AppState = {
      ...base,
      directory: {
        ...base.directory,
        workspaces: [{ id: "w", title: "Workspace → •", directory: "/workspace", archived: false }],
        agents: [
          {
            id: "agent",
            workspaceId: "w",
            title: "Agent → •",
            status: "running",
            providerId: "Provider →",
            modelId: "Model •",
            pendingPermissions: [],
            needsAttention: false,
            archived: false,
            availableModeIds: [],
            availableThinkingLevels: [],
          },
        ],
      },
      selectedWorkspaceId: "w",
      selectedAgentId: "agent",
      expandedIds: new Set(["w"]),
      notifications: [{ id: 1, kind: "info", message: "Notice → •" }],
      activeNotificationId: 1,
    };
    const deck = new DeckTui(terminal, uiState, () => undefined, {
      appearance: { color: "none", unicode: true, theme: "plain", symbols: "ascii" },
    });
    deck.update(uiState);
    deck.start();
    await terminal.waitForRender();
    const rendered = terminal.viewport().join("\n");
    await deck.stop();

    expect(rendered).toContain("Workspace → •");
    expect(rendered).toContain("Agent → •");
    expect(rendered).toContain("Provider →/Model •");
    expect(rendered).toContain("Notic");
    expect(terminal.viewport().every((line) => terminalDisplayWidth(line) <= 100)).toBe(true);
  });

  it("uses the ASCII overflow suffix for a full-width selected timeline row", async () => {
    const terminal = new RecordingTerminal(52, 18);
    const event: TimelineEvent = {
      epoch: "epoch",
      sequence: 1,
      item: {
        id: "tool",
        type: "tool",
        callId: "tool",
        name: "a deliberately long tool name that fills the selected timeline row",
        status: "completed",
      },
    };
    const uiState = {
      ...state(),
      focus: "timeline" as const,
      timeline: { recoveryRevision: 0, items: [event], loading: false },
    };
    const deck = new DeckTui(terminal, uiState, () => undefined, {
      appearance: { color: "none", unicode: true, theme: "plain", symbols: "ascii" },
    });
    deck.update(uiState);
    deck.start();
    await terminal.waitForRender();
    const rendered = terminal.viewport().join("\n");
    await deck.stop();

    expect(rendered).toContain("...");
    expect(rendered).not.toContain("…");
    expect(terminal.viewport().every((line) => terminalDisplayWidth(line) <= 52)).toBe(true);
  });

  it("shows actionable connecting and loading states", async () => {
    const terminal = new RecordingTerminal();
    const connecting = {
      ...state(),
      connection: "connecting" as const,
      timeline: { recoveryRevision: 0, items: [], loading: false },
    };
    const deck = new DeckTui(terminal, connecting, () => undefined);
    deck.update(connecting);
    deck.start();
    await terminal.waitForRender();
    const connectingRendered = terminal.viewport().join("\n");
    const loading = { ...state(), timeline: { recoveryRevision: 0, items: [], loading: true } };
    deck.update(loading);
    await terminal.waitForRender();
    const loadingRendered = terminal.viewport().join("\n");
    await deck.stop();

    expect(connectingRendered).toContain("Connecting to Paseo");
    expect(loadingRendered).toContain("Loading timeline history");
  });

  it("renders a hydrated session timeline without blocking the terminal", async () => {
    const terminal = new RecordingTerminal(100, 30);
    const items: TimelineEvent[] = Array.from({ length: 1_000 }, (_, sequence) => ({
      epoch: "history",
      sequence,
      item: {
        id: `message-${sequence}`,
        type: "assistant-message",
        messageId: `message-${sequence}`,
        text: "A completed response with enough predictable content to wrap across several terminal lines.",
        turnId: `turn-${Math.floor(sequence / 5)}`,
      },
    }));
    const uiState = {
      ...state(),
      focus: "timeline" as const,
      selectedAgentId: "agent",
      activeSessionId: "agent",
      directory: {
        ...state().directory,
        agents: [
          {
            id: "agent",
            workspaceId: "w",
            title: "Agent",
            status: "idle" as const,
            availableModeIds: [],
            availableThinkingLevels: [],
            pendingPermissions: [],
            needsAttention: false,
            archived: false,
          },
        ],
      },
      timeline: { recoveryRevision: 0, agentId: "agent", items, loading: false },
    };
    const deck = new DeckTui(terminal, uiState, () => undefined, {
      appearance: { color: "none", unicode: false, theme: "plain", symbols: "ascii" },
    });

    const started = performance.now();
    deck.start();
    deck.update(uiState);
    await terminal.waitForRender();
    const elapsed = performance.now() - started;
    await deck.stop();

    // The framed main pane adds layout work on slower hosted Windows/macOS
    // runners; retain a bounded responsiveness check without treating those
    // platforms as a rendering failure.
    expect(elapsed).toBeLessThan(8_000);
    expect(terminal.viewport().join("\n")).toContain("Assistant");
  }, 10_000);

  it("keeps empty-state actions visible instead of clipping them from their panes", async () => {
    const terminal = new RecordingTerminal(100, 18);
    const empty = {
      ...state(),
      connection: "connected" as const,
      directory: emptyDirectory(),
      timeline: { recoveryRevision: 0, items: [], loading: false },
    };
    const deck = new DeckTui(terminal, empty, () => undefined);
    deck.update(empty);
    deck.start();
    await terminal.waitForRender();
    const rendered = terminal.viewport().join("\n");
    await deck.stop();

    expect(rendered).toContain("Press r to refresh");
    expect(rendered).toContain("Choose a session tab");
    expect(rendered).not.toContain("avai\nlable");
    expect(rendered).not.toContain("ti\nmeline");
  });

  it("keeps selected Markdown and fenced code styles from becoming visible escape glyphs", async () => {
    const terminal = new RecordingTerminal();
    const event: TimelineEvent = {
      epoch: "demo",
      sequence: 1,
      item: {
        id: "message",
        type: "assistant-message",
        messageId: "message",
        text: "**Bold** [link](https://example.test)\n```ts\nconst ready = 'yes';\n```",
      },
    };
    const uiState = {
      ...state(),
      focus: "timeline" as const,
      selectedAgentId: "agent",
      timeline: { recoveryRevision: 0, agentId: "agent", items: [event], loading: false },
    };
    const deck = new DeckTui(terminal, uiState, () => undefined);
    deck.update(uiState);
    deck.start();
    await terminal.waitForRender();
    const rendered = terminal.viewport().join("\n");
    await deck.stop();

    expect(rendered).toContain("Bold");
    expect(rendered).toContain("const ready");
    expect(rendered).not.toContain("␛[");
    expect(highlightFencedCode("const ready = 'yes';", "ts").join("\n")).not.toContain("␛[");
    expect(terminal.writes.join("")).toContain("\u001b[36m");
    expect(terminal.writes.join("")).toContain("\u001b[0m");
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

  it("accepts a multiline prompt from the editor and renders preserved prompt text", async () => {
    const terminal = new RecordingTerminal();
    const intents: unknown[] = [];
    const promptModal = {
      type: "create-agent" as const,
      workspaceId: "w",
      step: "prompt" as const,
      providerId: "ready",
      modelId: "one",
    };
    const uiState = { ...state(), modal: promptModal };
    const deck = new DeckTui(terminal, uiState, (intent) => intents.push(intent));
    deck.update(uiState);
    deck.start();
    terminal.sendInput("First line");
    terminal.sendInput("\n");
    terminal.sendInput("Second line");
    terminal.sendInput("\r");
    await deck.stop();

    expect(intents).toContainEqual({ type: "create-choice", choice: "First line\nSecond line" });

    const restoredTerminal = new RecordingTerminal();
    const restoredState = {
      ...state(),
      modal: { ...promptModal, prompt: "First line\nSecond line" },
    };
    const restoredDeck = new DeckTui(restoredTerminal, restoredState, () => undefined);
    restoredDeck.update(restoredState);
    restoredDeck.start();
    await restoredTerminal.waitForRender();
    expect(restoredTerminal.viewport().join("\n")).toContain("First line");
    expect(restoredTerminal.viewport().join("\n")).toContain("Second line");
    await restoredDeck.stop();
  });

  it.each([
    { step: "provider" as const },
    { step: "model" as const, providerId: "ready" },
    { step: "mode" as const, providerId: "ready", modelId: "one" },
    { step: "thinking" as const, providerId: "ready", modelId: "one" },
    { step: "prompt" as const, providerId: "ready", modelId: "one" },
    {
      step: "confirm" as const,
      providerId: "ready",
      modelId: "one",
      prompt: "Create this agent",
    },
  ])("shows the workspace title at the $step step", async (form) => {
    const terminal = new RecordingTerminal();
    const uiState = {
      ...state(),
      modal: { type: "create-agent" as const, workspaceId: "w", ...form },
    };
    const deck = new DeckTui(terminal, uiState, () => undefined);
    deck.update(uiState);
    deck.start();
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Workspace label");
    await deck.stop();
  });

  it.each([
    { step: "provider" as const },
    { step: "model" as const, providerId: "ready" },
    { step: "mode" as const, providerId: "ready", modelId: "one" },
    { step: "thinking" as const, providerId: "ready", modelId: "one" },
    { step: "prompt" as const, providerId: "ready", modelId: "one" },
    {
      step: "confirm" as const,
      providerId: "ready",
      modelId: "one",
      prompt: "Create this agent",
    },
  ])("uses Esc to go back from the $step step", async (form) => {
    const terminal = new RecordingTerminal();
    const intents: unknown[] = [];
    const uiState = {
      ...state(),
      modal: { type: "create-agent" as const, workspaceId: "w", ...form },
    };
    const deck = new DeckTui(terminal, uiState, (intent) => intents.push(intent));
    deck.update(uiState);
    deck.start();
    terminal.sendInput("\u001b");
    await deck.stop();
    expect(intents).toContainEqual({ type: "creation-back" });
  });

  it("keeps confirmation controls inert while creation is submitting", async () => {
    const terminal = new RecordingTerminal();
    const intents: unknown[] = [];
    const uiState: AppState = {
      ...state(),
      modal: {
        type: "create-agent",
        workspaceId: "w",
        step: "confirm",
        providerId: "ready",
        modelId: "one",
        prompt: "Create this agent",
        submitting: true,
      },
    };
    const deck = new DeckTui(terminal, uiState, (intent) => intents.push(intent));
    deck.update(uiState);
    deck.start();
    terminal.sendInput("\r");
    terminal.sendInput("\u001b");
    await deck.stop();

    expect(intents).toEqual([]);
  });

  it.each([
    { step: "provider" as const, expected: "> Ready (default)" },
    {
      step: "model" as const,
      providerId: "ready",
      modelId: "one",
      expected: "> One (default)",
    },
    {
      step: "mode" as const,
      providerId: "ready",
      modelId: "one",
      modeId: "plan",
      expected: "> plan",
    },
    {
      step: "thinking" as const,
      providerId: "ready",
      modelId: "one",
      thinkingLevel: "low",
      expected: "> low",
    },
  ])("preselects the workspace default at the $step step", async (form) => {
    const terminal = new RecordingTerminal();
    const uiState: AppState = {
      ...state(),
      creationDefaults: {
        w: { providerId: "ready", modelId: "one", modeId: "plan", thinkingLevel: "low" },
      },
      modal: { type: "create-agent", workspaceId: "w", ...form },
    };
    const deck = new DeckTui(terminal, uiState, () => undefined);
    deck.update(uiState);
    deck.start();
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain(form.expected);
    await deck.stop();
  });

  it("searches choices from the keyboard and leaves unavailable matches inert", async () => {
    const terminal = new RecordingTerminal();
    const intents: unknown[] = [];
    const deck = new DeckTui(terminal, state(), (intent) => intents.push(intent));
    deck.update({
      ...state(),
      modal: { type: "create-agent", workspaceId: "w", step: "provider" },
    });
    deck.start();

    terminal.sendInput("not ready");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("unavailable: not ready");
    terminal.sendInput("\r");
    expect(intents).toEqual([]);

    await deck.stop();
    expect(intents).toEqual([]);

    const selectableTerminal = new RecordingTerminal();
    const selectableIntents: unknown[] = [];
    const selectableDeck = new DeckTui(selectableTerminal, state(), (intent) =>
      selectableIntents.push(intent),
    );
    selectableDeck.update({
      ...state(),
      modal: { type: "create-agent", workspaceId: "w", step: "provider" },
    });
    selectableDeck.start();
    selectableTerminal.sendInput("ready");
    selectableTerminal.sendInput("\r");
    await selectableDeck.stop();

    expect(selectableIntents).toContainEqual({ type: "create-choice", choice: "ready" });
  });
});

describe("DeckTui viewport and focus", () => {
  it("renders reconnect attempts and elapsed time from the injected render clock", async () => {
    const terminal = new RecordingTerminal();
    const clock = new FakeRenderClock();
    clock.current = 1_000;
    const deck = new DeckTui(
      terminal,
      {
        ...state(),
        connection: "reconnecting",
        recovery: { attempt: 2, since: 1_000, directoryStale: true, timelineStale: true },
      },
      () => undefined,
      { renderClock: clock },
    );
    deck.start();
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("reconnecting #2 · 0s · stale");
    clock.advance(1_000);
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("reconnecting #2 · 1s · stale");
    await deck.stop();
    const writesAfterStop = terminal.writes.length;
    clock.advance(5_000);

    expect(terminal.writes).toHaveLength(writesAfterStop);
  });

  it("renders a reviewable notification queue with category, details, and retry affordances", async () => {
    const terminal = new RecordingTerminal();
    const notificationState = {
      ...state(),
      notifications: [
        {
          id: 1,
          kind: "error" as const,
          failureKind: "daemon-unavailable" as const,
          message: "Offline",
        },
        {
          id: 2,
          kind: "error" as const,
          failureKind: "command" as const,
          message: "Send failed",
          detail: "safe detail",
          retry: { type: "operation" as const, token: 4 },
        },
      ],
      activeNotificationId: 2,
      modal: { type: "notifications" as const, index: 1 },
    };
    const deck = new DeckTui(terminal, notificationState, () => undefined);
    deck.update(notificationState);
    deck.start();
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("Notifications 2/2");
    expect(terminal.viewport().join("\n")).toContain("error/command: Send failed");
    expect(terminal.viewport().join("\n")).toContain("E details");
    expect(terminal.viewport().join("\n")).toContain("R retry");
  });

  it("searches source timeline text through the overlay", async () => {
    const terminal = new RecordingTerminal(80, 16);
    const searchState: AppState = {
      ...state(),
      focus: "timeline",
      timeline: {
        recoveryRevision: 0,
        loading: false,
        items: [
          {
            epoch: "search",
            sequence: 1,
            item: {
              id: "match",
              type: "reasoning",
              text: "\u001b[31mneedle\u001b[0m",
            },
          },
        ],
      },
    };
    const deck = new DeckTui(terminal, searchState, () => undefined);
    deck.start();
    terminal.sendInput("\u0006");
    terminal.sendInput("needle");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("1 match · result 1");
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("needle");
  });

  it("keeps search input local, refreshes streamed results, and restores its prior selection on cancel", async () => {
    const terminal = new RecordingTerminal(80, 16);
    const base: AppState = {
      ...state(),
      focus: "timeline",
      timeline: {
        recoveryRevision: 0,
        loading: false,
        items: [
          {
            epoch: "search",
            sequence: 1,
            item: { id: "first", type: "user-message", text: "first" },
          },
          {
            epoch: "search",
            sequence: 2,
            item: { id: "needle", type: "assistant-message", messageId: "needle", text: "needle" },
          },
        ],
      },
    };
    const deck = new DeckTui(terminal, base, () => undefined);
    deck.start();
    terminal.sendInput("\u0006");
    terminal.sendInput("needle");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("1 match · result 1");

    deck.update({
      ...base,
      timeline: {
        ...base.timeline,
        items: [
          ...base.timeline.items,
          {
            epoch: "search",
            sequence: 3,
            item: { id: "new-needle", type: "user-message", text: "new needle" },
          },
        ],
      },
    });
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("2 matches · result 1 · updated");
    terminal.sendInput("\u000e");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("2 matches · result 2");
    terminal.sendInput("\u0010");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("2 matches · result 1");
    terminal.sendInput("\r");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("2 matches · result 2");
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("> You");
    expect(terminal.viewport().join("\n")).toContain("first");
  });

  it("shows no-match feedback and expands matched tool source before computing its range", async () => {
    const terminal = new RecordingTerminal(80, 16);
    const deck = new DeckTui(
      terminal,
      {
        ...state(),
        focus: "timeline",
        timeline: {
          recoveryRevision: 0,
          loading: false,
          items: [
            {
              epoch: "search",
              sequence: 1,
              item: {
                id: "tool",
                type: "tool",
                callId: "tool",
                name: "shell",
                status: "completed",
                output: "matched tool output",
              },
            },
          ],
        },
      },
      () => undefined,
    );
    deck.start();
    terminal.sendInput("\u0006");
    terminal.sendInput("missing");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("No matches.");
    for (let index = 0; index < "missing".length; index += 1) terminal.sendInput("\u007f");
    terminal.sendInput("matched");
    await terminal.waitForRender();
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("matched tool output");
  });

  it("restores exact paused or following semantic timeline snapshots after streamed updates", async () => {
    const terminal = new RecordingTerminal(80, 16);
    const intents: unknown[] = [];
    const base: AppState = {
      ...state(),
      selectedAgentId: "agent",
      focus: "timeline",
      timeline: {
        agentId: "agent",
        recoveryRevision: 0,
        loading: false,
        items: Array.from({ length: 16 }, (_, sequence) => ({
          epoch: "pause",
          sequence,
          item: {
            id: `event-${sequence}`,
            type: "user-message" as const,
            text: `event ${sequence}`,
          },
        })),
      },
    };
    const deck = new DeckTui(terminal, base, (intent) => intents.push(intent));
    deck.start();
    await terminal.waitForRender();
    const transcript = (
      deck as unknown as {
        transcript: {
          scrollTop: number;
          isFollowingEnd: boolean;
          scrollTo: (top: number, options: { disableFollow: boolean }) => void;
          scrollToEnd: () => void;
        };
      }
    ).transcript;
    transcript.scrollTo(4, { disableFollow: true });
    const pausedTop = transcript.scrollTop;
    terminal.sendInput("\u0006");
    terminal.sendInput("event");
    deck.update({
      ...base,
      timeline: {
        ...base.timeline,
        items: [
          ...base.timeline.items,
          {
            epoch: "pause",
            sequence: 16,
            item: { id: "stream", type: "user-message", text: "event stream" },
          },
        ],
      },
    });
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    expect(transcript.scrollTop).toBe(pausedTop);
    expect(intents).toContainEqual({
      type: "set-timeline-navigation",
      agentId: "agent",
      following: false,
      anchor: { epoch: "pause", sequence: 1 },
    });

    transcript.scrollToEnd();
    terminal.sendInput("\u0006");
    deck.update({
      ...base,
      timeline: {
        ...base.timeline,
        items: [
          ...base.timeline.items,
          {
            epoch: "pause",
            sequence: 17,
            item: { id: "later", type: "user-message", text: "event later" },
          },
        ],
      },
    });
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    await deck.stop();

    expect(transcript.isFollowingEnd).toBe(true);
  });

  it("copies the selected source safely and reports unavailable copy targets", async () => {
    const terminal = new RecordingTerminal(80, 16);
    const copied: string[] = [];
    const intents: unknown[] = [];
    const copyState: AppState = {
      ...state(),
      focus: "timeline",
      timeline: {
        recoveryRevision: 0,
        loading: false,
        items: [
          {
            epoch: "copy",
            sequence: 1,
            item: { id: "copy", type: "user-message", text: "\u001b[31mhello\u001b[0m" },
          },
        ],
      },
    };
    const deck = new DeckTui(terminal, copyState, (intent) => intents.push(intent), {
      copyText: (text) => {
        copied.push(text);
      },
    });
    deck.start();
    terminal.sendInput("y");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Copy selected timeline item");
    terminal.sendInput("\r");
    await terminal.waitForRender();
    await deck.stop();

    expect(copied).toEqual(["hello"]);
    expect(intents).toContainEqual({ type: "notify", message: "Copied." });
  });

  it("offers UI-selectable code, error-detail, and tool-output copy targets", async () => {
    const cases = [
      {
        item: {
          id: "message",
          type: "assistant-message" as const,
          messageId: "message",
          text: "```ts\ncode\n```",
        },
        moveToTarget: true,
        expected: "code\n",
      },
      {
        item: { id: "error", type: "error" as const, message: "failed", detail: "error detail" },
        moveToTarget: false,
        expected: "error detail",
      },
      {
        item: {
          id: "tool",
          type: "tool" as const,
          callId: "tool",
          name: "shell",
          status: "completed" as const,
          output: "tool output",
        },
        moveToTarget: false,
        expected: "tool output",
      },
    ];
    for (const { item, moveToTarget, expected } of cases) {
      const terminal = new RecordingTerminal(80, 16);
      const copied: string[] = [];
      const deck = new DeckTui(
        terminal,
        {
          ...state(),
          focus: "timeline",
          timeline: {
            recoveryRevision: 0,
            loading: false,
            items: [{ epoch: "copy", sequence: 1, item }],
          },
        },
        () => undefined,
        { copyText: (text) => void copied.push(text) },
      );
      deck.start();
      terminal.sendInput("y");
      if (moveToTarget) terminal.sendInput("\u001b[B");
      terminal.sendInput("\r");
      await terminal.waitForRender();
      await deck.stop();
      expect(copied).toEqual([expected]);
    }
  });

  it("reports a non-copyable selected item without opening an overlay", async () => {
    const terminal = new RecordingTerminal(80, 16);
    const intents: unknown[] = [];
    const deck = new DeckTui(
      terminal,
      {
        ...state(),
        focus: "timeline",
        timeline: {
          recoveryRevision: 0,
          loading: false,
          items: [
            {
              epoch: "copy",
              sequence: 1,
              item: { id: "turn", type: "turn", status: "completed" },
            },
          ],
        },
      },
      (intent) => intents.push(intent),
    );
    deck.start();
    terminal.sendInput("y");
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).not.toContain("Copy selected timeline item");
    expect(intents).toContainEqual({
      type: "notify",
      message: "Selected item has nothing to copy.",
    });
  });

  it("yields a local search overlay when an app modal opens", async () => {
    const terminal = new RecordingTerminal(80, 16);
    const base: AppState = {
      ...state(),
      focus: "timeline",
      timeline: {
        recoveryRevision: 0,
        loading: false,
        items: [
          {
            epoch: "search",
            sequence: 1,
            item: { id: "match", type: "user-message", text: "needle" },
          },
        ],
      },
    };
    const intents: unknown[] = [];
    const deck = new DeckTui(terminal, base, (intent) => intents.push(intent));
    deck.start();
    terminal.sendInput("\u0006");
    terminal.sendInput("needle");
    deck.update({ ...base, modal: { type: "help" } });
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("Paseo Deck keys");
    expect(terminal.viewport().join("\n")).not.toContain("Search timeline");
    expect(intents).not.toContainEqual(
      expect.objectContaining({ type: "set-timeline-navigation" }),
    );
  });

  it("keeps Ctrl-C global while isolating other bindings in a local overlay", async () => {
    const terminal = new RecordingTerminal(80, 16);
    const intents: unknown[] = [];
    const deck = new DeckTui(
      terminal,
      {
        ...state(),
        focus: "timeline",
        timeline: {
          recoveryRevision: 0,
          loading: false,
          items: [
            {
              epoch: "search",
              sequence: 1,
              item: { id: "one", type: "user-message", text: "one" },
            },
          ],
        },
      },
      (intent) => intents.push(intent),
    );
    deck.start();
    terminal.sendInput("\u0006");
    terminal.sendInput("y");
    terminal.sendInput("\u0003");
    await deck.stop();

    expect(intents).toEqual([{ type: "quit" }]);
  });

  it("reports copy failures without crashing the timeline", async () => {
    const terminal = new RecordingTerminal(80, 16);
    const intents: unknown[] = [];
    const deck = new DeckTui(
      terminal,
      {
        ...state(),
        focus: "timeline",
        timeline: {
          recoveryRevision: 0,
          loading: false,
          items: [
            {
              epoch: "copy",
              sequence: 1,
              item: { id: "copy", type: "user-message", text: "text" },
            },
          ],
        },
      },
      (intent) => intents.push(intent),
      { copyText: () => Promise.reject(new Error("clipboard unavailable")) },
    );
    deck.start();
    terminal.sendInput("y");
    terminal.sendInput("\r");
    await terminal.waitForRender();
    await deck.stop();

    expect(intents).toContainEqual({ type: "notify", message: "Copy failed.", kind: "error" });
    expect(terminal.viewport().join("\n")).toContain("Active session timeline");
  });

  it("renders Markdown assistant streaming and timestamp metadata", async () => {
    const terminal = new RecordingTerminal(80, 14);
    const deck = new DeckTui(
      terminal,
      {
        ...state(),
        timeline: {
          recoveryRevision: 0,
          loading: false,
          items: [
            {
              epoch: "e",
              sequence: 1,
              item: {
                id: "assistant",
                type: "assistant-message",
                messageId: "m",
                text: "**partial**",
                streaming: true,
                timestamp: "2026-09-18T10:01:00Z",
              },
            },
          ],
        },
      },
      () => undefined,
    );
    deck.start();
    await terminal.waitForRender();
    await deck.stop();
    expect(terminal.viewport().join("\n")).toContain("Assistant · streaming… · 10:01");
  });

  it("renders fenced assistant code through the terminal while preserving its whitespace", async () => {
    const terminal = new RecordingTerminal(80, 14);
    const deck = new DeckTui(
      terminal,
      {
        ...state(),
        timeline: {
          recoveryRevision: 0,
          loading: false,
          items: [
            {
              epoch: "e",
              sequence: 1,
              item: {
                id: "assistant-code",
                type: "assistant-message",
                messageId: "m",
                text: "```ts\n  const answer = 1;\n  return answer;\n```",
                timestamp: "2026-09-18T10:01:00Z",
              },
            },
          ],
        },
      },
      () => undefined,
    );
    deck.start();
    await terminal.waitForRender();
    await deck.stop();

    const viewport = terminal.viewport().join("\n");
    expect(viewport).toContain("Assistant · 10:01");
    expect(viewport).toContain("  const answer = 1;");
    expect(viewport).toContain("  return answer;");
  });

  it("keeps a streaming timeline following its newest content", async () => {
    const terminal = new RecordingTerminal(80, 12);
    const deck = new DeckTui(terminal, { ...state(), focus: "timeline" }, () => undefined);
    deck.start();
    for (let count = 1; count <= 20; count += 1) {
      deck.update({
        ...state(),
        focus: "timeline",
        timeline: {
          recoveryRevision: 0,
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

  it("keeps paused scrollback fixed, marks unread output, and resumes at the end", async () => {
    const terminal = new RecordingTerminal(80, 14);
    const items = Array.from({ length: 12 }, (_, sequence) => ({
      epoch: "stream",
      sequence,
      item: {
        id: `message-${sequence}`,
        type: "assistant-message" as const,
        messageId: `message-${sequence}`,
        text: `event ${sequence}`,
      },
    }));
    const initial = {
      ...state(),
      selectedAgentId: "agent",
      focus: "timeline" as const,
      timeline: { recoveryRevision: 0, loading: false, agentId: "agent", items },
      timelineNavigation: { agent: { following: true, unread: 0 } },
    };
    const deck = new DeckTui(terminal, initial, () => undefined);
    deck.start();
    await terminal.waitForRender();
    deck.tui.scrollBy(-4);
    await terminal.waitForRender();
    const pausedTop = deck.tui.viewportTop;
    deck.update({
      ...initial,
      timeline: {
        recoveryRevision: 0,
        loading: false,
        agentId: "agent",
        items: [
          ...items,
          {
            epoch: "stream",
            sequence: 12,
            item: {
              id: "new",
              type: "assistant-message",
              messageId: "new",
              text: "new event",
            },
          },
        ],
      },
      timelineNavigation: {
        agent: { following: false, unread: 1, anchor: { epoch: "stream", sequence: 4 } },
      },
    });
    await terminal.waitForRender();

    expect(deck.tui.viewportTop).toBe(pausedTop);
    expect(terminal.viewport().join("\n")).toContain("1 new · G end");
    deck.tui.scrollBy(999);
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).not.toContain("2 new · G end");
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("new event");
  });

  it("counts consecutive unseen identities once while paused and clears them on G", async () => {
    const terminal = new RecordingTerminal(80, 14);
    const items = Array.from({ length: 10 }, (_, sequence) => ({
      epoch: "stream",
      sequence,
      item: {
        id: `message-${sequence}`,
        type: "assistant-message" as const,
        messageId: `message-${sequence}`,
        text: `event ${sequence}`,
      },
    }));
    const initial = {
      ...state(),
      selectedAgentId: "agent",
      focus: "timeline" as const,
      timeline: { recoveryRevision: 0, loading: false, agentId: "agent", items },
      timelineNavigation: { agent: { following: true, unread: 0 } },
    };
    let current: AppState = initial;
    const deck = new DeckTui(
      terminal,
      initial,
      (intent) => {
        if (intent.type !== "set-timeline-navigation") return;
        current = reduceApp(current, {
          type: "set-timeline-navigation",
          agentId: intent.agentId,
          following: intent.following,
          ...(intent.anchor === undefined ? {} : { anchor: intent.anchor }),
        });
        deck.update(current);
      },
      {
        appearance: { color: "none", unicode: true, theme: "plain", symbols: "ascii" },
      },
    );
    deck.start();
    await terminal.waitForRender();
    deck.tui.scrollBy(-3);
    expect(current.timelineNavigation.agent).toMatchObject({ following: false, unread: 0 });
    const append = (sequence: number, item: TimelineEvent["item"]): void => {
      current = reduceApp(current, {
        type: "timeline",
        update: { type: "event", agentId: "agent", event: { epoch: "stream", sequence, item } },
      });
      deck.update(current);
    };
    append(10, { id: "first", type: "error", message: "first unseen" });
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("1 new - G end");
    append(11, { id: "second", type: "turn", status: "completed" });
    append(12, {
      id: "delta",
      type: "assistant-message",
      messageId: "message-0",
      text: "event 0 updated",
    });
    await terminal.waitForRender();
    expect(current.timelineNavigation.agent?.unread).toBe(2);
    expect(terminal.viewport().join("\n")).toContain("2 new - G end");
    terminal.sendInput("G");
    await terminal.waitForRender();
    await deck.stop();

    expect(current.timelineNavigation.agent).toEqual({ following: true, unread: 0 });
  });

  it("moves between turn, error, and failed-tool landmarks from the timeline", async () => {
    const terminal = new RecordingTerminal(80, 14);
    const deck = new DeckTui(
      terminal,
      {
        ...state(),
        focus: "timeline",
        timeline: {
          recoveryRevision: 0,
          loading: false,
          items: [
            { epoch: "e", sequence: 1, item: { id: "user", type: "user-message", text: "start" } },
            { epoch: "e", sequence: 2, item: { id: "turn", type: "turn", status: "started" } },
            { epoch: "e", sequence: 3, item: { id: "error", type: "error", message: "failed" } },
            {
              epoch: "e",
              sequence: 4,
              item: { id: "tool", type: "tool", callId: "c", name: "git", status: "failed" },
            },
          ],
        },
      },
      () => undefined,
    );
    deck.start();
    await terminal.waitForRender();
    terminal.sendInput("]");
    terminal.sendInput("}");
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("> Error: failed");
  });

  it("restores an agent's paused semantic anchor after switching away and back", async () => {
    const terminal = new RecordingTerminal(80, 14);
    const items = Array.from({ length: 12 }, (_, sequence) => ({
      epoch: "a",
      sequence,
      item: {
        id: `message-${sequence}`,
        type: "assistant-message" as const,
        messageId: `message-${sequence}`,
        text: `event ${sequence}`,
      },
    }));
    let current: AppState = {
      ...state(),
      selectedAgentId: "a",
      focus: "timeline",
      timeline: { recoveryRevision: 0, loading: false, agentId: "a", items },
      timelineNavigation: { a: { following: true, unread: 0 } },
    };
    const deck = new DeckTui(terminal, current, (intent) => {
      if (intent.type !== "set-timeline-navigation") return;
      current = reduceApp(current, {
        type: "set-timeline-navigation",
        agentId: intent.agentId,
        following: intent.following,
        ...(intent.anchor === undefined ? {} : { anchor: intent.anchor }),
      });
      deck.update(current);
    });
    deck.start();
    await terminal.waitForRender();
    deck.tui.scrollBy(-4);
    await terminal.waitForRender();
    const pausedAnchor = current.timelineNavigation.a?.anchor;
    const recoveredItems = [
      {
        epoch: "a",
        sequence: -1,
        item: { id: "recovered", type: "error" as const, message: "older" },
      },
      ...items,
    ];
    current = {
      ...current,
      timeline: { recoveryRevision: 1, loading: false, agentId: "a", items: recoveredItems },
    };
    deck.update(current);
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain(`event ${pausedAnchor?.sequence}`);
    current = {
      ...current,
      selectedAgentId: "b",
      timeline: { recoveryRevision: 0, loading: false, agentId: "b", items: [] },
      timelineNavigation: { ...current.timelineNavigation, b: { following: true, unread: 0 } },
    };
    deck.update(current);
    current = {
      ...current,
      selectedAgentId: "a",
      timeline: { recoveryRevision: 1, loading: false, agentId: "a", items: recoveredItems },
    };
    deck.update(current);
    await terminal.waitForRender();
    await deck.stop();

    expect(current.timelineNavigation.a?.following).toBe(false);
    expect(terminal.viewport().join("\n")).toContain(`event ${pausedAnchor?.sequence}`);
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
    expect(treeViewport).toContain("Main");
    expect(
      treeViewport
        .split("\n")
        .map((line) => line.slice(0, 34))
        .join("\n"),
    ).not.toContain("Agent 11");

    const timelineState: AppState = {
      ...treeState,
      focus: "timeline",
      timeline: {
        recoveryRevision: 0,
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

  it("keeps focused-pane labels visible without persistent Vim instructions", async () => {
    const terminal = new RecordingTerminal(100, 16);
    const deck = new DeckTui(terminal, state(), () => undefined);

    deck.start();
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Projects / workspaces");
    expect(terminal.viewport().join("\n")).not.toContain("Sidebar:");
    deck.update({ ...state(), focus: "timeline" });
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("NORMAL Active session timeline");
    expect(terminal.viewport().join("\n")).not.toContain("Timeline NORMAL:");
    deck.update({ ...state(), focus: "composer" });
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("NORMAL Prompt");
    expect(terminal.viewport().join("\n")).not.toContain("Composer NORMAL:");
  });

  it("leaves the empty workspace tab row blank in a narrow viewport", async () => {
    const terminal = new RecordingTerminal(30, 12);
    const deck = new DeckTui(terminal, state(), () => undefined);

    deck.start();
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).not.toContain("Tabs");
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
        recoveryRevision: 0,
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
    expect(wideViewport).toContain("Main");
    expect(wideViewport).not.toContain("1 agent");
    expect(wideViewport).not.toContain("openai/gpt");
    terminal.setSize(42, 16);
    await terminal.waitForRender();
    const narrowViewport = terminal.viewport().join("\n");
    expect(narrowViewport).not.toContain("!1");
    expect(narrowViewport).not.toContain("openai/gpt");
    expect(narrowViewport).not.toContain("09/18 10:30");
    await deck.stop();
  });

  it("renders only the display-safe permission context supplied to the UI", async () => {
    const terminal = new RecordingTerminal(100, 16);
    const base = state();
    const permissionState: AppState = {
      ...base,
      directory: {
        ...base.directory,
        agents: [
          {
            id: "agent",
            workspaceId: "workspace",
            title: "Review",
            status: "running",
            availableModeIds: [],
            availableThinkingLevels: [],
            pendingPermissions: [
              {
                id: "permission-token=secret-request-id",
                agentId: "agent",
                title: "Run command",
                operation: "shell",
                arguments: ["command: curl -H Authorization: Bearer [redacted]"],
                description: "password=[redacted]",
              },
            ],
            needsAttention: true,
            archived: false,
          },
        ],
      },
      selectedAgentId: "agent",
      modal: {
        type: "permission",
        agentId: "agent",
        requestId: "permission-token=secret-request-id",
        queueIndex: 0,
        submitting: false,
      },
    };
    const deck = new DeckTui(terminal, base, () => undefined);

    deck.start();
    deck.update(permissionState);
    await terminal.waitForRender();
    const rendered = terminal.viewport().join("\n");
    expect(rendered).toContain("[redacted]");
    expect(rendered).not.toContain("secret-password");
    expect(rendered).not.toContain("secret-request-id");
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
        recoveryRevision: 0,
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
  it("confirms terminal termination through a centered fuzzy choice picker", async () => {
    const terminal = new RecordingTerminal(100, 28);
    const intents: unknown[] = [];
    const current: AppState = {
      ...state(),
      modal: { type: "confirm", action: "kill-terminal", terminalId: "terminal-1" },
    };
    const deck = new DeckTui(terminal, current, (intent) => intents.push(intent));
    deck.update(current);
    deck.start();
    await terminal.waitForRender();
    const lines = terminal.viewport();
    const top = lines.findIndex((line) => line.includes("Terminate terminal?"));
    const left = lines[top]?.indexOf("┌") ?? -1;
    expect(top).toBeGreaterThan(4);
    expect(left).toBeGreaterThan(10);
    expect(lines.join("\n")).toContain("> No - Keep terminal running");
    expect(lines.join("\n")).toContain("Yes - Terminate terminal and its process");
    expect(lines.join("\n")).not.toContain("␛_pi:c");

    terminal.sendInput("y");
    terminal.sendInput("s");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("> Yes - Terminate terminal and its process");
    terminal.sendInput("\r");
    await terminal.waitForRender();
    await deck.stop();
    expect(intents).toContainEqual({ type: "kill-terminal-confirmed", terminalId: "terminal-1" });
  });
  it("uses arrow keys to choose the safe terminal confirmation option", async () => {
    const terminal = new RecordingTerminal(100, 28);
    const intents: unknown[] = [];
    const current: AppState = {
      ...state(),
      modal: { type: "confirm", action: "kill-terminal", terminalId: "terminal-1" },
    };
    const deck = new DeckTui(terminal, current, (intent) => intents.push(intent));
    deck.update(current);
    deck.start();
    terminal.sendInput("\u001b[B");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("> Yes - Terminate terminal and its process");
    terminal.sendInput("\u001b[A");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("> No - Keep terminal running");
    terminal.sendInput("\r");
    await terminal.waitForRender();
    await deck.stop();
    expect(intents).toContainEqual({ type: "close-modal" });
    expect(intents).not.toContainEqual(
      expect.objectContaining({ type: "kill-terminal-confirmed" }),
    );
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
          recoveryRevision: 0,
          agentId: "agent",
          loading: false,
          usage: { inputTokens: 12, outputTokens: 3, contextTokens: 15, contextWindow: 100 },
          items: [],
        },
        notifications: [{ id: 1, kind: "info", message: "Directory refreshed." }],
        activeNotificationId: 1,
      },
      () => undefined,
    );

    deck.start();
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain(
      "ready/one · plan · low · context 15/100 · in 12 · out 3",
    );
    expect(terminal.viewport().join("\n")).not.toContain("Sidebar:");
  });

  it("expands the selected collapsed timeline block with Enter", async () => {
    const terminal = new RecordingTerminal(70, 16);
    const deck = new DeckTui(
      terminal,
      {
        ...state(),
        focus: "timeline",
        timeline: {
          recoveryRevision: 0,
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
    expect(lines.join("\n")).not.toContain("Tabs");
    expect(lines.join("\n")).toContain("Prompt");
    expect(lines.every((line) => line.length <= 30)).toBe(true);
  });

  it("contains unsafe wide markdown deltas while retaining the surrounding panes", async () => {
    const terminal = new RecordingTerminal(42, 14);
    const base = state();
    const timeline = {
      recoveryRevision: 0,
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
    expect(lines.join("\n")).toContain("conne");
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

  it("lists focus and session navigation keys in help", async () => {
    const terminal = new RecordingTerminal();
    const deck = new DeckTui(terminal, { ...state(), modal: { type: "help" } }, () => undefined);

    deck.start();
    await terminal.waitForRender();
    deck.update({ ...state(), modal: { type: "help" } });
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).not.toContain("Tab  Focus next pane");
    expect(terminal.viewport().join("\n")).toContain("h / Left  Collapse selected branch");
    await deck.stop();
  });

  it("lists bounded tree-width keys in help", async () => {
    const terminal = new RecordingTerminal();
    const deck = new DeckTui(terminal, state(), () => undefined);

    deck.start();
    deck.update({ ...state(), modal: { type: "help" } });
    await terminal.waitForRender();
    await deck.stop();

    expect(terminal.viewport().join("\n")).toContain("[  Narrow session tree");
    expect(terminal.viewport().join("\n")).toContain("]  Widen session tree");
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
    expect(terminal.viewport().join("\n")).toContain("Main");
    for (let index = 0; index < 50; index += 1) terminal.sendInput("[");
    await terminal.waitForRender();
    const narrowTree = terminal.viewport().slice(0, 8).join("\n");
    expect(narrowTree).not.toContain("openai/gpt");
    expect(narrowTree).toContain("No timeline selected");
    for (let index = 0; index < 50; index += 1) terminal.sendInput("]");
    await terminal.waitForRender();
    const wideTree = terminal.viewport().slice(0, 8).join("\n");
    expect(wideTree).toContain("Main");
    expect(wideTree).toContain("No timeline selected");
    deck.update({ ...resizedState, focus: "composer" });
    terminal.sendInput("x");
    await deck.stop();

    expect(intents).toContainEqual({ type: "set-composer-text", text: "draftx" });
  });

  it("opens the command palette from an editor and restores the composer without key leakage", async () => {
    const terminal = new RecordingTerminal();
    const intents: unknown[] = [];
    const base = state();
    const composerState: AppState = {
      ...base,
      selectedAgentId: "agent",
      focus: "composer",
      composer: { ...base.composer, drafts: { agent: "preserve me" } },
    };
    const deck = new DeckTui(terminal, composerState, (intent) => intents.push(intent));
    deck.start();
    terminal.sendInput("\u000b");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Command palette");
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    terminal.sendInput("x");
    await deck.stop();

    expect(intents).toContainEqual({ type: "set-composer-text", text: "preserve mex" });
    expect(intents).not.toContainEqual(
      expect.objectContaining({ type: "open-confirmation", action: "stop" }),
    );
  });

  it.each([
    {
      name: "rename",
      modal: { type: "rename" as const, agentId: "agent", value: "" },
      text: "Renamed",
      expected: {
        type: "command",
        command: { type: "rename-agent", agentId: "agent", name: "Renamed" },
      },
    },
    {
      name: "filter",
      modal: { type: "filter" as const, query: "" },
      text: "needle",
      expected: { type: "create-choice", choice: "needle" },
    },
    {
      name: "creation prompt",
      modal: {
        type: "create-agent" as const,
        workspaceId: "w",
        step: "prompt" as const,
        providerId: "ready",
        modelId: "one",
      },
      text: "preserve prompt",
      expected: { type: "create-choice", choice: "preserve prompt" },
    },
  ])(
    "restores unsaved $name text after palette and help close",
    async ({ modal, text, expected }) => {
      const terminal = new RecordingTerminal();
      const intents: unknown[] = [];
      const deck = new DeckTui(terminal, { ...state(), modal }, (intent) => intents.push(intent));
      deck.start();
      deck.update({ ...state(), modal });
      await terminal.waitForRender();
      terminal.sendInput(text);
      terminal.sendInput("\u000b");
      await terminal.waitForRender();
      expect(terminal.viewport().join("\n")).toContain("Command palette");
      terminal.sendInput("?");
      await terminal.waitForRender();
      expect(terminal.viewport().join("\n")).toContain("Paseo Deck keys");
      terminal.sendInput("\u001b");
      await terminal.waitForRender();
      expect(terminal.viewport().join("\n")).toContain("Command palette");
      terminal.sendInput("\u001b");
      terminal.sendInput("\r");
      await deck.stop();

      expect(intents).toContainEqual(expected);
    },
  );

  it("does not stack a palette over itself and keeps disabled palette actions inert", async () => {
    const terminal = new RecordingTerminal();
    const intents: unknown[] = [];
    const base = state();
    const deck = new DeckTui(terminal, base, (intent) => intents.push(intent));
    deck.start();
    terminal.sendInput("\u000b");
    terminal.sendInput("stop");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Select an active session first");
    terminal.sendInput("\r");
    terminal.sendInput("\u000b");
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).not.toContain("Command palette");
    expect(intents).not.toContainEqual(expect.objectContaining({ type: "open-confirmation" }));
    await deck.stop();
  });

  it("recomputes palette availability without reconstructing the open overlay", async () => {
    const terminal = new RecordingTerminal();
    const base = state();
    const deck = new DeckTui(terminal, base, () => undefined);
    deck.start();
    terminal.sendInput("\u000b");
    terminal.sendInput("stop");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Select an active session first");
    const agent = {
      id: "agent",
      workspaceId: "w",
      title: "Agent",
      status: "idle" as const,
      availableModeIds: [],
      availableThinkingLevels: [],
      pendingPermissions: [],
      needsAttention: false,
      archived: false,
    };
    deck.update({
      ...base,
      selectedAgentId: "agent",
      directory: { ...base.directory, agents: [agent] },
    });
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).not.toContain("Select an active session first");
    terminal.sendInput("\u001b");
    await deck.stop();
  });

  it("restores a clamped tree width and reports subsequent width changes", async () => {
    const terminal = new RecordingTerminal(100, 16);
    const preferences: Array<{
      treeWidth: number;
      theme?: "ember" | "plain";
      symbolSet?: "unicode" | "ascii";
    }> = [];
    const deck = new DeckTui(terminal, state(), () => undefined, {
      treeWidth: 999,
      onPreferencesChanged: (value) => preferences.push(value),
    });

    deck.start();
    terminal.sendInput("[");
    await terminal.waitForRender();
    await deck.stop();

    expect(preferences).toEqual([{ treeWidth: 46 }]);
  });

  it("invokes palette-visible presentation commands", async () => {
    const terminal = new RecordingTerminal(100, 16);
    const preferences: Array<{
      treeWidth: number;
      theme?: "ember" | "plain";
      symbolSet?: "unicode" | "ascii";
    }> = [];
    const deck = new DeckTui(terminal, state(), () => undefined, {
      onPreferencesChanged: (value) => preferences.push(value),
    });

    deck.start();
    terminal.sendInput("\u000b");
    terminal.sendInput("toggle theme");
    terminal.sendInput("\r");
    await terminal.waitForRender();
    terminal.sendInput("\u000b");
    terminal.sendInput("toggle symbol set");
    terminal.sendInput("\r");
    await terminal.waitForRender();
    await deck.stop();

    expect(preferences).toEqual([
      { treeWidth: 34, theme: "plain" },
      { treeWidth: 34, theme: "plain", symbolSet: "ascii" },
    ]);
  });

  it("keeps saved rich choices requested while rendering safe low-capability chrome", async () => {
    const lowAppearance: TerminalAppearance = {
      color: "none",
      unicode: false,
      theme: "plain",
      symbols: "ascii",
    };
    const lowTerminal = new RecordingTerminal(100, 16);
    const lowDeck = new DeckTui(lowTerminal, state(), () => undefined, {
      appearance: lowAppearance,
      requestedTheme: "ember",
      requestedSymbolSet: "unicode",
    });
    lowDeck.start();
    await lowTerminal.waitForRender();
    await lowDeck.stop();

    expect(lowTerminal.writes.join("")).not.toContain("\u001b[38;");
    expect(lowTerminal.writes.join("")).not.toContain("·");
    expect(lowTerminal.writes.join("")).not.toContain("•");

    const richTerminal = new RecordingTerminal(100, 16);
    const richDeck = new DeckTui(richTerminal, state(), () => undefined, {
      appearance: { color: "truecolor", unicode: true, theme: "ember", symbols: "unicode" },
      requestedTheme: "ember",
      requestedSymbolSet: "unicode",
    });
    richDeck.start();
    await richTerminal.waitForRender();
    await richDeck.stop();

    expect(richTerminal.writes.join("")).toContain("\u001b[38;2;");
    expect(richTerminal.writes.join("")).toContain("·");
  });

  it("toggles the requested theme under NO_COLOR without changing no-color rendering", async () => {
    const terminal = new RecordingTerminal(100, 16);
    const preferences: Array<{ treeWidth: number; theme?: "ember" | "plain" }> = [];
    const deck = new DeckTui(terminal, state(), () => undefined, {
      appearance: { color: "none", unicode: false, theme: "plain", symbols: "ascii" },
      requestedTheme: "ember",
      onPreferencesChanged: (value) => preferences.push(value),
    });

    deck.start();
    for (let index = 0; index < 2; index += 1) {
      terminal.sendInput("\u000b");
      terminal.sendInput("toggle theme");
      terminal.sendInput("\r");
      await terminal.waitForRender();
    }
    await deck.stop();

    expect(preferences).toEqual([
      { treeWidth: 34, theme: "plain" },
      { treeWidth: 34, theme: "ember" },
    ]);
    expect(terminal.writes.join("")).not.toContain("\u001b[38;");
  });

  it("explains why Unicode cannot be selected and never renders it on an ASCII terminal", async () => {
    const terminal = new RecordingTerminal(100, 16);
    const intents: unknown[] = [];
    const deck = new DeckTui(terminal, state(), (intent) => intents.push(intent), {
      appearance: { color: "none", unicode: false, theme: "plain", symbols: "ascii" },
      requestedSymbolSet: "unicode",
    });

    deck.start();
    terminal.sendInput("\u000b");
    terminal.sendInput("toggle symbol set");
    terminal.sendInput("\r");
    await terminal.waitForRender();
    await deck.stop();

    expect(intents).toContainEqual({
      type: "notify",
      message: "ASCII symbols are required by this terminal.",
    });
    expect(terminal.writes.join("")).not.toContain("·");
    expect(terminal.writes.join("")).not.toContain("•");
  });
});
