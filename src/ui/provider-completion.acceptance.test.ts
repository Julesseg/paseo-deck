import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

async function fixture(columns = 100, rows = 28) {
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
        providerId: "codex",
        archived: false,
        availableModeIds: [],
        availableThinkingLevels: [],
        pendingPermissions: [],
        needsAttention: false,
      },
    ],
  });
  gateway.providerCommands = [
    { name: "clear", description: "Clear context", kind: "command" },
    { name: "review", description: "Review changes", kind: "skill" },
    { name: "research", description: "Research a topic", kind: "skill" },
    { name: "unknown", description: "Unclassified item" },
  ];
  const app = new ApplicationController(gateway);
  await app.start();
  const terminal = new RecordingTerminal(columns, rows);
  const deck = new DeckTui(terminal, app.state, (intent) => void app.handleIntent(intent), {
    treeWidth: 34,
  });
  const stop = app.subscribe((state) => deck.update(state));
  await deck.start();
  await terminal.waitForRender();
  return {
    app,
    gateway,
    terminal,
    keys: async (...keys: string[]) => {
      for (const key of keys) {
        for (const input of !key.startsWith("\u001b") && key.length > 1 ? [...key] : [key]) {
          terminal.sendInput(input);
          await terminal.waitForRender();
        }
      }
    },
    close: async () => {
      stop();
      await deck.stop();
      await app.releaseObservations();
      await gateway.close();
    },
  };
}

it("offers the Session provider catalog above a leading slash and accepts without sending", async () => {
  const f = await fixture();
  try {
    await f.keys("i", "/", "r", "v");
    const lines = f.terminal.viewport();
    const item = lines.findIndex((line) => line.includes("Review changes"));
    const prompt = lines.findIndex((line) => line.includes("/rv"));
    expect(item).toBeGreaterThanOrEqual(0);
    expect(item).toBe(prompt - 1);
    await f.keys("\r");
    expect(f.app.state.composer.drafts.a).toBe("/review ");
    expect(f.app.state.composerMode).toBe("insert");
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.close();
  }
});

it("replaces the entire token from its middle, reuses a space, and undoes only acceptance", async () => {
  const f = await fixture();
  try {
    await f.keys(
      "i",
      "please /rvjunk tail",
      "\u001b[H",
      ...Array.from({ length: 10 }, () => "\u001b[C"),
      "\t",
    );
    expect(f.app.state.composer.drafts.a).toBe("please /review tail");
    await f.keys("X");
    expect(f.app.state.composer.drafts.a).toBe("please /review Xtail");
    await f.keys("\u001a", "\u001a");
    expect(f.app.state.composer.drafts.a).toBe("please /rvjunk tail");
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.close();
  }
});

it("offers commands only at prompt start and skills at line starts and literal-space boundaries", async () => {
  const f = await fixture();
  try {
    await f.keys("i", "/");
    expect(f.terminal.viewport().join("\n")).toContain("Clear context");
    expect(f.terminal.viewport().join("\n")).toContain("Unclassified item");
    await f.keys("\u001b", "\u001b", "d", "d", "i", "please /");
    expect(f.terminal.viewport().join("\n")).toContain("Review changes");
    expect(f.terminal.viewport().join("\n")).not.toContain("Clear context");
    expect(f.terminal.viewport().join("\n")).not.toContain("Unclassified item");
    await f.keys("\r", "\r", "/");
    expect(f.terminal.viewport().join("\n")).toContain("Review changes");
    expect(f.terminal.viewport().join("\n")).not.toContain("Clear context");
  } finally {
    await f.close();
  }
});

