import { createPaseoClient } from "@getpaseo/client";
import type { AgentCommand, CommandResult } from "../contracts/commands.js";
import type {
  AgentRecord,
  DirectorySnapshot,
  DirectoryUpdate,
  PermissionRequest,
  ProjectRecord,
  ProviderOption,
  TimelineCursor,
  TimelineEvent,
  TimelineItem,
  TimelineUpdate,
  UsageSummary,
  WorkspaceRecord,
} from "../contracts/domain.js";
import type { Observation, PaseoGateway } from "../contracts/gateway.js";
import { type CliRunner, createCliRunner, runJson } from "./cli.js";
import { PaseoGatewayError } from "./errors.js";
import { type PaseoTarget, type PaseoTargetInput, targetFromDaemonStatus } from "./target.js";

type UnknownRecord = Record<string, unknown>;
type Listener<T> = (value: T) => void;

interface Releasable {
  release?: () => Promise<void> | void;
}

interface DirectorySubscription extends Releasable {
  subscribe: (handlers: {
    snapshot: Listener<UnknownRecord>;
    update: Listener<UnknownRecord>;
    error?: Listener<unknown>;
  }) => void;
}

interface TimelineSubscription extends Releasable {
  (): void;
  ready: Promise<void>;
}

interface ClientSurface {
  connect(): Promise<void>;
  close(): Promise<void>;
  projects: {
    list(): Promise<UnknownRecord>;
    subscribe(listener: Listener<UnknownRecord>): () => void;
  };
  workspaces: {
    list(options?: UnknownRecord): Promise<UnknownRecord>;
    subscribe(listener: Listener<UnknownRecord>): () => void;
    ref(id: string): { agents: { create(options: UnknownRecord): Promise<{ id: string }> } };
  };
  agents: {
    list(options?: UnknownRecord): Promise<UnknownRecord>;
    subscribe(listener: Listener<UnknownRecord>): () => void;
    ref(id: string): {
      send(text: string): Promise<void>;
      respondToPermission(options: UnknownRecord): Promise<void>;
      archive(): Promise<unknown>;
      detach(): Promise<void>;
      timeline: {
        subscribe(listener: Listener<UnknownRecord>): TimelineSubscription;
        refetch(options?: UnknownRecord): Promise<UnknownRecord>;
      };
    };
  };
  providers: {
    waitForReady(): Promise<UnknownRecord>;
    listModels(provider: string, options?: UnknownRecord): Promise<UnknownRecord>;
    listModes(provider: string, options?: UnknownRecord): Promise<UnknownRecord>;
    subscribe(listener: Listener<UnknownRecord>): () => void;
  };
}

export interface PaseoGatewayOptions extends PaseoTargetInput {
  cliRunner?: CliRunner;
  createClient?: (target: PaseoTarget) => ClientSurface;
}

export class ProductionPaseoGateway implements PaseoGateway {
  private readonly cliRunner: CliRunner;
  private readonly createClient: (target: PaseoTarget) => ClientSurface;
  private client: ClientSurface | undefined;
  private target: PaseoTarget | undefined;
  private focused: Observation | undefined;
  private focusGeneration = 0;

  public constructor(private readonly options: PaseoGatewayOptions = {}) {
    this.cliRunner = options.cliRunner ?? createCliRunner();
    this.createClient =
      options.createClient ??
      ((target) =>
        createPaseoClient({
          url: target.websocketUrl,
          ...(target.password === undefined ? {} : { password: target.password }),
          reconnect: { enabled: true },
          // SDK background task failures otherwise write directly to stderr
          // after the alternate screen has been restored. Request failures and
          // owned observation errors are surfaced through the gateway instead.
          logger: quietPaseoLogger,
        }) as unknown as ClientSurface);
  }

  public async connect(): Promise<void> {
    if (this.client !== undefined) return;
    const password = this.options.password ?? process.env.PASEO_PASSWORD;
    const status = this.options.host === undefined ? await this.daemonStatus() : {};
    const targetInput = {
      ...(this.options.home === undefined ? {} : { home: this.options.home }),
      ...(this.options.host === undefined ? {} : { host: this.options.host }),
      ...(password === undefined ? {} : { password }),
    };
    this.target = targetFromDaemonStatus(targetInput, status);
    this.client = this.createClient(this.target);
    try {
      await this.client.connect();
    } catch (error) {
      try {
        await this.client.close();
      } catch {
        // Keep the original connection error; cleanup is best-effort here.
      }
      this.client = undefined;
      this.target = undefined;
      throw error;
    }
  }

