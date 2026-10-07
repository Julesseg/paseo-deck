import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import type { AgentCommand } from "../contracts/commands.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

class LaunchGateway extends FakePaseoGateway {
  failSend = false;
  failCreate = false;
  override async execute(command: AgentCommand) {
    if (command.type === "create-agent" && this.failCreate) {
      this.failCreate = false;
      throw new Error("creation unavailable");
    }
    if (command.type === "send-prompt" && this.failSend) {
      this.failSend = false;
      this.commands.push(command);
      throw new Error("send unavailable");
    }
    return super.execute(command);
  }
}
async function fixture(empty = false) {
  const gateway = new LaunchGateway({
    projects: [{ id: "p", name: "Project" }],
    providers: [
      {
        id: "provider",
        name: "Provider",
        ready: true,
        modeIds: [],
        models: [{ id: "model", name: "Model", selectable: true, thinkingLevels: [] }],
      },
    ],
    workspaces: [
      { id: "w", projectId: "p", title: "Workspace", directory: "/tmp", archived: false },
      ...(!empty
        ? [{ id: "other", projectId: "p", title: "Z Other", directory: "/other", archived: false }]
        : []),
    ],
    agents: empty
      ? []
      : [
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
  const app = new ApplicationController(gateway);
  await app.start();
  const terminal = new RecordingTerminal(100, 30);
  const pending: Promise<void>[] = [];
  const deck = new DeckTui(terminal, app.state, (intent) => {
    pending.push(app.handleIntent(intent));
  });
  const unsubscribe = app.subscribe((state) => deck.update(state));
  await deck.start();
  return {
    app,
    gateway,
    terminal,
    async key(data: string) {
      await terminal.waitForRender();
      terminal.sendInput(data);
      await Promise.all(pending.splice(0));
      await terminal.waitForRender();
    },
    async stop() {
      unsubscribe();
      await deck.stop();
    },
  };
}

it("retries the created Session's initial send without creating another Session", async () => {
  const f = await fixture();
  try {
    await f.app.handleIntent({ type: "open-new-tab", workspaceId: "w" });
    await f.key("\r");
    f.app.setComposerText("retained first prompt");
    f.gateway.failSend = true;
    await f.key("\r");
    expect(f.terminal.viewport().join("\n")).toContain("send unavailable");
    expect(f.gateway.commands).toEqual([
      {
        type: "create-agent",
        workspaceId: "w",
        providerId: "provider",
        modelId: "model",
        prompt: "",
      },
      { type: "send-prompt", agentId: "fake-agent-1", prompt: "retained first prompt" },
    ]);
    await f.key("\r");
    expect(f.gateway.commands).toHaveLength(3);
    expect(f.gateway.commands[2]).toEqual({
      type: "send-prompt",
      agentId: "fake-agent-1",
      prompt: "retained first prompt",
    });
    expect(f.app.state.activeTabIds.w).toBe("session:fake-agent-1");
  } finally {
    await f.stop();
  }
});

it("Sidebar c reuses the highlighted Workspace draft and Ctrl-T never falls back from a Project", async () => {
  const f = await fixture();
  try {
    await f.key("\u0013");
    await f.key("j");
    expect(f.app.state.sidebarSelection).toEqual({ kind: "workspace", id: "other" });
    expect(f.app.state.selectedWorkspaceId).toBe("w");
    await f.key("c");
    expect(f.app.state.activeTabIds.other).toBe("draft:other");
    f.app.setComposerText("saved draft");
    await f.key("\u0013");
    await f.key("c");
    expect(f.app.state.sessionDrafts.other?.prompt).toBe("saved draft");
    expect(f.gateway.commands).toEqual([]);
    await f.key("\u0013");
    await f.key("g");
    await f.key("g");
    await f.key("\u0014");
    expect(f.app.state.modal.type).toBe("none");
    await f.key("j");
    await f.key("\u0014");
    expect(f.app.state.modal).toMatchObject({ type: "new-tab", workspaceId: "w" });
  } finally {
    await f.stop();
  }
});

it("existing Workspace Terminal/profile creates immediately and retries attachment with the same identity", async () => {
  const f = await fixture();
  try {
    f.gateway.terminalProfiles = [
      { id: "build", name: "Build", command: "npm", args: ["run", "build"] },
    ];
    const capture = f.gateway.captureTerminal.bind(f.gateway);
    let fail = true;
    f.gateway.captureTerminal = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error("capture unavailable");
      }
      return capture(...args);
    };
    await f.key("\u0013");
    await f.key("j");
    await f.key("\u0014");
    expect(f.app.state.modal).toMatchObject({ type: "new-tab", workspaceId: "other" });
    expect(f.app.state.selectedWorkspaceId).toBe("w");
    await f.key("Build");
    await f.key("\r");
    expect(f.gateway.createdTerminals).toHaveLength(1);
    expect(f.gateway.createdTerminals[0]?.workspaceId).toBe("other");
    expect(f.app.state.modal.type).toBe("new-tab");
    await f.key("\r");
    expect(f.gateway.createdTerminals).toHaveLength(1);
    expect(f.app.state.activeTerminalId).toBe("fake-terminal-1");
    expect(f.gateway.terminalInput).toEqual([]);
    await f.key("echo literal\r");
    expect(f.gateway.terminalInput).toEqual([
      { terminalId: "fake-terminal-1", data: "echo literal\r" },
    ]);
  } finally {
    await f.stop();
  }
});

it("empty Workspace launch is distinct and c preserves its prompt; only the active draft can be discarded", async () => {
  const f = await fixture(true);
  try {
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("Launch Session");
    expect(f.terminal.viewport().join("\n")).not.toContain("Base ref");
    f.app.setComposerText("launch message");
    await f.key("\u0013");
    await f.key("g");
    await f.key("g");
    await f.key("l");
    await f.key("j");
    expect(f.app.state.sidebarSelection).toEqual({ kind: "workspace", id: "w" });
    await f.key("c");
    expect(f.app.state.sessionDrafts.w?.prompt).toBe("launch message");
    await f.key("\u001b");
    expect(f.app.state.sessionDrafts.w?.prompt).toBe("launch message");
    await f.key("\u0010");
    await f.key("Discard");
    await f.key("\r");
    expect(f.app.state.modal).toMatchObject({
      type: "confirm",
      action: "discard-draft",
      workspaceId: "w",
    });
    await f.key("\u001b");
    expect(f.app.state.sessionDrafts.w?.prompt).toBe("launch message");
  } finally {
    await f.stop();
  }
});

it("palette Discard protects a changed empty-Workspace launch and resets only that launch", async () => {
  const f = await fixture(true);
  try {
    f.app.setComposerText("kept launch");
    await f.key("\u0010");
    await f.key("Discard");
    await f.key("\r");
    expect(f.app.state.modal).toMatchObject({
      type: "confirm",
      action: "discard-draft",
      workspaceId: "w",
    });
    await f.key("\u001b");
    expect(f.app.state.launchDrafts?.w?.prompt).toBe("kept launch");
    await f.key("\u0010");
    await f.key("Discard");
    await f.key("\r");
    await f.key("\r");
    expect(f.app.state.launchDrafts?.w?.prompt ?? "").toBe("");
    expect(f.app.state.launchDrafts?.w?.dirty).toBeFalsy();
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("Session draft Enter is inert for invalid, pending and Visual input, while Insert Enter remains a newline", async () => {
  const f = await fixture();
  try {
    await f.app.handleIntent({ type: "open-new-tab", workspaceId: "w" });
    await f.key("\r");
    await f.key("\r");
    expect(f.gateway.commands).toEqual([]);
    f.app.setComposerText("first message");
    await f.key("d");
    await f.key("\r");
    expect(f.gateway.commands).toEqual([]);
    await f.key("v");
    await f.key("\r");
    expect(f.gateway.commands).toEqual([]);
    await f.key("\u001b");
    await f.key("A");
    await f.key("\r");
    await f.key("\u001b\r");
    expect(f.app.state.sessionDrafts.w?.prompt).toBe("first message\n\n");
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("untouched draft discards immediately and dirty draft quit cancellation retains its input", async () => {
  const f = await fixture();
  try {
    await f.app.handleIntent({ type: "open-new-tab", workspaceId: "w" });
    await f.key("\r");
    await f.key("\u0010");
    await f.key("Discard");
    await f.key("\r");
    expect(f.app.state.modal.type).toBe("none");
    expect(f.app.state.sessionDrafts.w).toBeUndefined();
    await f.app.handleIntent({ type: "open-new-tab", workspaceId: "w" });
    expect(f.app.state.modal.type).toBe("new-tab");
    await f.key("\r");
    expect(f.terminal.viewport().join("\n")).not.toContain("New Tab");
    expect(f.app.state.modal.type).toBe("none");
    expect(f.app.state.sessionDrafts.w).toBeDefined();
    f.app.setComposerText("unsent input");
    await f.key("\u0003");
    expect(f.app.state.modal).toMatchObject({ type: "confirm", action: "quit" });
    await f.key("\u001b");
    expect(f.app.state.sessionDrafts.w?.prompt).toBe("unsent input");
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("failure before Session creation keeps the draft and allows one deliberate successful retry", async () => {
  const f = await fixture();
  try {
    await f.app.handleIntent({ type: "open-new-tab", workspaceId: "w" });
    await f.key("\r");
    f.app.setComposerText("keep original input");
    f.gateway.failCreate = true;
    await f.key("\r");
    expect(f.terminal.viewport().join("\n")).toContain("creation unavailable");
    expect(f.app.state.sessionDrafts.w?.prompt).toBe("keep original input");
    expect(f.gateway.commands).toEqual([]);
    await f.key("\r");
    expect(f.gateway.commands).toEqual([
      {
        type: "create-agent",
        workspaceId: "w",
        providerId: "provider",
        modelId: "model",
        prompt: "",
      },
      { type: "send-prompt", agentId: "fake-agent-1", prompt: "keep original input" },
    ]);
  } finally {
    await f.stop();
  }
});
