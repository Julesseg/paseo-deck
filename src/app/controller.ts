import type { AppState, ModalState, PaseoFailureKind } from "../contracts/app-state.js";
import type { AgentCommand } from "../contracts/commands.js";
import type { DirectoryUpdate, ProviderOption } from "../contracts/domain.js";
import type { Observation, PaseoGateway } from "../contracts/gateway.js";
import type { TerminalObservation } from "../contracts/terminal.js";
import { PaseoGatewayError, paseoFailure, redactTransportDetail } from "../paseo/errors.js";
import { activeSessionDraftWorkspaceId, composerAvailability } from "../state/composer.js";
import {
  type AppAction,
  activeNotification,
  createInitialState,
  pendingPermissions,
  reduceApp,
} from "../state/store.js";
import type { UiIntent } from "../ui/controller.js";
import { sanitizeTerminalText } from "../ui/text-safety.js";
import { deriveTreeRows, type TreeRow, workspaceTabs } from "../ui/view-model.js";

export interface ApplicationControllerOptions {
  onQuit?: () => void | Promise<void>;
  /** Receives timeline-local actions that the terminal view owns (fold/search/copy). */
  onTimelineIntent?: (intent: UiIntent) => void | Promise<void>;
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
  #observedAgentId: string | undefined;
  #focusGeneration = 0;
  #permissionFocusGeneration = 0;
  #creationGeneration = 0;
  #recoveryGeneration = 0;
  #nextRetryToken = 0;
  #reconnectRetrying = false;
  readonly #terminalObservations = new Map<string, TerminalObservation>();
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
      await Promise.all(
        snapshot.workspaces.map(async (workspace) => {
          try {
            await this.discoverTerminals(workspace.id);
          } catch (error) {
            this.apply({
              type: "notify",
              message: `Could not discover terminals for ${workspace.title}.`,
              detail: errorMessage(error),
              kind: "error",
            });
          }
        }),
      );
      hydrating = false;
      for (const update of pending) this.receiveDirectoryUpdate(update);
      this.apply({
        type: "directory",
        update: { type: "connection-changed", state: "connected" },
      });
      if (!this.#state.selectedWorkspaceId) {
        const expandedIds = new Set(this.#state.directory.projects.map((project) => project.id));
        const first = deriveTreeRows({ ...this.#state, expandedIds }).find(
          (row) => row.kind === "workspace",
        );
        if (first) this.apply({ type: "activate-workspace", workspaceId: first.id });
      }
      await this.showActiveResource();
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
    this.#observedAgentId = undefined;
    this.#directoryObservation = undefined;
    await Promise.all(observations.map(async (observation) => observation?.release()));
    await Promise.all(
      [...this.#terminalObservations.values()].map((observation) => observation.release()),
    );
    this.#terminalObservations.clear();
  }

  setComposerText(text: string): void {
    this.apply({ type: "set-composer", text });
  }

  async createWorkspaceTerminal(workspaceId: string, name: string): Promise<void> {
    try {
      const terminal = await this.gateway.createTerminal(workspaceId, { name });
      const existing = this.#state.workspaceTerminals?.[workspaceId] ?? [];
      this.apply({ type: "set-terminals", workspaceId, terminals: [...existing, terminal] });
      await this.handleIntent({ type: "open-terminal", terminalId: terminal.id });
    } catch (error) {
      this.apply({
        type: "notify",
        message: "Could not create workspace terminal.",
        detail: errorMessage(error),
        kind: "error",
      });
    }
  }

  async selectAgent(agentId: string, preserveSidebar = false): Promise<void> {
    if (
      this.#state.selectedAgentId === agentId &&
      this.#observedAgentId === agentId &&
      this.#timelineObservation !== undefined &&
      !this.#state.activeTerminalId
    ) {
      // Explicit activation of the already-active session still returns the
      // user to its timeline after browsing in the sidebar.
      this.apply({ type: "set-focus", focus: "timeline" });
      return;
    }
    const generation = ++this.#focusGeneration;
    const previous = this.#timelineObservation;
    this.#timelineObservation = undefined;
    this.#observedAgentId = agentId;
    // Releasing a remote demand and hydrating the next timeline can both take
    // arbitrarily long. Neither operation may stall the input path: sidebar
    // navigation must remain available while the new session loads.
    void previous?.release();
    if (generation !== this.#focusGeneration) return;
    this.apply({
      type: "open-session-tab",
      agentId,
      ...(preserveSidebar ? { preserveSidebar: true } : {}),
    });
    void this.startTimelineObservation(agentId, generation);
  }

  private async startTimelineObservation(agentId: string, generation: number): Promise<void> {
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
      case "open-terminal": {
        const terminal = Object.values(this.#state.workspaceTerminals ?? {})
          .flat()
          .find((item) => item.id === intent.terminalId);
        if (!terminal) return;
        const generation = ++this.#focusGeneration;
        try {
          const capture = await this.gateway.captureTerminal(terminal.id, { start: -2000 });
          if (generation !== this.#focusGeneration) return;
          this.apply({
            type: "terminal-lines",
            terminalId: terminal.id,
            lines: capture.lines.map(sanitizeObservedTerminal),
          });
          this.apply({ type: "open-terminal-tab", terminalId: terminal.id });
          const previousTimeline = this.#timelineObservation;
          this.#timelineObservation = undefined;
          this.#observedAgentId = undefined;
          void previousTimeline?.release();
          await this.#terminalObservations.get(terminal.id)?.release();
          const observation = await this.gateway.observeTerminal(terminal.id, (update) => {
            if (update.type === "exited") {
              this.apply({
                type: "terminal-lines",
                terminalId: terminal.id,
                lines: this.#state.terminalLines?.[terminal.id] ?? [],
                stale: true,
              });
              void this.discoverTerminals(terminal.workspaceId).catch((error) =>
                this.reportError("Could not refresh workspace terminals.", error),
              );
            } else if (update.type === "output")
              this.apply({
                type: "terminal-lines",
                terminalId: terminal.id,
                lines: [
                  ...(this.#state.terminalLines?.[terminal.id] ?? []),
                  sanitizeObservedTerminal(new TextDecoder().decode(update.data)),
                ],
              });
            else if (update.type === "snapshot")
              this.apply({
                type: "terminal-lines",
                terminalId: terminal.id,
                lines: update.lines.map(sanitizeObservedTerminal),
              });
          });
          if (generation !== this.#focusGeneration) {
            await observation.release();
            return;
          }
          this.#terminalObservations.set(terminal.id, observation);
        } catch (error) {
          this.apply({
            type: "notify",
            message: "Could not open terminal.",
            detail: errorMessage(error),
            kind: "error",
          });
        }
        return;
      }
      case "scroll-terminal":
        if (this.#state.activeTerminalId) {
          const id = this.#state.activeTerminalId;
          const current = this.#state.terminalScrollTop?.[id] ?? 0;
          this.apply({
            type: "set-terminal-scroll",
            terminalId: id,
            offset: Math.max(0, current + (intent.direction < 0 ? -5 : 5)),
          });
        }
        return;
      case "reconnect-terminal":
        if (this.#state.activeTerminalId)
          await this.handleIntent({
            type: "open-terminal",
            terminalId: this.#state.activeTerminalId,
          });
        return;
      case "kill-terminal": {
        const id = this.#state.activeTerminalId;
        if (!id) return;
        this.apply({
          type: "open-modal",
          modal: { type: "confirm", action: "kill-terminal", terminalId: id },
        });
        return;
      }
      case "kill-terminal-confirmed": {
        try {
          await this.gateway.killTerminal(intent.terminalId);
          await this.#terminalObservations.get(intent.terminalId)?.release();
          this.#terminalObservations.delete(intent.terminalId);
          const workspaceId = Object.entries(this.#state.workspaceTerminals ?? {}).find(
            ([, items]) => items.some((item) => item.id === intent.terminalId),
          )?.[0];
          if (workspaceId) await this.discoverTerminals(workspaceId);
          this.apply({ type: "close-modal" });
        } catch (error) {
          this.apply({
            type: "notify",
            message: "Could not terminate terminal.",
            detail: errorMessage(error),
            kind: "error",
          });
        }
        return;
      }
      case "set-terminal-mode":
        this.apply({ type: "set-terminal-mode", mode: intent.mode });
        return;
      case "terminal-input":
        if (this.#state.activeTerminalId && this.#state.terminalMode === "insert")
          this.gateway.sendTerminalInput(this.#state.activeTerminalId, intent.data);
        return;
      case "select-next":
        await this.moveSelection(intent.direction);
        return;
      case "switch-tab":
        {
          const workspaceId = this.#state.selectedWorkspaceId;
          if (!workspaceId) return;
          const tabs = workspaceTabs(this.#state);
          if (!tabs.length) return;
          const current = tabs.findIndex(
            (tab) => `${tab.kind}:${tab.id}` === this.#state.activeTabIds[workspaceId],
          );
          const index =
            intent.count === undefined
              ? current === -1
                ? intent.direction === 1
                  ? 0
                  : tabs.length - 1
                : (current + intent.direction + tabs.length) % tabs.length
              : Math.min(tabs.length - 1, Math.max(0, intent.count - 1));
          const next = tabs[index];
          if (next?.kind === "session") await this.selectAgent(next.id, true);
          else if (next?.kind === "draft") this.focusSessionDraft(next.id);
          else if (next?.kind === "terminal")
            await this.handleIntent({ type: "open-terminal", terminalId: next.id });
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
        if (intent.focus === "tree") this.beginSidebarNavigation();
        else this.apply({ type: "set-focus", focus: intent.focus });
        return;
      case "set-composer-mode":
        this.apply({ type: "set-composer-mode", mode: intent.mode });
        return;
      case "set-timeline-mode":
        this.apply({ type: "set-timeline-mode", mode: intent.mode });
        return;
      case "scroll-timeline":
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
      case "open-new-tab":
        if (
          intent.workspaceId === this.#state.selectedWorkspaceId &&
          this.activeWorkspace(intent.workspaceId) &&
          this.#state.modal.type === "none"
        )
          this.apply({
            type: "open-modal",
            modal: { type: "new-tab", workspaceId: intent.workspaceId },
          });
        return;
      case "new-tab-choice": {
        const modal = this.#state.modal;
        if (modal.type !== "new-tab" || intent.choice !== "session") return;
        const provider = this.#state.directory.providers.find((item) => item.ready);
        const model = provider ? defaultSelectableModel(provider) : undefined;
        if (!this.#state.sessionDrafts[modal.workspaceId])
          this.apply({ type: "open-session-draft", workspaceId: modal.workspaceId });
        const draft = this.#state.sessionDrafts[modal.workspaceId];
        if (draft && !draft.providerId && provider && model)
          this.apply({
            type: "set-session-draft",
            workspaceId: modal.workspaceId,
            changes: {
              providerId: provider.id,
              modelId: model.id,
              ...(provider.defaultModeId ? { modeId: provider.defaultModeId } : {}),
              ...(model.defaultThinkingLevel ? { thinkingLevel: model.defaultThinkingLevel } : {}),
            },
          });
        this.focusSessionDraft(modal.workspaceId);
        this.apply({ type: "close-modal" });
        return;
      }
      case "open-draft-setting": {
        const id = this.#state.selectedWorkspaceId;
        if (
          id &&
          activeSessionDraftWorkspaceId(this.#state) === id &&
          this.#state.modal.type === "none"
        )
          this.apply({
            type: "open-modal",
            modal: { type: "draft-setting", workspaceId: id, setting: intent.setting },
          });
        return;
      }
      case "draft-setting-choice": {
        const modal = this.#state.modal;
        if (modal.type !== "draft-setting") return;
        const draft = this.#state.sessionDrafts[modal.workspaceId];
        if (!draft) return;
        const provider = this.#state.directory.providers.find(
          (item) => item.id === (modal.setting === "provider" ? intent.choice : draft.providerId),
        );
        const model = provider?.models.find(
          (item) => item.id === (modal.setting === "model" ? intent.choice : draft.modelId),
        );
        if (modal.setting === "provider" && provider?.ready) {
          const defaultModel = defaultSelectableModel(provider);
          this.apply({
            type: "set-session-draft",
            workspaceId: modal.workspaceId,
            changes: {
              providerId: provider.id,
              modelId: defaultModel?.id,
              modeId: provider.defaultModeId,
              thinkingLevel: defaultModel?.defaultThinkingLevel,
              dirty: true,
              settingsDirty: true,
              error: undefined,
            },
          });
        } else if (modal.setting === "model" && model?.selectable)
          this.apply({
            type: "set-session-draft",
            workspaceId: modal.workspaceId,
            changes: {
              modelId: model.id,
              thinkingLevel: model.defaultThinkingLevel,
              dirty: true,
              settingsDirty: true,
              error: undefined,
            },
          });
        else if (modal.setting === "mode" && provider?.modeIds.includes(intent.choice))
          this.apply({
            type: "set-session-draft",
            workspaceId: modal.workspaceId,
            changes: { modeId: intent.choice, dirty: true, settingsDirty: true, error: undefined },
          });
        else if (modal.setting === "thinking" && model?.thinkingLevels.includes(intent.choice))
          this.apply({
            type: "set-session-draft",
            workspaceId: modal.workspaceId,
            changes: {
              thinkingLevel: intent.choice,
              dirty: true,
              settingsDirty: true,
              error: undefined,
            },
          });
        this.apply({ type: "close-modal" });
        return;
      }
      case "discard-session-draft": {
        const draft = this.#state.sessionDrafts[intent.workspaceId];
        if (!draft) return;
        if (draft.dirty)
          this.apply({
            type: "open-modal",
            modal: { type: "confirm", action: "discard-draft", workspaceId: intent.workspaceId },
          });
        else {
          const wasActive =
            this.#state.activeTabIds[intent.workspaceId] === `draft:${intent.workspaceId}`;
          this.apply({ type: "discard-session-draft", workspaceId: intent.workspaceId });
          if (wasActive) await this.showActiveResource();
        }
        return;
      }
      case "discard-session-draft-confirmed": {
        const wasActive =
          this.#state.activeTabIds[intent.workspaceId] === `draft:${intent.workspaceId}`;
        this.apply({ type: "discard-session-draft", workspaceId: intent.workspaceId });
        this.apply({ type: "close-modal" });
        if (wasActive) await this.showActiveResource();
        return;
      }
      case "submit-session-draft":
        await this.submitSessionDraft(intent.workspaceId, intent.prompt);
        return;
      case "creation-back":
        this.moveCreationBack();
        return;
      case "open-confirmation":
        {
          if (intent.action === "kill-terminal") {
            this.apply({
              type: "open-modal",
              modal: {
                type: "confirm",
                action: intent.action,
                ...(intent.terminalId ? { terminalId: intent.terminalId } : {}),
              },
            });
            return;
          }
          if (!intent.agentId) return;
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
        if (Object.values(this.#state.sessionDrafts).some((draft) => draft.dirty)) {
          this.apply({ type: "open-modal", modal: { type: "confirm", action: "quit" } });
          return;
        }
        await this.options.onQuit?.();
        return;
      case "quit-confirmed":
        await this.options.onQuit?.();
        return;
      case "close-modal":
        this.apply({ type: "close-modal" });
        return;
      case "toggle-timeline-item":
      case "move-timeline-selection":
      case "move-timeline-selection-boundary":
      case "move-timeline-text":
      case "move-timeline-landmark":
      case "open-timeline-search":
      case "open-timeline-copy":
      case "timeline-page":
      case "timeline-visual":
      case "timeline-search-text":
      case "timeline-repeat-search":
      case "timeline-yank":
      case "timeline-fold":
      case "toggle-selected-timeline-item":
        await this.options.onTimelineIntent?.(intent);
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
      case "open-create-terminal":
        if (intent.workspaceId)
          this.apply({
            type: "open-modal",
            modal: { type: "create-terminal", workspaceId: intent.workspaceId, name: "" },
          });
        return;
      case "set-terminal-name":
        this.apply({ type: "set-terminal-name", name: intent.name });
        return;
      case "submit-terminal-name": {
        if (this.#state.modal.type !== "create-terminal") return;
        const name = this.#state.modal.name.trim();
        if (!name || name.length > 64) {
          this.apply({
            type: "open-modal",
            modal: { ...this.#state.modal, error: "Enter a name between 1 and 64 characters." },
          });
          return;
        }
        await this.createWorkspaceTerminal(this.#state.modal.workspaceId, name);
        this.apply({ type: "close-modal" });
        return;
      }
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
      this.#state.selectedWorkspaceId ??
      this.#state.selectedProjectId;
    const current = rows.findIndex((row) => row.id === selectedId);
    const index = current === -1 ? (direction === 1 ? 0 : rows.length - 1) : current + direction;
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (row) await this.selectRow(row);
  }

  private beginSidebarNavigation(): void {
    const rows = deriveTreeRows(this.#state);
    const row =
      rows.find(
        (item) => item.kind === "workspace" && item.id === this.#state.selectedWorkspaceId,
      ) ?? rows[0];
    if (row) {
      this.apply({
        type: "select-sidebar",
        selection: { kind: row.kind, id: row.id },
        order: rows.map((item) => item.id),
      });
      return;
    }
    this.apply({ type: "set-focus", focus: "tree" });
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
        kind: row.kind,
        id: row.id,
      },
      order: deriveTreeRows(this.#state).map((item) => item.id),
    });
  }

  private collapseOrExpand(direction: -1 | 1): void {
    const selection = this.#state.sidebarSelection;
    const id = selection?.kind === "project" ? selection.id : undefined;
    if (!id) return;
    const expanded = this.#state.expandedIds.has(id);
    if ((direction === 1 && !expanded) || (direction === -1 && expanded)) {
      this.apply({ type: "toggle-expanded", id });
    }
  }

  private async openSelection(): Promise<void> {
    const selection = this.#state.sidebarSelection;
    if (selection?.kind === "workspace") {
      this.#focusGeneration += 1;
      const previous = this.#timelineObservation;
      this.#timelineObservation = undefined;
      this.#observedAgentId = undefined;
      void previous?.release();
      this.apply({ type: "activate-workspace", workspaceId: selection.id });
      await this.showActiveResource();
      this.apply({ type: "set-focus", focus: "tree" });
      return;
    }
    if (selection?.kind === "project") this.apply({ type: "toggle-expanded", id: selection.id });
  }

  private async showActiveResource(): Promise<void> {
    const active = this.#state.selectedWorkspaceId
      ? this.#state.activeTabIds[this.#state.selectedWorkspaceId]
      : undefined;
    if (active?.startsWith("session:")) await this.selectAgent(active.slice(8), true);
    else if (active?.startsWith("draft:")) this.focusSessionDraft(active.slice(6));
    else if (active?.startsWith("terminal:"))
      await this.handleIntent({ type: "open-terminal", terminalId: active.slice(9) });
    else {
      this.#focusGeneration += 1;
      const previous = this.#timelineObservation;
      this.#timelineObservation = undefined;
      this.#observedAgentId = undefined;
      void previous?.release();
    }
  }

  private focusSessionDraft(workspaceId: string): void {
    this.#focusGeneration += 1;
    const previous = this.#timelineObservation;
    this.#timelineObservation = undefined;
    this.#observedAgentId = undefined;
    void previous?.release();
    this.apply({ type: "open-session-draft", workspaceId });
  }

  private async discoverTerminals(workspaceId: string): Promise<void> {
    const terminals = await this.gateway.listTerminals(workspaceId);
    const previous =
      this.#state.selectedWorkspaceId === workspaceId
        ? this.#state.activeTabIds[workspaceId]
        : undefined;
    this.apply({ type: "set-terminals", workspaceId, terminals });
    const current =
      this.#state.selectedWorkspaceId === workspaceId
        ? this.#state.activeTabIds[workspaceId]
        : undefined;
    if (current !== previous) await this.showActiveResource();
  }

  private activeWorkspace(workspaceId: string): boolean {
    return this.#state.directory.workspaces.some(
      (workspace) => workspace.id === workspaceId && !workspace.archived,
    );
  }

  private async refresh(): Promise<void> {
    this.apply({ type: "refresh-sidebar-order" });
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
      await Promise.all(
        snapshot.workspaces.map((workspace) => this.discoverTerminals(workspace.id)),
      );
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

  private async submitSessionDraft(workspaceId: string, prompt: string): Promise<void> {
    const draft = this.#state.sessionDrafts[workspaceId];
    if (!draft || draft.submitting) return;
    const provider = this.#state.directory.providers.find(
      (item) => item.id === draft.providerId && item.ready,
    );
    const model = provider?.models.find((item) => item.id === draft.modelId && item.selectable);
    if (!prompt.trim() || !provider || !model || !this.isConnected()) {
      this.apply({
        type: "set-session-draft",
        workspaceId,
        changes: {
          error: !prompt.trim()
            ? "Write a first message before creating the session."
            : !provider || !model
              ? "Choose a provider and model before creating the session."
              : "Reconnect to Paseo, then press Enter to retry.",
        },
      });
      return;
    }
    this.apply({
      type: "set-session-draft",
      workspaceId,
      changes: { submitting: true, error: undefined, prompt, dirty: true },
    });
    try {
      const result = await this.gateway.execute({
        type: "create-agent",
        workspaceId,
        providerId: provider.id,
        modelId: model.id,
        prompt,
        ...(draft.modeId ? { modeId: draft.modeId } : {}),
        ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
      });
      if (result.type !== "agent-created")
        throw new Error("Paseo did not return the created session.");
      const keepFocus = activeSessionDraftWorkspaceId(this.#state) === workspaceId;
      if (!this.#state.directory.agents.some((agent) => agent.id === result.agentId))
        this.apply({
          type: "directory",
          update: {
            type: "agent-upserted",
            agent: {
              id: result.agentId,
              workspaceId,
              title: "New session",
              status: "starting",
              providerId: provider.id,
              modelId: model.id,
              ...(draft.modeId ? { modeId: draft.modeId } : {}),
              ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
              availableModeIds: [],
              availableThinkingLevels: [],
              pendingPermissions: [],
              needsAttention: false,
              archived: false,
            },
          },
        });
      this.apply({ type: "complete-session-draft", workspaceId, agentId: result.agentId });
      this.apply({
        type: "set-creation-default",
        workspaceId,
        value: {
          providerId: provider.id,
          modelId: model.id,
          ...(draft.modeId ? { modeId: draft.modeId } : {}),
          ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
        },
      });
      if (keepFocus) await this.selectAgent(result.agentId, true);
      this.apply({ type: "notify", message: `Created session ${shortId(result.agentId)}.` });
    } catch (error) {
      this.apply({
        type: "set-session-draft",
        workspaceId,
        changes: {
          submitting: false,
          error: `Could not create session: ${errorDetail(error)}. Press Enter to retry.`,
        },
      });
    }
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
    const previousTab = this.#state.selectedWorkspaceId
      ? this.#state.activeTabIds[this.#state.selectedWorkspaceId]
      : undefined;
    const observed =
      update.type === "connection-changed" && update.at === undefined
        ? { ...update, at: Date.now() }
        : update;
    this.apply({ type: "directory", update: observed });
    const currentTab = this.#state.selectedWorkspaceId
      ? this.#state.activeTabIds[this.#state.selectedWorkspaceId]
      : undefined;
    if (currentTab !== previousTab) void this.showActiveResource();
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

function defaultSelectableModel(
  provider: ProviderOption,
): ProviderOption["models"][number] | undefined {
  return (
    provider.models.find((item) => item.id === provider.defaultModelId && item.selectable) ??
    provider.models.find((item) => item.selectable)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof PaseoGatewayError
    ? error.message
    : redactTransportDetail(error instanceof Error ? error.message : String(error));
}

function sanitizeObservedTerminal(value: string): string {
  const esc = String.fromCharCode(0x1b);
  return sanitizeTerminalText(
    value
      .replaceAll(new RegExp(`${esc}\\][^\\u0007]*(?:\\u0007|${esc}\\\\)`, "g"), "")
      .replaceAll(new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, "g"), ""),
  );
}

function errorDetail(error: unknown): string {
  return error instanceof PaseoGatewayError
    ? (error.detail ?? error.message)
    : redactTransportDetail(error instanceof Error ? error.message : String(error));
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