  public async close(): Promise<void> {
    this.focusGeneration += 1;
    await this.focused?.release();
    this.focused = undefined;
    if (this.client !== undefined) await this.client.close();
    this.client = undefined;
  }

  public async getDirectorySnapshot(): Promise<DirectorySnapshot> {
    const client = this.requireClient();
    const [projects, workspaces, agents, providers] = await Promise.all([
      client.projects.list(),
      client.workspaces.list(),
      client.agents.list(),
      client.providers.waitForReady(),
    ]);
    return directorySnapshot(client, projects, workspaces, agents, providers);
  }

  public async observeDirectory(listener: Listener<DirectoryUpdate>): Promise<Observation> {
    const client = this.requireClient();
    const releases: Array<() => Promise<void> | void> = [];
    // Stable 0.8.0 exposes the server-issued subscriptionId but no public release
    // handle. Local listeners below are released here; server demand ends on close().
    releases.push(client.agents.subscribe((message) => emitDirectoryMessage(message, listener)));
    let agentDirectory: UnknownRecord;
    try {
      agentDirectory = await client.agents.list({ subscribe: {} });
      releases.push(
        client.workspaces.subscribe((message) => emitDirectoryMessage(message, listener)),
      );
    } catch (error) {
      await releaseAll(releases);
      throw error;
    }
    let workspaceDirectory: UnknownRecord;
    try {
      workspaceDirectory = await client.workspaces.list({ subscribe: {} });
    } catch (error) {
      await releaseAll(releases);
      throw error;
    }
    const agentSubscription = getSubscription(agentDirectory);
    const workspaceSubscription = getSubscription(workspaceDirectory);
    if (agentSubscription !== undefined) {
      agentSubscription.subscribe({
        snapshot: (snapshot) => {
          for (const entry of recordEntries(snapshot)) {
            listener({
              type: "agent-upserted",
              agent: agentRecord(asRecord(entry.agent) ?? entry),
            });
          }
        },
        update: (message) => emitDirectoryMessage(message, listener),
        error: (error) => listener(directoryError(error)),
      });
      releases.push(() => releaseDirectorySubscription(agentSubscription));
    }
    if (workspaceSubscription !== undefined) {
      workspaceSubscription.subscribe({
        snapshot: (snapshot) => {
          for (const entry of recordEntries(snapshot))
            listener({ type: "workspace-upserted", workspace: workspaceRecord(entry) });
        },
        update: (message) => emitDirectoryMessage(message, listener),
        error: (error) => listener(directoryError(error)),
      });
      releases.push(() => releaseDirectorySubscription(workspaceSubscription));
    }
    releases.push(client.projects.subscribe((message) => emitDirectoryMessage(message, listener)));
    releases.push(
      client.providers.subscribe((message) => void emitProviderUpdate(client, message, listener)),
    );
    return observation(releases);
  }

  public async focusAgent(
    agentId: string,
    listener: Listener<TimelineUpdate>,
  ): Promise<Observation> {
    const generation = ++this.focusGeneration;
    await this.focused?.release();
    const agent = this.requireClient().agents.ref(agentId);
    const buffered: TimelineEvent[] = [];
    let hydrating = true;
    let cursor: TimelineCursor | undefined;
    let activeEpoch: string | undefined;
    let syntheticSequence = 0;
    let released = false;
    let timelineRevision = 0;
    let replacementEpoch: string | undefined;
    let replacementBuffer: TimelineEvent[] = [];
    const isCurrent = (): boolean => !released && this.focusGeneration === generation;

    let subscription: TimelineSubscription;
    const focused: Observation = {
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        await releaseSubscription(subscription);
      },
    };

