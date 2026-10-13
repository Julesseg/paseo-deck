import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

async function fixture() {
  const gateway = new FakePaseoGateway({
    projects: [{ id: "p", name: "Project" }],
    providers: [],
    agents: [
      {
        id: "agent",
        workspaceId: "a",
        title: "Session",
        status: "idle",
        archived: false,
        availableModeIds: ["plan"],
        availableThinkingLevels: ["low"],
        pendingPermissions: [],
        needsAttention: false,
      },
    ],
    workspaces: [
      { id: "a", projectId: "p", title: "Alpha", directory: "/alpha", archived: false },
      { id: "b", projectId: "p", title: "Beta", directory: "/beta", archived: false },
    ],
  });
  const app = new ApplicationController(gateway);
  await app.start();
  const terminal = new RecordingTerminal(110, 35);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const unsubscribe = app.subscribe((state) => tui.update(state));
  await tui.start();
  return {
    app,
    gateway,
    terminal,
    async stop() {
      unsubscribe();
      await tui.stop();
      await app.releaseObservations();
    },
  };
}

it("Sidebar g waits for gg or g?, Project Enter is inert, and movement leaves Active workspace alone", async () => {
  const f = await fixture();
  try {
    f.terminal.sendInput("\u0013");
    f.terminal.sendInput("l");
    f.terminal.sendInput("G");
    expect(f.app.state.sidebarSelection).toEqual({ kind: "workspace", id: "b" });
    const active = f.app.state.selectedWorkspaceId;
    f.terminal.sendInput("g");
    expect(f.app.state.sidebarSelection).toEqual({ kind: "workspace", id: "b" });
    f.terminal.sendInput("g");
    expect(f.app.state.sidebarSelection).toEqual({ kind: "project", id: "p" });
    const expanded = f.app.state.expandedIds.has("p");
    f.terminal.sendInput("\r");
    expect(f.app.state.expandedIds.has("p")).toBe(expanded);
    expect(f.app.state.selectedWorkspaceId).toBe(active);
    f.terminal.sendInput("g");
    f.terminal.sendInput("?");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("gg");
  } finally {
    await f.stop();
  }
});

it("Sidebar removed Session and utility keys are inert while palette filters remain reachable", async () => {
  const f = await fixture();
  try {
    f.terminal.sendInput("\u0013");
    for (const key of [
      "x",
      "A",
      "e",
      "d",
      "m",
      "t",
      "z",
      "r",
      "N",
      "R",
      "E",
      "\u0018",
      "\t",
      "g",
      "t",
      "g",
      "T",
    ]) {
      f.terminal.sendInput(key);
      expect(f.app.state.modal.type).toBe("none");
      expect(f.app.state.focus).toBe("tree");
    }
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).not.toContain("Command palette");
  } finally {
    await f.stop();
  }
});

it("name filter applies only on Enter, Escape retains applied query, and local undo leaves Composer alone", async () => {
  const f = await fixture();
  try {
    await f.app.handleIntent({ type: "set-composer-text", text: "saved prompt" });
    f.terminal.sendInput("\u0013");
    const active = f.app.state.selectedWorkspaceId;
    f.terminal.sendInput("/");
    f.terminal.sendInput("bEtA");
    expect(f.app.state.filter).toBe("");
    f.terminal.sendInput("\r");
    expect(f.app.state.filter).toBe("bEtA");
    await f.terminal.waitForRender();
    const text = f.terminal.viewport().join("\n");
    expect(text).toContain("Beta");
    expect(text).toContain("Project");
    f.terminal.sendInput("/");
    f.terminal.sendInput("\u0001");
    f.terminal.sendInput("x");
    f.terminal.sendInput("\u001a");
    f.terminal.sendInput("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(f.app.state.filter).toBe("bEtA");
    expect(f.app.state.selectedWorkspaceId).toBe(active);
    f.terminal.sendInput("/");
    f.terminal.sendInput("\u0005");
    for (let i = 0; i < 4; i++) f.terminal.sendInput("\u007f");
    f.terminal.sendInput("\r");
    expect(f.app.state.filter).toBe("");
  } finally {
    await f.stop();
  }
});

it("activity and directory updates keep focused Workspace ordering and highlight stable until activation", async () => {
  const f = await fixture();
  try {
    f.terminal.sendInput("\u0013");
    f.terminal.sendInput("l");
    f.terminal.sendInput("G");
    const active = f.app.state.selectedWorkspaceId;
    f.gateway.emitDirectory({
      type: "agent-upserted",
      agent: {
        id: "busy",
        workspaceId: "b",
        title: "Busy",
        status: "idle",
        archived: false,
        availableModeIds: [],
        availableThinkingLevels: [],
        pendingPermissions: [],
        needsAttention: true,
      },
    });
    f.gateway.emitDirectory({
      type: "workspace-upserted",
      workspace: { id: "a", projectId: "p", title: "Zeta", directory: "/alpha", archived: false },
    });
    expect(f.app.state.sidebarSelection).toEqual({ kind: "workspace", id: "b" });
    expect(f.app.state.selectedWorkspaceId).toBe(active);
    f.terminal.sendInput("k");
    expect(f.app.state.sidebarSelection).toEqual({ kind: "workspace", id: "a" });
    f.terminal.sendInput("]");
    f.terminal.sendInput("[");
    f.terminal.sendInput("j");
    f.terminal.sendInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.app.state.selectedWorkspaceId).toBe("b");
    expect(f.app.state.focus).toBe("tree");
  } finally {
    await f.stop();
  }
});

it("all three Sidebar filters combine on the rendered hierarchy without changing Active resources", async () => {
  const f = await fixture();
  try {
    f.gateway.emitDirectory({
      type: "workspace-upserted",
      workspace: { id: "b", projectId: "p", title: "Beta", directory: "/beta", archived: true },
    });
    f.gateway.emitDirectory({
      type: "agent-upserted",
      agent: {
        id: "attention",
        workspaceId: "b",
        title: "Needs input",
        status: "idle",
        archived: false,
        availableModeIds: [],
        availableThinkingLevels: [],
        pendingPermissions: [],
        needsAttention: true,
      },
    });
    const active = f.app.state.selectedWorkspaceId;
    const tab = f.app.state.activeSessionId;
    f.terminal.sendInput("\u0013");
    f.terminal.sendInput("g");
    f.terminal.sendInput("g");
    f.terminal.sendInput("l");
    for (const [name, archived, attention, expected] of [
      [false, false, false, true],
      [false, false, true, false],
      [false, true, false, true],
      [false, true, true, true],
      [true, false, false, false],
      [true, false, true, false],
      [true, true, false, true],
      [true, true, true, true],
    ] as const) {
      if (f.app.state.showArchived !== archived) f.terminal.sendInput("v");
      if (f.app.state.attentionOnly !== attention) f.terminal.sendInput("!");
      f.terminal.sendInput("/");
      f.terminal.sendInput("\u0005");
      for (let i = 0; i < f.app.state.filter.length; i++) f.terminal.sendInput("\u007f");
      if (name) f.terminal.sendInput("Beta");
      f.terminal.sendInput("\r");
      await f.terminal.waitForRender();
      const text = f.terminal.viewport().join("\n");
      expect(new RegExp(`(?:[AIWD●]) ${name || attention ? "Beta" : "Alpha"}\\s`).test(text)).toBe(
        expected,
      );
      expect(f.app.state.selectedWorkspaceId).toBe(active);
      expect(f.app.state.activeSessionId).toBe(tab);
    }
  } finally {
    await f.stop();
  }
});
