import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

async function fixture() {
  const gateway = new FakePaseoGateway({
    projects: [],
    providers: [],
    workspaces: ["Alpha", "Beta", "Shell", "Empty"].map((title) => ({
      id: title.toLowerCase(),
      title,
      directory: `/tmp/${title}`,
      archived: false,
    })),
    agents: ["alpha", "beta"].map((workspaceId) => ({
      id: `${workspaceId}-session`,
      workspaceId,
      title: `${workspaceId} Session`,
      status: "idle" as const,
      archived: false,
      availableModeIds: [],
      availableThinkingLevels: [],
      pendingPermissions: [],
      needsAttention: false,
    })),
  });
  gateway.terminals = [{ id: "terminal", workspaceId: "shell", name: "Shell", cwd: "/tmp" }];
  const app = new ApplicationController(gateway);
  await app.start();
  const terminal = new RecordingTerminal(110, 35);
  const pending: Promise<void>[] = [];
  let clipboard = "";
  const tui = new DeckTui(
    terminal,
    app.state,
    (intent) => {
      pending.push(app.handleIntent(intent));
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
  const unsubscribe = app.subscribe((state) => tui.update(state));
  tui.start();
  await terminal.waitForRender();
  const keys = async (...inputs: string[]) => {
    for (const input of inputs) {
      terminal.sendInput(input);
      if (input === "\u001b") await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await terminal.waitForRender();
  };
  return {
    app,
    gateway,
    terminal,
    keys,
    clipboard: () => clipboard,
    settle: () => Promise.all(pending.splice(0)),
    async open(title: string) {
      await keys("\u0013", "/", "\u0005");
      for (const _ of app.state.filter) await keys("\u007f");
      await keys(title, "\r", "G", "\r");
    },
    async stop() {
      unsubscribe();
      await tui.stop();
      await app.releaseObservations();
    },
  };
}

it.each([
  ["Shell", "Sidebar"],
  ["Empty", "Sidebar"],
  ["Shell", "another Workspace Timeline"],
  ["Empty", "another Workspace Timeline"],
] as const)("late %s activation preserves a newer %s", async (workspace, destination) => {
  const f = await fixture();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (workspace === "Shell") {
    const observe = f.gateway.observeTerminal.bind(f.gateway);
    f.gateway.observeTerminal = async (...args) => {
      await delayed;
      return observe(...args);
    };
  } else {
    const profiles = f.gateway.listTerminalProfiles.bind(f.gateway);
    f.gateway.listTerminalProfiles = async () => {
      await delayed;
      return profiles();
    };
  }
  try {
    await f.open(workspace);
    await f.keys("\u0013");
    if (destination === "another Workspace Timeline") {
      await f.open("Beta");
      await f.keys("\u000b");
    }
    release();
    await f.settle();
    await f.terminal.waitForRender();
    expect(f.app.state.focus).toBe(destination === "Sidebar" ? "tree" : "timeline");
    expect(f.app.state.selectedWorkspaceId).toBe(
      destination === "Sidebar" ? workspace.toLowerCase() : "beta",
    );
    await f.keys("j");
    expect(f.gateway.terminalInput).toEqual([]);
  } finally {
    release();
    await f.settle();
    await f.stop();
  }
});

it("Workspace Enter returns to its Session Composer with its saved mode, cursor and prompt", async () => {
  const f = await fixture();
  try {
    await f.keys("i", "saved prompt", "\u001b", "0", "l", "l");
    await f.open("Beta");
    expect(f.app.state.selectedWorkspaceId).toBe("beta");
    expect(f.app.state.focus).toBe("composer");
    expect(f.app.state.composerMode).toBe("normal");
    await f.keys("i", "other prompt");
    await f.open("Alpha");
    expect(f.app.state.focus).toBe("composer");
    expect(f.app.state.composerMode).toBe("normal");
    await f.keys("i", "!");
    expect(f.app.state.composer.drafts["alpha-session"]).toBe("sa!ved prompt");
    expect(f.app.state.composer.drafts["beta-session"]).toBe("other prompt");
  } finally {
    await f.stop();
  }
});

it("Workspace activation restores its active Session draft without losing unfinished edits", async () => {
  const f = await fixture();
  try {
    await f.keys("\u0013", "c", "i", "draft prompt", "\u0001", "\u001b[C", "\u001b[C");
    await f.open("Beta");
    await f.open("Alpha");
    expect(f.app.state.activeTabIds.alpha).toBe("draft:alpha");
    expect(f.app.state.focus).toBe("composer");
    expect(f.app.state.composerMode).toBe("insert");
    await f.keys("!");
    expect(f.app.state.sessionDrafts.alpha?.prompt).toBe("dr!aft prompt");
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("Composer finds, text objects and search queries retain their existing i meaning", async () => {
  const f = await fixture();
  try {
    await f.keys("i", "first middle words", "\u001b", "0", "f", "i", "y", "i", "w");
    expect(f.clipboard()).toBe("first");
    expect(f.app.state.composerMode).toBe("normal");
    await f.keys("0", "t", "i", "v", "i", "w", "y");
    expect(f.clipboard()).toBe("first");
    expect(f.app.state.composerMode).toBe("normal");
    await f.keys("/", "i", "\r");
    expect(f.app.state.focus).toBe("composer");
    expect(f.app.state.composerMode).toBe("normal");
    expect(f.app.state.composer.drafts["alpha-session"]).toBe("first middle words");
  } finally {
    await f.stop();
  }
});

it("Timeline finds, text objects, searches, counts and paste retain ownership of i", async () => {
  const f = await fixture();
  try {
    f.gateway.emitTimeline("alpha-session", {
      type: "hydrated",
      agentId: "alpha-session",
      items: [
        {
          epoch: "e",
          sequence: 1,
          item: { id: "message", type: "user-message", text: "first middle words" },
        },
      ],
    });
    await f.terminal.waitForRender();
    await f.keys("\u000b", "g", "g", "j", "^", "f", "i", "y", "i", "w");
    expect(f.app.state.focus).toBe("timeline");
    expect(f.clipboard()).toBe("first");
    await f.keys("0", "t", "i", "v", "i", "w", "y");
    expect(f.app.state.focus).toBe("timeline");
    expect(f.app.state.timelineMode).toBe("normal");
    expect(f.clipboard()).toBe("first");
    await f.keys("2", "i", "/", "i", "\r", "\u001b[200~i\n!\u001b[201~");
    expect(f.app.state.focus).toBe("timeline");
    expect(f.app.state.composer.drafts["alpha-session"]).toBeUndefined();
    await f.keys("\u0013", "/", "i", "\r");
    expect(f.app.state.filter).toBe("i");
    expect(f.app.state.focus).toBe("tree");
    await f.keys("\u001b[200~i\u001b[201~");
    expect(f.app.state.focus).toBe("tree");
    expect(f.app.state.selectedWorkspaceId).toBe("alpha");
  } finally {
    await f.stop();
  }
});

it("Sidebar i cannot activate another highlighted Workspace when Terminal has no Composer", async () => {
  const f = await fixture();
  try {
    await f.open("Shell");
    await f.keys("\u0013", "/", "Alpha", "\r", "G", "i");
    expect(f.app.state.focus).toBe("tree");
    expect(f.app.state.selectedWorkspaceId).toBe("shell");
    expect(f.app.state.activeTerminalId).toBe("terminal");
    expect(f.app.state.sidebarSelection).toEqual({ kind: "workspace", id: "alpha" });
    expect(f.gateway.terminalInput).toEqual([]);
    await f.keys("\u001b", "i");
    expect(f.gateway.terminalInput).toEqual([{ terminalId: "terminal", data: "i" }]);
  } finally {
    await f.stop();
  }
});

it("Workspace Enter restores Insert cursors, empty Launch drafts and direct Terminal input", async () => {
  const f = await fixture();
  try {
    await f.keys("i", "alpha prompt", "\u0001", "\u001b[C", "\u001b[C");
    await f.open("Empty");
    expect(f.app.state.focus).toBe("composer");
    expect(f.app.state.composerMode).toBe("normal");
    expect(f.terminal.viewport().join("\n")).toContain("Launch Session");
    await f.keys("i", "launch prompt", "\u0001", "\u001b[C");
    await f.open("Shell");
    expect(f.app.state.activeTerminalId).toBe("terminal");
    expect(f.app.state.focus).toBe("timeline");
    await f.keys("i", "\u001b[200~literal i\u001b[201~");
    expect(f.gateway.terminalInput).toEqual([
      { terminalId: "terminal", data: "i" },
      { terminalId: "terminal", data: "\u001b[200~literal i\u001b[201~" },
    ]);
    await f.open("Alpha");
    expect(f.app.state.focus).toBe("composer");
    expect(f.app.state.composerMode).toBe("insert");
    await f.keys("!");
    expect(f.app.state.composer.drafts["alpha-session"]).toBe("al!pha prompt");
    await f.open("Empty");
    expect(f.app.state.composerMode).toBe("insert");
    await f.keys("!");
    expect(f.app.state.launchDrafts?.empty?.prompt).toBe("l!aunch prompt");
  } finally {
    await f.stop();
  }
});

it("idle Timeline bare i resumes the displayed Composer at its saved cursor in Insert", async () => {
  const f = await fixture();
  try {
    await f.keys("i", "saved prompt", "\u001b", "0", "l", "l", "\u000b");
    expect(f.app.state.focus).toBe("timeline");
    await f.keys("i", "!");
    expect(f.app.state.focus).toBe("composer");
    expect(f.app.state.composerMode).toBe("insert");
    expect(f.app.state.composer.drafts["alpha-session"]).toBe("sa!ved prompt");
  } finally {
    await f.stop();
  }
});

it("Sidebar bare i edits the displayed Workspace without opening its highlighted Workspace", async () => {
  const f = await fixture();
  try {
    await f.keys("i", "alpha prompt", "\u001b", "0", "l");
    await f.keys("\u0013", "/", "Beta", "\r", "G");
    expect(f.app.state.sidebarSelection).toEqual({ kind: "workspace", id: "beta" });
    await f.keys("i", "!");
    expect(f.app.state.focus).toBe("composer");
    expect(f.app.state.composerMode).toBe("insert");
    expect(f.app.state.selectedWorkspaceId).toBe("alpha");
    expect(f.app.state.activeSessionId).toBe("alpha-session");
    expect(f.app.state.filter).toBe("Beta");
    expect(f.app.state.composer.drafts["alpha-session"]).toBe("a!lpha prompt");
    expect(f.app.state.composer.drafts["beta-session"]).toBeUndefined();
  } finally {
    await f.stop();
  }
});

it("Workspace activation clears only the text query while Sidebar movement keeps it", async () => {
  const f = await fixture();
  try {
    const beta = f.app.state.directory.agents.find((agent) => agent.id === "beta-session");
    if (!beta) throw new Error("Missing Beta Session");
    f.gateway.emitDirectory({ type: "agent-upserted", agent: { ...beta, needsAttention: true } });
    await f.keys("\u0013", "v", "!", "/", "Beta", "\r", "G", "k", "j");
    expect(f.app.state.filter).toBe("Beta");
    expect(f.app.state.selectedWorkspaceId).toBe("alpha");
    await f.keys("\r");
    expect(f.app.state.filter).toBe("");
    expect(f.app.state.attentionOnly).toBe(true);
    expect(f.app.state.showArchived).toBe(true);
    expect(f.app.state.selectedWorkspaceId).toBe("beta");
    expect(f.app.state.focus).toBe("composer");
  } finally {
    await f.stop();
  }
});