    const receive = (message: UnknownRecord): void => {
      if (!isCurrent()) return;
      const replacement = asRecord(message.event);
      if (replacement?.type === "replacement") {
        const epoch = String(replacement.epoch);
        const revision = ++timelineRevision;
        replacementEpoch = epoch;
        replacementBuffer = [];
        void replaceTimeline(
          epoch,
          listener,
          agentId,
          agent.timeline,
          () => isCurrent() && timelineRevision === revision && replacementEpoch === epoch,
          () => replacementBuffer,
          () => {
            replacementEpoch = undefined;
            replacementBuffer = [];
          },
          (nextCursor, epoch) => {
            cursor = latestCursor(cursor, nextCursor);
            activeEpoch = epoch;
          },
        );
        return;
      }
      if (replacement?.type === "subscription_restored") {
        void restoreTimeline(listener, agentId, agent.timeline, cursor, isCurrent, (nextCursor) => {
          cursor = latestCursor(cursor, nextCursor);
        });
        return;
      }
      if (replacement?.type === "error") {
        const detail = stringValue(replacement.error);
        listener({
          type: "error",
          agentId,
          message: "Timeline observation stopped.",
          ...(detail === undefined ? {} : { detail }),
        });
        return;
      }
      const stream =
        asRecord(message.event) ?? (asRecord(message.payload)?.event as UnknownRecord | undefined);
      if (stream === undefined) return;
      const epoch = stringValue(message.epoch) ?? activeEpoch ?? "live";
      const wireSequence = numberValue(message.seq);
      const sequence = wireSequence ?? syntheticControlSequence(epoch, cursor, ++syntheticSequence);
      const event = timelineEvent(epoch, sequence, stream, agentId);
      if (event === undefined) return;
      activeEpoch = epoch;
      // Control events such as turn_started and turn_completed intentionally
      // carry no daemon cursor. Give them stable ordering space between real
      // timeline entries without advancing reconnect recovery past the server.
      if (wireSequence !== undefined) cursor = latestCursor(cursor, { epoch, sequence });
      if (stream.type === "usage_updated") {
        listener({ type: "usage", agentId, usage: usageSummary(stream.usage) });
      }
      if (replacementEpoch !== undefined) replacementBuffer.push(event);
      else if (hydrating) buffered.push(event);
      else listener({ type: "event", agentId, event });
    };

    try {
      subscription = agent.timeline.subscribe(receive);
    } catch (error) {
      listener({
        type: "error",
        agentId,
        message: "Could not subscribe to the agent timeline.",
        detail: errorDetail(error),
      });
      return { release: async () => undefined };
    }
    this.focused = focused;
    try {
      await subscription.ready;
      if (!isCurrent()) return focused;
      const hydrationRevision = timelineRevision;
      const page = await agent.timeline.refetch({
        direction: "before",
        limit: 200,
        projection: "projected",
      });
      if (!isCurrent() || timelineRevision !== hydrationRevision) return focused;
      const pageEpoch = stringValue(page.epoch) ?? "history";
      const history = timelineEntries(page, pageEpoch, agentId);
      activeEpoch = pageEpoch;
      cursor = latestCursor(cursor, pageCursor(page));
      hydrating = false;
      listener({
        type: "hydrated",
        agentId,
        items: dedupeTimeline([...history, ...buffered]),
        ...(cursor === undefined ? {} : { cursor }),
      });
      buffered.length = 0;
    } catch (error) {
      if (!isCurrent()) return focused;
      hydrating = false;
      listener({
        type: "error",
        agentId,
        message: "Could not load the agent timeline.",
        detail: errorDetail(error),
      });
    }
    return focused;
  }

  public async execute(command: AgentCommand): Promise<CommandResult> {
    const client = this.requireClient();
    switch (command.type) {
      case "send-prompt":
        await client.agents.ref(command.agentId).send(command.prompt);
        return { type: "ok" };
      case "create-agent": {
        const agent = await client.workspaces.ref(command.workspaceId).agents.create({
          title: command.title,
          prompt: command.prompt,
          config: {
            provider: `${command.providerId}/${command.modelId}`,
            ...(command.modeId === undefined ? {} : { modeId: command.modeId }),
            ...(command.thinkingLevel === undefined
              ? {}
              : { thinkingOptionId: command.thinkingLevel }),
          },
        });
        return { type: "agent-created", agentId: agent.id };
      }
      case "respond-permission":
        await client.agents.ref(command.agentId).respondToPermission({
          requestId: command.requestId,
          response: command.allow ? { behavior: "allow" } : { behavior: "deny" },
        });
        return { type: "permission-resolved", requestId: command.requestId };
      case "archive-agent":
        await client.agents.ref(command.agentId).archive();
        return { type: "ok" };
      case "detach-agent":
        await client.agents.ref(command.agentId).detach();
        return { type: "ok" };
      case "stop-agent":
        await this.runFallback(["stop", command.agentId]);
        return { type: "ok" };
      case "rename-agent":
        await this.runFallback(["agent", "update", command.agentId, "--name", command.name]);
        return { type: "ok" };
      case "set-thinking-level":
        await this.runFallback([
          "agent",
          "update",
          command.agentId,
          "--thinking",
          command.thinkingLevel,
        ]);
        return { type: "ok" };
      case "set-agent-mode":
        await this.runFallback(["agent", "mode", command.agentId, command.modeId]);
        return { type: "ok" };
    }
  }

  private async daemonStatus(): Promise<UnknownRecord> {
    const arguments_ = [
      "daemon",
      "status",
      "--json",
      ...(this.options.home === undefined ? [] : ["--home", this.options.home]),
    ];
    return asRecord(await runJson(this.cliRunner, arguments_)) ?? {};
  }

  private async runFallback(arguments_: readonly string[]): Promise<void> {
    const target = this.target;
    if (target === undefined)
      throw new PaseoGatewayError("Connect before issuing a Paseo command.");
    await runJson(this.cliRunner, ["--json", ...target.cliArguments, ...arguments_]);
  }

  private requireClient(): ClientSurface {
    if (this.client === undefined) throw new PaseoGatewayError("Paseo Deck is not connected.");
    return this.client;
  }
}

