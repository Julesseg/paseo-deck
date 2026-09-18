import { describe, expect, it } from "vitest";
import type { DirectorySnapshot, TimelineEvent } from "../contracts/domain.js";
import type { Observation } from "../contracts/gateway.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { ApplicationController } from "./controller.js";

const snapshot: DirectorySnapshot = {
  projects: [{ id: "project-1", name: "Deck" }],
  workspaces: [
    {
      id: "workspace-1",
      projectId: "project-1",
      title: "Main",
      directory: "/deck",
      archived: false,
    },
  ],
  agents: [
    {
      id: "agent-1",
      workspaceId: "workspace-1",
      title: "First",
      status: "running",
      providerId: "codex",
      modelId: "gpt-5.6",
      availableModeIds: ["default"],
      availableThinkingLevels: ["medium"],
      pendingPermissions: [],
      needsAttention: false,
      archived: false,
    },
    {
      id: "agent-2",
      workspaceId: "workspace-1",
      title: "Second",
      status: "idle",
      availableModeIds: [],
      availableThinkingLevels: [],
      pendingPermissions: [],
      needsAttention: false,
      archived: false,
    },
  ],
  providers: [
    {
      id: "codex",
      name: "Codex",
      ready: true,
      models: [
        {
          id: "gpt-5.6",
          name: "GPT-5.6",
          selectable: true,
          thinkingLevels: ["medium"],
        },
      ],
      modeIds: ["default"],
    },
  ],
};

function event(sequence: number, text: string): TimelineEvent {
  return {
    epoch: "epoch-1",
    sequence,
    item: {
      id: `assistant-${sequence}`,
      type: "assistant-message",
      messageId: `message-${sequence}`,
      text,
    },
  };
}

