import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import type { AgentCommand } from "../contracts/commands.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

class LaunchGateway extends FakePaseoGateway {
  failSend = false;
  override async execute(command: AgentCommand) {
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
    providers: [{ id: "provider", name: "Provider", ready: true, modeIds: [], models: [{ id: "model", name: "Model", selectable: true }] }],
    workspaces: [{ id: "w", projectId: "p", title: "Workspace", directory: "/tmp", archived: false }, { id: "other", projectId: "p", title: "Z Other", directory: "/other", archived: false }],
    agents: empty ? [] : [{ id: "a", workspaceId: "w", title: "Session", status: "idle", archived: false, availableModeIds: [], availableThinkingLevels: [], pendingPermissions: [], needsAttention: false }],
  });
  const app = new ApplicationController(gateway);
  await app.start();
  const terminal = new RecordingTerminal(100, 30);
  const pending: Promise<void>[] = [];
  const deck = new DeckTui(terminal, app.state, intent => { pending.push(app.handleIntent(intent)); });
  const unsubscribe = app.subscribe(state => deck.update(state));
  await deck.start();
  return { app, gateway, terminal, async key(data: string) { terminal.sendInput(data); await Promise.all(pending.splice(0)); await terminal.waitForRender(); }, async stop() { unsubscribe(); await deck.stop(); } };
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
    expect(f.gateway.commands).toEqual([{ type: "create-agent", workspaceId: "w", providerId: "provider", modelId: "model", prompt: "" }, { type: "send-prompt", agentId: "fake-agent-1", prompt: "retained first prompt" }]);
    await f.key("\r");
    expect(f.gateway.commands).toHaveLength(3);
    expect(f.gateway.commands[2]).toEqual({ type: "send-prompt", agentId: "fake-agent-1", prompt: "retained first prompt" });
    expect(f.app.state.activeTabIds.w).toBe("session:fake-agent-1");
  } finally { await f.stop(); }
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
    await f.key("g"); await f.key("g");
    await f.key("\u0014");
    expect(f.app.state.modal.type).toBe("none");
    await f.key("j");
    await f.key("\u0014");
    expect(f.app.state.modal).toMatchObject({ type: "new-tab", workspaceId: "w" });
  } finally { await f.stop(); }
});
