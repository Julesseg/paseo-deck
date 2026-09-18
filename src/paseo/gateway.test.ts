import { describe, expect, it, vi } from "vitest";
import { ProductionPaseoGateway } from "./gateway.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function testClient(
  options: {
    onTimeline?: (listener: (message: Record<string, unknown>) => void) => void;
    page?: Promise<Record<string, unknown>>;
  } = {},
) {
  const release = vi.fn();
  let timelineListener: ((message: Record<string, unknown>) => void) | undefined;
  const timeline = {
    subscribe: vi.fn((listener: (message: Record<string, unknown>) => void) => {
      timelineListener = listener;
      options.onTimeline?.(listener);
      return Object.assign(() => release(), {
        ready: Promise.resolve(),
        release: async () => release(),
      });
    }),
    refetch: vi.fn(async () => options.page ?? { epoch: "epoch-1", entries: [], endCursor: null }),
  };
  const agent = {
    send: vi.fn(),
    respondToPermission: vi.fn(),
    archive: vi.fn(),
    detach: vi.fn(),
    timeline,
  };
  const create = vi.fn(async () => ({ id: "new-agent" }));
  let agentDirectoryListener: ((message: Record<string, unknown>) => void) | undefined;
  let workspaceDirectoryListener: ((message: Record<string, unknown>) => void) | undefined;
  return {
    client: {
      connect: vi.fn(),
      close: vi.fn(),
      projects: {
        list: vi.fn(async () => ({
          projects: [{ projectKey: "project-1", projectName: "Project" }],
        })),
        subscribe: vi.fn(() => () => undefined),
      },
      workspaces: {
        list: vi.fn(async () => ({
          entries: [{ id: "workspace-1", workspaceDirectory: "/repo", name: "Main" }],
        })),
        subscribe: vi.fn((listener) => {
          workspaceDirectoryListener = listener;
          return () => undefined;
        }),
        ref: vi.fn(() => ({ agents: { create } })),
      },
      agents: {
        list: vi.fn(async () => ({
          subscriptionId: "agents-observation",
          entries: [
            {
              agent: {
                id: "agent-1",
                workspaceId: "workspace-1",
                title: "Agent",
                status: "idle",
                availableModes: [],
                pendingPermissions: [],
              },
            },
          ],
        })),
        subscribe: vi.fn((listener) => {
          agentDirectoryListener = listener;
          return () => undefined;
        }),
        ref: vi.fn(() => agent),
      },
      providers: {
        waitForReady: vi.fn(async () => ({
          entries: [{ provider: "codex", label: "Codex", status: "ready", enabled: true }],
        })),
        listModels: vi.fn(async () => ({
          models: [
            {
              id: "gpt-5",
              label: "GPT-5",
              isSelectable: true,
              isDefault: true,
              thinkingOptions: [{ id: "high" }],
            },
          ],
        })),
        listModes: vi.fn(async () => ({ modes: [{ id: "full-access" }] })),
        subscribe: vi.fn(() => () => undefined),
      },
    },
    agent,
    create,
    timeline,
    release,
    emitAgentDirectory: (message: Record<string, unknown>) => agentDirectoryListener?.(message),
    emitWorkspaceDirectory: (message: Record<string, unknown>) =>
      workspaceDirectoryListener?.(message),
    emitTimeline: (message: Record<string, unknown>) => timelineListener?.(message),
  };
}