describe("ApplicationController", () => {
  it("integrates directory, timelines, permissions, focus changes, and reconnects exactly once", async () => {
    const gateway = new FakePaseoGateway(snapshot);
    const app = new ApplicationController(gateway);

    await app.start();
    expect(app.state.connection).toBe("connected");
    expect(app.state.directory.agents).toHaveLength(2);

    await app.selectAgent("agent-1");
    gateway.emitTimeline("agent-1", {
      type: "hydrated",
      agentId: "agent-1",
      items: [event(1, "Hello")],
      cursor: { epoch: "epoch-1", sequence: 1 },
    });
    gateway.emitTimeline("agent-1", {
      type: "event",
      agentId: "agent-1",
      event: event(1, "Hello"),
    });
    gateway.emitTimeline("agent-1", {
      type: "event",
      agentId: "agent-1",
      event: event(2, "READY"),
    });
    expect(app.state.timeline.items.map((item) => item.sequence)).toEqual([1, 2]);

    const request = { id: "permission-1", agentId: "agent-1", title: "Read a file" };
    const firstAgent = snapshot.agents[0];
    if (!firstAgent) throw new Error("fixture requires an agent");
    gateway.emitDirectory({
      type: "agent-upserted",
      agent: { ...firstAgent, pendingPermissions: [request] },
    });
    await app.handleIntent({
      type: "respond-permission",
      agentId: "agent-1",
      requestId: "permission-1",
      allow: false,
    });
    expect(gateway.commands).toContainEqual({
      type: "respond-permission",
      agentId: "agent-1",
      requestId: "permission-1",
      allow: false,
    });
    expect(app.state.directory.agents[0]?.pendingPermissions).toEqual([]);

    await app.selectAgent("agent-2");
    expect(gateway.releaseCount).toBe(1);

    app.setComposerText("preserve me");
    gateway.emitDirectory({ type: "connection-changed", state: "reconnecting" });
    gateway.emitDirectory({ type: "snapshot", snapshot });
    gateway.emitDirectory({ type: "connection-changed", state: "connected" });
    expect(app.state.connection).toBe("connected");
    expect(app.state.composerText).toBe("preserve me");

    await app.releaseObservations();
    expect(gateway.releaseCount).toBe(3);
  });

  it("creates an agent only after provider, model, mode, thinking, and prompt choices", async () => {
    const gateway = new FakePaseoGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();

    await app.handleIntent({
      type: "open-create-agent",
      workspaceId: "workspace-1",
      step: "provider",
    });
    await app.handleIntent({ type: "create-choice", choice: "codex" });
    await app.handleIntent({ type: "create-choice", choice: "gpt-5.6" });
    await app.handleIntent({ type: "create-choice", choice: "default" });
    await app.handleIntent({ type: "create-choice", choice: "medium" });
    expect(gateway.commands).toEqual([]);
    await app.handleIntent({ type: "create-choice", choice: "Start here" });

    expect(gateway.commands).toContainEqual({
      type: "create-agent",
      workspaceId: "workspace-1",
      providerId: "codex",
      modelId: "gpt-5.6",
      modeId: "default",
      thinkingLevel: "medium",
      prompt: "Start here",
    });
    expect(app.state.selectedAgentId).toBe("fake-agent-1");
  });

  it("preserves composer text when sending a prompt fails", async () => {
    const gateway = new FakePaseoGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    await app.selectAgent("agent-1");
    app.setComposerText("Keep this");
    await gateway.close();

    await app.handleIntent({ type: "submit-composer", agentId: "agent-1", prompt: "Keep this" });

    expect(app.state.composerText).toBe("Keep this");
    expect(app.state.notification?.kind).toBe("error");
  });

  it("ignores and releases focus operations that complete after a newer selection", async () => {
    const gateway = new DeferredFocusGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();

    const first = app.selectAgent("agent-1");
    const second = app.selectAgent("agent-2");
    const third = app.selectAgent("agent-1");
    gateway.resolveFocus(0);
    gateway.resolveFocus(1);
    gateway.resolveFocus(2);
    await Promise.all([first, second, third]);

    gateway.emitFocus(0, { type: "event", agentId: "agent-1", event: event(3, "stale") });
    gateway.emitFocus(2, { type: "event", agentId: "agent-1", event: event(4, "current") });

    expect(gateway.focusReleases).toEqual(["agent-1", "agent-2"]);
    expect(app.state.timeline.items.map((item) => item.item)).toEqual([
      expect.objectContaining({ text: "current" }),
    ]);
  });

  it("releases an established directory observation when initial snapshot fails", async () => {
    const gateway = new SnapshotFailureGateway(snapshot);
    const app = new ApplicationController(gateway);

    await app.start();

    expect(gateway.releaseCount).toBe(1);
    expect(app.state.connection).toBe("disconnected");
  });

  it("reconnects on refresh after a failed connection without losing composer text", async () => {
    const gateway = new RecoveringSnapshotGateway(snapshot);
    const app = new ApplicationController(gateway);
    app.setComposerText("draft survives");
    await app.start();
    expect(app.state.connection).toBe("disconnected");

    await app.handleIntent({ type: "refresh" });

    expect(app.state.connection).toBe("connected");
    expect(app.state.directory.agents).toHaveLength(2);
    expect(app.state.composerText).toBe("draft survives");
  });

  it("rejects mode and thinking choices that discovery did not return", async () => {
    const gateway = new FakePaseoGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    await app.handleIntent({
      type: "open-create-agent",
      workspaceId: "workspace-1",
      step: "provider",
    });
    await app.handleIntent({ type: "create-choice", choice: "codex" });
    await app.handleIntent({ type: "create-choice", choice: "gpt-5.6" });
    await app.handleIntent({ type: "create-choice", choice: "unsupported" });
    expect(app.state.modal).toMatchObject({ type: "create-agent", step: "mode" });
    expect(gateway.commands).toEqual([]);
  });
});

class DeferredFocusGateway extends FakePaseoGateway {
  readonly focusReleases: string[] = [];
  private readonly focuses: Array<{
    agentId: string;
    listener: Parameters<FakePaseoGateway["focusAgent"]>[1];
    resolve: (observation: Observation) => void;
  }> = [];

  override focusAgent(
    agentId: string,
    listener: Parameters<FakePaseoGateway["focusAgent"]>[1],
  ): Promise<Observation> {
    return new Promise((resolve) => this.focuses.push({ agentId, listener, resolve }));
  }

  resolveFocus(index: number): void {
    const focus = this.focuses[index];
    if (!focus) throw new Error(`missing focus ${index}`);
    focus.resolve({
      release: async () => {
        this.focusReleases.push(focus.agentId);
      },
    });
  }

  emitFocus(
    index: number,
    update: Parameters<Parameters<FakePaseoGateway["focusAgent"]>[1]>[0],
  ): void {
    const focus = this.focuses[index];
    if (!focus) throw new Error(`missing focus ${index}`);
    focus.listener(update);
  }
}

class SnapshotFailureGateway extends FakePaseoGateway {
  override async getDirectorySnapshot(): Promise<DirectorySnapshot> {
    throw new Error("snapshot failed");
  }
}

class RecoveringSnapshotGateway extends FakePaseoGateway {
  private attempts = 0;

  override async getDirectorySnapshot(): Promise<DirectorySnapshot> {
    this.attempts += 1;
    if (this.attempts === 1) throw new Error("snapshot failed");
    return super.getDirectorySnapshot();
  }
}
