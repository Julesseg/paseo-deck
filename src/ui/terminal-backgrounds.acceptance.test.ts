import { expect, it, vi } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { defaultTerminalAppearance } from "./capabilities.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

async function fixture(terminalFirst = false, appearance = defaultTerminalAppearance) {
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
    ],
  });
  gateway.terminals = [{ id: "t", workspaceId: "w", name: "Shell", cwd: "/tmp" }];
  const app = new ApplicationController(gateway);
  await app.start();
  gateway.emitTimeline("a", {
    type: "hydrated",
    agentId: "a",
    items: [
      {
        epoch: "e",
        sequence: 1,
        item: { id: "message", type: "user-message", text: "alpha target omega" },
      },
    ],
  });
  if (terminalFirst) await app.handleIntent({ type: "open-terminal", terminalId: "t" });
  const terminal = new RecordingTerminal(100, 28);
  const deck = new DeckTui(
    terminal,
    app.state,
    (intent) => {
      void app.handleIntent(intent);
    },
    { appearance },
  );
  const unsubscribe = app.subscribe((state) => deck.update(state));
  await deck.start();
  return {
    app,
    gateway,
    terminal,
    deck,
    close: async () => {
      unsubscribe();
      await deck.stop();
      await app.releaseObservations();
      await gateway.close();
    },
  };
}

it.each([
  ["whole BEL", ["\u001b]11;rgb:1c1c/1919/1717\u0007"]],
  ["fragmented BEL", ["\u001b]11;", "rgb:1c1c/1919/1717", "\u0007"]],
  ["whole ST", ["\u001b]11;rgb:1c1c/1919/1717\u001b\\"]],
  ["fragmented ST", ["\u001b", "]11;rgb:1c1c/1919/1717", "\u001b", "\\"]],
])(
  "applies %s OSC 11 reply without giving terminal protocol bytes to Composer",
  async (_name, chunks) => {
    const f = await fixture();
    try {
      f.terminal.sendInput("i");
      f.terminal.sendInput("draft");
      for (const chunk of chunks) f.terminal.sendInput(chunk);
      await f.terminal.waitForRender();
      expect(f.app.state.composer.drafts.a).toBe("draft");
      expect(f.app.state.composerMode).toBe("insert");
      expect(f.app.state.focus).toBe("composer");
      expect(f.terminal.viewportBackgrounds().flat()).toContain("#24211f");
    } finally {
      await f.close();
    }
  },
);

it("keeps focus and selection backgrounds visible when a truecolor terminal never answers OSC 11", async () => {
  const { app, terminal, close } = await fixture();
  try {
    terminal.sendInput("\u0013");
    await terminal.waitForRender();
    expect(app.state.focus).toBe("tree");
    const focusedRow = terminal.viewport().findIndex((line) => line.includes("Workspace"));
    const focusedBackgrounds = terminal.viewportBackgrounds()[focusedRow] ?? [];
    expect(
      focusedBackgrounds.some((value) => value !== undefined) ||
        terminal.viewportInverseCells()[focusedRow]?.some(Boolean),
      "Sidebar focus row must have a visible background without OSC 11",
    ).toBe(true);
    terminal.sendInput("\u000b");
    terminal.sendInput("g");
    terminal.sendInput("g");
    terminal.sendInput("j");
    terminal.sendInput("^");
    await terminal.waitForRender();
    expect(app.state.focus).toBe("timeline");
    const timelineRow = terminal.viewportCursor().row;
    expect(
      (terminal.viewportBackgrounds()[timelineRow] ?? []).some((value) => value !== undefined) ||
        terminal.viewportInverseCells()[timelineRow]?.some(Boolean),
      "Timeline current row must have a visible background without OSC 11",
    ).toBe(true);
    terminal.sendInput("v");
    terminal.sendInput("l");
    terminal.sendInput("l");
    await terminal.waitForRender();
    expect(app.state.timelineMode).toBe("visual");
    expect(terminal.viewportUnderlineCells()[timelineRow]?.filter(Boolean).length).toBe(3);
    expect(
      (terminal.viewportBackgrounds()[timelineRow] ?? []).some((value) => value !== undefined) ||
        terminal.viewportInverseCells()[timelineRow]?.some(Boolean),
      "Timeline Visual must remain visible without OSC 11",
    ).toBe(true);
  } finally {
    await close();
  }
});

