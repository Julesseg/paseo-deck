import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

async function fixture(twoSessions = false) {
  const gateway = new FakePaseoGateway({
    projects: [],
    providers: [],
    workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
    agents: [
      {
        id: "a",
        workspaceId: "w",
        title: "Session",
        status: "idle",
        archived: false,
        availableModeIds: [],
        availableThinkingLevels: [],
        pendingPermissions: [],
        needsAttention: false,
      },
      ...(twoSessions
        ? [
            {
              id: "b",
              workspaceId: "w",
              title: "Other",
              status: "idle" as const,
              archived: false,
              availableModeIds: [],
              availableThinkingLevels: [],
              pendingPermissions: [],
              needsAttention: false,
            },
          ]
        : []),
    ],
  });
  const app = new ApplicationController(gateway);
  await app.start();
  await app.handleIntent({ type: "submit-composer", agentId: "a", prompt: "older\nlast" });
  await app.handleIntent({ type: "submit-composer", agentId: "a", prompt: "newest" });
  app.setComposerText("draft\nend");
  const terminal = new RecordingTerminal(100, 30);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const unsubscribe = app.subscribe((state) => tui.update(state));
  tui.start();
  return {
    app,
    terminal,
    gateway,
    close: async () => {
      unsubscribe();
      await tui.stop();
      await gateway.close();
    },
  };
}

it("recalls only standalone logical-boundary motion, restores the draft and undoes recall", async () => {
  const { app, terminal, close } = await fixture();
  try {
    terminal.sendInput("g");
    terminal.sendInput("g");
    terminal.sendInput("1");
    terminal.sendInput("k");
    expect(app.state.composer.drafts.a).toBe("draft\nend");
    terminal.sendInput("k");
    expect(app.state.composer.drafts.a).toBe("newest");
    terminal.sendInput("k");
    expect(app.state.composer.drafts.a).toBe("older\nlast");
    terminal.sendInput("k");
    expect(app.state.composer.drafts.a).toBe("older\nlast");
    terminal.sendInput("G");
    terminal.sendInput("j");
    expect(app.state.composer.drafts.a).toBe("newest");
    terminal.sendInput("j");
    expect(app.state.composer.drafts.a).toBe("draft\nend");
    terminal.sendInput("u");
    expect(app.state.composer.drafts.a).toBe("newest");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("newest");
  } finally {
    await close();
  }
});

