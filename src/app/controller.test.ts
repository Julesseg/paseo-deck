import { describe, expect, it } from "vitest";
import type { DirectorySnapshot, TimelineEvent } from "../contracts/domain.js";
import type { Observation } from "../contracts/gateway.js";
import { PaseoGatewayError } from "../paseo/errors.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { selectedComposerDraft } from "../state/composer.js";
import { activeNotification } from "../state/store.js";
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
    expect(app.state.sidebarSelection).toEqual({ kind: "session", id: "agent-remote" });

    await app.handleIntent({ type: "select-next", direction: 1 });
    await app.handleIntent({ type: "select-next", direction: 1 });
    expect(app.state.selectedWorkspaceId).toBe("workspace-orphan");
    await app.handleIntent({ type: "collapse-or-expand", direction: 1 });
    await app.handleIntent({ type: "select-next", direction: 1 });
    expect(app.state.sidebarSelection).toEqual({ kind: "session", id: "agent-orphan" });
  });

  it("derives tree start and end boundaries from the current visible rows", async () => {
    const app = new ApplicationController(new FakePaseoGateway(remoteSnapshot));
    await app.start();

    await app.handleIntent({ type: "select-boundary", boundary: "end" });
    expect(app.state.selectedWorkspaceId).toBe("workspace-orphan");
    await app.handleIntent({ type: "select-boundary", boundary: "start" });
    expect(app.state.selectedProjectId).toBe("remote:github.com/acme/paseo-deck");
  });

  it("keeps sidebar navigation separate from the active session until Enter", async () => {
    const gateway = new FakePaseoGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    await app.selectAgent("agent-1");
    gateway.emitTimeline("agent-1", { type: "hydrated", agentId: "agent-1", items: [event(1, "active")] });
    const timelineBefore = app.state.timeline;

    await app.handleIntent({ type: "select-next", direction: 1 });
    expect(app.state.sidebarSelection).toEqual({ kind: "session", id: "agent-2" });
    expect(app.state.activeSessionId).toBe("agent-1");
    expect(app.state.timeline).toBe(timelineBefore);

    await app.handleIntent({ type: "select-or-open" });
    expect(app.state.activeSessionId).toBe("agent-2");
    expect(app.state.sidebarSelection).toEqual({ kind: "session", id: "agent-2" });
  });

  it("does not activate a session while browsing from an empty active state", async () => {
    const app = new ApplicationController(new FakePaseoGateway(snapshot));
    await app.start();

    await app.handleIntent({ type: "select-next", direction: 1 });
    await app.handleIntent({ type: "collapse-or-expand", direction: 1 });
    await app.handleIntent({ type: "select-next", direction: 1 });
    await app.handleIntent({ type: "select-next", direction: 1 });
    await app.handleIntent({ type: "collapse-or-expand", direction: 1 });
    await app.handleIntent({ type: "select-next", direction: 1 });
    await app.handleIntent({ type: "select-next", direction: 1 });
    expect(app.state.sidebarSelection).toEqual({ kind: "session", id: "agent-2" });
    expect(app.state.activeSessionId).toBeUndefined();
    expect(app.state.selectedAgentId).toBeUndefined();

    await app.handleIntent({ type: "select-or-open" });
    expect(app.state.activeSessionId).toBe("agent-2");
  });

  it("returns to the active timeline when Enter is pressed on the active sidebar session", async () => {
    const app = new ApplicationController(new FakePaseoGateway(snapshot));
    await app.start();
    await app.selectAgent("agent-1");
    await app.handleIntent({ type: "set-focus", focus: "tree" });
    await app.handleIntent({ type: "select-or-open" });
    expect(app.state.activeSessionId).toBe("agent-1");
    expect(app.state.focus).toBe("timeline");
  });

  it("preserves the active timeline while sidebar rows survive and repair directory updates", async () => {
    const gateway = new FakePaseoGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    await app.selectAgent("agent-1");
    gateway.emitTimeline("agent-1", { type: "hydrated", agentId: "agent-1", items: [event(1, "active")] });
    await app.handleIntent({ type: "select-next", direction: 1 });
    expect(app.state.sidebarSelection).toEqual({ kind: "session", id: "agent-2" });
    const timeline = app.state.timeline;

    gateway.emitDirectory({ type: "snapshot", snapshot });
    expect(app.state.sidebarSelection).toEqual({ kind: "session", id: "agent-2" });
    expect(app.state.activeSessionId).toBe("agent-1");
    expect(app.state.timeline).toBe(timeline);

    gateway.emitDirectory({
      type: "snapshot",
      snapshot: { ...snapshot, agents: snapshot.agents.filter((agent) => agent.id !== "agent-2") },
    });
    expect(app.state.sidebarSelection).toEqual({ kind: "session", id: "agent-1" });
    expect(app.state.activeSessionId).toBe("agent-1");
    expect(app.state.timeline).toBe(timeline);
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
    expect(app.state.directory.agents[0]?.pendingPermissions).toEqual([request]);
    gateway.emitTimeline("agent-1", {
      type: "event",
      agentId: "agent-1",
      event: {
        epoch: "epoch-1",
        sequence: 3,
        item: {
          id: "permission:permission-1",
          type: "permission",
          request,
          resolved: true,
        },
      },
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

  it("keeps permission decisions pending, navigates requests, and advances only on daemon confirmation", async () => {
    const first = { id: "p1", agentId: "agent-1", title: "First request" };
    const second = { id: "p2", agentId: "agent-2", title: "Second request" };
    const firstAgent = snapshot.agents[0];
    const secondAgent = snapshot.agents[1];
    if (!firstAgent || !secondAgent) throw new Error("fixture requires two agents");
    const fixture: DirectorySnapshot = {
      ...snapshot,
      agents: [
        { ...firstAgent, pendingPermissions: [first] },
        { ...secondAgent, pendingPermissions: [second] },
      ],
    };
    const gateway = new FakePaseoGateway(fixture);
    const app = new ApplicationController(gateway);
    await app.start();

    await app.handleIntent({ type: "open-permissions" });
    expect(app.state.selectedAgentId).toBe("agent-1");
    expect(app.state.modal).toMatchObject({ requestId: "p1", queueIndex: 0 });
    await app.handleIntent({ type: "move-permission", direction: 1 });
    expect(app.state.selectedAgentId).toBe("agent-2");
    expect(app.state.modal).toMatchObject({ requestId: "p2", queueIndex: 1 });

    await app.handleIntent({
      type: "respond-permission",
      agentId: "agent-2",
      requestId: "p2",
      allow: true,
    });
    expect(app.state.modal).toMatchObject({ submitting: true, requestId: "p2" });
    expect(app.state.directory.agents[1]?.pendingPermissions).toEqual([second]);

    gateway.emitTimeline("agent-2", {
      type: "event",
      agentId: "agent-2",
      event: {
        epoch: "epoch-1",
        sequence: 1,
        item: { id: "permission:p2", type: "permission", request: second, resolved: true },
      },
    });
    await Promise.resolve();
    expect(app.state.directory.agents[1]?.pendingPermissions).toEqual([]);
    expect(app.state.modal).toMatchObject({ requestId: "p1", queueIndex: 0 });
    expect(app.state.selectedAgentId).toBe("agent-1");
  });

  it("keeps a failed permission available for an explicit retry using the same decision", async () => {
    const request = { id: "p1", agentId: "agent-1", title: "Review" };
    const agent = snapshot.agents[0];
    if (!agent) throw new Error("fixture requires an agent");
    const gateway = new FailingPermissionGateway({
      ...snapshot,
      agents: [{ ...agent, pendingPermissions: [request] }, ...snapshot.agents.slice(1)],
    });
    const app = new ApplicationController(gateway);
    await app.start();
    await app.handleIntent({ type: "open-permissions" });
    await app.handleIntent({
      type: "respond-permission",
      agentId: "agent-1",
      requestId: "p1",
      allow: false,
    });

    expect(app.state.modal).toMatchObject({
      type: "permission",
      requestId: "p1",
      submitting: false,
      lastDecision: "deny",
      error: expect.stringContaining("response failed"),
    });
    expect(app.state.directory.agents[0]?.pendingPermissions).toEqual([request]);
    gateway.shouldFail = false;
    await app.handleIntent({
      type: "retry-permission",
      agentId: "agent-1",
      requestId: "p1",
      allow: false,
    });
    expect(gateway.commands.at(-1)).toEqual({
      type: "respond-permission",
      agentId: "agent-1",
      requestId: "p1",
      allow: false,
    });
    expect(app.state.directory.agents[0]?.pendingPermissions).toEqual([request]);
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

    expect(app.state.modal).toMatchObject({ type: "create-agent", step: "confirm" });
    expect(gateway.commands).toEqual([]);
    await app.handleIntent({ type: "create-choice", choice: "__confirm__" });

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
    expect(app.state.creationDefaults).toEqual({
      "workspace-1": {
        providerId: "codex",
        modelId: "gpt-5.6",
        modeId: "default",
        thinkingLevel: "medium",
      },
    });
  });

  it("keeps the complete creation form through back navigation and closes from provider", async () => {
    const app = new ApplicationController(new FakePaseoGateway(snapshot));
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
    await app.handleIntent({ type: "create-choice", choice: "First line\nSecond line" });
    await app.handleIntent({ type: "creation-back" });
    await app.handleIntent({ type: "creation-back" });
    await app.handleIntent({ type: "creation-back" });
    await app.handleIntent({ type: "creation-back" });
    await app.handleIntent({ type: "creation-back" });

    expect(app.state.modal).toMatchObject({
      type: "create-agent",
      step: "provider",
      providerId: "codex",
      modelId: "gpt-5.6",
      modeId: "default",
      thinkingLevel: "medium",
      prompt: "First line\nSecond line",
    });
    await app.handleIntent({ type: "creation-back" });
    expect(app.state.modal).toEqual({ type: "none" });
  });

  it("invalidates only dependent creation choices when provider or model changes", async () => {
    const initialProvider = snapshot.providers[0];
    if (!initialProvider) throw new Error("fixture requires a provider");
    const alternate: DirectorySnapshot = {
      ...snapshot,
      providers: [
        initialProvider,
        {
          id: "other",
          name: "Other",
          ready: true,
          modeIds: ["safe"],
          models: [
            { id: "first", name: "First", selectable: true, thinkingLevels: ["low"] },
            { id: "second", name: "Second", selectable: true, thinkingLevels: ["high"] },
          ],
        },
      ],
    };
    const app = new ApplicationController(new FakePaseoGateway(alternate));
    await app.start();
    await app.handleIntent({
      type: "open-create-agent",
      workspaceId: "workspace-1",
      step: "provider",
    });
    await app.handleIntent({ type: "create-choice", choice: "other" });
    await app.handleIntent({ type: "create-choice", choice: "first" });
    await app.handleIntent({ type: "create-choice", choice: "safe" });
    await app.handleIntent({ type: "create-choice", choice: "low" });
    await app.handleIntent({ type: "creation-back" });
    await app.handleIntent({ type: "creation-back" });
    await app.handleIntent({ type: "creation-back" });
    await app.handleIntent({ type: "create-choice", choice: "second" });
    expect(app.state.modal).toMatchObject({
      type: "create-agent",
      step: "mode",
      providerId: "other",
      modelId: "second",
      modeId: "safe",
    });
    expect(app.state.modal).not.toHaveProperty("thinkingLevel");
    await app.handleIntent({ type: "creation-back" });
    await app.handleIntent({ type: "creation-back" });
    await app.handleIntent({ type: "create-choice", choice: "codex" });
    expect(app.state.modal).toMatchObject({
      type: "create-agent",
      providerId: "codex",
      step: "model",
    });
    expect(app.state.modal).not.toHaveProperty("modelId");
    expect(app.state.modal).not.toHaveProperty("modeId");
  });

  it("keeps a failed confirmation intact and retries the exact command", async () => {
    const gateway = new DeferredCreateGateway(snapshot);
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
    await app.handleIntent({ type: "create-choice", choice: "line one\nline two" });

    const first = app.handleIntent({ type: "create-choice", choice: "__confirm__" });
    expect(app.state.modal).toMatchObject({
      type: "create-agent",
      step: "confirm",
      submitting: true,
    });
    await app.handleIntent({ type: "creation-back" });
    await app.handleIntent({ type: "create-choice", choice: "__confirm__" });
    expect(gateway.commands).toHaveLength(1);
    gateway.rejectCreate(new Error("daemon unavailable"));
    await first;

    expect(app.state.modal).toMatchObject({
      type: "create-agent",
      step: "confirm",
      prompt: "line one\nline two",
      providerId: "codex",
      modelId: "gpt-5.6",
      modeId: "default",
      thinkingLevel: "medium",
      submitting: false,
      error: expect.stringContaining("daemon unavailable"),
    });
    expect(app.state.creationDefaults).toEqual({});
    const retry = app.handleIntent({ type: "create-choice", choice: "__confirm__" });
    expect(gateway.commands).toHaveLength(2);
    expect(gateway.commands[1]).toEqual(gateway.commands[0]);
    gateway.resolveCreate("created-after-retry");
    await retry;
    expect(app.state.selectedAgentId).toBe("created-after-retry");
  });

  it("keeps successful creation defaults isolated by workspace", async () => {
    const twoWorkspaces: DirectorySnapshot = {
      ...snapshot,
      workspaces: [
        ...snapshot.workspaces,
        {
          id: "workspace-2",
          projectId: "project-1",
          title: "Second workspace",
          directory: "/deck-second",
          archived: false,
        },
      ],
    };
    const app = new ApplicationController(new FakePaseoGateway(twoWorkspaces));
    await app.start();

    await chooseCreation(app, "workspace-1", "first workspace prompt");
    expect(app.state.creationDefaults["workspace-1"]).toMatchObject({
      providerId: "codex",
      modelId: "gpt-5.6",
      modeId: "default",
      thinkingLevel: "medium",
    });

    await app.handleIntent({
      type: "open-create-agent",
      workspaceId: "workspace-2",
      step: "provider",
    });
    expect(app.state.modal).toMatchObject({ type: "create-agent", workspaceId: "workspace-2" });
    expect(app.state.modal).not.toHaveProperty("providerId");
    await app.handleIntent({ type: "creation-back" });

    await chooseCreation(app, "workspace-2", "second workspace prompt");
    expect(app.state.creationDefaults).toMatchObject({
      "workspace-1": expect.objectContaining({ providerId: "codex" }),
      "workspace-2": expect.objectContaining({ providerId: "codex" }),
    });
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
    expect(activeNotification(app.state)?.kind).toBe("error");
  });

  it("retries an exact failed prompt through an opaque notification token", async () => {
    const gateway = new FailingOnceSendGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    await app.selectAgent("agent-1");
    app.setComposerText("private retry prompt");

    await app.handleIntent({
      type: "submit-composer",
      agentId: "agent-1",
      prompt: "private retry prompt",
    });

    const notification = activeNotification(app.state);
    expect(notification).toMatchObject({ failureKind: "command", retry: { type: "operation" } });
    expect(JSON.stringify(notification)).not.toContain("private retry prompt");
    if (notification?.retry?.type !== "operation") throw new Error("retry missing");
    await app.handleIntent({ type: "retry-notification", id: notification.id });
    await app.handleIntent({ type: "retry-notification", id: notification.id });
    expect(gateway.commands.filter((command) => command.type === "send-prompt")).toEqual([
      { type: "send-prompt", agentId: "agent-1", prompt: "private retry prompt" },
      { type: "send-prompt", agentId: "agent-1", prompt: "private retry prompt" },
    ]);
    expect(selectedComposerDraft(app.state)).toBe("");
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

  it("surfaces local UI feedback as a nonfatal notification", async () => {
    const app = new ApplicationController(new FakePaseoGateway(snapshot));
    await app.start();

    await app.handleIntent({ type: "notify", message: "Copied." });

    expect(activeNotification(app.state)).toMatchObject({ kind: "info", message: "Copied." });
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

  it("retains drafts, selection and timeline data across a reconnect recovery", async () => {
    const gateway = new FakePaseoGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    await app.selectAgent("agent-1");
    app.setComposerText("keep this draft");
    gateway.emitTimeline("agent-1", { type: "event", agentId: "agent-1", event: event(8, "kept") });
    gateway.emitDirectory({ type: "connection-changed", state: "reconnecting", attempt: 2 });
    expect(app.state.recovery).toMatchObject({
      attempt: 2,
      directoryStale: true,
      timelineStale: true,
    });
    gateway.emitDirectory({ type: "connection-changed", state: "connected" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app.state.selectedAgentId).toBe("agent-1");
    expect(app.state.composer.drafts["agent-1"]).toBe("keep this draft");
    expect(app.state.timeline.items.map((entry) => entry.item.id)).toContain("assistant-8");
    expect(app.state.recovery).toMatchObject({
      attempt: 0,
      directoryStale: false,
      timelineStale: false,
    });
  });

  it("recovers directory and focused timeline stages independently without clearing local context", async () => {
    const gateway = new RecoveryStageGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    await app.selectAgent("agent-1");
    app.setComposerText("keep recovery draft");
    await app.handleIntent({
      type: "set-timeline-navigation",
      agentId: "agent-1",
      following: false,
      anchor: { epoch: "epoch-1", sequence: 4 },
    });
    gateway.emitTimeline("agent-1", { type: "event", agentId: "agent-1", event: event(4, "kept") });

    gateway.failFocus = true;
    gateway.emitDirectory({ type: "connection-changed", state: "reconnecting", attempt: 1 });
    gateway.emitDirectory({ type: "connection-changed", state: "connected" });
    await nextTurn();
    expect(app.state.recovery).toMatchObject({ directoryStale: false, timelineStale: true });
    expect(selectedComposerDraft(app.state)).toBe("keep recovery draft");
    expect(app.state.timeline.items.map((item) => item.item.id)).toContain("assistant-4");
    expect(app.state.timelineNavigation["agent-1"]).toMatchObject({
      following: false,
      unread: 1,
      anchor: { epoch: "epoch-1", sequence: 4 },
    });

    gateway.failFocus = false;
    const timelineFailure = activeNotification(app.state);
    if (!timelineFailure) throw new Error("expected timeline recovery notification");
    await app.handleIntent({ type: "retry-notification", id: timelineFailure.id });
    await nextTurn();
    expect(app.state.recovery).toMatchObject({ directoryStale: false, timelineStale: false });

    gateway.failSnapshot = true;
    gateway.emitDirectory({ type: "connection-changed", state: "reconnecting", attempt: 3 });
    gateway.emitDirectory({ type: "connection-changed", state: "connected" });
    await nextTurn();
    expect(app.state.recovery).toMatchObject({ directoryStale: true, timelineStale: false });

    gateway.failSnapshot = false;
    const directoryFailure = activeNotification(app.state);
    if (!directoryFailure) throw new Error("expected directory recovery notification");
    await app.handleIntent({ type: "retry-notification", id: directoryFailure.id });
    await nextTurn();
    expect(app.state.recovery).toMatchObject({ directoryStale: false, timelineStale: false });
  });

  it("ignores a recovery snapshot that completes after a newer disconnect", async () => {
    const gateway = new DeferredRecoveryGateway(snapshot);
    const app = new ApplicationController(gateway);
    await app.start();
    await app.selectAgent("agent-1");
    gateway.deferSnapshots = true;
    gateway.emitDirectory({ type: "connection-changed", state: "reconnecting", attempt: 1 });
    gateway.emitDirectory({ type: "connection-changed", state: "connected" });
    await Promise.resolve();
    gateway.emitDirectory({ type: "connection-changed", state: "reconnecting", attempt: 2 });
    gateway.resolveSnapshot(0);
    await nextTurn();

    expect(app.state.recovery).toMatchObject({ attempt: 2, directoryStale: true });
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

class FailingPermissionGateway extends FakePaseoGateway {
  shouldFail = true;

  override async execute(command: import("../contracts/commands.js").AgentCommand) {
    if (command.type === "respond-permission" && this.shouldFail) {
      this.commands.push(command);
      throw new Error("response failed");
    }
    return super.execute(command);
  }
}

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

class FailingOnceSendGateway extends FakePaseoGateway {
  private failed = false;

  override async execute(command: import("../contracts/commands.js").AgentCommand) {
    if (command.type === "send-prompt" && !this.failed) {
      this.failed = true;
      this.commands.push(command);
      throw new PaseoGatewayError("command failed", "network unavailable", "command");
    }
    return super.execute(command);
  }
}

class DeferredCreateGateway extends FakePaseoGateway {
  private resolvePending:
    | ((value: import("../contracts/commands.js").CommandResult) => void)
    | undefined;
  private rejectPending: ((error: Error) => void) | undefined;

  override async execute(command: import("../contracts/commands.js").AgentCommand) {
    if (command.type !== "create-agent") return super.execute(command);
    this.commands.push(command);
    return new Promise<import("../contracts/commands.js").CommandResult>((resolve, reject) => {
      this.resolvePending = resolve;
      this.rejectPending = reject;
    });
  }

  rejectCreate(error: Error): void {
    this.rejectPending?.(error);
  }

  resolveCreate(agentId: string): void {
    this.resolvePending?.({ type: "agent-created", agentId });
  }
}

async function chooseCreation(
  app: ApplicationController,
  workspaceId: string,
  prompt: string,
): Promise<void> {
  await app.handleIntent({ type: "open-create-agent", workspaceId, step: "provider" });
  await app.handleIntent({ type: "create-choice", choice: "codex" });
  await app.handleIntent({ type: "create-choice", choice: "gpt-5.6" });
  await app.handleIntent({ type: "create-choice", choice: "default" });
  await app.handleIntent({ type: "create-choice", choice: "medium" });
  await app.handleIntent({ type: "create-choice", choice: prompt });
  await app.handleIntent({ type: "create-choice", choice: "__confirm__" });
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

class RecoveryStageGateway extends FakePaseoGateway {
  failSnapshot = false;
  failFocus = false;

  override async getDirectorySnapshot(): Promise<DirectorySnapshot> {
    if (this.failSnapshot) throw new Error("directory temporarily unavailable");
    return super.getDirectorySnapshot();
  }

  override async focusAgent(
    agentId: string,
    listener: Parameters<FakePaseoGateway["focusAgent"]>[1],
  ): Promise<Observation> {
    if (this.failFocus) throw new Error("timeline temporarily unavailable");
    return super.focusAgent(agentId, listener);
  }
}

class DeferredRecoveryGateway extends FakePaseoGateway {
  deferSnapshots = false;
  private readonly pending: Array<(snapshot: DirectorySnapshot) => void> = [];

  override async getDirectorySnapshot(): Promise<DirectorySnapshot> {
    if (!this.deferSnapshots) return super.getDirectorySnapshot();
    return new Promise((resolve) => this.pending.push(resolve));
  }

  resolveSnapshot(index: number): void {
    const resolve = this.pending[index];
    if (!resolve) throw new Error(`missing snapshot ${index}`);
    void this.snapshotForTest().then(resolve);
  }

  private async snapshotForTest(): Promise<DirectorySnapshot> {
    return super.getDirectorySnapshot();
  }
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