it("uses arrows only in an open popup and dismisses with Escape, spaces, second slashes and zero matches", async () => {
  const f = await fixture();
  try {
    await f.keys("i", "/re", "\u001b[B", "\t");
    expect(f.app.state.composer.drafts.a).toBe("/research ");
    await f.keys("/r", "\u001b");
    expect(f.app.state.composerMode).toBe("insert");
    expect(f.terminal.viewport().join("\n")).not.toContain("Review changes");
    await f.keys("\u001b");
    expect(f.app.state.composerMode).toBe("normal");
    await f.keys("A", " ", "/", " ");
    expect(f.app.state.composer.drafts.a).toBe("/research /r / ");
    expect(f.terminal.viewport().join("\n")).not.toContain("Review changes");
    await f.keys("/tmp", "/", "file");
    expect(f.app.state.composer.drafts.a).toBe("/research /r / /tmp/file");
    expect(f.terminal.viewport().join("\n")).not.toContain("Review changes");
    await f.keys(" ", "/zz", "\r");
    expect(f.app.state.composer.drafts.a).toBe("/research /r / /tmp/file /zz\n");
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.close();
  }
});

it.each(["src/file", "~/file", "./file", "word/review"])(
  "keeps %s literal without a popup",
  async (text) => {
    const f = await fixture();
    try {
      await f.keys("i", text, "\t");
      expect(f.app.state.composer.drafts.a).toBe(text);
      expect(f.terminal.viewport().join("\n")).not.toContain("Review changes");
    } finally {
      await f.close();
    }
  },
);

it("keeps native paste literal and suppresses completion until a new slash reference", async () => {
  const f = await fixture();
  try {
    await f.keys("i", "/r", "\u001b[200~v\r\t/review\u001b[201~");
    expect(f.app.state.composer.drafts.a).toBe("/rv\n    /review");
    expect(f.gateway.commands).toEqual([]);
    expect(f.terminal.viewport().join("\n")).not.toContain("Review changes");
    await f.keys(" ", "\u001b[200~/r\u001b[201~");
    expect(f.terminal.viewport().join("\n")).not.toContain("Review changes");
    await f.keys(" ", "/r");
    expect(f.terminal.viewport().join("\n")).toContain("Review changes");
  } finally {
    await f.close();
  }
});

it.each([
  [100, 28],
  [160, 36],
  [52, 18],
  [30, 12],
])(
  "anchors a wrapped and scrolled reference above its visible row at %ix%i",
  async (columns, rows) => {
    const f = await fixture(columns, rows);
    try {
      await f.keys(
        "i",
        `\u001b[200~${Array.from({ length: 16 }, (_, i) => `line ${i}`).join("\n")}\n${"word ".repeat(12)}\u001b[201~`,
        "/rv",
      );
      const lines = f.terminal.viewport();
      const tokenRow = lines.findIndex((line) => line.includes("/rv"));
      const menuRow = lines.findIndex((line) => line.includes("/review"));
      expect(tokenRow).toBeGreaterThan(0);
      expect(menuRow).toBe(tokenRow - 1);
      expect(f.terminal.viewportCursor().row).toBe(tokenRow);
      expect(lines.length).toBe(rows);
      await f.keys("\t", "text");
      expect(f.app.state.composer.drafts.a?.endsWith("/review text")).toBe(true);
      expect(f.gateway.commands).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it("dismisses suggestions across global overlays and Sidebar focus while preserving the prompt and Normal search", async () => {
  const f = await fixture();
  try {
    await f.keys("i", "/rv", "\u0010");
    expect(f.terminal.viewport().join("\n")).not.toContain("Review changes");
    await f.keys("\u001b");
    expect(f.app.state.composer.drafts.a).toBe("/rv");
    expect(f.app.state.composerMode).toBe("insert");
    await f.keys(" ", "/rv", "\u0013");
    expect(f.app.state.focus).toBe("tree");
    expect(f.terminal.viewport().join("\n")).not.toContain("Review changes");
    await f.keys("\u001b", "\u001b", "/");
    expect(f.app.state.composerMode).toBe("normal");
    expect(f.terminal.viewport().join("\n")).not.toContain("Review changes");
    expect(f.app.state.composer.drafts.a).toBe("/rv /rv");
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.close();
  }
});