it("Insert arrows reach boundaries before recall and typing shares cross-mode undo", async () => {
  const { app, terminal, close } = await fixture();
  try {
    terminal.sendInput("g");
    terminal.sendInput("g");
    terminal.sendInput("l");
    terminal.sendInput("i");
    terminal.sendInput("\u001b[A");
    expect(app.state.composer.drafts.a).toBe("draft\nend");
    terminal.sendInput("\u001b[A");
    expect(app.state.composer.drafts.a).toBe("newest");
    terminal.sendInput("X");
    expect(app.state.composer.drafts.a).toBe("Xnewest");
    terminal.sendInput("\u001a");
    expect(app.state.composer.drafts.a).toBe("newest");
    terminal.sendInput("\u001b[90;6u");
    expect(app.state.composer.drafts.a).toBe("Xnewest");
    terminal.sendInput("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.state.composerMode).toBe("normal");
    terminal.sendInput("u");
    expect(app.state.composer.drafts.a).toBe("newest");
    terminal.sendInput("u");
    expect(app.state.composer.drafts.a).toBe("draft\nend");
  } finally {
    await close();
  }
});

it("inserts multiline paste atomically and keeps removed Insert shortcuts inert", async () => {
  const { app, terminal, gateway, close } = await fixture();
  try {
    terminal.sendInput("g");
    terminal.sendInput("g");
    terminal.sendInput("i");
    terminal.sendInput("Q");
    terminal.sendInput("\u001b[200~one\ntwo\u001b[201~");
    expect(app.state.composer.drafts.a).toBe("Qone\ntwodraft\nend");
    terminal.sendInput("\u001a");
    expect(app.state.composer.drafts.a).toBe("Qdraft\nend");
    for (const key of [
      "\t",
      "\u001b[Z",
      "\u0014",
      "\u0018",
      "\u000e",
      "\u0019",
      "\u001b[1;5A",
      "\u001b[5~",
    ])
      terminal.sendInput(key);
    expect(app.state.composer.drafts.a).toBe("Qdraft\nend");
    expect(app.state.modal.type).toBe("none");
    expect(gateway.commands.filter((command) => command.type !== "send-prompt")).toEqual([]);
    terminal.sendInput("\r");
    terminal.sendInput("\u001b\r");
    expect(app.state.composer.drafts.a).toBe("Q\n\ndraft\nend");
  } finally {
    await close();
  }
});

it("restores the saved boundary column and recalled-copy edits leave sent prompts unchanged", async () => {
  const { app, terminal, close } = await fixture();
  try {
    terminal.sendInput("g");
    terminal.sendInput("g");
    terminal.sendInput("l");
    terminal.sendInput("l");
    terminal.sendInput("k");
    terminal.sendInput("j");
    terminal.sendInput("i");
    terminal.sendInput("X");
    expect(app.state.composer.drafts.a).toBe("drXaft\nend");
    terminal.sendInput("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    terminal.sendInput("k");
    terminal.sendInput("i");
    terminal.sendInput("EDIT");
    expect(app.state.composer.drafts.a).toBe("EDITnewest");
    expect(app.state.composer.histories.a).toEqual(["newest", "older\nlast"]);
    terminal.sendInput("\u001b[B");
    terminal.sendInput("\u001b[B");
    expect(app.state.composer.drafts.a).toBe("EDITnewest");
  } finally {
    await close();
  }
});

it("moves through wrapped displayed rows before recalling from Insert", async () => {
  const { app, terminal, close } = await fixture();
  try {
    app.setComposerText("abcdefghijklmnopqrstuvwxyz".repeat(8));
    terminal.sendInput("G");
    terminal.sendInput("A");
    await terminal.waitForRender();
    terminal.sendInput("\u001b[A");
    expect(app.state.composer.drafts.a).toBe("abcdefghijklmnopqrstuvwxyz".repeat(8));
    terminal.sendInput("X");
    const edited = app.state.composer.drafts.a ?? "";
    expect(edited.indexOf("X")).toBeGreaterThan(0);
    expect(edited.indexOf("X")).toBeLessThan(208);
    expect(app.state.composerMode).toBe("insert");
  } finally {
    await close();
  }
});

it("keeps shared undo with its draft across focus and resource return", async () => {
  const { app, terminal, close } = await fixture(true);
  try {
    terminal.sendInput("g");
    terminal.sendInput("g");
    terminal.sendInput("i");
    terminal.sendInput("X");
    terminal.sendInput("\u0013");
    terminal.sendInput("\u000b");
    terminal.sendInput("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.state.composerMode).toBe("insert");
    await app.handleIntent({ type: "set-focus", focus: "composer" });
    await app.handleIntent({ type: "switch-tab", direction: 1 });
    expect(app.state.selectedAgentId).toBe("b");
    await app.handleIntent({ type: "set-focus", focus: "composer" });
    expect(app.state.focus).toBe("composer");
    terminal.sendInput("i");
    terminal.sendInput("B");
    terminal.sendInput("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    terminal.sendInput("u");
    expect(app.state.composer.drafts.b).toBe("");
    await app.handleIntent({ type: "switch-tab", direction: -1 });
    expect(app.state.selectedAgentId).toBe("a");
    await app.handleIntent({ type: "set-focus", focus: "composer" });
    expect(app.state.composerMode).toBe("insert");
    terminal.sendInput("\u001a");
    expect(app.state.composer.drafts.a).toBe("draft\nend");
    expect(app.state.composer.drafts.b).toBe("");
  } finally {
    await close();
  }
});

it("owns reviewed Insert character, word and logical-line editing keys", async () => {
  const { app, terminal, gateway, close } = await fixture();
  try {
    app.setComposerText("😀é one two\nsecond");
    terminal.sendInput("g");
    terminal.sendInput("g");
    terminal.sendInput("i");
    terminal.sendInput("\u0005"); // Ctrl-E: logical line end
    terminal.sendInput("\u0017"); // Ctrl-W: previous word
    expect(app.state.composer.drafts.a).toBe("😀é one \nsecond");
    terminal.sendInput("\u0001"); // Ctrl-A stays an editing key
    terminal.sendInput("\u0006"); // Ctrl-F skips the emoji grapheme
    terminal.sendInput("\u001b[3;2~"); // Shift-Delete removes combining grapheme
    expect(app.state.composer.drafts.a).toBe("😀 one \nsecond");
    terminal.sendInput("\u0002"); // Ctrl-B returns to start
    terminal.sendInput("\u001bd"); // Alt-D next word
    expect(app.state.composer.drafts.a).toBe(" one \nsecond");
    terminal.sendInput("\u001b[1;5C"); // Ctrl-Right next word
    terminal.sendInput("\u001b\u007f"); // Alt-Backspace previous word
    expect(app.state.composer.drafts.a).toBe("  \nsecond");
    expect(app.state.modal.type).toBe("none");
    expect(gateway.commands.filter((command) => command.type !== "send-prompt")).toEqual([]);
  } finally {
    await close();
  }
});