function syntheticControlSequence(
  epoch: string,
  cursor: TimelineCursor | undefined,
  ordinal: number,
): number {
  const base = cursor?.epoch === epoch ? cursor.sequence : -1;
  return base + ordinal / 1_000_000;
}

const quietPaseoLogger = {
  debug: (_object: object, _message?: string): void => undefined,
  info: (_object: object, _message?: string): void => undefined,
  warn: (_object: object, _message?: string): void => undefined,
  error: (_object: object, _message?: string): void => undefined,
};

export function createPaseoGateway(options?: PaseoGatewayOptions): ProductionPaseoGateway {
  return new ProductionPaseoGateway(options);
}

function observation(releases: readonly (() => Promise<void> | void)[]): Observation {
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await Promise.all(releases.map(async (release) => release()));
    },
  };
}

async function releaseAll(releases: readonly (() => Promise<void> | void)[]): Promise<void> {
  await Promise.all(releases.map(async (release) => release()));
}

async function releaseSubscription(subscription: Releasable & (() => void)): Promise<void> {
  if (subscription.release !== undefined) await subscription.release();
  else subscription();
}

async function releaseDirectorySubscription(subscription: DirectorySubscription): Promise<void> {
  if (subscription.release !== undefined) await subscription.release();
}

function getSubscription(result: UnknownRecord): DirectorySubscription | undefined {
  const candidate = result.subscription;
  return typeof candidate === "object" && candidate !== null && "subscribe" in candidate
    ? (candidate as DirectorySubscription)
    : undefined;
}

function directoryError(error: unknown): DirectoryUpdate {
  return { type: "connection-changed", state: "reconnecting", detail: errorDetail(error) };
}

function emitDirectoryMessage(message: UnknownRecord, listener: Listener<DirectoryUpdate>): void {
  const payload = asRecord(message.payload) ?? message;
  if (message.type === "agent_update" || "agent" in payload) {
    if (payload.kind === "remove")
      listener({ type: "agent-removed", agentId: String(payload.agentId) });
    else if (asRecord(payload.agent) !== undefined)
      listener({ type: "agent-upserted", agent: agentRecord(asRecord(payload.agent) ?? {}) });
  } else if (message.type === "workspace_update" || "workspace" in payload) {
    if (payload.kind === "remove")
      listener({ type: "workspace-removed", workspaceId: String(payload.workspaceId) });
    else if (asRecord(payload.workspace) !== undefined)
      listener({
        type: "workspace-upserted",
        workspace: workspaceRecord(asRecord(payload.workspace) ?? {}),
      });
  } else if (message.type === "project.update" || "project" in payload) {
    const project = asRecord(payload.project) ?? payload;
    if (payload.kind === "remove")
      listener({ type: "project-removed", projectId: String(payload.projectId) });
    else {
      const normalized = projectRecord(project);
      if (normalized !== undefined) listener({ type: "project-upserted", project: normalized });
    }
  }
}

