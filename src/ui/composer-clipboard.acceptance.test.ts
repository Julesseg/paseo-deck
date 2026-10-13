import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { emptyDirectory } from "../contracts/app-state.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { selectedComposerDraft } from "../state/composer.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

it("copies deletes to system clipboard and pastes fresh external text through the application", async () => {
  const gateway = new FakePaseoGateway({
    ...emptyDirectory(),
    workspaces: [{ id: "w", title: "Workspace", directory: "/w", archived: false }],
    agents: [
      {
        id: "a",
        workspaceId: "w",
        title: "Session",
        status: "idle",
        archived: false,
        pendingPermissions: [],
        needsAttention: false,
        availableModeIds: [],
        availableThinkingLevels: [],
      },
    ],
  });
  const app = new ApplicationController(gateway);
  await app.start();
  await app.handleIntent({ type: "set-composer-text", text: "one two" });
  await app.handleIntent({ type: "set-composer-mode", mode: "normal" });
  await app.handleIntent({ type: "set-focus", focus: "composer" });
  let clipboard = "outside";
  const terminal = new RecordingTerminal(100, 30);
  const deck = new DeckTui(
    terminal,
    app.state,
    (intent) => {
      void app.handleIntent(intent);
    },
    {
      clipboard: {
        read: () => clipboard,
        write: (text) => {
          clipboard = text;
        },
      },
    },
  );
  const unsubscribe = app.subscribe((state) => deck.update(state));
  deck.start();
  try {
    terminal.sendInput("0");
    terminal.sendInput("d");
    terminal.sendInput("w");
    await terminal.waitForRender();
    expect(selectedComposerDraft(app.state)).toBe("two");
    expect(clipboard).toBe("one ");
    clipboard = "EXTERNAL\ntext";
    terminal.sendInput("P");
    await terminal.waitForRender();
    expect(selectedComposerDraft(app.state)).toBe("EXTERNAL\ntexttwo");
    expect(terminal.viewport().join("\n")).toContain("EXTERNAL");
    expect(gateway.commands).toEqual([]);
    await app.handleIntent({ type: "set-composer-text", text: "😀éx" });
    terminal.sendInput("0");
    terminal.sendInput("l");
    terminal.sendInput("x");
    await terminal.waitForRender();
    expect(selectedComposerDraft(app.state)).toBe("😀x");
  } finally {
    unsubscribe();
    await deck.stop();
    await gateway.close();
  }
});

it("reports clipboard failures without pasting the prior copied value or changing a failed target", async () => {
  const gateway = new FakePaseoGateway({
    ...emptyDirectory(),
    workspaces: [{ id: "w", title: "Workspace", directory: "/w", archived: false }],
    agents: [
      {
        id: "a",
        workspaceId: "w",
        title: "Session",
        status: "idle",
        archived: false,
        pendingPermissions: [],
        needsAttention: false,
        availableModeIds: [],
        availableThinkingLevels: [],
      },
    ],
  });
  const app = new ApplicationController(gateway);
  await app.start();
  await app.handleIntent({ type: "set-composer-text", text: "one two" });
  await app.handleIntent({ type: "set-composer-mode", mode: "normal" });
  await app.handleIntent({ type: "set-focus", focus: "composer" });
  let failWrite = false;
  let clipboard = "outside";
  const terminal = new RecordingTerminal(100, 30);
  const deck = new DeckTui(
    terminal,
    app.state,
    (intent) => {
      void app.handleIntent(intent);
    },
    {
      clipboard: {
        read: () => {
          throw Error("read denied");
        },
        write: (text) => {
          if (failWrite) throw Error("write denied");
          clipboard = text;
        },
      },
    },
  );
  const unsubscribe = app.subscribe((state) => deck.update(state));
  deck.start();
  try {
    terminal.sendInput("0");
    terminal.sendInput("y");
    terminal.sendInput("w");
    await terminal.waitForRender();
    expect(clipboard).toBe("one ");
    terminal.sendInput("p");
    await terminal.waitForRender();
    expect(selectedComposerDraft(app.state)).toBe("one two");
    expect(app.state.notifications.at(-1)?.message).toBe("Clipboard read failed.");
    failWrite = true;
    terminal.sendInput("d");
    terminal.sendInput("w");
    await terminal.waitForRender();
    expect(selectedComposerDraft(app.state)).toBe("two");
    expect(clipboard).toBe("one ");
    expect(app.state.notifications.at(-1)?.message).toBe("Clipboard write failed.");
    terminal.sendInput("c");
    terminal.sendInput("i");
    terminal.sendInput("q");
    await terminal.waitForRender();
    expect(selectedComposerDraft(app.state)).toBe("two");
    expect(app.state.composerMode).toBe("normal");
    terminal.sendInput("v");
    terminal.sendInput("l");
    terminal.sendInput("p");
    await terminal.waitForRender();
    expect(selectedComposerDraft(app.state)).toBe("two");
    expect(app.state.composerMode).toBe("visual");
    expect(terminal.viewport().join("\n")).toContain("selected 2 chars");
    expect(gateway.commands).toEqual([]);
  } finally {
    unsubscribe();
    await deck.stop();
    await gateway.close();
  }
});

