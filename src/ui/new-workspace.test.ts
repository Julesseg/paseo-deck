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
async function fixture(empty = false, noWorkspace = false) {
  const gateway = new LaunchGateway({
    projects: [
      { id: "p", name: "Project", path: "/repo" },
      { id: "p2", name: "Other Project", path: "/other" },
    ],
    providers: [
      {
        id: "provider",
        name: "Provider",
        ready: true,
        modeIds: [],
        models: [{ id: "model", name: "Model", selectable: true, thinkingLevels: [] }],
      },
    ],
    workspaces: noWorkspace
      ? []
      : [
          { id: "w", projectId: "p", title: "Workspace", directory: "/tmp", archived: false },
          ...(!empty
            ? [
                {
                  id: "other",
                  projectId: "p",
                  title: "Z Other",
                  directory: "/other",
                  archived: false,
                },
              ]
            : []),
        ],
    agents:
      empty || noWorkspace
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
  gateway.workspacePlacement = {
    supportsWorktree: true,
    defaultRef: "refs/remotes/origin/advertised-default",
    refs: [
      {
        ref: "refs/remotes/origin/advertised-default",
        label: "refs/remotes/origin/advertised-default (remote)",
        remote: true,
      },
    ],
  };
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

it("opens one resumable Normal New workspace draft and Escape preserves it", async () => {
  const f = await fixture();
  try {
    await f.key("\u0013");
    await f.key("n");
    expect(f.app.state.newWorkspace).toMatchObject({ projectId: "p", placement: "worktree" });
    f.app.setComposerText("retained prompt");
    await f.key("\u001b");
    expect(f.app.state.newWorkspace?.launch.prompt).toBe("retained prompt");

    await f.key("\u0013");
    await f.key("n");
    expect(f.app.state.newWorkspace).toMatchObject({
      projectId: "p",
      launch: { prompt: "retained prompt" },
    });
    expect(f.app.state.focus).toBe("composer");
    expect(f.terminal.viewport().join("\n")).toContain("refs/remotes/origin/advertised-default");
  } finally {
    await f.stop();
  }
});

it("blocks unresolved Worktree without silently creating Local and keeps prompt for explicit refresh", async () => {
  const f = await fixture();
  try {
    f.gateway.workspacePlacement = { supportsWorktree: false, refs: [] };
    await f.key("\u0013");
    await f.key("n");
    f.app.setComposerText("preserve me");
    expect(f.terminal.viewport().join("\n")).toContain("Worktree is unavailable");
    await f.key("\r");
    expect(f.gateway.createdWorkspaces).toEqual([]);
    expect(f.app.state.newWorkspace).toMatchObject({
      placement: "worktree",
      launch: { prompt: "preserve me" },
    });
  } finally {
    await f.stop();
  }
});

it("creates Workspace once then retries only the captured Session send after partial success", async () => {
  const f = await fixture();
  try {
    await f.key("\u0013");
    await f.key("n");
    f.app.setComposerText("first prompt");
    f.gateway.failSend = true;
    await f.key("\r");
    expect(f.gateway.createdWorkspaces).toEqual([
      {
        projectId: "p",
        directory: "/repo",
        baseRef: "refs/remotes/origin/advertised-default",
        firstAgentPrompt: "first prompt",
      },
    ]);
    expect(f.terminal.viewport().join("\n")).toContain("was created; could not send");
    await f.key("\r");
    expect(f.gateway.createdWorkspaces).toHaveLength(1);
    expect(f.gateway.commands.filter((c) => c.type === "create-agent")).toHaveLength(1);
    expect(f.gateway.commands.filter((c) => c.type === "send-prompt")).toEqual([
      { type: "send-prompt", agentId: "fake-agent-1", prompt: "first prompt" },
      { type: "send-prompt", agentId: "fake-agent-1", prompt: "first prompt" },
    ]);
  } finally {
    await f.stop();
  }
});

it("md resets Project Base while preserving placement and Session prompt and settings", async () => {
  const f = await fixture();
  try {
    await f.key("\u0013");
    await f.key("n");
    f.app.setComposerText("same prompt");
    f.gateway.workspacePlacement = {
      supportsWorktree: true,
      defaultRef: "refs/remotes/origin/second",
      refs: [{ ref: "refs/remotes/origin/second", label: "second", remote: true }],
    };
    await f.key("m");
    await f.key("d");
    await f.key("Other");
    await f.key("\r");
    expect(f.app.state.newWorkspace).toMatchObject({
      projectId: "p2",
      placement: "worktree",
      baseRef: "refs/remotes/origin/second",
      launch: { prompt: "same prompt", providerId: "provider", modelId: "model" },
    });
    expect(f.gateway.createdWorkspaces).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("palette opens a Normal New workspace draft without an Active workspace and visibly blocks missing Project", async () => {
  const f = await fixture(false, true);
  try {
    await f.key("\u0010");
    await f.key("New workspace");
    await f.key("\r");
    expect(f.app.state.newWorkspace).toMatchObject({ placement: "worktree" });
    expect(f.app.state.composerMode).toBe("normal");
    expect(f.terminal.viewport().join("\n")).toContain("Project unset");
    expect(f.terminal.viewport().join("\n")).toContain("Choose a Project");
    f.app.setComposerText("retained");
    await f.key("\r");
    expect(f.gateway.createdWorkspaces).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("only idle Normal Enter creates, and discard restores the previous Session and its input", async () => {
  const f = await fixture();
  try {
    f.app.setComposerText("prior Session draft");
    await f.key("\u0010");
    await f.key("New workspace");
    await f.key("\r");
    await f.key("i");
    await f.key("new prompt");
    await f.key("\r");
    expect(f.gateway.createdWorkspaces).toEqual([]);
    await f.key("\u001b");
    await f.key("v");
    await f.key("\r");
    expect(f.gateway.createdWorkspaces).toEqual([]);
    await f.key("\u001b");
    await f.key("d");
    await f.key("\r");
    expect(f.gateway.createdWorkspaces).toEqual([]);
    await f.key("\u0010");
    await f.key("Discard");
    await f.key("\r");
    expect(f.app.state.modal).toMatchObject({ type: "confirm", action: "discard-draft" });
    await f.key("\u001b");
    expect(f.app.state.newWorkspace?.launch.prompt).toContain("new prompt");
    await f.key("\u0010");
    await f.key("Discard");
    await f.key("\r");
    await f.key("\r");
    expect(f.app.state.newWorkspace).toBeUndefined();
    expect(f.app.state.selectedAgentId).toBe("a");
    expect(f.terminal.viewport().join("\n")).toContain("prior Session draft");
  } finally {
    await f.stop();
  }
});

it("retains values after Workspace creation failure and creates only on explicit retry", async () => {
  const f = await fixture();
  try {
    const create = f.gateway.createWorkspace.bind(f.gateway);
    let fail = true;
    f.gateway.createWorkspace = async (options) => {
      if (fail) throw new Error("disk unavailable");
      return create(options);
    };
    await f.key("\u0013");
    await f.key("n");
    f.app.setComposerText("saved creation prompt");
    await f.key("\r");
    expect(f.terminal.viewport().join("\n")).toContain("disk unavailable");
    expect(f.app.state.newWorkspace).toMatchObject({
      projectId: "p",
      baseRef: "refs/remotes/origin/advertised-default",
      launch: { prompt: "saved creation prompt", submitting: false },
    });
    expect(f.gateway.commands).toEqual([]);
    fail = false;
    await f.key("\r");
    expect(f.gateway.createdWorkspaces).toHaveLength(1);
    expect(f.gateway.commands.filter((c) => c.type === "send-prompt")).toHaveLength(1);
  } finally {
    await f.stop();
  }
});

it("explicit refresh preserves prompt and selected Base on resolution failure and never submits", async () => {
  const f = await fixture();
  try {
    await f.key("\u0013");
    await f.key("n");
    f.app.setComposerText("retained during refresh");
    f.gateway.getWorkspacePlacement = async () => {
      throw new Error("origin unavailable");
    };
    await f.app.handleIntent({ type: "refresh" });
    await f.terminal.waitForRender();
    expect(f.app.state.newWorkspace).toMatchObject({
      placement: "worktree",
      baseRef: "refs/remotes/origin/advertised-default",
      launch: { prompt: "retained during refresh" },
    });
    expect(f.terminal.viewport().join("\n")).toContain("origin unavailable");
    await f.key("\r");
    expect(f.gateway.createdWorkspaces).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("a failed Session creation retains the created Workspace and retries Session creation there", async () => {
  const f = await fixture();
  try {
    await f.key("\u0013");
    await f.key("n");
    f.app.setComposerText("first prompt");
    f.gateway.failCreate = true;
    await f.key("\r");
    expect(f.app.state.newWorkspace).toBeUndefined();
    expect(f.app.state.selectedWorkspaceId).toBe("fake-workspace-1");
    expect(f.terminal.viewport().join("\n")).toContain("creation unavailable");
    await f.key("\r");
    expect(f.gateway.createdWorkspaces).toHaveLength(1);
    expect(f.gateway.commands.filter((c) => c.type === "send-prompt")).toHaveLength(1);
  } finally {
    await f.stop();
  }
});

it("Local hides Base and returning to Worktree revalidates its chosen same-Project ref", async () => {
  const f = await fixture();
  try {
    f.gateway.workspacePlacement = {
      ...f.gateway.workspacePlacement,
      refs: [
        ...f.gateway.workspacePlacement.refs,
        { ref: "refs/heads/chosen", label: "chosen", remote: false },
      ],
    };
    await f.key("\u0013");
    await f.key("n");
    await f.key("m");
    await f.key("b");
    await f.key("chosen");
    await f.key("\r");
    f.app.setComposerText("preserved Local prompt");
    await f.key("m");
    await f.key("w");
    await f.key("Local");
    await f.key("\r");
    expect(f.terminal.viewport().join("\n")).not.toContain("[mb]");
    await f.key("m");
    await f.key("b");
    expect(f.app.state.modal.type).toBe("none");
    await f.key("m");
    await f.key("w");
    await f.key("Worktree");
    await f.key("\r");
    expect(f.terminal.viewport().join("\n")).toContain("refs/heads/chosen");
    await f.key("m");
    await f.key("w");
    await f.key("Local");
    await f.key("\r");
    f.gateway.workspacePlacement = {
      supportsWorktree: true,
      defaultRef: "refs/remotes/origin/new-default",
      refs: [{ ref: "refs/remotes/origin/new-default", label: "new default", remote: true }],
    };
    await f.key("m");
    await f.key("w");
    await f.key("Worktree");
    await f.key("\r");
    expect(f.terminal.viewport().join("\n")).toContain("refs/remotes/origin/new-default");
    expect(f.terminal.viewport().join("\n")).toContain("preserved Local prompt");
    expect(f.gateway.createdWorkspaces).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("shows why Local is unavailable without a Project original checkout", async () => {
  const f = await fixture(false, true);
  try {
    await f.key("\u0010");
    await f.key("New workspace");
    await f.key("\r");
    await f.key("m");
    await f.key("w");
    await f.key("Local");
    expect(f.terminal.viewport().join("\n")).toContain("Original checkout unavailable");
    await f.key("\r");
    expect(f.app.state.modal.type).toBe("new-workspace-placement");
    expect(f.app.state.newWorkspace?.placement).toBe("worktree");
    expect(f.gateway.createdWorkspaces).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("failed Worktree restoration stays visible and blocks submission without losing Local input", async () => {
  const f = await fixture();
  try {
    await f.key("\u0013");
    await f.key("n");
    f.app.setComposerText("kept across failure");
    await f.key("m");
    await f.key("w");
    await f.key("Local");
    await f.key("\r");
    f.gateway.getWorkspacePlacement = async () => {
      throw new Error("origin resolution failed");
    };
    await f.key("m");
    await f.key("w");
    await f.key("Worktree");
    await f.key("\r");
    expect(f.terminal.viewport().join("\n")).toContain("origin resolution failed");
    expect(f.terminal.viewport().join("\n")).toContain("kept across failure");
    await f.key("\r");
    expect(f.gateway.createdWorkspaces).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("creates distinct Local Workspaces in the original checkout and retries only a captured failed send", async () => {
  const f = await fixture();
  try {
    for (const prompt of ["first Local", "second Local"]) {
      await f.key("\u0013");
      await f.key("n");
      expect(f.app.state.newWorkspace?.placement).toBe("worktree");
      await f.key("m");
      await f.key("w");
      await f.key("Local");
      await f.key("\r");
      f.app.setComposerText(prompt);
      f.gateway.failSend = true;
      await f.key("\r");
      expect(f.terminal.viewport().join("\n")).toContain("was created; could not send");
      await f.key("\r");
    }
    expect(f.gateway.createdWorkspaces).toEqual([
      { projectId: "p", directory: "/repo" },
      { projectId: "p", directory: "/repo" },
    ]);
    expect(
      f.app.state.directory.workspaces.filter((w) => w.directory === "/repo").map((w) => w.id),
    ).toEqual(["fake-workspace-1", "fake-workspace-2"]);
    expect(f.gateway.commands.filter((c) => c.type === "create-agent")).toHaveLength(2);
    expect(f.gateway.commands.filter((c) => c.type === "send-prompt")).toEqual([
      { type: "send-prompt", agentId: "fake-agent-1", prompt: "first Local" },
      { type: "send-prompt", agentId: "fake-agent-1", prompt: "first Local" },
      { type: "send-prompt", agentId: "fake-agent-4", prompt: "second Local" },
      { type: "send-prompt", agentId: "fake-agent-4", prompt: "second Local" },
    ]);
    expect(f.app.state.selectedWorkspaceId).toBe("fake-workspace-2");
  } finally {
    await f.stop();
  }
});

it("changing Project while Local preserves Session choices and returning Worktree uses only the new Project Base", async () => {
  const f = await fixture();
  try {
    await f.key("\u0013");
    await f.key("n");
    f.app.setComposerText("same Local prompt");
    await f.key("m");
    await f.key("w");
    await f.key("Local");
    await f.key("\r");
    f.gateway.workspacePlacement = {
      supportsWorktree: true,
      defaultRef: "refs/remotes/origin/other-project",
      refs: [{ ref: "refs/remotes/origin/other-project", label: "Other", remote: true }],
    };
    await f.key("m");
    await f.key("d");
    await f.key("Other");
    await f.key("\r");
    expect(f.app.state.newWorkspace).toMatchObject({
      projectId: "p2",
      placement: "local",
      launch: {
        kind: "session",
        prompt: "same Local prompt",
        providerId: "provider",
        modelId: "model",
      },
    });
    expect(f.terminal.viewport().join("\n")).not.toContain("[mb]");
    await f.key("\u0013");
    await f.key("n");
    expect(f.app.state.newWorkspace?.projectId).toBe("p2");
    await f.key("m");
    await f.key("w");
    await f.key("Worktree");
    await f.key("\r");
    expect(f.terminal.viewport().join("\n")).toContain("refs/remotes/origin/other-project");
    expect(f.gateway.createdWorkspaces).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("Local remains usable when the new Project cannot resolve Worktree placement", async () => {
  const f = await fixture();
  try {
    await f.key("\u0013");
    await f.key("n");
    await f.key("m");
    await f.key("w");
    await f.key("Local");
    await f.key("\r");
    f.app.setComposerText("Local does not need Git resolution");
    f.gateway.getWorkspacePlacement = async () => {
      throw new Error("origin unavailable");
    };
    await f.key("m");
    await f.key("d");
    await f.key("Other");
    await f.key("\r");
    expect(f.app.state.newWorkspace?.launch.error).toBe("");
    await f.key("\r");
    expect(f.gateway.createdWorkspaces).toEqual([{ projectId: "p2", directory: "/other" }]);
    expect(f.gateway.commands.filter((command) => command.type === "send-prompt")).toEqual([
      {
        type: "send-prompt",
        agentId: "fake-agent-1",
        prompt: "Local does not need Git resolution",
      },
    ]);
  } finally {
    await f.stop();
  }
});
