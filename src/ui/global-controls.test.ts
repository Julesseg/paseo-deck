import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

it.each([
  ["legacy", "\u0013", "\u000b", "\u0010", "\u0003"],
  ["CSI-u", "\u001b[115;5u", "\u001b[107;5u", "\u001b[112;5u", "\u001b[99;5u"],
  [
    "modifyOtherKeys",
    "\u001b[27;5;115~",
    "\u001b[27;5;107~",
    "\u001b[27;5;112~",
    "\u001b[27;5;99~",
  ],
])(
  "routes %s focus, palette and quit globals from Insert without editing",
  async (_, sidebar, timeline, palette, quit) => {
    const app = new ApplicationController(
      new FakePaseoGateway({
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
      }),
    );
    await app.start();
    const terminal = new RecordingTerminal(100, 30);
    const tui = new DeckTui(terminal, app.state, (intent) => {
      void app.handleIntent(intent);
    });
    const stop = app.subscribe((state) => tui.update(state));
    await tui.start();
    try {
      terminal.sendInput("i");
      terminal.sendInput("draft");
      terminal.sendInput(sidebar);
      expect(app.state.focus).toBe("tree");
      expect(app.state.composerMode).toBe("insert");
      terminal.sendInput(timeline);
      expect(app.state.focus).toBe("timeline");
      terminal.sendInput(palette);
      await terminal.waitForRender();
      expect(terminal.viewport().join("\n")).toContain("Command palette");
      expect(app.state.composer.drafts.a).toBe("draft");
      terminal.sendInput(quit);
      await terminal.waitForRender();
      expect(terminal.viewport().join("\n")).toContain("Quit and discard");
    } finally {
      stop();
      await tui.stop();
    }
  },
);

it("canceling dirty quit restores the exact rename editor and cursor", async () => {
  const app = new ApplicationController(
    new FakePaseoGateway({
      projects: [],
      providers: [],
      workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
      agents: [
        {
          id: "a",
          workspaceId: "w",
          title: "Original",
          status: "idle",
          archived: false,
          availableModeIds: [],
          availableThinkingLevels: [],
          pendingPermissions: [],
          needsAttention: false,
        },
      ],
    }),
  );
  await app.start();
  app.setComposerText("unsent");
  const terminal = new RecordingTerminal(100, 30);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const stop = app.subscribe((state) => tui.update(state));
  await tui.start();
  try {
    await app.handleIntent({ type: "open-rename", agentId: "a" });
    terminal.sendInput("X");
    terminal.sendInput("\u001b[D");
    await terminal.waitForRender();
    const before = terminal.viewport();
    const cursor = terminal.viewportCursor();
    terminal.sendInput("\u0003");
    terminal.sendInput("\u0003");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Quit and discard");
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    expect(terminal.viewport()).toEqual(before);
    expect(terminal.viewportCursor()).toEqual(cursor);
  } finally {
    stop();
    await tui.stop();
  }
});

it("each session restores its own Insert mode and cursor after switching tabs", async () => {
  const agents = ["a", "b"].map((id) => ({
    id,
    workspaceId: "w",
    title: id,
    status: "idle" as const,
    archived: false,
    availableModeIds: [],
    availableThinkingLevels: [],
    pendingPermissions: [],
    needsAttention: false,
  }));
  const app = new ApplicationController(
    new FakePaseoGateway({
      projects: [],
      providers: [],
      workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
      agents,
    }),
  );
  await app.start();
  const terminal = new RecordingTerminal(100, 30);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const stop = app.subscribe((state) => tui.update(state));
  tui.start();
  try {
    terminal.sendInput("i");
    terminal.sendInput("abc");
    terminal.sendInput("\u001b[D");
    await app.handleIntent({ type: "switch-tab", direction: 1 });
    expect(app.state.composerMode).toBe("normal");
    await app.handleIntent({ type: "set-focus", focus: "composer" });
    terminal.sendInput("i");
    terminal.sendInput("xyz");
    await app.handleIntent({ type: "switch-tab", direction: -1 });
    expect(app.state.composerMode).toBe("insert");
    await app.handleIntent({ type: "set-focus", focus: "composer" });
    terminal.sendInput("Q");
    expect(app.state.composer.drafts.a).toBe("abQc");
    expect(app.state.composer.drafts.b).toBe("xyz");
  } finally {
    stop();
    await tui.stop();
    await app.releaseObservations();
  }
});

