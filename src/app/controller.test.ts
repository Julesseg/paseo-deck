import { describe, expect, it } from "vitest";
import type { DirectorySnapshot, TimelineEvent } from "../contracts/domain.js";
import type { Observation } from "../contracts/gateway.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { selectedComposerDraft } from "../state/composer.js";
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

const remoteSnapshot: DirectorySnapshot = {
  projects: [{ id: "remote:github.com/acme/paseo-deck", name: "acme/paseo-deck" }],
  workspaces: [
    {
      id: "workspace-remote",
      projectId: "remote:github.com/acme/paseo-deck",
      title: "Remote workspace",
      directory: "/tmp/paseo-deck",
      archived: false,
    },
    {
      id: "workspace-orphan",
      projectId: "remote:unknown",
      title: "Orphan workspace",
      directory: "/tmp/orphan",
      archived: false,
    },
  ],
  agents: [
    {
      id: "agent-remote",
      workspaceId: "workspace-remote",
      title: "Remote agent",
      status: "running",
      availableModeIds: [],
      availableThinkingLevels: [],
      pendingPermissions: [],
      needsAttention: false,
      archived: false,
    },
    {
      id: "agent-orphan",
      workspaceId: "workspace-orphan",
      title: "Orphan agent",
      status: "idle",
      availableModeIds: [],
      availableThinkingLevels: [],
      pendingPermissions: [],
      needsAttention: true,
      archived: false,
    },
  ],
  providers: [],
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
  it("applies the explicit tree triage intents", async () => {
    const app = new ApplicationController(new FakePaseoGateway(snapshot));
    await app.start();

    await app.handleIntent({ type: "toggle-tree-order" });
    await app.handleIntent({ type: "toggle-archived" });
    await app.handleIntent({ type: "toggle-attention-only" });

    expect(app.state).toMatchObject({
      treeOrder: "alphabetical",
      showArchived: true,
      attentionOnly: true,
    });
  });

  it("reaches resolved and orphan remote agents through tree keyboard intents", async () => {
    const gateway = new FakePaseoGateway(remoteSnapshot);
    const app = new ApplicationController(gateway);
    await app.start();

    await app.handleIntent({ type: "select-next", direction: 1 });
    expect(app.state.selectedProjectId).toBe("remote:github.com/acme/paseo-deck");
    await app.handleIntent({ type: "collapse-or-expand", direction: 1 });
    await app.handleIntent({ type: "select-next", direction: 1 });
    expect(app.state.selectedWorkspaceId).toBe("workspace-remote");
    await app.handleIntent({ type: "collapse-or-expand", direction: 1 });
    await app.handleIntent({ type: "select-next", direction: 1 });
    expect(app.state.selectedAgentId).toBe("agent-remote");

    await app.handleIntent({ type: "select-next", direction: 1 });
    await app.handleIntent({ type: "select-next", direction: 1 });
    expect(app.state.selectedWorkspaceId).toBe("workspace-orphan");
    await app.handleIntent({ type: "collapse-or-expand", direction: 1 });
    await app.handleIntent({ type: "select-next", direction: 1 });
    expect(app.state.selectedAgentId).toBe("agent-orphan");
  });

  it("derives tree start and end boundaries from the current visible rows", async () => {
    const app = new ApplicationController(new FakePaseoGateway(remoteSnapshot));
    await app.start();

    await app.handleIntent({ type: "select-boundary", boundary: "end" });
    expect(app.state.selectedWorkspaceId).toBe("workspace-orphan");
    await app.handleIntent({ type: "select-boundary", boundary: "start" });
    expect(app.state.selectedProjectId).toBe("remote:github.com/acme/paseo-deck");
  });

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
    expect(selectedComposerDraft(app.state)).toBe("preserve me");

    await app.releaseObservations();
    expect(gateway.releaseCount).toBe(3);
  });

  it("preserves selected tree context through refresh and reconnect snapshots", async () => {
    const gateway = new FakePaseoGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    await app.selectAgent("agent-1");
    expect(app.state.expandedIds).toEqual(new Set(["workspace-1", "project-1"]));

    await app.handleIntent({ type: "refresh" });
    expect(app.state.selectedAgentId).toBe("agent-1");
    expect(app.state.selectedWorkspaceId).toBe("workspace-1");
    expect(app.state.expandedIds).toEqual(new Set(["workspace-1", "project-1"]));

    gateway.emitDirectory({ type: "connection-changed", state: "reconnecting" });
    gateway.emitDirectory({ type: "snapshot", snapshot });
    gateway.emitDirectory({ type: "connection-changed", state: "connected" });
    expect(app.state.selectedAgentId).toBe("agent-1");
    expect(app.state.selectedWorkspaceId).toBe("workspace-1");
    expect(app.state.expandedIds).toEqual(new Set(["workspace-1", "project-1"]));
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
    expect(app.state.expandedIds).toEqual(new Set(["workspace-1", "project-1"]));
  });

  it("preserves composer text when sending a prompt fails", async () => {
    const gateway = new FakePaseoGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    await app.selectAgent("agent-1");
    app.setComposerText("Keep this");
    await gateway.close();

    await app.handleIntent({ type: "submit-composer", agentId: "agent-1", prompt: "Keep this" });

    expect(selectedComposerDraft(app.state)).toBe("Keep this");
    expect(app.state.notification?.kind).toBe("error");
  });

  it("warns before destructive actions when the destination has an unsent draft", async () => {
    const gateway = new FakePaseoGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    await app.selectAgent("agent-1");
    app.setComposerText("do not lose this");

    await app.handleIntent({ type: "open-confirmation", action: "archive", agentId: "agent-1" });

    expect(app.state.modal).toEqual({
      type: "confirm",
      action: "archive",
      agentId: "agent-1",
      draftWarning: true,
    });
  });

  it("records one in-flight send and clears the selected draft only after it succeeds", async () => {
    const gateway = new FakePaseoGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    await app.selectAgent("agent-1");
    app.setComposerText("send once");

    await Promise.all([
      app.handleIntent({ type: "submit-composer", agentId: "agent-1", prompt: "send once" }),
      app.handleIntent({ type: "submit-composer", agentId: "agent-1", prompt: "send once" }),
    ]);

    expect(gateway.commands.filter((command) => command.type === "send-prompt")).toHaveLength(1);
    expect(selectedComposerDraft(app.state)).toBe("");
    expect(app.state.composer.histories["agent-1"]).toEqual(["send once"]);
  });

  it("keeps edits made during a failed send and permits another agent to send", async () => {
    const gateway = new DeferredSendGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    await app.selectAgent("agent-1");
    app.setComposerText("original");
    const first = app.handleIntent({
      type: "submit-composer",
      agentId: "agent-1",
      prompt: "original",
    });
    app.setComposerText("edited while sending");
    await app.selectAgent("agent-2");
    app.setComposerText("second prompt");
    const second = app.handleIntent({
      type: "submit-composer",
      agentId: "agent-2",
      prompt: "second prompt",
    });
    expect(gateway.commands.filter((command) => command.type === "send-prompt")).toHaveLength(2);

    gateway.rejectAll(new Error("offline"));
    await Promise.all([first, second]);
    await app.selectAgent("agent-1");
    expect(selectedComposerDraft(app.state)).toBe("edited while sending");
  });

  it("keeps edits made during a successful deferred send", async () => {
    const gateway = new DeferredSendGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    await app.selectAgent("agent-1");
    app.setComposerText("submitted");
    const sending = app.handleIntent({
      type: "submit-composer",
      agentId: "agent-1",
      prompt: "submitted",
    });
    app.setComposerText("newer draft");
    gateway.resolveAll();
    await sending;
    expect(selectedComposerDraft(app.state)).toBe("newer draft");
  });

  it("marks a successfully detached agent as unavailable to the composer", async () => {
    const gateway = new FakePaseoGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    await app.handleIntent({
      type: "command",
      command: { type: "detach-agent", agentId: "agent-1" },
    });
    expect(app.state.composer.detachedAgentIds.has("agent-1")).toBe(true);
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

  it("reconnects on refresh after a failed connection", async () => {
    const gateway = new RecoveringSnapshotGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    expect(app.state.connection).toBe("disconnected");

    await app.handleIntent({ type: "refresh" });

    expect(app.state.connection).toBe("connected");
    expect(app.state.directory.agents).toHaveLength(2);
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

class DeferredSendGateway extends FakePaseoGateway {
  private readonly failures: Array<(error: Error) => void> = [];
  private readonly successes: Array<
    (result: import("../contracts/commands.js").CommandResult) => void
  > = [];

  override async execute(command: import("../contracts/commands.js").AgentCommand) {
    if (command.type !== "send-prompt") return super.execute(command);
    this.commands.push(command);
    return new Promise<import("../contracts/commands.js").CommandResult>((resolve, reject) => {
      this.failures.push(reject);
      this.successes.push(resolve);
    });
  }

  rejectAll(error: Error): void {
    for (const reject of this.failures.splice(0)) reject(error);
  }

  resolveAll(): void {
    for (const resolve of this.successes.splice(0)) resolve({ type: "ok" });
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
