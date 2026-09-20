import type { AppState, ModalState, PaseoFailureKind } from "../contracts/app-state.js";
import type { AgentCommand } from "../contracts/commands.js";
import type { DirectoryUpdate } from "../contracts/domain.js";
import type { Observation, PaseoGateway } from "../contracts/gateway.js";
import { PaseoGatewayError, paseoFailure, redactTransportDetail } from "../paseo/errors.js";
import { composerAvailability } from "../state/composer.js";
import {
  type AppAction,
  activeNotification,
  createInitialState,
  pendingPermissions,
  reduceApp,
} from "../state/store.js";
import type { UiIntent } from "../ui/controller.js";
import { deriveTreeRows, type TreeRow } from "../ui/view-model.js";

export interface ApplicationControllerOptions {
  onQuit?: () => void | Promise<void>;
  initialState?: AppState;
}

type RetryOperation =
  | { type: "command"; command: AgentCommand }
  | { type: "send"; agentId: string; prompt: string }
  | { type: "focus"; agentId: string }
  | { type: "refresh" }
  | { type: "recovery-directory" }
  | { type: "recovery-timeline"; agentId: string };

export class ApplicationController {
  #state: AppState;
  readonly #listeners = new Set<(state: AppState) => void>();
  #directoryObservation: Observation | undefined;
  #timelineObservation: Observation | undefined;
  #focusGeneration = 0;
  #permissionFocusGeneration = 0;
  #creationGeneration = 0;
  #recoveryGeneration = 0;
  #nextRetryToken = 0;
  #reconnectRetrying = false;
  readonly #retryOperations = new Map<
    number,
    { running: boolean; completed: boolean; operation: RetryOperation }
  >();

  constructor(
    private readonly gateway: PaseoGateway,
    private readonly options: ApplicationControllerOptions = {},
  ) {
    this.#state = options.initialState ?? createInitialState();
  }

  get state(): AppState {
    return this.#state;
  }

  subscribe(listener: (state: AppState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    this.apply({
      type: "directory",
      update: { type: "connection-changed", state: "connecting" },
    });
    try {
      await this.gateway.connect();
      const pending: DirectoryUpdate[] = [];
      let hydrating = true;
      this.#directoryObservation = await this.gateway.observeDirectory((update) => {
        if (hydrating) pending.push(update);
        else this.receiveDirectoryUpdate(update);
      });
      const snapshot = await this.gateway.getDirectorySnapshot();
      this.apply({ type: "directory", update: { type: "snapshot", snapshot } });
      hydrating = false;
      for (const update of pending) this.receiveDirectoryUpdate(update);
      this.apply({
        type: "directory",
        update: { type: "connection-changed", state: "connected" },
      });
      const restored = this.#state.activeSessionId;
      if (restored && this.#state.directory.agents.some((agent) => agent.id === restored))
        await this.selectAgent(restored);
    } catch (error) {
      await this.#directoryObservation?.release();
      this.#directoryObservation = undefined;
      this.apply({
        type: "directory",
        update: { type: "connection-changed", state: "disconnected", detail: errorMessage(error) },
      });
      this.reportError(
        "Could not connect to Paseo.",
        error,
        { type: "reconnect" },
        "daemon-unavailable",
      );
    }
  }

