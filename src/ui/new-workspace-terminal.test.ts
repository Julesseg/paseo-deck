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

it("chooses first Tab without creating and preserves Session input through Terminal/profile round trips", async () => {
  const f = await fixture();
  try {
    f.gateway.terminalProfiles = [{ id: "tools", name: "Tools", command: "htop" }];
    await f.key("\u0013");
    await f.key("n");
    f.app.setComposerText("retained Session text");
    await f.key("\u0014");
    expect(f.terminal.viewport().join("\n")).toContain("Choose first Tab");
    await f.key("Tools");
    await f.key("\r");
    expect(f.terminal.viewport().join("\n")).toContain("[Ctrl-T] Tools");
    expect(f.terminal.viewport().join("\n")).not.toContain("[mp]");
    expect(f.gateway.createdWorkspaces).toEqual([]);
    expect(f.gateway.createdTerminals).toEqual([]);
    await f.key("\u0014");
    await f.key("Session");
    await f.key("\r");
    expect(f.terminal.viewport().join("\n")).toContain("retained Session text");
    expect(f.app.state.newWorkspace?.launch).toMatchObject({
      prompt: "retained Session text",
      providerId: "provider",
      modelId: "model",
    });
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.stop();
  }
});

it.each([false, true])(
  "Terminal submission accepts an empty prompt and never delivers retained Session text (%s)",
  async (retained) => {
    const f = await fixture();
    try {
      await f.key("\u0013");
      await f.key("n");
      if (retained) f.app.setComposerText("NEVER SEND\nSession text");
      await f.key("\u0014");
      await f.key("Terminal");
      await f.key("\r");
      await f.key("\r");
      expect(f.gateway.createdWorkspaces).toEqual([
        {
          projectId: "p",
          directory: "/repo",
          baseRef: "refs/remotes/origin/advertised-default",
        },
      ]);
      expect(f.gateway.createdTerminals).toEqual([
        { workspaceId: "fake-workspace-1", options: undefined },
      ]);
      expect(f.gateway.terminalInput).toEqual([]);
      expect(f.gateway.commands).toEqual([]);
      expect(f.app.state.activeTerminalId).toBe("fake-terminal-1");
      await f.key("q");
      expect(f.gateway.terminalInput).toEqual([{ terminalId: "fake-terminal-1", data: "q" }]);
    } finally {
      await f.stop();
    }
  },
);

it("retains Workspace/profile/Terminal identities and retries attachment only", async () => {
  const f = await fixture();
  try {
    f.gateway.terminalProfiles = [{ id: "tools", name: "Tools", command: "htop" }];
    const capture = f.gateway.captureTerminal.bind(f.gateway);
    let fail = true;
    f.gateway.captureTerminal = async (id) => {
      if (fail) throw new Error("attach offline");
      return capture(id);
    };
    await f.key("\u0013");
    await f.key("n");
    f.app.setComposerText("retained Session text");
    await f.key("\u0014");
    await f.key("Tools");
    await f.key("\r");
    await f.key("\r");
    expect(f.terminal.viewport().join("\n")).toContain("could not attach. Press Enter to retry.");
    expect(f.app.state.selectedWorkspaceId).toBe("fake-workspace-1");
    expect(f.app.state.launchDrafts?.["fake-workspace-1"]).toMatchObject({
      profileId: "tools",
      prompt: "retained Session text",
      createdTerminal: { id: "fake-terminal-1" },
    });
    fail = false;
    await f.key("\r");
    expect(f.gateway.createdWorkspaces).toHaveLength(1);
    expect(f.gateway.createdTerminals).toHaveLength(1);
    expect(f.gateway.createdTerminals[0]?.options).toMatchObject({ command: "htop" });
    expect(f.gateway.terminalInput).toEqual([]);
    expect(f.app.state.activeTerminalId).toBe("fake-terminal-1");
  } finally {
    await f.stop();
  }
});

it.each([80, 100, 180])(
  "keeps Workspace choices together when they fit and full Base ref visible at width %s",
  async (columns) => {
    const f = await fixture();
    try {
      f.terminal.setSize(columns, 30);
      await f.key("\u0013");
      await f.key("n");
      const rows = f.terminal.viewport();
      expect(rows.join("\n")).toContain("refs/remotes/origin/advertised-default");
      expect(rows.join("\n")).toContain("[Ctrl-T] Session");
      if (columns === 180) {
        const controls = rows.find((row) => row.includes("[md]"));
        expect(controls).toContain("[mw]");
        expect(controls).toContain("[mb]");
        expect(controls).toContain("[Ctrl-T]");
      }
    } finally {
      await f.stop();
    }
  },
);

it.each(["Workspace", "Terminal"])(
  "retains profile and Session values after %s creation failure for explicit retry",
  async (step) => {
    const f = await fixture();
    try {
      f.gateway.terminalProfiles = [{ id: "tools", name: "Tools", command: "htop" }];
      const workspace = f.gateway.createWorkspace.bind(f.gateway);
      const terminal = f.gateway.createTerminal.bind(f.gateway);
      let fail = true;
      f.gateway.createWorkspace = async (options) => {
        if (step === "Workspace" && fail) throw new Error("disk unavailable");
        return workspace(options);
      };
      f.gateway.createTerminal = async (id, options) => {
        if (step === "Terminal" && fail) throw new Error("shell unavailable");
        return terminal(id, options);
      };
      await f.key("\u0013");
      await f.key("n");
      f.app.setComposerText("retained Session text");
      await f.key("\u0014");
      await f.key("Tools");
      await f.key("\r");
      await f.key("\r");
      expect(f.terminal.viewport().join("\n")).toContain(
        step === "Workspace" ? "disk unavailable" : "shell unavailable",
      );
      expect(f.gateway.createdWorkspaces).toHaveLength(step === "Workspace" ? 0 : 1);
      expect(f.gateway.createdTerminals).toEqual([]);
      const retained =
        f.app.state.newWorkspace?.launch ?? f.app.state.launchDrafts?.["fake-workspace-1"];
      expect(retained).toMatchObject({ profileId: "tools", prompt: "retained Session text" });
      fail = false;
      await f.key("\r");
      expect(f.gateway.createdWorkspaces).toHaveLength(1);
      expect(f.gateway.createdTerminals).toHaveLength(1);
      expect(f.gateway.terminalInput).toEqual([]);
      expect(f.app.state.activeTerminalId).toBe("fake-terminal-1");
    } finally {
      await f.stop();
    }
  },
);

it("Terminal-first creation still requires idle Normal and Escape preserves its retained Session", async () => {
  const f = await fixture();
  try {
    await f.key("\u0013");
    await f.key("n");
    f.app.setComposerText("retained Session");
    await f.key("\u0014");
    await f.key("Terminal");
    await f.key("\r");
    await f.key("i");
    await f.key("\r");
    await f.key("\u0014");
    expect(f.app.state.modal.type).toBe("none");
    await f.key("\u001b");
    await f.key("v");
    await f.key("\r");
    await f.key("\u001b");
    await f.key("d");
    await f.key("\r");
    expect(f.gateway.createdWorkspaces).toEqual([]);
    expect(f.app.state.newWorkspace?.launch.prompt).toBe("retained Session");
    await f.key("\u001b");
    await f.key("\r");
    expect(f.app.state.activeTerminalId).toBe("fake-terminal-1");
    expect(f.gateway.terminalInput).toEqual([]);
  } finally {
    await f.stop();
  }
});