it("unavailable Timeline preserves a count, while a real focus transition cancels it", async () => {
  const gateway = new FakePaseoGateway({
    projects: [],
    providers: [],
    workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
    agents: [],
  });
  const initial = new ApplicationController(gateway).state;
  const app = new ApplicationController(gateway, {
    initialState: {
      ...initial,
      connection: "connected",
      directory: {
        ...initial.directory,
        workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
      },
      selectedWorkspaceId: "w",
      activeTabIds: { w: "draft:w" },
      sessionDrafts: { w: { prompt: "abcdef" } },
      focus: "composer",
      composerMode: "normal",
    },
  });
  const terminal = new RecordingTerminal(100, 30);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const stop = app.subscribe((state) => tui.update(state));
  tui.start();
  try {
    terminal.sendInput("0");
    terminal.sendInput("3");
    terminal.sendInput("\u000b");
    terminal.sendInput("x");
    expect(app.state.sessionDrafts.w?.prompt).toBe("def");
    terminal.sendInput("2");
    terminal.sendInput("\u0013");
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    terminal.sendInput("x");
    expect(app.state.sessionDrafts.w?.prompt).toBe("ef");
  } finally {
    stop();
    await tui.stop();
  }
});

it("restores Visual selection and undo across Sidebar focus", async () => {
  const directory = {
    projects: [],
    providers: [],
    workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
    agents: [
      {
        id: "a",
        workspaceId: "w",
        title: "Session",
        status: "idle" as const,
        archived: false,
        availableModeIds: [],
        availableThinkingLevels: [],
        pendingPermissions: [],
        needsAttention: false,
      },
    ],
  };
  const app = new ApplicationController(new FakePaseoGateway(directory));
  await app.start();
  const terminal = new RecordingTerminal(100, 30);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const stop = app.subscribe((state) => tui.update(state));
  tui.start();
  try {
    terminal.sendInput("i");
    terminal.sendInput("abcdef");
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    for (const key of ["0", "v", "l", "l"]) terminal.sendInput(key);
    terminal.sendInput("\u0013");
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    expect(app.state.composerMode).toBe("visual");
    expect(terminal.viewport().join("\n")).toContain("selected 3 chars");
    terminal.sendInput("x");
    expect(app.state.composer.drafts.a).toBe("def");
    terminal.sendInput("u");
    expect(app.state.composer.drafts.a).toBe("abcdef");
    terminal.sendInput("g");
    terminal.sendInput("?");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Paseo Deck keys");
    terminal.sendInput("?");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Paseo Deck keys");
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    expect(app.state.composerMode).toBe("normal");
  } finally {
    stop();
    await tui.stop();
    await app.releaseObservations();
  }
});

it("palette self-invocation preserves its query and selected result", async () => {
  const app = new ApplicationController(
    new FakePaseoGateway({ projects: [], providers: [], workspaces: [], agents: [] }),
  );
  const terminal = new RecordingTerminal(100, 30);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const stop = app.subscribe((state) => tui.update(state));
  tui.start();
  try {
    terminal.sendInput("\u0010");
    terminal.sendInput("theme");
    await terminal.waitForRender();
    const before = terminal.viewport();
    terminal.sendInput("\u0010");
    await terminal.waitForRender();
    expect(terminal.viewport()).toEqual(before);
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).not.toContain("Command palette");
  } finally {
    stop();
    await tui.stop();
  }
});

it("captured confirmation runs once and late completion leaves a newer dialog intact", async () => {
  const gateway = new FakePaseoGateway({
    projects: [],
    providers: [],
    workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
    agents: [
      {
        id: "a",
        workspaceId: "w",
        title: "Captured session",
        status: "running",
        archived: false,
        availableModeIds: [],
        availableThinkingLevels: [],
        pendingPermissions: [],
        needsAttention: false,
      },
    ],
  });
  let finish!: () => void;
  const execute = gateway.execute.bind(gateway);
  gateway.execute = async (command) => {
    const result = await execute(command);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return result;
  };
  const app = new ApplicationController(gateway);
  await app.start();
  const terminal = new RecordingTerminal(100, 30);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const stop = app.subscribe((state) => tui.update(state));
  tui.start();
  try {
    await app.handleIntent({ type: "open-confirmation", action: "stop", agentId: "a" });
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Stop Session Captured session (a)?");
    terminal.sendInput("\r");
    terminal.sendInput("\r");
    await terminal.waitForRender();
    expect(gateway.commands).toEqual([{ type: "stop-agent", agentId: "a" }]);
    expect(terminal.viewport().join("\n")).toContain("request continues");
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    await app.handleIntent({ type: "open-confirmation", action: "stop", agentId: "a" });
    terminal.sendInput("\r");
    await terminal.waitForRender();
    expect(gateway.commands).toEqual([{ type: "stop-agent", agentId: "a" }]);
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    await app.handleIntent({ type: "open-rename", agentId: "a" });
    terminal.sendInput("New ");
    finish();
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Rename Session");
    expect(terminal.viewport().join("\n")).toContain("New Captured session");
  } finally {
    stop();
    await tui.stop();
    await app.releaseObservations();
  }
});

