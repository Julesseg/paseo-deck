import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

async function terminalDeck() {
  const gateway = new FakePaseoGateway({
    projects: [],
    providers: [],
    workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
    agents: [],
  });
  gateway.terminals = [{ id: "t", workspaceId: "w", name: "Shell", cwd: "/tmp" }];
  const app = new ApplicationController(gateway);
  await app.start();
  await app.handleIntent({ type: "open-terminal", terminalId: "t" });
  const terminal = new RecordingTerminal(110, 35);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const unsubscribe = app.subscribe((state) => tui.update(state));
  await tui.start();
  return {
    gateway,
    app,
    terminal,
    tui,
    async stop() {
      unsubscribe();
      await tui.stop();
      await app.releaseObservations();
    },
  };
}

it("a focused Terminal immediately delivers every ordinary key and paste literally", async () => {
  const deck = await terminalDeck();
  try {
    const input = [
      "x",
      "\u001b",
      "\u0003",
      "\u0015",
      "\u0004",
      "\u000b",
      "\u0010",
      "\u0014",
      "\u0001",
      "\u0018",
      "\t",
      "\u001b[Z",
      "g",
      "?",
      "g",
      "t",
      "g",
      "T",
      "q",
      "n",
      "i",
      "r",
      "\u001b[A",
      "\u001b[B",
      "\u001b[200~echo first\nsecond\u0013\u001b[201~",
    ];
    for (const key of input) deck.terminal.sendInput(key);
    expect(deck.gateway.terminalInput).toEqual(input.map((data) => ({ terminalId: "t", data })));
    expect(deck.app.state.focus).toBe("timeline");
    expect(deck.app.state.modal.type).toBe("none");
    await deck.terminal.waitForRender();
    expect(deck.terminal.viewport().join("\n")).toContain("Terminal");
    expect(deck.terminal.viewport().join("\n")).not.toMatch(/(?:NORMAL|INSERT) Terminal/);
  } finally {
    await deck.stop();
  }
});

