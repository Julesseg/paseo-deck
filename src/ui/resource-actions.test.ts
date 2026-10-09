import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

async function fixture() {
  const snapshot = {
    projects: [{ id: "p", name: "Project", directory: "/tmp" }],
    providers: [],
    workspaces: ["w", "other"].map((id) => ({
      id,
      projectId: "p",
      title: id === "w" ? "Active workspace" : "Highlighted workspace",
      directory: `/tmp/${id}`,
      archived: false,
    })),
    agents: [
      {
        id: "a",
        workspaceId: "w",
        title: "Active session",
        status: "running" as const,
        archived: false,
        availableModeIds: [],
        availableThinkingLevels: [],
        pendingPermissions: [],
        needsAttention: false,
      },
    ],
  };
  const gateway = new FakePaseoGateway(snapshot);
  const app = new ApplicationController(gateway);
  await app.start();
  const terminal = new RecordingTerminal(120, 35);
  const deck = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const unsubscribe = app.subscribe((state) => deck.update(state));
  await deck.start();
  return {
    app,
    gateway,
    terminal,
    snapshot,
    stop: async () => {
      unsubscribe();
      await deck.stop();
      await app.releaseObservations();
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("Sidebar archive captures highlighted Workspace, never Active workspace or Project fallback", async () => {
  const f = await fixture();
  try {
    f.terminal.sendInput("\u0013");
    f.terminal.sendInput("G");
    f.terminal.sendInput("\u0001");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain(
      "Archive Workspace Highlighted workspace (other)",
    );
    f.terminal.sendInput("n");
    expect(f.gateway.commands).toEqual([]);
    f.terminal.sendInput("\r");
    await settle();
    expect(f.gateway.commands).toEqual([{ type: "archive-workspace", workspaceId: "other" }]);
    expect(f.app.state.selectedWorkspaceId).toBe("w");
    f.terminal.sendInput("g");
    f.terminal.sendInput("g");
    f.terminal.sendInput("\u0001");
    expect(f.app.state.modal.type).toBe("none");
  } finally {
    await f.stop();
  }
});

it("Workspace rename captures highlight, trims and retains failed input for correction", async () => {
  const f = await fixture();
  try {
    f.terminal.sendInput("\u0013");
    f.terminal.sendInput("G");
    f.terminal.sendInput("\u0010");
    f.terminal.sendInput("Rename Workspace");
    f.terminal.sendInput("\r");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain(
      "Rename Workspace Highlighted workspace (other)",
    );
    const execute = f.gateway.execute.bind(f.gateway);
    f.gateway.execute = async (command) => {
      if (command.type === "rename-workspace") throw new Error("Name rejected");
      return execute(command);
    };
    f.terminal.sendInput("\u001b[200~  New name  \u001b[201~");
    f.terminal.sendInput("\u0005");
    // Select all through field motions: existing name follows pasted text, so remove it.
    for (let i = 0; i < "Highlighted workspace".length; i++) f.terminal.sendInput("\u007f");
    f.terminal.sendInput("\r");
    await settle();
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("New name");
    expect(f.terminal.viewport().join("\n")).toContain("Name rejected");
    f.gateway.execute = execute;
    f.terminal.sendInput("\r");
    await settle();
    expect(f.gateway.commands).toContainEqual({
      type: "rename-workspace",
      workspaceId: "other",
      name: "New name",
    });
    expect(f.app.state.modal.type).toBe("none");
  } finally {
    await f.stop();
  }
});

it("Sidebar palette names the Active terminal and Workspace even when another Workspace is highlighted", async () => {
  const f = await fixture();
  try {
    f.gateway.terminals = [{ id: "term", workspaceId: "w", name: "Shell", cwd: "/tmp/w" }];
    await f.app.handleIntent({ type: "refresh" });
    await f.app.handleIntent({ type: "open-terminal", terminalId: "term" });
    f.terminal.sendInput("\u0013");
    f.terminal.sendInput("G");
    f.terminal.sendInput("\u0010");
    f.terminal.sendInput("Rename active terminal");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("Shell (term)");
    f.terminal.sendInput("\r");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("in Workspace Active workspace (w)");
    f.terminal.sendInput("\u0005");
    f.terminal.sendInput(" renamed");
    f.terminal.sendInput("\r");
    await settle();
    expect(f.gateway.commands).toContainEqual({
      type: "rename-terminal",
      terminalId: "term",
      workspaceId: "w",
      name: "Shell renamed",
    });
    expect(f.gateway.terminals).toEqual([
      { id: "term", workspaceId: "w", name: "Shell", title: "Shell renamed", cwd: "/tmp/w" },
    ]);
    expect(f.app.state.activeTerminalId).toBe("term");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("Shell renamed");
    await f.app.handleIntent({
      type: "open-resource-rename",
      workspaceId: "w",
      terminalId: "term",
    });
    f.terminal.sendInput("\r");
    await settle();
    expect(f.app.state.modal.type).toBe("none");
    expect(f.gateway.commands).toHaveLength(1);
  } finally {
    await f.stop();
  }
});

it("a removed or newly archived captured Workspace disables its open confirmation without retargeting", async () => {
  const f = await fixture();
  try {
    f.terminal.sendInput("\u0013");
    f.terminal.sendInput("G");
    f.terminal.sendInput("\u0001");
    f.gateway.emitDirectory({
      type: "snapshot",
      snapshot: {
        ...f.snapshot,
        workspaces: f.snapshot.workspaces.filter((item) => item.id !== "other"),
      },
    });
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("Captured Workspace is no longer available");
    f.terminal.sendInput("\r");
    await settle();
    expect(f.gateway.commands).toEqual([]);
    expect(f.app.state.modal.type).toBe("confirm");
    f.terminal.sendInput("\u001b");
    expect(f.app.state.focus).toBe("tree");
  } finally {
    await f.stop();
  }
});

it("busy rename guards repeated Enter and reopened target; dismissal and late completion preserve the newer editor", async () => {
  const f = await fixture();
  try {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const execute = f.gateway.execute.bind(f.gateway);
    const requests: unknown[] = [];
    f.gateway.execute = async (command) => {
      requests.push(command);
      await pending;
      return execute(command);
    };
    await f.app.handleIntent({ type: "open-resource-rename", workspaceId: "other" });
    f.terminal.sendInput("\u0005");
    f.terminal.sendInput(" renamed");
    f.terminal.sendInput("\r");
    f.terminal.sendInput("\r");
    expect(requests).toEqual([
      { type: "rename-workspace", workspaceId: "other", name: "Highlighted workspace renamed" },
    ]);
    f.terminal.sendInput("\u001b");
    await f.terminal.waitForRender();
    await f.app.handleIntent({ type: "open-resource-rename", workspaceId: "other" });
    f.terminal.sendInput("again");
    f.terminal.sendInput("\r");
    expect(requests).toHaveLength(1);
    f.terminal.sendInput("\u001b");
    await f.terminal.waitForRender();
    await f.app.handleIntent({ type: "open-rename", agentId: "a" });
    f.terminal.sendInput("X");
    f.terminal.sendInput("\u001b[C");
    await f.terminal.waitForRender();
    const cursor = f.terminal.viewportCursor();
    finish();
    await settle();
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("XActive session");
    expect(f.terminal.viewportCursor()).toEqual(cursor);
    expect(f.app.state.modal).toMatchObject({ type: "rename", agentId: "a" });
    expect(f.app.state.directory.workspaces.find((item) => item.id === "other")?.title).toBe(
      "Highlighted workspace renamed",
    );
  } finally {
    await f.stop();
  }
});

it("captured Workspace archive remains once-only after dismissal and late completion cannot close another dialog", async () => {
  const f = await fixture();
  try {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const requests: unknown[] = [];
    const execute = f.gateway.execute.bind(f.gateway);
    f.gateway.execute = async (command) => {
      requests.push(command);
      await pending;
      return execute(command);
    };
    f.terminal.sendInput("\u0013");
    f.terminal.sendInput("G");
    f.terminal.sendInput("\u0001");
    f.terminal.sendInput("\r");
    f.terminal.sendInput("\r");
    f.terminal.sendInput("\u001b");
    f.terminal.sendInput("\u0001");
    f.terminal.sendInput("\r");
    expect(requests).toEqual([{ type: "archive-workspace", workspaceId: "other" }]);
    f.terminal.sendInput("\u001b");
    await f.terminal.waitForRender();
    await f.app.handleIntent({ type: "open-rename", agentId: "a" });
    f.terminal.sendInput("new");
    finish();
    await settle();
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("newActive session");
    expect(f.app.state.modal).toMatchObject({ type: "rename", agentId: "a" });
  } finally {
    await f.stop();
  }
});

it("Stop/Archive are Normal Active-session actions and captured ineligibility remains visible", async () => {
  const f = await fixture();
  try {
    f.terminal.sendInput("i");
    f.terminal.sendInput("\u0018");
    expect(f.app.state.modal.type).toBe("none");
    f.terminal.sendInput("\u001b");
    await f.terminal.waitForRender();

    f.terminal.sendInput("\u0018");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("Stop Session Active session (a)");
    f.gateway.emitDirectory({
      type: "snapshot",
      snapshot: {
        ...f.snapshot,
        agents: f.snapshot.agents.map((item) => ({ ...item, status: "stopped" as const })),
      },
    });
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("Captured Session has already stopped");
    f.terminal.sendInput("\r");
    expect(f.gateway.commands).toEqual([]);
    f.terminal.sendInput("\u001b");
    await f.terminal.waitForRender();
    f.terminal.sendInput("\u0001");
    await f.terminal.waitForRender();
    f.terminal.sendInput("\r");
    await settle();
    expect(f.gateway.commands).toEqual([{ type: "archive-agent", agentId: "a" }]);
  } finally {
    await f.stop();
  }
});

it("a failed terminate retry retains its captured Terminal after Active tab and highlight change", async () => {
  const f = await fixture();
  try {
    f.gateway.terminals = [
      { id: "term", workspaceId: "w", name: "Shell", cwd: "/tmp/w" },
      { id: "other-term", workspaceId: "other", name: "Other shell", cwd: "/tmp/other" },
    ];
    await f.app.handleIntent({ type: "refresh" });
    await f.app.handleIntent({ type: "open-terminal", terminalId: "term" });
    const kill = f.gateway.killTerminal.bind(f.gateway);
    f.gateway.killTerminal = async () => {
      throw new Error("Terminate failed");
    };
    f.terminal.sendInput("\u0013");
    f.terminal.sendInput("\u0010");
    f.terminal.sendInput("Terminate active terminal");
    f.terminal.sendInput("\r");
    await f.terminal.waitForRender();
    f.terminal.sendInput("\r");
    await settle();
    f.terminal.sendInput("\u001b");
    await f.terminal.waitForRender();
    await f.app.handleIntent({ type: "open-terminal", terminalId: "other-term" });
    f.gateway.killTerminal = kill;
    f.terminal.sendInput("\u0013");
    f.terminal.sendInput("\u0010");
    f.terminal.sendInput("Retry selected failure");
    f.terminal.sendInput("\r");
    await settle();
    expect(f.gateway.terminals.map((item) => item.id)).toEqual(["other-term"]);
    expect(f.app.state.activeTerminalId).toBe("other-term");
  } finally {
    await f.stop();
  }
});

it("narrow rename and terminate dialogs expose the complete captured Terminal and Workspace identities", async () => {
  const f = await fixture();
  try {
    f.terminal.setSize(80, 35);
    f.gateway.terminals = [
      {
        id: "captured-terminal",
        workspaceId: "w",
        name: "A long terminal display name that consumes the entire header",
        cwd: "/tmp/w",
      },
    ];
    await f.app.handleIntent({ type: "refresh" });
    await f.app.handleIntent({ type: "open-terminal", terminalId: "captured-terminal" });
    await f.app.handleIntent({
      type: "open-resource-rename",
      workspaceId: "w",
      terminalId: "captured-terminal",
    });
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("(captured-terminal)");
    expect(f.terminal.viewport().join("\n")).toContain("Active workspace (w)");
    f.terminal.sendInput("\u001b");
    await f.terminal.waitForRender();
    await f.app.handleIntent({ type: "kill-terminal" });
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("(captured-terminal)");
    expect(f.terminal.viewport().join("\n")).toContain("Active workspace (w)");
  } finally {
    await f.stop();
  }
});

it("Session rename and Detach keep the captured Session when the Active session changes", async () => {
  const f = await fixture();
  try {
    const first = f.snapshot.agents[0];
    if (!first) throw new Error("Missing Session fixture");
    const second = { ...first, id: "b", title: "Other session" };
    f.gateway.emitDirectory({
      type: "snapshot",
      snapshot: { ...f.snapshot, agents: [...f.snapshot.agents, second] },
    });
    f.terminal.sendInput("\u0010");
    f.terminal.sendInput("Rename Session");
    f.terminal.sendInput("\r");
    await f.terminal.waitForRender();
    await f.app.selectAgent("b");
    f.terminal.sendInput("\u0005");
    f.terminal.sendInput(" renamed");
    f.terminal.sendInput("\r");
    await settle();
    expect(f.gateway.commands).toContainEqual({
      type: "rename-agent",
      agentId: "a",
      name: "Active session renamed",
    });
    f.terminal.sendInput("\u0010");
    f.terminal.sendInput("Detach Session");
    f.terminal.sendInput("\r");
    await f.terminal.waitForRender();
    await f.app.selectAgent("a");
    f.terminal.sendInput("\r");
    await settle();
    expect(f.gateway.commands).toContainEqual({ type: "detach-agent", agentId: "b" });
    expect(f.app.state.selectedAgentId).toBe("a");
  } finally {
    await f.stop();
  }
});

it("a successful rename followed by refresh failure reports completion and retries refresh without renaming twice", async () => {
  const f = await fixture();
  try {
    const snapshot = f.gateway.getDirectorySnapshot.bind(f.gateway);
    const execute = f.gateway.execute.bind(f.gateway);
    f.gateway.execute = async (command) => {
      const result = await execute(command);
      f.gateway.getDirectorySnapshot = async () => {
        throw new Error("Read unavailable");
      };
      return result;
    };
    await f.app.handleIntent({ type: "open-resource-rename", workspaceId: "other" });
    f.terminal.sendInput("\u0005");
    f.terminal.sendInput(" renamed");
    f.terminal.sendInput("\r");
    await settle();
    expect(f.app.state.modal.type).toBe("none");
    expect(f.app.state.notifications.at(-1)?.message).toBe(
      "Action completed; refreshing confirmed resources failed.",
    );
    expect(f.app.state.directory.workspaces.find((item) => item.id === "other")?.title).toBe(
      "Highlighted workspace renamed",
    );
    f.gateway.getDirectorySnapshot = snapshot;
    f.terminal.sendInput("\u0010");
    f.terminal.sendInput("Retry selected failure");
    f.terminal.sendInput("\r");
    await settle();
    expect(f.gateway.commands).toEqual([
      { type: "rename-workspace", workspaceId: "other", name: "Highlighted workspace renamed" },
    ]);
  } finally {
    await f.stop();
  }
});