describe("ProductionPaseoGateway", () => {
  it("cleans up a failed connection so a later connection can retry", async () => {
    const failing = testClient();
    const succeeding = testClient();
    failing.client.connect.mockRejectedValueOnce(new Error("offline"));
    const createClient = vi
      .fn()
      .mockReturnValueOnce(failing.client)
      .mockReturnValueOnce(succeeding.client);
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: createClient as never,
    });
    await expect(gateway.connect()).rejects.toThrow("offline");
    await expect(gateway.connect()).resolves.toBeUndefined();
    expect(failing.client.close).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("normalizes an initial snapshot from the SDK", async () => {
    const fixture = testClient();
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    await expect(gateway.getDirectorySnapshot()).resolves.toMatchObject({
      projects: [{ id: "project-1" }],
      workspaces: [{ id: "workspace-1", directory: "/repo" }],
      agents: [{ id: "agent-1" }],
      providers: [
        {
          id: "codex",
          models: [{ id: "gpt-5", thinkingLevels: ["high"] }],
          modeIds: ["full-access"],
        },
      ],
    });
    expect(fixture.client.providers.listModels).toHaveBeenCalledWith("codex");
    expect(fixture.client.providers.listModes).toHaveBeenCalledWith("codex");
  });

  it("keeps remote workspace IDs while exposing only readable remote projects", async () => {
    const fixture = testClient();
    fixture.client.projects.list.mockResolvedValueOnce({
      projects: [
        {
          projectKey: "remote:github.com/acme/paseo-deck",
          projectName: "remote:github.com/acme/paseo-deck",
        },
        { projectKey: "remote:unknown" },
        {},
        { projectKey: "", projectName: "" },
      ],
    } as never);
    fixture.client.workspaces.list.mockResolvedValueOnce({
      entries: [
        {
          id: "workspace-remote",
          projectId: "remote:github.com/acme/paseo-deck",
          workspaceDirectory: "/tmp/paseo-deck",
        },
        {
          id: "workspace-orphan",
          projectId: "remote:unknown",
          workspaceDirectory: "/tmp/orphan",
        },
      ],
    } as never);
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });

    await gateway.connect();
    await expect(gateway.getDirectorySnapshot()).resolves.toMatchObject({
      projects: [{ id: "remote:github.com/acme/paseo-deck", name: "acme/paseo-deck" }],
      workspaces: [
        { id: "workspace-remote", projectId: "remote:github.com/acme/paseo-deck" },
        { id: "workspace-orphan", projectId: "remote:unknown" },
      ],
    });
  });

  it("attaches and releases stable SDK local directory listeners after establishing server demand", async () => {
    const fixture = testClient();
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    const updates: unknown[] = [];
    const observation = await gateway.observeDirectory((update) => updates.push(update));
    fixture.emitAgentDirectory({
      type: "agent_update",
      payload: {
        kind: "upsert",
        agent: {
          id: "agent-2",
          workspaceId: "workspace-1",
          title: "Second",
          status: "running",
          availableModes: [],
          pendingPermissions: [],
        },
      },
    });
    fixture.emitWorkspaceDirectory({
      type: "workspace_update",
      payload: { kind: "remove", workspaceId: "workspace-1" },
    });
    expect(fixture.client.agents.list).toHaveBeenCalledWith({ subscribe: {} });
    expect(fixture.client.workspaces.list).toHaveBeenCalledWith({ subscribe: {} });
    expect(fixture.client.agents.subscribe).toHaveBeenCalledOnce();
    expect(fixture.client.workspaces.subscribe).toHaveBeenCalledOnce();
    expect(updates).toEqual([
      expect.objectContaining({
        type: "agent-upserted",
        agent: expect.objectContaining({ id: "agent-2" }),
      }),
      { type: "workspace-removed", workspaceId: "workspace-1" },
    ]);
    await observation.release();
  });

  it("buffers live events that arrive while history hydrates and de-duplicates history", async () => {
    const page = deferred<Record<string, unknown>>();
    const fixture = testClient({
      page: page.promise,
      onTimeline: (listener) =>
        listener({
          epoch: "epoch-1",
          seq: 2,
          event: {
            type: "timeline",
            item: { type: "assistant_message", messageId: "m1", text: "there" },
          },
        }),
    });
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    const seen: unknown[] = [];
    const focusing = gateway.focusAgent("agent-1", (update) => seen.push(update));
    page.resolve({
      epoch: "epoch-1",
      entries: [
        {
          seqStart: 1,
          seqEnd: 1,
          item: { type: "assistant_message", messageId: "m1", text: "hi" },
        },
        {
          seqStart: 2,
          seqEnd: 2,
          item: { type: "assistant_message", messageId: "m1", text: "there" },
        },
      ],
      endCursor: { epoch: "epoch-1", seq: 2 },
    });
    await focusing;
    expect(seen).toEqual([
      {
        type: "hydrated",
        agentId: "agent-1",
        cursor: { epoch: "epoch-1", sequence: 2 },
        items: expect.arrayContaining([
          expect.objectContaining({ sequence: 1 }),
          expect.objectContaining({ sequence: 2 }),
        ]),
      },
    ]);
  });

  it("recovers after the newest buffered cursor instead of replaying it on restoration", async () => {
    const fixture = testClient();
    fixture.timeline.refetch
      .mockResolvedValueOnce({
        epoch: "epoch-1",
        entries: [{ seqStart: 1, seqEnd: 1, item: { type: "user_message", text: "one" } }],
        endCursor: { epoch: "epoch-1", seq: 1 },
      })
      .mockResolvedValueOnce({
        epoch: "epoch-1",
        entries: [],
        endCursor: { epoch: "epoch-1", seq: 2 },
      });
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    const opening = gateway.focusAgent("agent-1", () => undefined);
    await vi.waitFor(() => expect(fixture.timeline.subscribe).toHaveBeenCalledOnce());
    fixture.emitTimeline({
      epoch: "epoch-1",
      seq: 2,
      event: {
        type: "timeline",
        item: { type: "assistant_message", messageId: "m1", text: "two" },
      },
    });
    await opening;
    fixture.emitTimeline({ event: { type: "subscription_restored" } });
    await vi.waitFor(() => expect(fixture.timeline.refetch).toHaveBeenCalledTimes(2));
    expect(fixture.timeline.refetch).toHaveBeenLastCalledWith({
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 2 },
      projection: "projected",
    });
  });

  it("orders cursorless turn events without colliding with timeline cursors", async () => {
    const fixture = testClient();
    fixture.timeline.refetch
      .mockResolvedValueOnce({
        epoch: "epoch-1",
        entries: [{ seqStart: 1, seqEnd: 1, item: { type: "user_message", text: "one" } }],
        endCursor: { epoch: "epoch-1", seq: 1 },
      })
      .mockResolvedValueOnce({ epoch: "epoch-1", entries: [], endCursor: null });
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    const updates: Array<Record<string, unknown>> = [];
    await gateway.focusAgent("agent-1", (update) => updates.push(update as never));

    fixture.emitTimeline({
      epoch: "epoch-1",
      seq: 2,
      event: {
        type: "timeline",
        item: { type: "assistant_message", messageId: "m1", text: "two" },
      },
    });
    fixture.emitTimeline({ event: { type: "turn_completed", turnId: "turn-1" } });

    const delivered = updates.filter((update) => update.type === "event") as Array<{
      event: { sequence: number; item: { type: string } };
    }>;
    expect(delivered).toHaveLength(2);
    expect(delivered[0]?.event.sequence).toBe(2);
    expect(delivered[1]?.event.item.type).toBe("turn");
    expect(delivered[1]?.event.sequence).toBeGreaterThan(2);

    fixture.emitTimeline({ event: { type: "subscription_restored" } });
    await vi.waitFor(() => expect(fixture.timeline.refetch).toHaveBeenCalledTimes(2));
    expect(fixture.timeline.refetch).toHaveBeenLastCalledWith({
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 2 },
      projection: "projected",
    });
  });

  it("does not deliver late hydration after closing the focused observation", async () => {
    const page = deferred<Record<string, unknown>>();
    const fixture = testClient({ page: page.promise });
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    const updates: unknown[] = [];
    const opening = gateway.focusAgent("agent-1", (update) => updates.push(update));
    await gateway.close();
    page.resolve({ epoch: "epoch-1", entries: [], endCursor: null });
    await opening;
    expect(updates).toEqual([]);
  });

  it("replaces history before delivering buffered new-epoch events", async () => {
    const replacement = deferred<Record<string, unknown>>();
    const fixture = testClient();
    fixture.timeline.refetch
      .mockResolvedValueOnce({ epoch: "epoch-1", entries: [], endCursor: null })
      .mockImplementationOnce(async () => replacement.promise);
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    const updates: unknown[] = [];
    await gateway.focusAgent("agent-1", (update) => updates.push(update));
    fixture.emitTimeline({ event: { type: "replacement", epoch: "epoch-2" } });
    fixture.emitTimeline({
      epoch: "epoch-2",
      seq: 3,
      event: {
        type: "timeline",
        item: { type: "assistant_message", messageId: "m2", text: "live" },
      },
    });
    replacement.resolve({
      epoch: "epoch-2",
      entries: [{ seqStart: 2, seqEnd: 2, item: { type: "user_message", text: "history" } }],
      endCursor: { epoch: "epoch-2", seq: 2 },
    });
    await vi.waitFor(() => expect(updates).toHaveLength(3));
    expect(updates[1]).toMatchObject({ type: "replaced", epoch: "epoch-2" });
    expect(updates[2]).toMatchObject({ type: "event", event: { sequence: 3 } });
    fixture.emitTimeline({
      epoch: "epoch-2",
      seq: 4,
      event: {
        type: "timeline",
        item: { type: "assistant_message", messageId: "m2", text: "after" },
      },
    });
    await vi.waitFor(() => expect(updates).toHaveLength(4));
    expect(updates[3]).toMatchObject({ type: "event", event: { sequence: 4 } });
  });

  it("keeps directory data when one provider discovery request fails", async () => {
    const fixture = testClient();
    fixture.client.providers.listModels.mockRejectedValueOnce(new Error("provider unavailable"));
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    await expect(gateway.getDirectorySnapshot()).resolves.toMatchObject({
      projects: [{ id: "project-1" }],
      agents: [{ id: "agent-1" }],
      providers: [{ id: "codex", ready: false, models: [], modeIds: [] }],
    });
  });

  it("attaches the local agent listener before awaiting its server demand", async () => {
    const demand = deferred<Record<string, unknown>>();
    const fixture = testClient();
    fixture.client.agents.list.mockImplementationOnce(() => demand.promise as never);
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    const updates: unknown[] = [];
    const observing = gateway.observeDirectory((update) => updates.push(update));
    await vi.waitFor(() => expect(fixture.client.agents.subscribe).toHaveBeenCalledOnce());
    fixture.emitAgentDirectory({
      kind: "upsert",
      agent: {
        id: "agent-live",
        workspaceId: "workspace-1",
        title: "Live",
        status: "running",
        availableModes: [],
        pendingPermissions: [],
      },
    });
    demand.resolve({ entries: [] });
    await observing;
    expect(updates).toContainEqual(
      expect.objectContaining({
        type: "agent-upserted",
        agent: expect.objectContaining({ id: "agent-live" }),
      }),
    );
  });

  it("releases a prior focused timeline before focusing another agent", async () => {
    const fixture = testClient();
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    await gateway.focusAgent("agent-1", () => undefined);
    await gateway.focusAgent("agent-2", () => undefined);
    expect(fixture.release).toHaveBeenCalled();
  });

  it("uses SDK commands where supported and exact JSON CLI fallbacks where absent", async () => {
    const fixture = testClient();
    const runner = vi.fn(async () => ({ stdout: '{"ok":true}', stderr: "", exitCode: 0 }));
    const gateway = new ProductionPaseoGateway({
      host: "tcp://host.test:6767",
      cliRunner: runner,
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    await gateway.execute({
      type: "respond-permission",
      agentId: "agent-1",
      requestId: "permission-1",
      allow: false,
    });
    await gateway.execute({
      type: "create-agent",
      workspaceId: "workspace-1",
      providerId: "codex",
      modelId: "gpt",
      prompt: "hello",
    });
    await gateway.execute({ type: "stop-agent", agentId: "agent-1" });
    await gateway.execute({ type: "rename-agent", agentId: "agent-1", name: "Renamed" });
    expect(fixture.agent.respondToPermission).toHaveBeenCalledWith({
      requestId: "permission-1",
      response: { behavior: "deny" },
    });
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({ config: { provider: "codex/gpt" } }),
    );
    expect(runner).toHaveBeenNthCalledWith(1, [
      "--json",
      "--host",
      "tcp://host.test:6767",
      "stop",
      "agent-1",
    ]);
    expect(runner).toHaveBeenNthCalledWith(2, [
      "--json",
      "--host",
      "tcp://host.test:6767",
      "agent",
      "update",
      "agent-1",
      "--name",
      "Renamed",
    ]);
  });
});
