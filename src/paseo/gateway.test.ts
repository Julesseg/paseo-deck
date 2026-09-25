import { describe, expect, it, vi } from "vitest";
import type { PaseoGatewayError } from "./errors.js";
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
  const getConfig = vi.fn(async () => ({
    requestId: "config",
    config: {
      terminalProfiles: [{ id: "build", name: "Build", command: "npm", args: ["run", "build"] }],
    },
  }));
  let agentDirectoryListener: ((message: Record<string, unknown>) => void) | undefined;
  let workspaceDirectoryListener: ((message: Record<string, unknown>) => void) | undefined;
  return {
    client: {
      connect: vi.fn(),
      close: vi.fn(),
      config: { get: getConfig },
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
    getConfig,
    timeline,
    release,
    emitAgentDirectory: (message: Record<string, unknown>) => agentDirectoryListener?.(message),
    emitWorkspaceDirectory: (message: Record<string, unknown>) =>
      workspaceDirectoryListener?.(message),
    emitTimeline: (message: Record<string, unknown>) => timelineListener?.(message),
  };
}

describe("ProductionPaseoGateway", () => {
  it("reads configured profiles, daemon defaults, and an explicitly empty profile list", async () => {
    const fixture = testClient();
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    expect(await gateway.listTerminalProfiles()).toEqual([
      { id: "build", name: "Build", command: "npm", args: ["run", "build"] },
    ]);
    fixture.getConfig.mockResolvedValueOnce({ requestId: "config", config: {} as never });
    expect((await gateway.listTerminalProfiles()).map((profile) => profile.id)).toEqual([
      "claude",
      "codex",
      "opencode",
      "pi",
    ]);
    fixture.getConfig.mockResolvedValueOnce({
      requestId: "config",
      config: { terminalProfiles: [] },
    });
    expect(await gateway.listTerminalProfiles()).toEqual([]);
    expect(fixture.getConfig).toHaveBeenCalledTimes(3);
    await gateway.close();
  });
  it("connects and closes the stable SDK surface without private connection hooks", async () => {
    const fixture = testClient();
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    await gateway.close();
    expect(fixture.client.connect).toHaveBeenCalledOnce();
    expect(fixture.client.close).toHaveBeenCalledOnce();
  });

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

  it("maps SDK failures to safe closed gateway failures", async () => {
    const fixture = testClient();
    fixture.client.projects.list.mockRejectedValueOnce(new Error("ECONNREFUSED password=hunter2"));
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    await expect(gateway.getDirectorySnapshot()).rejects.toMatchObject({
      kind: "authentication",
      detail: expect.not.stringContaining("hunter2"),
    } satisfies Partial<PaseoGatewayError>);
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

  it("uses the live projectId field to join projects with their workspaces", async () => {
    const fixture = testClient();
    fixture.client.projects.list.mockResolvedValueOnce({
      projects: [{ projectId: "live-project", name: "Live project" }],
    } as never);
    fixture.client.workspaces.list.mockResolvedValueOnce({
      entries: [
        {
          id: "workspace-1",
          projectId: "live-project",
          workspaceDirectory: "/repo",
        },
      ],
    } as never);
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });

    await gateway.connect();
    await expect(gateway.getDirectorySnapshot()).resolves.toMatchObject({
      projects: [{ id: "live-project", name: "Live project" }],
      workspaces: [{ id: "workspace-1", projectId: "live-project" }],
    });
  });

  it("projects the SDK updatedAt activity timestamp without manufacturing one", async () => {
    const fixture = testClient();
    fixture.client.agents.list.mockResolvedValueOnce({
      entries: [
        {
          agent: {
            id: "agent-1",
            workspaceId: "workspace-1",
            title: "Agent",
            status: "idle",
            updatedAt: "2026-09-18T12:34:56.000Z",
            availableModes: [],
            pendingPermissions: [],
          },
        },
        {
          agent: {
            id: "agent-2",
            workspaceId: "workspace-1",
            title: "No timestamp",
            status: "idle",
            availableModes: [],
            pendingPermissions: [],
          },
        },
      ],
    } as never);
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });

    await gateway.connect();
    const directory = await gateway.getDirectorySnapshot();

    expect(directory.agents).toMatchObject([
      { id: "agent-1", lastActivityAt: "2026-09-18T12:34:56.000Z" },
      { id: "agent-2" },
    ]);
    expect(directory.agents[1]).not.toHaveProperty("lastActivityAt");
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

  it("projects permission requests through a narrow display-safe boundary", async () => {
    const fixture = testClient();
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    const seen: unknown[] = [];
    await gateway.focusAgent("agent-1", (update) => seen.push(update));

    fixture.emitTimeline({
      epoch: "epoch-1",
      seq: 2,
      event: {
        type: "permission_requested",
        request: {
          id: "permission-token=secret-request-id",
          title: "Run Bearer secret-title",
          operation: "shell --token secret-operation",
          name: "name?apiKey=secret-name",
          provider: "Bearer secret-provider",
          kind: "kind password=secret-kind",
          cwd: "/safe/workspace?token=secret-cwd",
          arguments: {
            command:
              "curl -H 'Authorization: Bearer secret-header' https://user:secret-url@example.test/?token=secret-query",
            token: "never-project-this",
            metadata: { token: "nested-secret" },
          },
          description: 'payload {"apiKey":"secret-json"} password=secret-inline',
          detail: {
            type: "shell authorization secret-detail",
            filePath: "/tmp?token=secret-path",
            shell: { command: "echo --secret secret-command" },
          },
          actions: [
            {
              id: "action-token=secret-action-id",
              label: "Bearer secret-action-label",
              behavior: "password=secret-action-behavior",
            },
          ],
          raw: { input: "private prompt", metadata: { token: "secret" } },
          input: "private input",
          content: "private content",
          log: "private log",
          token: "private token",
        },
      },
    });

    expect(seen).toContainEqual({
      type: "event",
      agentId: "agent-1",
      event: expect.objectContaining({
        item: expect.objectContaining({
          type: "permission",
          request: expect.objectContaining({
            id: "permission-token=secret-request-id",
            operation: "shell --token [redacted]",
            workingDirectory: "/safe/workspace?token=[redacted]",
            arguments: [
              "command: curl -H 'Authorization: Bearer [redacted]' https://[redacted]@example.test/?token=[redacted]",
            ],
          }),
        }),
      }),
    });
    const projectedRequest = (
      seen.at(-1) as {
        event: { item: { request: { id: string; actions?: readonly { id: string }[] } } };
      }
    ).event.item.request;
    expect(projectedRequest.id).toBe("permission-token=secret-request-id");
    expect(projectedRequest.actions?.[0]?.id).toBe("action-token=secret-action-id");
    await gateway.execute({
      type: "respond-permission",
      agentId: "agent-1",
      requestId: projectedRequest.id,
      allow: true,
    });
    expect(fixture.agent.respondToPermission).toHaveBeenCalledWith({
      requestId: "permission-token=secret-request-id",
      response: { behavior: "allow" },
    });
    const serialized = JSON.stringify({ ...projectedRequest, id: undefined, actions: undefined });
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private input");
    expect(serialized).not.toContain("private content");
    expect(serialized).not.toContain("private log");
    expect(serialized).not.toContain("private token");
    expect(serialized).not.toContain("never-project-this");
    expect(serialized).not.toContain("secret-header");
    expect(serialized).not.toContain("secret-url");
    expect(serialized).not.toContain("secret-query");
    expect(serialized).not.toContain("secret-json");
    expect(serialized).not.toContain("secret-inline");
    expect(serialized).not.toContain("secret-title");
    expect(serialized).not.toContain("secret-operation");
    expect(serialized).not.toContain("secret-name");
    expect(serialized).not.toContain("secret-provider");
    expect(serialized).not.toContain("secret-kind");
    expect(serialized).not.toContain("secret-cwd");
    expect(serialized).not.toContain("secret-detail");
    expect(serialized).not.toContain("secret-path");
    expect(serialized).not.toContain("secret-command");
    expect(serialized).not.toContain("secret-action-label");
    expect(serialized).not.toContain("secret-action-behavior");
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
  });

  it("projects only source-provided timeline timing, tool failure, and streaming fields", async () => {
    const fixture = testClient();
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();
    const updates: Array<Record<string, unknown>> = [];
    await gateway.focusAgent("agent-1", (update) => updates.push(update as never));

    fixture.emitTimeline({
      epoch: "epoch-1",
      seq: 1,
      timestamp: "2026-09-18T10:00:00Z",
      event: {
        type: "timeline",
        item: {
          type: "assistant_message",
          messageId: "m1",
          text: "partial",
          turnId: "turn-1",
          streaming: true,
        },
      },
    });
    fixture.emitTimeline({
      epoch: "epoch-1",
      seq: 2,
      timestamp: "2026-09-18T10:00:01Z",
      event: {
        type: "timeline",
        item: {
          type: "tool_call",
          callId: "call-1",
          name: "git",
          status: "failed",
          error: "permission denied",
          detail: { type: "fetch", url: "https://example.test", result: "bad", durationMs: 1200 },
        },
      },
    });
    fixture.emitTimeline({
      event: {
        type: "turn_completed",
        turnId: "turn-1",
      },
      timestamp: "2026-09-18T10:00:03Z",
    });

    const items = updates
      .filter((update) => update.type === "event")
      .map((update) => (update.event as { item: unknown }).item);
    expect(items).toContainEqual(
      expect.objectContaining({
        type: "assistant-message",
        timestamp: "2026-09-18T10:00:00Z",
        turnId: "turn-1",
        streaming: true,
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        type: "tool",
        durationMs: 1200,
        failureSummary: "permission denied",
        detail: expect.objectContaining({ kind: "fetch", url: "https://example.test" }),
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({ type: "turn", completedAt: "2026-09-18T10:00:03Z" }),
    );
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

  it("uses documented discovery errors and default thinking metadata without projecting model internals", async () => {
    const fixture = testClient();
    fixture.client.providers.listModels.mockResolvedValueOnce({
      models: [
        {
          id: "blocked",
          label: "Blocked",
          isSelectable: false,
          reason: "internal daemon detail",
        },
        {
          id: "gpt-5",
          label: "GPT-5",
          isSelectable: true,
          defaultThinkingOptionId: "high",
          thinkingOptions: [{ id: "low" }, { id: "high" }],
        },
      ],
    } as never);
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();

    const directory = await gateway.getDirectorySnapshot();
    expect(directory.providers[0]?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "blocked",
          selectable: false,
          unavailableReason: "not selectable",
        }),
        expect.objectContaining({ id: "gpt-5", defaultThinkingLevel: "high" }),
      ]),
    );
    expect(JSON.stringify(directory)).not.toContain("internal daemon detail");
  });

  it("projects a resolved provider-list error as an unavailable provider", async () => {
    const fixture = testClient();
    fixture.client.providers.listModels.mockResolvedValueOnce({
      error: "models unavailable",
    } as never);
    const gateway = new ProductionPaseoGateway({
      host: "127.0.0.1:6767",
      createClient: () => fixture.client as never,
    });
    await gateway.connect();

    await expect(gateway.getDirectorySnapshot()).resolves.toMatchObject({
      providers: [
        {
          id: "codex",
          ready: false,
          unavailableReason: "models unavailable",
          models: [],
          modeIds: [],
        },
      ],
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