  async releaseObservations(): Promise<void> {
    this.#focusGeneration += 1;
    const observations = [this.#timelineObservation, this.#directoryObservation];
    this.#timelineObservation = undefined;
    this.#directoryObservation = undefined;
    await Promise.all(observations.map(async (observation) => observation?.release()));
  }

  setComposerText(text: string): void {
    this.apply({ type: "set-composer", text });
  }

  async selectAgent(agentId: string): Promise<void> {
    if (this.#state.selectedAgentId === agentId && this.#timelineObservation !== undefined) {
      // Explicit activation of the already-active session still returns the
      // user to its timeline after browsing in the sidebar.
      this.apply({ type: "set-focus", focus: "timeline" });
      return;
    }
    const generation = ++this.#focusGeneration;
    const previous = this.#timelineObservation;
    this.#timelineObservation = undefined;
    if (previous) await previous.release();
    if (generation !== this.#focusGeneration) return;
    this.apply({ type: "open-session-tab", agentId });
    try {
      const observation = await this.gateway.focusAgent(agentId, (update) => {
        if (generation !== this.#focusGeneration) return;
        this.apply({ type: "timeline", update });
        if (update.type === "error")
          this.apply({
            type: "notify",
            message: update.message,
            ...(update.detail ? { detail: update.detail } : {}),
            kind: "error",
            retry: this.registerRetry({ type: "focus", agentId }),
          });
      });
      if (generation !== this.#focusGeneration) {
        await observation.release();
        return;
      }
      this.#timelineObservation = observation;
    } catch (error) {
      this.apply({
        type: "timeline",
        update: {
          type: "error",
          agentId,
          message: "Could not open the agent timeline.",
          detail: errorMessage(error),
        },
      });
      this.reportError(
        "Could not open the agent timeline.",
        error,
        this.registerRetry({ type: "focus", agentId }),
        "subscription",
      );
    }
  }

  async handleIntent(intent: UiIntent): Promise<void> {
    switch (intent.type) {
      case "select-next":
        await this.moveSelection(intent.direction);
        return;
      case "switch-tab":
        this.apply({
          type: "switch-session-tab",
          direction: intent.direction,
          ...(intent.count ? { count: intent.count } : {}),
        });
        if (this.#state.activeSessionId) await this.selectAgent(this.#state.activeSessionId);
        return;
      case "close-tab":
        {
          const id = this.#state.activeSessionId ?? this.#state.selectedAgentId;
          if (!id) return;
          const before = this.#state.activeSessionId;
          this.apply({ type: "close-session-tab", agentId: id });
          const next = this.#state.activeSessionId;
          if (next && next !== before) await this.selectAgent(next);
        }
        return;
      case "select-boundary":
        await this.moveSelectionBoundary(intent.boundary);
        return;
      case "collapse-or-expand":
        this.collapseOrExpand(intent.direction);
        return;
      case "select-or-open":
        await this.openSelection();
        return;
      case "set-focus":
        this.apply({ type: "set-focus", focus: intent.focus });
        return;
      case "open-help":
        this.apply({ type: "open-modal", modal: { type: "help" } });
        return;
      case "open-filter":
        this.apply({ type: "open-modal", modal: { type: "filter", query: this.#state.filter } });
        return;
      case "toggle-tree-order":
        this.apply({
          type: "set-tree-order",
          order: this.#state.treeOrder === "alphabetical" ? "attention" : "alphabetical",
        });
        return;
      case "toggle-archived":
        this.apply({ type: "toggle-archived" });
        return;
      case "toggle-attention-only":
        this.apply({ type: "toggle-attention-only" });
        return;
      case "open-create-agent":
        if (this.activeWorkspace(intent.workspaceId)) {
          const defaults = this.#state.creationDefaults[intent.workspaceId];
          this.apply({
            type: "open-modal",
            modal: {
              type: "create-agent",
              workspaceId: intent.workspaceId,
              step: "provider",
              ...(defaults ?? {}),
            },
          });
        }
        return;
      case "creation-back":
        this.moveCreationBack();
        return;
      case "open-confirmation":
        {
          const draft = this.#state.composer.drafts[intent.agentId] ?? "";
          this.apply({
            type: "open-modal",
            modal: {
              type: "confirm",
              action: intent.action,
              agentId: intent.agentId,
              ...(draft.trim() ? { draftWarning: true } : {}),
            },
          });
        }
        return;
      case "open-rename": {
        const agent = this.#state.directory.agents.find((item) => item.id === intent.agentId);
        this.apply({
          type: "open-modal",
          modal: { type: "rename", agentId: intent.agentId, value: agent?.title ?? "" },
        });
        return;
      }
      case "open-mode":
        this.apply({ type: "open-modal", modal: { type: "mode", agentId: intent.agentId } });
        return;
      case "open-thinking":
        this.apply({
          type: "open-modal",
          modal: { type: "thinking", agentId: intent.agentId },
        });
        return;
      case "open-error-details":
        this.apply({
          type: "open-modal",
          modal: { type: "error-details", message: intent.message, detail: intent.detail },
        });
        return;
      case "open-notifications": {
        const selected = activeNotification(this.#state);
        this.apply({
          type: "open-modal",
          modal: {
            type: "notifications",
            index: selected ? this.#state.notifications.indexOf(selected) : 0,
          },
        });
        return;
      }
      case "move-notification": {
        const modal = this.#state.modal;
        if (modal.type !== "notifications" || this.#state.notifications.length === 0) return;
        const index = Math.max(
          0,
          Math.min(this.#state.notifications.length - 1, modal.index + intent.direction),
        );
        const notification = this.#state.notifications[index];
        if (!notification) return;
        this.apply({ type: "select-notification", id: notification.id });
        this.apply({ type: "open-modal", modal: { type: "notifications", index } });
        return;
      }
      case "select-notification":
        this.apply({ type: "select-notification", id: intent.id });
        this.apply({ type: "close-modal" });
        return;
      case "open-permissions": {
        const request = pendingPermissions(this.#state)[0];
        if (request) {
          await this.openPermission(request, 0);
        } else this.apply({ type: "notify", message: "No permission requests are pending." });
        return;
      }
      case "move-permission": {
        const queue = pendingPermissions(this.#state);
        const modal = this.#state.modal;
        if (modal.type !== "permission" || queue.length === 0) return;
        const current = queue.findIndex(
          (request) => request.id === modal.requestId && request.agentId === modal.agentId,
        );
        const index = (Math.max(0, current) + intent.direction + queue.length) % queue.length;
        const request = queue[index];
        if (request) await this.openPermission(request, index);
        return;
      }
      case "refresh":
        await this.refresh();
        return;
      case "quit":
        await this.options.onQuit?.();
        return;
      case "close-modal":
        this.apply({ type: "close-modal" });
        return;
      case "toggle-timeline-item":
        return;
      case "move-timeline-selection":
      case "move-timeline-selection-boundary":
      case "move-timeline-landmark":
      case "open-timeline-search":
      case "open-timeline-copy":
        return;
      case "notify":
        this.apply({
          type: "notify",
          message: intent.message,
          ...(intent.kind ? { kind: intent.kind } : {}),
        });
        return;
      case "set-timeline-navigation":
        this.apply({
          type: "set-timeline-navigation",
          agentId: intent.agentId,
          following: intent.following,
          ...(intent.anchor === undefined ? {} : { anchor: intent.anchor }),
        });
        return;
      case "respond-permission":
        await this.respondPermission(intent.agentId, intent.requestId, intent.allow);
        return;
      case "retry-permission":
        await this.respondPermission(intent.agentId, intent.requestId, intent.allow);
        return;
      case "retry-notification":
        await this.retryNotification(intent.id);
        return;
      case "command":
        await this.runCommand(intent.command);
        return;
      case "submit-composer":
        await this.submitPrompt(intent.agentId, intent.prompt);
        return;
      case "set-composer-text":
        this.setComposerText(intent.text);
        return;
      case "navigate-composer-history":
        this.apply({ type: "navigate-composer-history", direction: intent.direction });
        return;
      case "create-choice":
        await this.applyChoice(intent.choice);
        return;
    }
  }

  private apply(action: AppAction): void {
    const previousModal = this.#state.modal;
    this.#state = reduceApp(this.#state, action);
    this.pruneRetries();
    for (const listener of this.#listeners) listener(this.#state);
    const modal = this.#state.modal;
    if (
      previousModal.type === "permission" &&
      modal.type === "permission" &&
      (previousModal.requestId !== modal.requestId || previousModal.agentId !== modal.agentId)
    )
      void this.focusPermissionModal(modal);
  }

  private async openPermission(
    request: { id: string; agentId: string },
    queueIndex: number,
  ): Promise<void> {
    this.apply({
      type: "open-modal",
      modal: {
        type: "permission",
        agentId: request.agentId,
        requestId: request.id,
        queueIndex,
        submitting: false,
      },
    });
    await this.focusPermissionModal(this.#state.modal);
  }

  private async focusPermissionModal(modal: AppState["modal"]): Promise<void> {
    if (modal.type !== "permission" || !modal.agentId || !modal.requestId) return;
    const generation = ++this.#permissionFocusGeneration;
    await this.selectAgent(modal.agentId);
    if (generation !== this.#permissionFocusGeneration) return;
    this.apply({ type: "set-focus", focus: "timeline" });
  }

  private async moveSelection(direction: -1 | 1): Promise<void> {
    const rows = deriveTreeRows(this.#state);
    if (rows.length === 0) return;
    const selectedId =
      this.#state.sidebarSelection?.id ??
      this.#state.selectedAgentId ??
      this.#state.selectedWorkspaceId ??
      this.#state.selectedProjectId;
    const current = rows.findIndex((row) => row.id === selectedId);
    const index = current === -1 ? (direction === 1 ? 0 : rows.length - 1) : current + direction;
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (row) await this.selectRow(row);
  }

  private async moveSelectionBoundary(boundary: "start" | "end"): Promise<void> {
    const rows = deriveTreeRows(this.#state);
    const row = boundary === "start" ? rows[0] : rows.at(-1);
    if (row) await this.selectRow(row);
  }

  private async selectRow(row: TreeRow): Promise<void> {
    this.apply({
      type: "select-sidebar",
      selection: {
        kind: row.kind === "agent" ? "session" : row.kind,
        id: row.id,
      },
    });
  }

  private collapseOrExpand(direction: -1 | 1): void {
    const selection = this.#state.sidebarSelection;
    const id =
      selection?.kind === "workspace" || selection?.kind === "project"
        ? selection.id
        : (this.#state.selectedWorkspaceId ?? this.#state.selectedProjectId);
    if (!id) return;
    const expanded = this.#state.expandedIds.has(id);
    if ((direction === 1 && !expanded) || (direction === -1 && expanded)) {
      this.apply({ type: "toggle-expanded", id });
    }
  }

  private async openSelection(): Promise<void> {
    const selection = this.#state.sidebarSelection;
    if (selection?.kind === "session") {
      await this.selectAgent(selection.id);
      return;
    }
    const id = selection?.id ?? this.#state.selectedWorkspaceId ?? this.#state.selectedProjectId;
    if (id) this.apply({ type: "toggle-expanded", id });
  }

  private activeWorkspace(workspaceId: string): boolean {
    return this.#state.directory.workspaces.some(
      (workspace) => workspace.id === workspaceId && !workspace.archived,
    );
  }

  private async refresh(): Promise<void> {
    if (this.#state.connection === "disconnected") {
      const selectedAgentId = this.#state.selectedAgentId;
      await this.releaseObservations();
      await this.gateway.close();
      await this.start();
      if (selectedAgentId && this.isConnected()) {
        await this.selectAgent(selectedAgentId);
      }
      return;
    }
    try {
      const snapshot = await this.gateway.getDirectorySnapshot();
      this.apply({ type: "directory", update: { type: "snapshot", snapshot } });
      this.apply({ type: "notify", message: "Directory refreshed." });
    } catch (error) {
      this.reportError(
        "Could not refresh the directory.",
        error,
        this.registerRetry({ type: "refresh" }),
        "protocol",
      );
    }
  }

  private isConnected(): boolean {
    return this.#state.connection === "connected";
  }

  private async submitPrompt(agentId: string, prompt: string): Promise<void> {
    if (this.#state.composer.sendingAgentIds.has(agentId)) return;
    const availability = composerAvailability(this.#state, agentId);
    if (!availability.canSend) {
      this.apply({
        type: "notify",
        message: availabilityMessage(availability.reason),
        kind: "error",
      });
      return;
    }
    this.apply({ type: "set-composer-sending", agentId, sending: true });
    try {
      await this.gateway.execute({ type: "send-prompt", agentId, prompt });
      this.apply({ type: "composer-sent", agentId, prompt });
    } catch (error) {
      this.apply({ type: "set-composer-sending", agentId, sending: false });
      this.reportError(
        "Could not send the prompt.",
        error,
        this.registerRetry({ type: "send", agentId, prompt }),
        "command",
      );
    }
  }

  private async runCommand(command: AgentCommand): Promise<void> {
    try {
      const result = await this.gateway.execute(command);
      if (command.type === "detach-agent")
        this.apply({ type: "composer-detached", agentId: command.agentId });
      this.apply({ type: "close-modal" });
      this.apply({
        type: "notify",
        message:
          result.type === "agent-created" ? `Created agent ${shortId(result.agentId)}.` : "Done.",
      });
    } catch (error) {
      this.reportError(
        "The Paseo command failed.",
        error,
        this.registerRetry({ type: "command", command }),
        "command",
      );
    }
  }

  private async respondPermission(
    agentId: string,
    requestId: string,
    allow: boolean,
  ): Promise<void> {
    this.apply({
      type: "permission-submitting",
      agentId,
      requestId,
      allow: allow ? "allow" : "deny",
    });
    try {
      await this.gateway.execute({ type: "respond-permission", agentId, requestId, allow });
    } catch (error) {
      this.apply({ type: "permission-failed", agentId, requestId, error: errorDetail(error) });
    }
  }

  private async applyChoice(choice: string): Promise<void> {
    const modal = this.#state.modal;
    if (modal.type === "filter") {
      this.apply({ type: "set-filter", filter: choice });
      this.apply({ type: "close-modal" });
      return;
    }
    if (modal.type === "mode") {
      await this.runCommand({ type: "set-agent-mode", agentId: modal.agentId, modeId: choice });
      return;
    }
    if (modal.type === "thinking") {
      await this.runCommand({
        type: "set-thinking-level",
        agentId: modal.agentId,
        thinkingLevel: choice,
      });
      return;
    }
    if (modal.type !== "create-agent") return;
    await this.advanceCreation(modal, choice);
  }

  private async advanceCreation(
    modal: Extract<ModalState, { type: "create-agent" }>,
    choice: string,
  ): Promise<void> {
    if (modal.submitting) return;
    if (modal.step === "provider") {
      const provider = this.#state.directory.providers.find(
        (item) => item.id === choice && item.ready,
      );
      if (!provider) return;
      if (modal.providerId === provider.id) {
        this.setCreationModal({ ...modal, step: "model" });
        return;
      }
      const { modelId: _modelId, modeId: _modeId, thinkingLevel: _thinkingLevel, ...form } = modal;
      this.setCreationModal({ ...form, providerId: provider.id, step: "model" });
      return;
    }
    if (modal.step === "model") {
      const provider = this.#state.directory.providers.find((item) => item.id === modal.providerId);
      const model = provider?.models.find((item) => item.id === choice && item.selectable);
      if (!provider || !model) return;
      const next =
        provider.modeIds.length > 0
          ? "mode"
          : model.thinkingLevels.length > 0
            ? "thinking"
            : "prompt";
      const { thinkingLevel: _thinkingLevel, ...form } = modal;
      this.setCreationModal({
        ...form,
        modelId: model.id,
        ...(model.thinkingLevels.includes(modal.thinkingLevel ?? "")
          ? { thinkingLevel: modal.thinkingLevel }
          : {}),
        step: next,
      });
      return;
    }
    if (modal.step === "mode") {
      const provider = this.#state.directory.providers.find((item) => item.id === modal.providerId);
      if (!provider?.modeIds.includes(choice)) return;
      const model = selectedCreationModel(this.#state, modal);
      this.setCreationModal({
        ...modal,
        modeId: choice,
        step: model && model.thinkingLevels.length > 0 ? "thinking" : "prompt",
      });
      return;
    }
    if (modal.step === "thinking") {
      const model = selectedCreationModel(this.#state, modal);
      if (!model?.thinkingLevels.includes(choice)) return;
      this.setCreationModal({ ...modal, thinkingLevel: choice, step: "prompt" });
      return;
    }
    if (modal.step === "prompt") {
      const prompt = choice.trim();
      if (!prompt) return;
      const { error: _error, ...form } = modal;
      this.setCreationModal({ ...form, prompt: choice, step: "confirm" });
      return;
    }
    if (modal.step !== "confirm" || !modal.prompt?.trim() || !modal.providerId || !modal.modelId)
      return;
    const generation = ++this.#creationGeneration;
    try {
      const { error: _error, ...form } = modal;
      this.setCreationModal({ ...form, submitting: true });
      const result = await this.gateway.execute({
        type: "create-agent",
        workspaceId: modal.workspaceId,
        providerId: modal.providerId,
        modelId: modal.modelId,
        prompt: modal.prompt,
        ...(modal.modeId ? { modeId: modal.modeId } : {}),
        ...(modal.thinkingLevel ? { thinkingLevel: modal.thinkingLevel } : {}),
      });
      if (generation !== this.#creationGeneration) return;
      if (result.type !== "agent-created")
        throw new Error("Paseo did not return the created agent.");
      this.apply({ type: "close-modal" });
      this.apply({
        type: "set-creation-default",
        workspaceId: modal.workspaceId,
        value: {
          providerId: modal.providerId,
          modelId: modal.modelId,
          ...(modal.modeId ? { modeId: modal.modeId } : {}),
          ...(modal.thinkingLevel ? { thinkingLevel: modal.thinkingLevel } : {}),
        },
      });
      this.apply({ type: "reveal-workspace", workspaceId: modal.workspaceId });
      await this.selectAgent(result.agentId);
      this.apply({ type: "notify", message: `Created agent ${shortId(result.agentId)}.` });
    } catch (error) {
      if (generation !== this.#creationGeneration) return;
      this.setCreationModal({ ...modal, submitting: false, error: errorDetail(error) });
    }
  }

  private setCreationModal(modal: Extract<ModalState, { type: "create-agent" }>): void {
    this.apply({ type: "open-modal", modal });
  }

  private moveCreationBack(): void {
    const modal = this.#state.modal;
    if (modal.type !== "create-agent" || modal.submitting) return;
    this.#creationGeneration += 1;
    const provider = this.#state.directory.providers.find((item) => item.id === modal.providerId);
    const step =
      modal.step === "confirm"
        ? "prompt"
        : modal.step === "prompt"
          ? modal.thinkingLevel
            ? "thinking"
            : modal.modeId
              ? "mode"
              : "model"
          : modal.step === "thinking"
            ? provider?.modeIds.length
              ? "mode"
              : "model"
            : modal.step === "mode"
              ? "model"
              : modal.step === "model"
                ? "provider"
                : undefined;
    if (step) this.setCreationModal({ ...modal, step });
    else if (modal.step === "provider") this.apply({ type: "close-modal" });
  }

  private receiveDirectoryUpdate(update: DirectoryUpdate): void {
    const previous = this.#state.connection;
    const observed =
      update.type === "connection-changed" && update.at === undefined
        ? { ...update, at: Date.now() }
        : update;
    this.apply({ type: "directory", update: observed });
    if (update.type === "connection-changed" && update.state !== "connected")
      this.#recoveryGeneration += 1;
    if (
      update.type === "connection-changed" &&
      update.state === "connected" &&
      previous !== "connected"
    )
      void this.recoverAfterConnection(this.#recoveryGeneration);
  }

  private async recoverAfterConnection(generation: number): Promise<void> {
    await this.recoverDirectory(generation);
    const agentId = this.#state.selectedAgentId;
    if (!agentId) return;
    await this.recoverTimeline(agentId, generation);
  }

  private async recoverDirectory(generation: number): Promise<void> {
    try {
      const snapshot = await this.gateway.getDirectorySnapshot();
      if (generation !== this.#recoveryGeneration || this.#state.connection !== "connected") return;
      this.apply({ type: "directory", update: { type: "snapshot", snapshot } });
      this.apply({ type: "recovery-stage-succeeded", stage: "directory" });
    } catch (error) {
      if (generation !== this.#recoveryGeneration) return;
      this.reportError(
        "Directory recovery failed.",
        error,
        this.registerRetry({ type: "recovery-directory" }),
        "protocol",
      );
    }
  }

  /** Reopen a focused observation without replacing visible history or navigation. */
  private async recoverTimeline(agentId: string, recoveryGeneration: number): Promise<void> {
    const focusGeneration = ++this.#focusGeneration;
    const previous = this.#timelineObservation;
    this.#timelineObservation = undefined;
    await previous?.release();
    if (
      focusGeneration !== this.#focusGeneration ||
      recoveryGeneration !== this.#recoveryGeneration ||
      this.#state.connection !== "connected" ||
      this.#state.selectedAgentId !== agentId
    )
      return;
    try {
      const observation = await this.gateway.focusAgent(agentId, (update) => {
        if (
          focusGeneration === this.#focusGeneration &&
          recoveryGeneration === this.#recoveryGeneration &&
          this.#state.connection === "connected"
        )
          this.apply({ type: "timeline", update });
      });
      if (
        focusGeneration !== this.#focusGeneration ||
        recoveryGeneration !== this.#recoveryGeneration ||
        this.#state.connection !== "connected"
      ) {
        await observation.release();
        return;
      }
      this.#timelineObservation = observation;
      this.apply({ type: "recovery-stage-succeeded", stage: "timeline" });
    } catch (error) {
      if (recoveryGeneration !== this.#recoveryGeneration) return;
      this.reportError(
        "Timeline recovery failed.",
        error,
        this.registerRetry({ type: "recovery-timeline", agentId }),
        "subscription",
      );
    }
  }

  private async retryNotification(id: number): Promise<void> {
    const retry = this.#state.notifications.find((item) => item.id === id)?.retry;
    if (!retry) return;
    if (retry.type === "reconnect") {
      if (this.#reconnectRetrying) return;
      this.#reconnectRetrying = true;
      try {
        await this.refresh();
      } finally {
        this.#reconnectRetrying = false;
      }
      return;
    }
    const entry = this.#retryOperations.get(retry.token);
    if (!entry || entry.running || entry.completed) return;
    entry.running = true;
    try {
      switch (entry.operation.type) {
        case "command":
          await this.runCommand(entry.operation.command);
          return;
        case "send":
          await this.submitPrompt(entry.operation.agentId, entry.operation.prompt);
          return;
        case "focus":
          await this.selectAgent(entry.operation.agentId);
          return;
        case "refresh":
          await this.refresh();
          return;
        case "recovery-directory":
          await this.recoverDirectory(this.#recoveryGeneration);
          return;
        case "recovery-timeline":
          await this.recoverTimeline(entry.operation.agentId, this.#recoveryGeneration);
          return;
      }
    } finally {
      entry.running = false;
      entry.completed = true;
      this.#retryOperations.delete(retry.token);
    }
  }

  private reportError(
    message: string,
    error: unknown,
    retry?: AppState["notifications"][number]["retry"],
    fallback: PaseoFailureKind = "protocol",
  ): void {
    const failure = paseoFailure(error, fallback);
    this.apply({
      type: "notify",
      message,
      detail: errorDetail(failure),
      kind: "error",
      failureKind: failure.kind,
      ...(retry === undefined ? {} : { retry }),
    });
  }

  private registerRetry(operation: RetryOperation): { type: "operation"; token: number } {
    const token = ++this.#nextRetryToken;
    this.#retryOperations.set(token, { operation, running: false, completed: false });
    return { type: "operation", token };
  }

  private pruneRetries(): void {
    const retained = new Set(
      this.#state.notifications.flatMap((notification) =>
        notification.retry?.type === "operation" ? [notification.retry.token] : [],
      ),
    );
    for (const token of this.#retryOperations.keys())
      if (!retained.has(token)) this.#retryOperations.delete(token);
  }
}

function availabilityMessage(
  reason: Exclude<ReturnType<typeof composerAvailability>, { canSend: true }>["reason"],
): string {
  return {
    disconnected: "Cannot send while disconnected.",
    missing: "The destination agent is unavailable.",
    detached: "Cannot send to a detached agent.",
    archived: "Cannot send to an archived agent.",
    stopped: "Cannot send to a stopped agent.",
    failed: "Cannot send to a failed agent.",
  }[reason];
}

function selectedCreationModel(
  state: AppState,
  modal: Extract<ModalState, { type: "create-agent" }>,
) {
  return state.directory.providers
    .find((provider) => provider.id === modal.providerId)
    ?.models.find((model) => model.id === modal.modelId);
}

function errorMessage(error: unknown): string {
  return error instanceof PaseoGatewayError
    ? error.message
    : redactTransportDetail(error instanceof Error ? error.message : String(error));
}

function errorDetail(error: unknown): string {
  return error instanceof PaseoGatewayError
    ? (error.detail ?? error.message)
    : redactTransportDetail(error instanceof Error ? error.message : String(error));
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
