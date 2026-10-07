import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

it("opens full selected notice and returns to its identity despite incoming notices", async () => {
  const app = new ApplicationController(
    new FakePaseoGateway({ projects: [], providers: [], workspaces: [], agents: [] }),
  );
  await app.start();
  const terminal = new RecordingTerminal(100, 30);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const stop = app.subscribe((state) => tui.update(state));
  await tui.start();
  try {
    await app.handleIntent({ type: "notify", message: "Original notice" });
    terminal.sendInput("\u0010");
    terminal.sendInput("notification");
    terminal.sendInput("\r");
    await app.handleIntent({ type: "notify", message: "Incoming notice" });
    terminal.sendInput("\r");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Original notice");
    expect(terminal.viewport().join("\n")).not.toContain("Notifications 2/2");
    terminal.sendInput("\u001b");
    await terminal.waitForRender();
    await expect
      .poll(async () => {
        await terminal.flush();
        return terminal.viewport().join("\n");
      })
      .toContain("> info: Original notice");
    for (let i = 0; i < 50; i++)
      await app.handleIntent({ type: "notify", message: `Later notice ${i}` });
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain(
      "Selected notification is no longer available.",
    );
    terminal.sendInput("\r");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain(
      "Selected notification is no longer available.",
    );
  } finally {
    stop();
    await tui.stop();
  }
});

it("retries the displayed failed decision after visiting another request and never answers on Enter", async () => {
  const agent = {
    id: "a",
    workspaceId: "w",
    title: "Session",
    status: "idle" as const,
    archived: false,
    availableModeIds: [],
    availableThinkingLevels: [],
    needsAttention: false,
    pendingPermissions: [
      { id: "first", agentId: "a", title: "Original request" },
      { id: "second", agentId: "a", title: "Other request" },
    ],
  };
  class Gateway extends FakePaseoGateway {
    override async execute(
      command: import("../contracts/commands.js").AgentCommand,
    ): Promise<import("../contracts/commands.js").CommandResult> {
      if (command.type === "respond-permission") {
        this.commands.push(command);
        throw new Error("Decision failed");
      }
      return super.execute(command);
    }
  }
  const gateway = new Gateway({
    projects: [],
    providers: [],
    workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
    agents: [agent],
  });
  const app = new ApplicationController(gateway);
  await app.start();
  const terminal = new RecordingTerminal(100, 30);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const stop = app.subscribe((state) => tui.update(state));
  await tui.start();
  try {
    await app.handleIntent({ type: "open-permissions" });
    terminal.sendInput("\r");
    terminal.sendInput("\n");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Original request");
    expect(gateway.commands).toEqual([]);
    terminal.sendInput("d");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Decision failed");
    gateway.emitDirectory({
      type: "agent-upserted",
      agent: {
        ...agent,
        pendingPermissions: [
          { id: "new", agentId: "a", title: "Incoming request" },
          ...agent.pendingPermissions,
        ],
      },
    });
    terminal.sendInput("l");
    await terminal.waitForRender();
    terminal.sendInput("h");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Original request");
    terminal.sendInput("r");
    await terminal.waitForRender();
    expect(gateway.commands).toEqual([
      { type: "respond-permission", agentId: "a", requestId: "first", allow: false },
      { type: "respond-permission", agentId: "a", requestId: "first", allow: false },
    ]);
  } finally {
    stop();
    await tui.stop();
  }
});

