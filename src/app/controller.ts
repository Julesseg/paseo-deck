import type { AppState, ModalState } from "../contracts/app-state.js";
import type { AgentCommand } from "../contracts/commands.js";
import type { DirectoryUpdate } from "../contracts/domain.js";
import type { Observation, PaseoGateway } from "../contracts/gateway.js";
import { composerAvailability } from "../state/composer.js";
import {
  type AppAction,
  createInitialState,
  pendingPermissions,
  reduceApp,
} from "../state/store.js";
import type { UiIntent } from "../ui/controller.js";
import { deriveTreeRows, type TreeRow } from "../ui/view-model.js";

export interface ApplicationControllerOptions {
  onQuit?: () => void | Promise<void>;
}

export class ApplicationController {
  #state = createInitialState();
  readonly #listeners = new Set<(state: AppState) => void>();
  #directoryObservation: Observation | undefined;
  #timelineObservation: Observation | undefined;
  #focusGeneration = 0;

  constructor(
    private readonly gateway: PaseoGateway,
    private readonly options: ApplicationControllerOptions = {},
  ) {}

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
        else this.apply({ type: "directory", update });
      });
      const snapshot = await this.gateway.getDirectorySnapshot();
      this.apply({ type: "directory", update: { type: "snapshot", snapshot } });
      hydrating = false;
      for (const update of pending) this.apply({ type: "directory", update });
      this.apply({
        type: "directory",
        update: { type: "connection-changed", state: "connected" },
      });
    } catch (error) {
      await this.#directoryObservation?.release();
      this.#directoryObservation = undefined;
      this.apply({
        type: "directory",
        update: { type: "connection-changed", state: "disconnected", detail: errorMessage(error) },
      });
      this.reportError("Could not connect to Paseo.", error);
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
    if (this.#state.selectedAgentId === agentId && this.#timelineObservation !== undefined) return;
    const generation = ++this.#focusGeneration;
    const previous = this.#timelineObservation;
    this.#timelineObservation = undefined;
    if (previous) await previous.release();
    if (generation !== this.#focusGeneration) return;
    this.apply({ type: "select-agent", agentId });
    try {
      const observation = await this.gateway.focusAgent(agentId, (update) => {
        if (generation === this.#focusGeneration) this.apply({ type: "timeline", update });
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
    }
  }

  async handleIntent(intent: UiIntent): Promise<void> {
    switch (intent.type) {
      case "select-next":
        await this.moveSelection(intent.direction);
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
      case "open-create-agent":
        if (this.activeWorkspace(intent.workspaceId)) {
          this.apply({
            type: "open-modal",
            modal: { type: "create-agent", workspaceId: intent.workspaceId, step: "provider" },
          });
        }
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
      case "open-permissions": {
        const request = pendingPermissions(this.#state)[0];
        if (request) this.apply({ type: "open-modal", modal: { type: "permission", request } });
        else this.apply({ type: "notify", message: "No permission requests are pending." });
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
      case "respond-permission":
        await this.runCommand({
          type: "respond-permission",
          agentId: intent.agentId,
          requestId: intent.requestId,
          allow: intent.allow,
        });
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
    this.#state = reduceApp(this.#state, action);
    for (const listener of this.#listeners) listener(this.#state);
  }

  private async moveSelection(direction: -1 | 1): Promise<void> {
    const rows = deriveTreeRows(this.#state);
    if (rows.length === 0) return;
    const selectedId =
      this.#state.selectedAgentId ??
      this.#state.selectedWorkspaceId ??
      this.#state.selectedProjectId;
    const current = rows.findIndex((row) => row.id === selectedId);
    const index = current === -1 ? (direction === 1 ? 0 : rows.length - 1) : current + direction;
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (row) await this.selectRow(row);
  }

  private async selectRow(row: TreeRow): Promise<void> {
    if (row.kind === "agent") await this.selectAgent(row.id);
    else if (row.kind === "workspace") {
      this.apply({ type: "select-workspace", workspaceId: row.id });
      this.apply({ type: "set-focus", focus: "tree" });
    } else {
      this.apply({ type: "select-project", projectId: row.id });
      this.apply({ type: "set-focus", focus: "tree" });
    }
  }

  private collapseOrExpand(direction: -1 | 1): void {
    const id = this.#state.selectedWorkspaceId ?? this.#state.selectedProjectId;
    if (!id) return;
    const expanded = this.#state.expandedIds.has(id);
    if ((direction === 1 && !expanded) || (direction === -1 && expanded)) {
      this.apply({ type: "toggle-expanded", id });
    }
  }

  private async openSelection(): Promise<void> {
    if (this.#state.selectedAgentId) {
      await this.selectAgent(this.#state.selectedAgentId);
      return;
    }
    const id = this.#state.selectedWorkspaceId ?? this.#state.selectedProjectId;
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
      this.reportError("Could not refresh the directory.", error);
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
      this.reportError("Could not send the prompt.", error);
    }
  }

  private async runCommand(command: AgentCommand): Promise<void> {
    try {
      const result = await this.gateway.execute(command);
      if (command.type === "respond-permission") {
        this.apply({
          type: "permission-resolved",
          agentId: command.agentId,
          requestId: command.requestId,
          allow: command.allow,
        });
      }
      if (command.type === "detach-agent")
        this.apply({ type: "composer-detached", agentId: command.agentId });
      this.apply({ type: "close-modal" });
      this.apply({
        type: "notify",
        message:
          result.type === "agent-created" ? `Created agent ${shortId(result.agentId)}.` : "Done.",
      });
    } catch (error) {
      this.reportError("The Paseo command failed.", error);
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
    if (modal.step === "provider") {
      const provider = this.#state.directory.providers.find(
        (item) => item.id === choice && item.ready,
      );
      if (!provider) return;
      this.setCreationModal({ ...modal, providerId: provider.id, step: "model" });
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
      this.setCreationModal({ ...modal, modelId: model.id, step: next });
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
    const prompt = choice.trim();
    if (!prompt || !modal.providerId || !modal.modelId) return;
    try {
      const result = await this.gateway.execute({
        type: "create-agent",
        workspaceId: modal.workspaceId,
        providerId: modal.providerId,
        modelId: modal.modelId,
        prompt,
        ...(modal.modeId ? { modeId: modal.modeId } : {}),
        ...(modal.thinkingLevel ? { thinkingLevel: modal.thinkingLevel } : {}),
      });
      if (result.type !== "agent-created")
        throw new Error("Paseo did not return the created agent.");
      this.apply({ type: "close-modal" });
      await this.selectAgent(result.agentId);
      this.apply({ type: "notify", message: `Created agent ${shortId(result.agentId)}.` });
    } catch (error) {
      this.reportError("Could not create the agent.", error);
    }
  }

  private setCreationModal(modal: Extract<ModalState, { type: "create-agent" }>): void {
    this.apply({ type: "open-modal", modal });
  }

  private reportError(message: string, error: unknown): void {
    this.apply({ type: "notify", message, detail: errorDetail(error), kind: "error" });
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
  return error instanceof Error ? error.message : String(error);
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    const detail = "detail" in error && typeof error.detail === "string" ? error.detail : undefined;
    return detail ?? error.stack ?? error.message;
  }
  return String(error);
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