it("a vanished captured target stays visible with a reason and never executes", async () => {
  const gateway = new FakePaseoGateway({
    projects: [],
    providers: [],
    workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
    agents: [
      {
        id: "a",
        workspaceId: "w",
        title: "Captured session",
        status: "running",
        archived: false,
        availableModeIds: [],
        availableThinkingLevels: [],
        pendingPermissions: [],
        needsAttention: false,
      },
    ],
  });
  const app = new ApplicationController(gateway);
  await app.start();
  const terminal = new RecordingTerminal(100, 30);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const stop = app.subscribe((state) => tui.update(state));
  tui.start();
  try {
    await app.handleIntent({ type: "open-confirmation", action: "stop", agentId: "a" });
    gateway.emitDirectory({ type: "agent-removed", agentId: "a" });
    terminal.sendInput("\r");
    await terminal.waitForRender();
    expect(gateway.commands).toEqual([]);
    expect(terminal.viewport().join("\n")).toContain("Captured Session is no longer available");
    terminal.sendInput("\r");
    expect(gateway.commands).toEqual([]);
  } finally {
    stop();
    await tui.stop();
    await app.releaseObservations();
  }
});

it("running Terminal owns Ctrl-C, Ctrl-K and Ctrl-P while Ctrl-S leaves it", async () => {
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
  const terminal = new RecordingTerminal(100, 30);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const stop = app.subscribe((state) => tui.update(state));
  tui.start();
  try {
    for (const key of ["\u0003", "\u000b", "\u0010"]) terminal.sendInput(key);
    expect(gateway.terminalInput).toEqual(
      ["\u0003", "\u000b", "\u0010"].map((data) => ({ terminalId: "t", data })),
    );
    terminal.sendInput("\u0013");
    expect(app.state.focus).toBe("tree");
  } finally {
    stop();
    await tui.stop();
    await app.releaseObservations();
  }
});

it.each(["\u000b", "\u001b[107;5u", "\u001b[27;5;107~"])(
  "searchable palette %j moves to the previous result without changing its query",
  async (previous) => {
    const app = new ApplicationController(
      new FakePaseoGateway({ projects: [], providers: [], workspaces: [], agents: [] }),
    );
    const terminal = new RecordingTerminal(100, 30);
    const tui = new DeckTui(terminal, app.state, (intent) => {
      void app.handleIntent(intent);
    });
    const stop = app.subscribe((state) => tui.update(state));
    tui.start();
    try {
      terminal.sendInput("\u0010");
      terminal.sendInput("tab");
      terminal.sendInput("\u001b[B");
      terminal.sendInput("\u001b[B");
      await terminal.waitForRender();
      expect(terminal.viewport().join("\n")).toContain("> Next tab");
      terminal.sendInput(previous);
      await terminal.waitForRender();
      expect(terminal.viewport().join("\n")).toContain("> Discard session draft");
      expect(terminal.viewport().join("\n")).toContain("> tab");
    } finally {
      stop();
      await tui.stop();
    }
  },
);

async function sessionDeck() {
  const app = new ApplicationController(
    new FakePaseoGateway({
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
    }),
  );
  await app.start();
  const terminal = new RecordingTerminal(100, 30);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const unsubscribe = app.subscribe((state) => tui.update(state));
  await tui.start();
  return {
    app,
    terminal,
    close: async () => {
      unsubscribe();
      await tui.stop();
      await app.releaseObservations();
    },
  };
}

it.each(["\u0012", "\u001b[114;5u", "\u001b[27;5;114~"])(
  "Normal redo %j restores one native paste edit",
  async (redo) => {
    const f = await sessionDeck();
    try {
      f.terminal.sendInput("\u001b[200~pasted edit\u001b[201~");
      f.terminal.sendInput("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 20));
      f.terminal.sendInput("u");
      expect(f.app.state.composer.drafts.a).toBe("");
      f.terminal.sendInput(redo);
      expect(f.app.state.composer.drafts.a).toBe("pasted edit");
    } finally {
      await f.close();
    }
  },
);

it.each(["2", "d", "g"])(
  "background half-page consumes Composer pending %s without changing mode or cursor",
  async (prefix) => {
    const f = await sessionDeck();
    try {
      f.terminal.sendInput("i");
      f.terminal.sendInput("abcdef");
      f.terminal.sendInput("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 20));
      f.terminal.sendInput("0");
      f.terminal.sendInput(prefix);
      f.terminal.sendInput("\u0004");
      expect(f.app.state.focus).toBe("composer");
      expect(f.app.state.composerMode).toBe("normal");
      f.terminal.sendInput("x");
      expect(f.app.state.composer.drafts.a).toBe("bcdef");
    } finally {
      await f.close();
    }
  },
);

it("removed fullscreen search cannot open over Sidebar or a searchable picker", async () => {
  const f = await sessionDeck();
  try {
    f.terminal.sendInput("\u0013");
    await f.terminal.waitForRender();
    const sidebar = f.terminal.viewport().map((line) => line.trimEnd());
    f.terminal.sendInput("\u001b[102;6u");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().map((line) => line.trimEnd())).toEqual(sidebar);
    f.terminal.sendInput("\u0010");
    f.terminal.sendInput("tab");
    await f.terminal.waitForRender();
    const picker = f.terminal.viewport().map((line) => line.trimEnd());
    f.terminal.sendInput("\u001b[102;6u");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().map((line) => line.trimEnd())).toEqual(picker);
  } finally {
    await f.close();
  }
});