it("scrolls full diagnostic rows and ignores unreviewed detail controls", async () => {
  const app = new ApplicationController(
    new FakePaseoGateway({ projects: [], providers: [], workspaces: [], agents: [] }),
  );
  await app.start();
  const terminal = new RecordingTerminal(80, 20);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const stop = app.subscribe((state) => tui.update(state));
  await tui.start();
  try {
    await app.handleIntent({
      type: "open-error-details",
      message: "Diagnostic beginning",
      detail: Array.from({ length: 45 }, (_, i) => `Diagnostic row ${i + 1}`).join("\n"),
    });
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Diagnostic beginning");
    terminal.sendInput("G");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Diagnostic row 45");
    terminal.sendInput("\u001b[5~");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).not.toContain("Diagnostic row 45");
    terminal.sendInput("\u001b[6~");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Diagnostic row 45");
    for (const key of ["?", "/", "r", "y", "v"]) terminal.sendInput(key);
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Diagnostic row 45");
    terminal.sendInput("g");
    terminal.sendInput("g");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Diagnostic beginning");
    terminal.sendInput("j");
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).not.toContain("Diagnostic beginning");
  } finally {
    stop();
    await tui.stop();
  }
});

it("dismisses an in-flight permission without answering again or reopening on late failure", async () => {
  let fail: (reason: Error) => void = () => {};
  class Gateway extends FakePaseoGateway {
    override async execute(
      command: import("../contracts/commands.js").AgentCommand,
    ): Promise<import("../contracts/commands.js").CommandResult> {
      if (command.type === "respond-permission") {
        this.commands.push(command);
        return new Promise<import("../contracts/commands.js").CommandResult>((_resolve, reject) => {
          fail = reject;
        });
      }
      return super.execute(command);
    }
  }
  const gateway = new Gateway({
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
        needsAttention: false,
        pendingPermissions: [{ id: "first", agentId: "a", title: "Original request" }],
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
  await tui.start();
  try {
    terminal.sendInput("\u0013");
    await app.handleIntent({ type: "open-permissions" });
    terminal.sendInput("a");
    terminal.sendInput("a");
    terminal.sendInput("\u001b");
    expect(app.state.focus).toBe("tree");
    await app.handleIntent({ type: "notify", message: "New notice while pending" });
    await app.handleIntent({ type: "open-notifications" });
    expect(app.state.modal.type).toBe("notifications");
    fail(new Error("Late failure"));
    await terminal.waitForRender();
    expect(gateway.commands).toEqual([
      { type: "respond-permission", agentId: "a", requestId: "first", allow: true },
    ]);
    expect(terminal.viewport().join("\n")).toContain("New notice while pending");
    expect(terminal.viewport().join("\n")).not.toContain("Original request");
  } finally {
    stop();
    await tui.stop();
  }
});

it("retries the selected notice's failed action repeatedly without retargeting incoming failures", async () => {
  class Gateway extends FakePaseoGateway {
    override async execute(
      command: import("../contracts/commands.js").AgentCommand,
    ): Promise<import("../contracts/commands.js").CommandResult> {
      this.commands.push(command);
      throw new Error(`Failed ${command.type}`);
    }
  }
  const gateway = new Gateway({ projects: [], providers: [], workspaces: [], agents: [] });
  const app = new ApplicationController(gateway);
  await app.start();
  const terminal = new RecordingTerminal(100, 30);
  const tui = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const stop = app.subscribe((state) => tui.update(state));
  await tui.start();
  try {
    await app.handleIntent({
      type: "command",
      command: { type: "stop-agent", agentId: "original" },
    });
    await app.handleIntent({ type: "open-notifications" });
    await app.handleIntent({
      type: "command",
      command: { type: "archive-agent", agentId: "incoming" },
    });
    terminal.sendInput("r");
    await terminal.waitForRender();
    terminal.sendInput("r");
    await terminal.waitForRender();
    terminal.sendInput("\u0010");
    terminal.sendInput("retry");
    terminal.sendInput("\r");
    await terminal.waitForRender();
    expect(gateway.commands).toEqual([
      { type: "stop-agent", agentId: "original" },
      { type: "archive-agent", agentId: "incoming" },
      { type: "stop-agent", agentId: "original" },
      { type: "stop-agent", agentId: "original" },
      { type: "stop-agent", agentId: "original" },
    ]);
  } finally {
    stop();
    await tui.stop();
  }
});