async function emitProviderUpdate(
  client: ClientSurface,
  message: UnknownRecord,
  listener: Listener<DirectoryUpdate>,
): Promise<void> {
  const payload = asRecord(message.payload) ?? message;
  if (message.type !== "providers_snapshot_update" && !Array.isArray(payload.entries)) return;
  try {
    listener({ type: "providers-replaced", providers: await providerRecords(client, payload) });
  } catch (error) {
    listener({
      type: "connection-changed",
      state: "reconnecting",
      detail: `Could not refresh provider discovery: ${errorDetail(error)}`,
    });
  }
}

async function replaceTimeline(
  epoch: string,
  listener: Listener<TimelineUpdate>,
  agentId: string,
  timeline: ClientSurface["agents"]["ref"] extends (...args: never[]) => infer Agent
    ? Agent extends { timeline: infer T }
      ? T
      : never
    : never,
  isCurrent: () => boolean,
  bufferedEvents: () => readonly TimelineEvent[],
  finishReplacement: () => void,
  setCursor: (cursor: TimelineCursor | undefined, epoch: string) => void,
): Promise<void> {
  try {
    const page = await timeline.refetch({
      direction: "before",
      limit: 200,
      projection: "projected",
    });
    if (!isCurrent()) return;
    const pageEpoch = stringValue(page.epoch) ?? epoch;
    const cursor = pageCursor(page);
    const history = timelineEntries(page, pageEpoch, agentId);
    listener({
      type: "replaced",
      agentId,
      epoch: pageEpoch,
      items: history,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const seen = new Set(history.map(timelineKey));
    const buffered = bufferedEvents().filter((event) => {
      const key = timelineKey(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    for (const event of buffered) {
      if (!isCurrent()) return;
      listener({ type: "event", agentId, event });
    }
    setCursor(latestTimelineCursor(history, buffered) ?? cursor, pageEpoch);
    finishReplacement();
  } catch (error) {
    if (!isCurrent()) return;
    listener({
      type: "error",
      agentId,
      message: "Could not refresh a replaced timeline.",
      detail: errorDetail(error),
    });
  }
}

async function restoreTimeline(
  listener: Listener<TimelineUpdate>,
  agentId: string,
  timeline: ClientSurface["agents"]["ref"] extends (...args: never[]) => infer Agent
    ? Agent extends { timeline: infer T }
      ? T
      : never
    : never,
  cursor: TimelineCursor | undefined,
  isCurrent: () => boolean,
  setCursor: (cursor: TimelineCursor | undefined) => void,
): Promise<void> {
  if (cursor === undefined) return;
  try {
    const page = await timeline.refetch({
      direction: "after",
      cursor: { epoch: cursor.epoch, seq: cursor.sequence },
      projection: "projected",
    });
    if (!isCurrent()) return;
    const epoch = stringValue(page.epoch) ?? cursor.epoch;
    const nextCursor = pageCursor(page) ?? cursor;
    setCursor(nextCursor);
    listener({ type: "restored", agentId, missed: timelineEntries(page, epoch, agentId) });
  } catch (error) {
    listener({
      type: "error",
      agentId,
      message: "Could not recover missed timeline events.",
      detail: errorDetail(error),
    });
  }
}

async function directorySnapshot(
  client: ClientSurface,
  projects: UnknownRecord,
  workspaces: UnknownRecord,
  agents: UnknownRecord,
  providers: UnknownRecord,
): Promise<DirectorySnapshot> {
  return {
    projects: projectEntries(projects)
      .map(projectRecord)
      .filter((project): project is ProjectRecord => project !== undefined),
    workspaces: recordEntries(workspaces).map(workspaceRecord),
    agents: recordEntries(agents).map((entry) => agentRecord(asRecord(entry.agent) ?? entry)),
    providers: await providerRecords(client, providers),
  };
}

function projectRecord(value: UnknownRecord): ProjectRecord | undefined {
  const id = nonBlankString(value.id ?? value.projectKey);
  if (id === undefined) return undefined;
  const sourceName = nonBlankString(value.name ?? value.projectName);
  const remoteName = readableRemoteProjectName(id);
  const name = id.startsWith("remote:")
    ? sourceName?.startsWith("remote:")
      ? remoteName
      : (sourceName ?? remoteName)
    : (sourceName ?? id);
  if (name === undefined) return undefined;
  return {
    id,
    name,
    ...(stringValue(value.path ?? value.directory) === undefined
      ? {}
      : { path: stringValue(value.path ?? value.directory) as string }),
  };
}

function readableRemoteProjectName(id: string): string | undefined {
  if (!id.startsWith("remote:")) return undefined;
  const location = id.slice("remote:".length).replace(/^https?:\/\//, "");
  const match = /^github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(location);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function nonBlankString(value: unknown): string | undefined {
  const result = stringValue(value);
  return result?.trim() ? result : undefined;
}

function workspaceRecord(value: UnknownRecord): WorkspaceRecord {
  const directory = String(value.workspaceDirectory ?? value.directory ?? value.cwd ?? "");
  return {
    id: String(value.id ?? value.workspaceId ?? "unknown-workspace"),
    ...(stringValue(value.projectId) === undefined
      ? {}
      : { projectId: stringValue(value.projectId) as string }),
    title: String((value.name ?? value.title ?? directory) || "Workspace"),
    directory,
    archived:
      value.status === "archived" || (value.archivedAt !== null && value.archivedAt !== undefined),
  };
}

function agentRecord(value: UnknownRecord): AgentRecord {
  const pending = Array.isArray(value.pendingPermissions)
    ? value.pendingPermissions.map((request) =>
        permissionRequest(asRecord(request) ?? {}, String(value.id)),
      )
    : [];
  const modes = Array.isArray(value.availableModes)
    ? value.availableModes.map((mode) => String(asRecord(mode)?.id ?? mode))
    : [];
  const thinking = Array.isArray(value.thinkingOptions)
    ? value.thinkingOptions.map((option) => String(asRecord(option)?.id ?? option))
    : [];
  return {
    id: String(value.id ?? "unknown-agent"),
    workspaceId: String(value.workspaceId ?? ""),
    title: String(value.title ?? value.id ?? "Agent"),
    status: status(value.status),
    ...(stringValue(value.provider) === undefined
      ? {}
      : { providerId: stringValue(value.provider) as string }),
    ...(stringValue(value.model) === undefined
      ? {}
      : { modelId: stringValue(value.model) as string }),
    ...(stringValue(value.thinkingOptionId) === undefined
      ? {}
      : { thinkingLevel: stringValue(value.thinkingOptionId) as string }),
    ...(stringValue(value.currentModeId) === undefined
      ? {}
      : { modeId: stringValue(value.currentModeId) as string }),
    availableModeIds: modes,
    availableThinkingLevels: thinking,
    pendingPermissions: pending,
    needsAttention: value.requiresAttention === true || pending.length > 0,
    archived: value.archivedAt !== null && value.archivedAt !== undefined,
    ...(stringValue(value.updatedAt) === undefined
      ? {}
      : { lastActivityAt: stringValue(value.updatedAt) as string }),
    ...(asRecord(value.lastUsage) === undefined
      ? {}
      : { lastUsage: usageSummary(value.lastUsage) }),
  };
}

async function providerRecords(
  client: ClientSurface,
  value: UnknownRecord,
): Promise<readonly ProviderOption[]> {
  return Promise.all(
    recordEntries(value).map(async (entry) => {
      const provider = String(entry.provider ?? entry.id);
      const ready = entry.status === "ready" && entry.enabled !== false;
      if (!ready)
        return {
          id: provider,
          name: String(entry.label ?? provider),
          ready: false,
          models: [],
          modeIds: [],
        };
      let modelsResponse: UnknownRecord;
      let modesResponse: UnknownRecord;
      try {
        [modelsResponse, modesResponse] = await Promise.all([
          client.providers.listModels(provider),
          client.providers.listModes(provider),
        ]);
      } catch {
        return {
          id: provider,
          name: String(entry.label ?? provider),
          ready: false,
          models: [],
          modeIds: [],
        };
      }
      const modelEntries = arrayRecords(modelsResponse.models);
      const models = modelEntries.map((record) => ({
        id: String(record.id),
        name: String(record.label ?? record.id),
        selectable: record.isSelectable !== false,
        thinkingLevels: Array.isArray(record.thinkingOptions)
          ? record.thinkingOptions.map((option) => String(asRecord(option)?.id ?? option))
          : [],
      }));
      const modes = arrayRecords(modesResponse.modes).map((mode) => String(mode.id));
      const defaultModel = modelEntries.find((model) => model.isDefault === true)?.id;
      return {
        id: provider,
        name: String(entry.label ?? provider),
        ready: true,
        models,
        modeIds: modes,
        ...(defaultModel === undefined ? {} : { defaultModelId: String(defaultModel) }),
        ...(stringValue(entry.defaultModeId) === undefined
          ? {}
          : { defaultModeId: stringValue(entry.defaultModeId) as string }),
      };
    }),
  );
}

function timelineEntries(page: UnknownRecord, epoch: string, agentId: string): TimelineEvent[] {
  return recordEntries(page).flatMap((entry) => {
    const item = timelineItem(asRecord(entry.item) ?? {}, agentId);
    const sequence = numberValue(entry.seqEnd) ?? numberValue(entry.seqStart);
    return item === undefined || sequence === undefined ? [] : [{ epoch, sequence, item }];
  });
}

function timelineEvent(
  epoch: string,
  sequence: number,
  stream: UnknownRecord,
  agentId: string,
): TimelineEvent | undefined {
  const item =
    stream.type === "timeline"
      ? timelineItem(asRecord(stream.item) ?? {}, agentId)
      : streamItem(stream, agentId);
  return item === undefined ? undefined : { epoch, sequence, item };
}

function streamItem(stream: UnknownRecord, agentId: string): TimelineItem | undefined {
  switch (stream.type) {
    case "turn_started":
      return {
        id: `turn:${agentId}:${stringValue(stream.turnId) ?? "current"}`,
        type: "turn",
        status: "started",
      };
    case "turn_completed":
      return {
        id: `turn:${agentId}:${stringValue(stream.turnId) ?? "current"}`,
        type: "turn",
        status: "completed",
      };
    case "turn_failed":
      return {
        id: `turn:${agentId}:${stringValue(stream.turnId) ?? "current"}`,
        type: "turn",
        status: "failed",
        detail: String(stream.error ?? ""),
      };
    case "turn_canceled":
      return {
        id: `turn:${agentId}:${stringValue(stream.turnId) ?? "current"}`,
        type: "turn",
        status: "canceled",
        detail: String(stream.reason ?? ""),
      };
    case "permission_requested":
      return {
        id: `permission:${String(asRecord(stream.request)?.id ?? "unknown")}`,
        type: "permission",
        request: permissionRequest(asRecord(stream.request) ?? {}, agentId),
      };
    case "permission_resolved":
      return {
        id: `permission:${String(stream.requestId)}`,
        type: "permission",
        request: { id: String(stream.requestId), agentId, title: "Permission" },
        resolved: true,
      };
    default:
      return undefined;
  }
}

function timelineItem(value: UnknownRecord, agentId: string): TimelineItem | undefined {
  const type = stringValue(value.type) ?? "unknown";
  if (type === "user_message")
    return {
      id: `user:${String(value.messageId ?? value.clientMessageId ?? value.text)}`,
      type: "user-message",
      text: String(value.text ?? ""),
    };
  if (type === "assistant_message")
    return {
      id: `assistant:${String(value.messageId ?? value.text)}`,
      type: "assistant-message",
      messageId: String(value.messageId ?? "unknown"),
      text: String(value.text ?? ""),
    };
  if (type === "reasoning")
    return {
      id: `reasoning:${String(value.text)}`,
      type: "reasoning",
      text: String(value.text ?? ""),
      collapsed: true,
    };
  if (type === "tool_call")
    return {
      id: `tool:${String(value.callId)}`,
      type: "tool",
      callId: String(value.callId),
      name: String(value.name ?? "tool"),
      status: toolStatus(value.status),
      ...(stringValue(asRecord(value.detail)?.output) === undefined
        ? {}
        : { output: stringValue(asRecord(value.detail)?.output) as string }),
    };
  if (type === "error")
    return {
      id: `error:${String(value.message)}`,
      type: "error",
      message: String(value.message ?? "Unknown error"),
    };
  if (type === "permission")
    return {
      id: `permission:${String(asRecord(value.request)?.id ?? "unknown")}`,
      type: "permission",
      request: permissionRequest(asRecord(value.request) ?? {}, agentId),
    };
  return {
    id: `unknown:${type}:${String(value.id ?? value.text ?? "")}`,
    type: "unknown",
    sourceType: type,
    summary: String(value.message ?? value.text ?? type),
    raw: value,
  };
}

function permissionRequest(value: UnknownRecord, agentId: string): PermissionRequest {
  return {
    id: String(value.id ?? "unknown-permission"),
    agentId,
    title: String(value.title ?? value.name ?? "Permission requested"),
    ...(stringValue(value.description) === undefined
      ? {}
      : { description: stringValue(value.description) as string }),
    ...(Array.isArray(value.actions)
      ? { choices: value.actions.map((action) => String(asRecord(action)?.label ?? action)) }
      : {}),
    raw: value,
  };
}

function pageCursor(page: UnknownRecord): TimelineCursor | undefined {
  const value = asRecord(page.endCursor);
  const epoch = stringValue(value?.epoch);
  const sequence = numberValue(value?.seq);
  return epoch === undefined || sequence === undefined ? undefined : { epoch, sequence };
}

function dedupeTimeline(events: readonly TimelineEvent[]): TimelineEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.epoch}:${event.sequence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function timelineKey(event: TimelineEvent): string {
  return `${event.epoch}:${event.sequence}`;
}

function latestCursor(
  current: TimelineCursor | undefined,
  candidate: TimelineCursor | undefined,
): TimelineCursor | undefined {
  if (candidate === undefined) return current;
  if (current === undefined || current.epoch !== candidate.epoch) return candidate;
  return current.sequence >= candidate.sequence ? current : candidate;
}

function latestTimelineCursor(
  history: readonly TimelineEvent[],
  buffered: readonly TimelineEvent[],
): TimelineCursor | undefined {
  return [...history, ...buffered].reduce<TimelineCursor | undefined>(
    (cursor, event) => latestCursor(cursor, { epoch: event.epoch, sequence: event.sequence }),
    undefined,
  );
}

function usageSummary(value: unknown): UsageSummary {
  const record = asRecord(value) ?? {};
  const inputTokens = numberValue(record.inputTokens);
  const outputTokens = numberValue(record.outputTokens);
  const cachedTokens = numberValue(record.cachedInputTokens);
  const contextTokens = numberValue(record.contextWindowUsedTokens);
  const contextWindow = numberValue(record.contextWindowMaxTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

function recordEntries(value: UnknownRecord): UnknownRecord[] {
  return Array.isArray(value.entries)
    ? value.entries.flatMap((entry) =>
        asRecord(entry) === undefined ? [] : [asRecord(entry) as UnknownRecord],
      )
    : [];
}
function arrayRecords(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.flatMap((entry) =>
        asRecord(entry) === undefined ? [] : [asRecord(entry) as UnknownRecord],
      )
    : [];
}
function projectEntries(value: UnknownRecord): UnknownRecord[] {
  return Array.isArray(value.projects)
    ? value.projects.flatMap((entry) =>
        asRecord(entry) === undefined ? [] : [asRecord(entry) as UnknownRecord],
      )
    : recordEntries(value);
}
function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function status(value: unknown): AgentRecord["status"] {
  return value === "initializing"
    ? "starting"
    : value === "closed"
      ? "stopped"
      : value === "error"
        ? "failed"
        : value === "running" || value === "idle"
          ? value
          : "unknown";
}
function toolStatus(value: unknown): "running" | "completed" | "failed" | "canceled" {
  return value === "completed" || value === "failed" || value === "canceled" ? value : "running";
}