it("Ctrl-S reaches Deck overlays and returning to Terminal resumes literal input", async () => {
  const deck = await terminalDeck();
  try {
    deck.terminal.sendInput("\u0013");
    expect(deck.app.state.focus).toBe("tree");
    deck.terminal.sendInput("\u0010");
    await deck.terminal.waitForRender();
    expect(deck.terminal.viewport().join("\n")).toContain("Command palette");
    deck.terminal.sendInput("rename");
    expect(deck.gateway.terminalInput).toEqual([]);
    deck.terminal.sendInput("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await deck.terminal.waitForRender();
    deck.terminal.sendInput("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(deck.app.state.focus).toBe("timeline");
    deck.terminal.sendInput("x");
    expect(deck.gateway.terminalInput).toEqual([{ terminalId: "t", data: "x" }]);
  } finally {
    await deck.stop();
  }
});

it("only distinguishable modified Tab chords switch Terminal tabs", async () => {
  const deck = await terminalDeck();
  try {
    await deck.gateway.createTerminal("w", { name: "Other" });
    await deck.app.handleIntent({ type: "refresh" });
    deck.terminal.sendInput("\u001b[9;5u");
    await deck.terminal.waitForRender();
    expect(deck.app.state.activeTerminalId).toBe("fake-terminal-2");
    deck.terminal.sendInput("\u001b[9;5:3u");
    expect(deck.app.state.activeTerminalId).toBe("fake-terminal-2");
    deck.terminal.sendInput("\u001b[9;6u");
    await deck.terminal.waitForRender();
    expect(deck.app.state.activeTerminalId).toBe("t");
    deck.terminal.sendInput("\u001b[115;5:3u");
    expect(deck.app.state.focus).toBe("timeline");
    deck.terminal.sendInput("\t");
    deck.terminal.sendInput("\u001b[Z");
    expect(deck.app.state.activeTerminalId).toBe("t");
    expect(deck.gateway.terminalInput).toEqual([
      { terminalId: "t", data: "\t" },
      { terminalId: "t", data: "\u001b[Z" },
    ]);
  } finally {
    await deck.stop();
  }
});

it("Composer and Timeline counted tabs resolve once across Terminals, reject invalid indices and wrap backwards", async () => {
  const gateway = new FakePaseoGateway({
    projects: [],
    providers: [],
    workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
    agents: ["a", "b"].map((id) => ({
      id,
      workspaceId: "w",
      title: id,
      status: "idle" as const,
      archived: false,
      availableModeIds: [],
      availableThinkingLevels: [],
      pendingPermissions: [],
      needsAttention: false,
    })),
  });
  gateway.terminals = [{ id: "t", workspaceId: "w", name: "Shell", cwd: "/tmp" }];
  const app = new ApplicationController(gateway);
  await app.start();
  const terminal = new RecordingTerminal(110, 35);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const unsubscribe = app.subscribe((state) => tui.update(state));
  await tui.start();
  try {
    // Directory order is Sessions a,b then Terminal t. Traversing two tabs
    // backwards must resolve b without ever sending a suffix to t.
    for (const key of ["2", "g", "T"]) terminal.sendInput(key);
    await terminal.waitForRender();
    expect(app.state.activeTabIds.w).toBe("session:b");
    expect(gateway.terminalInput).toEqual([]);
    for (const key of ["3", "g", "T", "9", "g", "t"]) terminal.sendInput(key);
    await terminal.waitForRender();
    expect(app.state.activeTabIds.w).toBe("session:b");
    expect(gateway.terminalInput).toEqual([]);
    await app.handleIntent({ type: "set-timeline-mode", mode: "visual" });
    for (const key of ["g", "t", "2", "g", "T", "\u0014", "\u0018", "\u0001"])
      terminal.sendInput(key);
    await terminal.waitForRender();
    expect(app.state.activeTabIds.w).toBe("session:b");
    expect(app.state.modal.type).toBe("none");
    await app.handleIntent({ type: "set-timeline-mode", mode: "normal" });
    await app.handleIntent({ type: "set-focus", focus: "composer" });
    for (const key of ["9", "g", "t"]) terminal.sendInput(key);
    expect(app.state.activeTabIds.w).toBe("session:b");
    for (const key of ["1", "g", "t"]) terminal.sendInput(key);
    await terminal.waitForRender();
    expect(app.state.activeTabIds.w).toBe("session:a");
    await app.handleIntent({ type: "set-focus", focus: "composer" });
    for (const key of ["g", "t"]) terminal.sendInput(key);
    await terminal.waitForRender();
    expect(app.state.activeTabIds.w).toBe("session:b");
    terminal.sendInput("\u0018");
    expect(app.state.modal).toMatchObject({ type: "confirm", action: "stop", agentId: "b" });
    await app.handleIntent({ type: "close-modal" });
    terminal.sendInput("\u0001");
    expect(app.state.modal).toMatchObject({ type: "confirm", action: "archive", agentId: "b" });
    await app.handleIntent({ type: "close-modal" });
    await app.handleIntent({ type: "set-focus", focus: "composer" });
    terminal.sendInput("\u0018");
    expect(app.state.modal).toMatchObject({ type: "confirm", action: "stop", agentId: "b" });
    await app.handleIntent({ type: "close-modal" });
    terminal.sendInput("v");
    for (const key of ["\u0018", "\u0001", "g", "t"]) terminal.sendInput(key);
    expect(app.state.modal.type).toBe("none");
    expect(app.state.activeTabIds.w).toBe("session:b");
    await app.handleIntent({ type: "set-focus", focus: "tree" });
    for (const key of ["2", "g", "t", "g", "T", "\u0018", "\u0014"]) terminal.sendInput(key);
    expect(app.state.modal.type).toBe("none");
    expect(app.state.activeTabIds.w).toBe("session:b");
  } finally {
    unsubscribe();
    await tui.stop();
    await app.releaseObservations();
  }
});

it("enhanced releases stay literal in Terminal and cannot repeat Deck actions", async () => {
  const deck = await terminalDeck();
  try {
    deck.terminal.sendInput("\u001b[13;1:3u");
    expect(deck.gateway.terminalInput).toEqual([{ terminalId: "t", data: "\u001b[13;1:3u" }]);
    deck.terminal.sendInput("\u0013");
    deck.terminal.sendInput("\u001b[112;5:3u"); // Ctrl-P release, no palette
    await deck.terminal.waitForRender();
    expect(deck.terminal.viewport().join("\n")).not.toContain("Command palette");
    expect(deck.app.state.focus).toBe("tree");
  } finally {
    await deck.stop();
  }
});

it("enhanced Enter release never submits a Normal Composer draft", async () => {
  const gateway = new FakePaseoGateway({
    projects: [],
    providers: [],
    workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
    agents: [],
  });
  const app = new ApplicationController(gateway);
  await app.start();
  await app.handleIntent({ type: "set-composer-text", text: "draft" });
  const terminal = new RecordingTerminal(110, 35);
  const intents: unknown[] = [];
  const tui = new DeckTui(terminal, app.state, (intent) => {
    intents.push(intent);
    void app.handleIntent(intent);
  });
  const unsubscribe = app.subscribe((state) => tui.update(state));
  await tui.start();
  try {
    terminal.sendInput("\u001b[13;1:3u");
    expect(intents).toEqual([]);
    terminal.sendInput("i");
    terminal.sendInput("\u001b[13;1:3u");
    expect(app.state.launchDrafts?.w?.prompt).toBe("draft");
  } finally {
    unsubscribe();
    await tui.stop();
    await app.releaseObservations();
  }
});

it("Normal app controls stay out of Composer Insert and Visual", async () => {
  const gateway = new FakePaseoGateway({
    projects: [],
    providers: [],
    workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
    agents: [],
  });
  const app = new ApplicationController(gateway);
  await app.start();
  const terminal = new RecordingTerminal(110, 35);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const unsubscribe = app.subscribe((state) => tui.update(state));
  await tui.start();
  try {
    terminal.sendInput("\u0014");
    expect(app.state.modal.type).toBe("new-tab");
    await app.handleIntent({ type: "close-modal" });
    terminal.sendInput("i");
    for (const key of ["\u0014", "\u0018", "\u0001"]) terminal.sendInput(key);
    expect(app.state.modal.type).toBe("none");
    terminal.sendInput("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    terminal.sendInput("v");
    for (const key of ["\u0014", "\u0018", "\u0001", "g", "t"]) terminal.sendInput(key);
    expect(app.state.modal.type).toBe("none");
  } finally {
    unsubscribe();
    await tui.stop();
    await app.releaseObservations();
  }
});