it("keeps clipboard reads through background updates and discards them after switching resource", async () => {
  const agents = ["a", "b"].map((id) => ({
    id,
    workspaceId: "w",
    title: id,
    status: "idle" as const,
    archived: false,
    pendingPermissions: [],
    needsAttention: false,
    availableModeIds: [],
    availableThinkingLevels: [],
  }));
  const gateway = new FakePaseoGateway({
    ...emptyDirectory(),
    workspaces: [{ id: "w", title: "Workspace", directory: "/w", archived: false }],
    agents,
  });
  const app = new ApplicationController(gateway);
  await app.start();
  await app.handleIntent({ type: "set-composer-text", text: "first draft" });
  await app.handleIntent({ type: "set-composer-mode", mode: "normal" });
  await app.handleIntent({ type: "set-focus", focus: "composer" });
  let finishRead: (text: string) => void = () => undefined;
  const terminal = new RecordingTerminal(100, 30);
  const deck = new DeckTui(
    terminal,
    app.state,
    (intent) => {
      void app.handleIntent(intent);
    },
    {
      clipboard: {
        read: () =>
          new Promise<string>((resolve) => {
            finishRead = resolve;
          }),
        write: () => undefined,
      },
    },
  );
  const unsubscribe = app.subscribe((state) => deck.update(state));
  deck.start();
  try {
    terminal.sendInput("p");
    await app.handleIntent({ type: "notify", message: "Background update" });
    finishRead("fresh");
    await terminal.waitForRender();
    expect(selectedComposerDraft(app.state)).toBe("first draftfresh");
    terminal.sendInput("p");
    await app.selectAgent("b");
    finishRead("late clipboard text");
    await terminal.waitForRender();
    expect(selectedComposerDraft(app.state)).toBe("");
    expect(app.state.composer.drafts.a).toBe("first draftfresh");
    expect(terminal.viewport().join("\n")).not.toContain("late clipboard text");
    expect(gateway.commands).toEqual([]);
  } finally {
    unsubscribe();
    await deck.stop();
    await gateway.close();
  }
});

it("replaces wrapped backward Visual selections using fresh p/P and native paste across focus", async () => {
  const gateway = new FakePaseoGateway({
    ...emptyDirectory(),
    workspaces: [{ id: "w", title: "Workspace", directory: "/w", archived: false }],
    agents: [
      {
        id: "a",
        workspaceId: "w",
        title: "Session",
        status: "idle",
        archived: false,
        pendingPermissions: [],
        needsAttention: false,
        availableModeIds: [],
        availableThinkingLevels: [],
      },
    ],
  });
  const app = new ApplicationController(gateway);
  await app.start();
  const text = `😀é ${"word ".repeat(28)}END`;
  await app.handleIntent({ type: "set-composer-text", text });
  await app.handleIntent({ type: "set-composer-mode", mode: "normal" });
  await app.handleIntent({ type: "set-focus", focus: "composer" });
  let clipboard = "EXTERNAL";
  const terminal = new RecordingTerminal(100, 30);
  const deck = new DeckTui(
    terminal,
    app.state,
    (intent) => {
      void app.handleIntent(intent);
    },
    {
      appearance: {
        color: "truecolor",
        unicode: true,
        theme: "ember",
        symbols: "unicode",
        palette: "ember",
      },
      clipboard: {
        read: () => clipboard,
        write: (value) => {
          clipboard = value;
        },
      },
    },
  );
  const stop = app.subscribe((state) => deck.update(state));
  deck.start();
  try {
    for (const key of ["0", "v", "$", "o", "\u0013", "\u001b"]) terminal.sendInput(key);
    await terminal.waitForRender();
    expect(app.state.composerMode).toBe("visual");
    expect(terminal.viewport().join("\n")).toContain("selected");
    const rows = terminal.viewport();
    const backgrounds = terminal.viewportBackgrounds();
    const wordRows = rows
      .map((row, index) => (row.includes("word") ? index : -1))
      .filter((index) => index >= 0);
    expect(wordRows.length).toBeGreaterThan(1);
    expect(wordRows.every((row) => new Set(backgrounds[row]?.filter(Boolean)).size > 1)).toBe(true);
    terminal.sendInput("P");
    await terminal.waitForRender();
    expect(selectedComposerDraft(app.state)).toBe("EXTERNAL");
    expect(clipboard).toBe("EXTERNAL");
    terminal.sendInput("u");
    for (const key of ["0", "v", "l", "p"]) terminal.sendInput(key);
    await terminal.waitForRender();
    expect(selectedComposerDraft(app.state)).toBe(`EXTERNAL ${"word ".repeat(28)}END`);
    expect(clipboard).toBe("😀é");
    for (const key of ["0", "v", "l"]) terminal.sendInput(key);
    terminal.sendInput("\u001b[200~N\n😀\u001b[201~");
    await terminal.waitForRender();
    expect(selectedComposerDraft(app.state).startsWith("N\n😀TERNAL")).toBe(true);
    expect(app.state.composerMode).toBe("insert");
    expect(clipboard).toBe("😀é");
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    expect(app.state.composerMode).toBe("normal");
    terminal.sendInput("u");
    await terminal.waitForRender();
    expect(selectedComposerDraft(app.state)).toBe(`EXTERNAL ${"word ".repeat(28)}END`);
    terminal.sendInput("g");
    terminal.sendInput("v");
    await terminal.waitForRender();
    expect(app.state.composerMode).toBe("normal");
    expect(gateway.commands).toEqual([]);
  } finally {
    stop();
    await deck.stop();
    await gateway.close();
  }
});