it("routes fragmented startup OSC 11 replies to the Deck query while Terminal receives literal keys", async () => {
  const f = await fixture(true);
  try {
    for (const chunk of ["\u001b", "]11;rgb:1c1c/1919/1717", "\u001b", "\\"])
      f.terminal.sendInput(chunk);
    await f.terminal.waitForRender();
    expect(f.gateway.terminalInput).toEqual([]);
    expect(f.terminal.viewportBackgrounds().flat()).toContain("#24211f");
    f.terminal.sendInput("\u001b");
    f.terminal.sendInput("q");
    expect(f.gateway.terminalInput).toEqual([
      { terminalId: "t", data: "\u001b" },
      { terminalId: "t", data: "q" },
    ]);
  } finally {
    await f.close();
  }
});

it.each([
  { ...defaultTerminalAppearance, color: "none" as const, theme: "plain" as const },
  { ...defaultTerminalAppearance, theme: "plain" as const },
])(
  "preserves text fallbacks without inverse backgrounds in plain/no-color appearance",
  async (appearance) => {
    const f = await fixture(false, appearance);
    try {
      f.terminal.sendInput("\u0013");
      await f.terminal.waitForRender();
      const row = f.terminal.viewport().findIndex((line) => line.includes("Workspace"));
      expect(f.terminal.viewportInverseCells()[row]?.some(Boolean)).toBe(false);
      expect(f.terminal.viewportBackgrounds().flat().some(Boolean)).toBe(false);
      expect(f.terminal.viewport()[row]).toContain("Workspace");
      expect(f.app.state.focus).toBe("tree");
      f.terminal.sendInput("\u000b");
      f.terminal.sendInput("v");
      await f.terminal.waitForRender();
      expect(f.app.state.timelineMode).toBe("visual");
      expect(f.terminal.viewportBackgrounds().flat().some(Boolean)).toBe(false);
    } finally {
      await f.close();
    }
  },
);

it.each(["ls\r", "\u001b[102;1:3u", "\u001b[200~echo one\ntwo\u001b[201~"])(
  "keeps direct Terminal suffix literal after a fragmented background reply",
  async (suffix) => {
    const f = await fixture(true);
    try {
      f.terminal.sendInput("\u001b]11;rgb:1c1c/1919/1717");
      f.terminal.sendInput(`\u0007${suffix}`);
      await f.terminal.waitForRender();
      expect(f.gateway.terminalInput).toEqual([{ terminalId: "t", data: suffix }]);
      expect(f.terminal.viewportBackgrounds().flat()).toContain("#24211f");
    } finally {
      await f.close();
    }
  },
);

it.each([false, true])(
  "expires incomplete protocol candidates without trapping later input (direct=%s)",
  async (direct) => {
    const f = await fixture(direct);
    try {
      if (!direct) f.terminal.sendInput("i");
      vi.useFakeTimers();
      f.terminal.sendInput("\u001b]11;rgb:unfinished");
      f.terminal.sendInput("later");
      await vi.advanceTimersByTimeAsync(121);
      if (direct)
        expect(f.gateway.terminalInput).toEqual([
          { terminalId: "t", data: "\u001b]11;rgb:unfinished" },
          { terminalId: "t", data: "later" },
        ]);
      else expect(f.app.state.composer.drafts.a).toContain("later");
      f.terminal.sendInput("q");
      if (direct) expect(f.gateway.terminalInput.at(-1)?.data).toBe("q");
      else expect(f.app.state.composer.drafts.a).toContain("laterq");
    } finally {
      vi.useRealTimers();
      await f.close();
    }
  },
);

it("bounds oversized direct protocol candidates and restores original chunks", async () => {
  const f = await fixture(true);
  try {
    const chunks = ["\u001b]11;", "x".repeat(4097)];
    for (const chunk of chunks) f.terminal.sendInput(chunk);
    expect(f.gateway.terminalInput).toEqual(chunks.map((data) => ({ terminalId: "t", data })));
  } finally {
    await f.close();
  }
});

it.each([false, true])(
  "preserves chunked paste containing OSC-looking text (direct=%s)",
  async (direct) => {
    const f = await fixture(direct);
    try {
      if (!direct) f.terminal.sendInput("i");
      const payload = "\u001b]11;rgb:1c1c/1919/1717\u0007";
      const chunks = ["\u001b[200~", payload, "\u001b[201~"];
      for (const chunk of chunks) f.terminal.sendInput(chunk);
      await f.terminal.waitForRender();
      if (direct)
        expect(f.gateway.terminalInput).toEqual(chunks.map((data) => ({ terminalId: "t", data })));
      else expect(f.app.state.composer.drafts.a).toContain("11;rgb:1c1c/1919/1717");
      expect(f.terminal.viewportBackgrounds().flat().some(Boolean)).toBe(false);
    } finally {
      await f.close();
    }
  },
);
