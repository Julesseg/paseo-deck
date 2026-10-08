import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

async function fixture() {
  const gateway = new FakePaseoGateway({
    projects: [],
    providers: [
      {
        id: "p",
        name: "Provider",
        ready: true,
        modeIds: ["plan", "build"],
        defaultModeId: "plan",
        defaultModelId: "m",
        models: [
          {
            id: "m",
            name: "Model",
            selectable: true,
            thinkingLevels: ["low", "high"],
            defaultThinkingLevel: "low",
          },
        ],
      },
      {
        id: "off",
        name: "Unavailable",
        ready: false,
        unavailableReason: "offline",
        modeIds: [],
        models: [],
      },
    ],
    workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
    agents: [
      {
        id: "a",
        workspaceId: "w",
        title: "Original",
        modeId: "plan",
        providerId: "p",
        status: "idle",
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
  const deck = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const unsubscribe = app.subscribe((state) => deck.update(state));
  await deck.start();
  return {
    app,
    terminal,
    gateway,
    stop: async () => {
      unsubscribe();
      await deck.stop();
    },
  };
}

it.each(["\n", "\u001b[106;5u", "\u001b[27;5;106~"])(
  "picker next %j selects without confirming, caret keeps selection, and CR executes",
  async (next) => {
    const f = await fixture();
    try {
      await f.app.handleIntent({ type: "open-new-tab", workspaceId: "w" });
      f.terminal.sendInput(next);
      expect(f.app.state.modal.type).toBe("new-tab");
      f.terminal.sendInput("\u0001");
      f.terminal.sendInput("\r");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.gateway.terminals).toHaveLength(1);
    } finally {
      await f.stop();
    }
  },
);

it("rename paste is literal single-line text and one local undo step with enhanced redo", async () => {
  const f = await fixture();
  try {
    f.app.setComposerText("background prompt");
    await f.app.handleIntent({ type: "open-rename", agentId: "a" });
    f.terminal.sendInput("\u001b[200~j\r\nk\n:quit\rlast\u001b[201~");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("j k :quit lastOriginal");
    f.terminal.sendInput("\u001a");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).not.toContain(":quit");
    f.terminal.sendInput("\u001b[122;6u");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("j k :quit lastOriginal");
    expect(f.app.state.composer.drafts.a).toBe("background prompt");
    expect(f.app.state.directory.agents[0]?.title).toBe("Original");
  } finally {
    await f.stop();
  }
});

it("reconfirming a provider closes without resetting customized dependent settings", async () => {
  const f = await fixture();
  try {
    await f.app.handleIntent({ type: "open-new-tab", workspaceId: "w" });
    f.terminal.sendInput("\r");
    await f.app.handleIntent({ type: "open-draft-setting", setting: "mode" });
    f.terminal.sendInput("build");
    f.terminal.sendInput("\r");
    await f.app.handleIntent({ type: "open-draft-setting", setting: "thinking" });
    f.terminal.sendInput("high");
    f.terminal.sendInput("\r");
    await f.app.handleIntent({ type: "open-draft-setting", setting: "provider" });
    f.terminal.sendInput("\r");
    expect(f.app.state.modal.type).toBe("none");
    expect(f.app.state.sessionDrafts.w).toMatchObject({
      providerId: "p",
      modeId: "build",
      thinkingLevel: "high",
    });
  } finally {
    await f.stop();
  }
});

it("disabled provider results show reasons and neither disabled nor empty results apply", async () => {
  const f = await fixture();
  try {
    await f.app.handleIntent({ type: "open-new-tab", workspaceId: "w" });
    f.terminal.sendInput("\r");
    await f.app.handleIntent({ type: "open-draft-setting", setting: "provider" });
    f.terminal.sendInput("\n");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("> Unavailable - unavailable: offline");
    f.terminal.sendInput("\r");
    expect(f.app.state.modal.type).toBe("draft-setting");
    f.terminal.sendInput("nothing-matches");
    f.terminal.sendInput("\r");
    expect(f.app.state.modal.type).toBe("draft-setting");
    expect(f.app.state.sessionDrafts.w?.providerId).toBe("p");
    f.terminal.sendInput("\u001a");
    f.terminal.sendInput("\u001b[13u");
    expect(f.app.state.modal.type).toBe("none");
  } finally {
    await f.stop();
  }
});

it("blank rename remains editable and unchanged trimmed rename closes without a write", async () => {
  const f = await fixture();
  try {
    await f.app.handleIntent({ type: "open-rename", agentId: "a" });
    f.terminal.sendInput("\u001b[200~  \u001b[201~");
    f.terminal.sendInput("\r");
    expect(f.app.state.modal.type).toBe("none");
    expect(f.gateway.commands).toEqual([]);
    await f.app.handleIntent({ type: "open-rename", agentId: "a" });
    f.terminal.sendInput("\u0005");
    f.terminal.sendInput("\u0017");
    f.terminal.sendInput("\r");
    expect(f.app.state.modal.type).toBe("rename");
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("filter cancel restores the applied query and Ctrl-K abandons rename without touching its target", async () => {
  const f = await fixture();
  try {
    await f.app.handleIntent({ type: "open-filter" });
    f.terminal.sendInput("Workspace");
    f.terminal.sendInput("\r");
    expect(f.app.state.filter).toBe("Workspace");
    await f.app.handleIntent({ type: "open-filter" });
    f.terminal.sendInput("different");
    f.terminal.sendInput("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.app.state.filter).toBe("Workspace");
    await f.app.handleIntent({ type: "open-rename", agentId: "a" });
    f.terminal.sendInput("discard me");
    f.terminal.sendInput("\u000b");
    expect(f.app.state.focus).toBe("timeline");
    expect(f.app.state.modal.type).toBe("none");
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("reconfirming an existing Session setting closes without a backend write", async () => {
  const f = await fixture();
  try {
    await f.app.handleIntent({ type: "open-mode", agentId: "a" });
    f.terminal.sendInput("\r");
    expect(f.app.state.modal.type).toBe("none");
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.stop();
  }
});
