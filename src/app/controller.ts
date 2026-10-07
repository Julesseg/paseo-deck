import type {
  AppState,
  LaunchDraft,
  ModalState,
  PaseoFailureKind,
} from "../contracts/app-state.js";
import type { AgentCommand } from "../contracts/commands.js";
import type { DirectoryUpdate, ProviderOption } from "../contracts/domain.js";
import type { Observation, PaseoGateway } from "../contracts/gateway.js";
import type {
  TerminalCreateOptions,
  TerminalObservation,
  TerminalProfile,
  TerminalRecord,
} from "../contracts/terminal.js";
import { sessionSettingChoices } from "../domain/session-settings.js";
import { PaseoGatewayError, paseoFailure, redactTransportDetail } from "../paseo/errors.js";
import {
  activeSessionDraftWorkspaceId,
  composerAvailability,
  draftHasUnsentWork,
  hasUnsentWork,
} from "../state/composer.js";
import { activeLaunchWorkspaceId, launchDraft, NEW_WORKSPACE_DRAFT_ID } from "../state/launch.js";
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
  private confirmationSequence = 0;
  private readonly permissionDecisions = new Map<
    string,
    { lastDecision: "allow" | "deny"; error?: string; submitting: boolean }
  >();
  private quitting = false;
  private readonly inFlightConfirmations = new Set<number>();
  private readonly inFlightTargets = new Set<string>();
  private quitOrigin: AppState["modal"] | undefined;
  readonly #listeners = new Set<(state: AppState) => void>();
  #directoryObservation: Observation | undefined;
  #timelineObservation: Observation | undefined;
  #observedAgentId: string | undefined;
  #focusGeneration = 0;
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
    const initialStart = this.#state.selectedWorkspaceId === undefined;
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
      if (initialStart && !this.#state.activeTerminalId) {
        this.apply({ type: "set-composer-mode", mode: "normal" });
        this.apply({ type: "set-focus", focus: "composer" });
      }
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

  async createWorkspaceTerminal(
    workspaceId: string,
    options?: TerminalCreateOptions,
  ): Promise<boolean> {
    return this.activateCreatedTerminal(
      workspaceId,
      this.gateway.createTerminal(workspaceId, options),
    );
  }

  private async createWorkspaceProfileTerminal(
    workspaceId: string,
    profile: TerminalProfile,
  ): Promise<boolean> {
    return this.activateCreatedTerminal(
      workspaceId,
      this.gateway.createProfileTerminal(workspaceId, profile),
    );
  }

  private async activateCreatedTerminal(
    workspaceId: string,
    creation: Promise<TerminalRecord>,
  ): Promise<boolean> {
    try {
      const terminal = await creation;
      const existing = this.#state.workspaceTerminals?.[workspaceId] ?? [];
      this.apply({ type: "set-terminals", workspaceId, terminals: [...existing, terminal] });
      await this.handleIntent({ type: "open-terminal", terminalId: terminal.id });
      return this.#state.activeTerminalId === terminal.id;
    } catch (error) {
      this.apply({
        type: "notify",
        message: "Could not create workspace terminal.",
        detail: errorMessage(error),
        kind: "error",
      });
      return false;
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
        const captured = this.#state.modal;
        const targetKey = `kill-terminal:${intent.terminalId}`;
        const token =
          captured.type === "confirm" && captured.terminalId === intent.terminalId
            ? captured.id
            : undefined;
        if (token !== undefined && captured.type === "confirm") {
          if (this.inFlightTargets.has(targetKey)) {
            this.apply({
              type: "open-modal",
              modal: {
                ...captured,
                unavailableReason: "Request already in progress for this captured terminal.",
              },
            });
            return;
          }
          if (this.inFlightConfirmations.has(token) || captured.unavailableReason) return;
          if (
            !Object.values(this.#state.workspaceTerminals ?? {}).some((items) =>
              items.some((terminal) => terminal.id === intent.terminalId),
            ) ||
            this.#state.connection !== "connected"
          ) {
            this.apply({
              type: "open-modal",
              modal: {
                ...captured,
                unavailableReason: "Captured terminal is no longer available.",
              },
            });
            return;
          }
          this.inFlightConfirmations.add(token);
          this.inFlightTargets.add(targetKey);
          this.apply({ type: "open-modal", modal: { ...captured, busy: true } });
        }
        try {
          await this.gateway.killTerminal(intent.terminalId);
          await this.#terminalObservations.get(intent.terminalId)?.release();
          this.#terminalObservations.delete(intent.terminalId);
          const workspaceId = Object.entries(this.#state.workspaceTerminals ?? {}).find(
            ([, items]) => items.some((item) => item.id === intent.terminalId),
          )?.[0];
          if (workspaceId) await this.discoverTerminals(workspaceId);
          if (
            token === undefined
              ? this.#state.modal === captured
              : this.#state.modal.type === "confirm" && this.#state.modal.id === token
          )
            this.apply({ type: "close-modal" });
        } catch (error) {
          if (
            token !== undefined &&
            this.#state.modal.type === "confirm" &&
            this.#state.modal.id === token
          )
            this.apply({ type: "open-modal", modal: { ...this.#state.modal, busy: false } });
          this.apply({
            type: "notify",
            message: "Could not terminate terminal.",
            detail: errorMessage(error),
            kind: "error",
          });
        } finally {
          if (token !== undefined) this.inFlightConfirmations.delete(token);
          this.inFlightTargets.delete(targetKey);
        }
        return;
      }
      case "terminal-input":
        if (this.#state.activeTerminalId)
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
          if (
            intent.count !== undefined &&
            (!Number.isSafeInteger(intent.count) || intent.count < 1)
          )
            return;
          if (intent.count !== undefined && intent.direction === 1 && intent.count > tabs.length)
            return;
          const index =
            intent.count !== undefined && intent.direction === 1
              ? intent.count - 1
              : ((current < 0 ? (intent.direction === 1 ? -1 : 0) : current) +
                  ((intent.direction * (intent.count ?? 1)) % tabs.length) +
                  tabs.length) %
                tabs.length;
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
          !this.#state.newWorkspace &&
          intent.workspaceId === this.#state.selectedWorkspaceId &&
          this.activeWorkspace(intent.workspaceId) &&
          this.#state.modal.type === "none"
        ) {
          const opened: Extract<ModalState, { type: "new-tab" }> = {
            type: "new-tab",
            workspaceId: intent.workspaceId,
            profiles: [],
          };
          this.apply({
            type: "open-modal",
            modal: opened,
          });
          try {
            const profiles = await this.gateway.listTerminalProfiles();
            if ((this.#state.modal as ModalState) === opened)
              this.apply({
                type: "open-modal",
                modal: { type: "new-tab", workspaceId: intent.workspaceId, profiles },
              });
          } catch (error) {
            this.reportError("Could not load terminal profiles.", error);
          }
        }
        return;
      case "new-tab-choice": {
        const modal = this.#state.modal;
        if (modal.type !== "new-tab") return;
        if (intent.choice.kind === "terminal") {
          if (await this.createWorkspaceTerminal(modal.workspaceId))
            this.apply({ type: "close-modal" });
          return;
        }
        if (intent.choice.kind === "profile") {
          const profileId = intent.choice.profileId;
          const profile = modal.profiles?.find((item) => item.id === profileId);
          if (!profile) return;
          if (await this.createWorkspaceProfileTerminal(modal.workspaceId, profile))
            this.apply({ type: "close-modal" });
          return;
        }
        if (intent.choice.kind !== "session") return;
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
      case "open-session-setting": {
        if (
          this.#state.modal.type !== "none" ||
          this.#state.activeTerminalId ||
          !(
            (this.#state.focus === "composer" && this.#state.composerMode === "normal") ||
            (this.#state.focus === "timeline" && this.#state.timelineMode === "normal")
          )
        )
          return;
        if (activeSessionDraftWorkspaceId(this.#state) || activeLaunchWorkspaceId(this.#state)) {
          await this.handleIntent({ type: "open-draft-setting", setting: intent.setting });
        } else if (intent.setting !== "provider" && this.#state.selectedAgentId) {
          this.apply({
            type: "open-modal",
            modal: {
              type: "session-setting",
              agentId: this.#state.selectedAgentId,
              setting: intent.setting,
              ...(this.inFlightTargets.has(`settings:${this.#state.selectedAgentId}`)
                ? { busy: true }
                : {}),
            },
          });
        }
        return;
      }
      case "open-draft-setting": {
        const launchId = activeLaunchWorkspaceId(this.#state);
        const id = launchId ?? this.#state.selectedWorkspaceId;
        const launch = launchId ? launchDraft(this.#state, launchId) : undefined;
        if (launch && (launch.kind !== "session" || launch.createdAgentId)) return;
        if (
          id &&
          (activeSessionDraftWorkspaceId(this.#state) === id || launchId === id) &&
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
        const isLaunch = activeLaunchWorkspaceId(this.#state) === modal.workspaceId;
        const actionType = isLaunch ? "set-launch-draft" : "set-session-draft";
        const draft = isLaunch
          ? launchDraft(this.#state, modal.workspaceId)
          : this.#state.sessionDrafts[modal.workspaceId];
        if (!draft || draft.submitting) return;
        const selected =
          modal.setting === "provider"
            ? draft.providerId
            : modal.setting === "model"
              ? draft.modelId
              : modal.setting === "mode"
                ? draft.modeId
                : draft.thinkingLevel;
        if (selected === intent.choice) {
          this.apply({ type: "close-modal" });
          return;
        }
        const provider = this.#state.directory.providers.find(
          (item) => item.id === (modal.setting === "provider" ? intent.choice : draft.providerId),
        );
        const model = provider?.models.find(
          (item) => item.id === (modal.setting === "model" ? intent.choice : draft.modelId),
        );
        if (modal.setting === "provider" && provider?.ready) {
          const defaultModel = defaultSelectableModel(provider);
          this.apply({
            type: actionType,
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
            type: actionType,
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
            type: actionType,
            workspaceId: modal.workspaceId,
            changes: { modeId: intent.choice, dirty: true, settingsDirty: true, error: undefined },
          });
        else if (modal.setting === "thinking" && model?.thinkingLevels.includes(intent.choice))
          this.apply({
            type: actionType,
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
        if (draftHasUnsentWork(draft))
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
      case "open-new-workspace": {
        if (
          this.#state.focus !== "tree" ||
          this.#state.modal.type !== "none" ||
          this.#state.newWorkspace
        )
          return;
        const selection = this.#state.sidebarSelection;
        const projectId =
          selection?.kind === "project"
            ? selection.id
            : this.#state.directory.workspaces.find((workspace) => workspace.id === selection?.id)
                ?.projectId;
        this.apply({
          type: "set-new-workspace",
          draft: {
            projectId,
            placement: "local",
            title: "",
            launch: launchDraft(this.#state, NEW_WORKSPACE_DRAFT_ID),
          },
        });
        this.apply({ type: "set-focus", focus: "composer" });
        this.apply({ type: "set-composer-mode", mode: "normal" });
        await this.loadWorkspacePlacement();
        return;
      }
      case "open-new-workspace-placement":
      case "open-new-workspace-base": {
        const draft = this.#state.newWorkspace;
        if (
          !draft ||
          draft.launch.submitting ||
          draft.placementLoading ||
          !draft.placementOptions?.supportsWorktree ||
          this.#state.modal.type !== "none"
        )
          return;
        if (intent.type === "open-new-workspace-base" && draft.placement !== "worktree") return;
        this.apply({
          type: "open-modal",
          modal: {
            type:
              intent.type === "open-new-workspace-base"
                ? "new-workspace-base"
                : "new-workspace-placement",
          },
        });
        return;
      }
      case "new-workspace-placement-choice": {
        const draft = this.#state.newWorkspace;
        if (
          draft &&
          !draft.launch.submitting &&
          !draft.placementLoading &&
          (intent.placement === "local" || draft.placementOptions?.supportsWorktree)
        )
          this.apply({
            type: "set-new-workspace",
            draft: {
              ...draft,
              placement: intent.placement,
              launch: { ...draft.launch, error: undefined },
            },
          });
        this.apply({ type: "close-modal" });
        return;
      }
      case "new-workspace-base-choice": {
        const draft = this.#state.newWorkspace;
        if (
          draft &&
          !draft.launch.submitting &&
          draft.placementOptions?.refs.some((ref) => ref.ref === intent.ref)
        )
          this.apply({
            type: "set-new-workspace",
            draft: { ...draft, baseRef: intent.ref, launch: { ...draft.launch, error: undefined } },
          });
        this.apply({ type: "close-modal" });
        return;
      }
      case "open-new-workspace-project":
      case "open-new-workspace-title":
        if (
          this.#state.newWorkspace &&
          !this.#state.newWorkspace.launch.submitting &&
          this.#state.modal.type === "none"
        )
          this.apply({
            type: "open-modal",
            modal: {
              type:
                intent.type === "open-new-workspace-project"
                  ? "new-workspace-project"
                  : "new-workspace-title",
            },
          });
        return;
      case "new-workspace-project-choice":
        if (
          this.#state.newWorkspace &&
          !this.#state.newWorkspace.launch.submitting &&
          this.#state.directory.projects.some((project) => project.id === intent.projectId)
        ) {
          this.apply({
            type: "set-new-workspace",
            draft: {
              ...this.#state.newWorkspace,
              projectId: intent.projectId,
              launch: { ...this.#state.newWorkspace.launch, error: undefined },
            },
          });
          this.apply({ type: "close-modal" });
          await this.loadWorkspacePlacement();
        }
        return;
      case "set-new-workspace-title":
        if (this.#state.newWorkspace && !this.#state.newWorkspace.launch.submitting)
          this.apply({
            type: "set-new-workspace",
            draft: { ...this.#state.newWorkspace, title: intent.title },
          });
        this.apply({ type: "close-modal" });
        return;
      case "cancel-new-workspace":
        if (!this.#state.newWorkspace || this.#state.newWorkspace.launch.submitting) return;
        this.workspacePlacementGeneration += 1;
        this.apply({ type: "set-new-workspace", draft: undefined });
        this.apply({ type: "set-focus", focus: "tree" });
        return;
      case "toggle-launch-kind": {
        const id = activeLaunchWorkspaceId(this.#state);
        if (!id) return;
        const draft = launchDraft(this.#state, id);
        if (draft.submitting || draft.createdAgentId || draft.createdTerminal) return;
        this.apply({
          type: "set-launch-draft",
          workspaceId: id,
          changes: { kind: draft.kind === "session" ? "terminal" : "session", error: undefined },
        });
        return;
      }
      case "open-launch-profile": {
        const id = activeLaunchWorkspaceId(this.#state);
        if (!id) return;
        const draft = launchDraft(this.#state, id);
        if (draft.kind !== "terminal" || draft.submitting || draft.createdTerminal) return;
        try {
          const profiles = await this.gateway.listTerminalProfiles();
          this.apply({ type: "set-launch-draft", workspaceId: id, changes: { profiles } });
          if (activeLaunchWorkspaceId(this.#state) === id)
            this.apply({ type: "open-modal", modal: { type: "launch-profile", workspaceId: id } });
        } catch (error) {
          this.apply({
            type: "set-launch-draft",
            workspaceId: id,
            changes: {
              error: `Could not load terminal profiles: ${errorDetail(error)}. Press \\p to retry.`,
            },
          });
        }
        return;
      }
      case "launch-profile-choice": {
        const modal = this.#state.modal;
        if (modal.type !== "launch-profile") return;
        const draft = launchDraft(this.#state, modal.workspaceId);
        if (intent.profileId && !draft.profiles?.some((profile) => profile.id === intent.profileId))
          return;
        this.apply({
          type: "set-launch-draft",
          workspaceId: modal.workspaceId,
          changes: { profileId: intent.profileId || undefined, error: undefined },
        });
        this.apply({ type: "close-modal" });
        return;
      }
      case "submit-launch":
        await this.submitLaunch(intent.workspaceId, intent.prompt);
        return;
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
            ...(selected ? { noticeId: selected.id } : {}),
          },
        });
        return;
      }
      case "move-notification": {
        const modal = this.#state.modal;
        if (modal.type !== "notifications" || this.#state.notifications.length === 0) return;
        const index = Math.max(
          0,
          Math.min(
            this.#state.notifications.length - 1,
            (this.#state.notifications.findIndex((item) => item.id === modal.noticeId) >= 0
              ? this.#state.notifications.findIndex((item) => item.id === modal.noticeId)
              : modal.index) + intent.direction,
          ),
        );
        const notification = this.#state.notifications[index];
        if (!notification) return;
        this.apply({ type: "select-notification", id: notification.id });
        this.apply({
          type: "open-modal",
          modal: { type: "notifications", index, noticeId: notification.id },
        });
        return;
      }
      case "select-notification": {
        const modal = this.#state.modal;
        const notice = this.#state.notifications.find((item) => item.id === intent.id);
        if (!notice) return;
        this.apply({ type: "select-notification", id: notice.id });
        this.apply({
          type: "open-modal",
          modal: {
            type: "error-details",
            message: notice.message,
            detail: notice.detail ?? "",
            ...(modal.type === "notifications"
              ? { origin: { ...modal, noticeId: notice.id } }
              : {}),
          },
        });
        return;
      }
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
        if (this.#state.modal.type === "confirm" && this.#state.modal.action === "quit") return;
        if (hasUnsentWork(this.#state)) {
          this.quitOrigin = this.#state.modal;
          this.apply({ type: "open-modal", modal: { type: "confirm", action: "quit" } });
          return;
        }
        await this.options.onQuit?.();
        return;
      case "quit-confirmed":
        if (this.quitting) return;
        this.quitting = true;
        await this.options.onQuit?.();
        return;
      case "close-modal":
        if (this.#state.modal.type === "error-details" && this.#state.modal.origin) {
          this.apply({ type: "open-modal", modal: this.#state.modal.origin });
          return;
        }
        if (
          this.#state.modal.type === "confirm" &&
          this.#state.modal.action === "quit" &&
          this.quitOrigin
        ) {
          const modal = this.quitOrigin;
          this.quitOrigin = undefined;
          if (modal.type === "none") this.apply({ type: "close-modal" });
          else this.apply({ type: "open-modal", modal });
          return;
        }
        this.apply({ type: "close-modal" });
        return;
      case "toggle-timeline-item":
      case "move-timeline-selection":
      case "move-timeline-selection-boundary":
      case "move-timeline-text":
      case "timeline-find-character":
      case "timeline-repeat-find":
      case "timeline-viewport-motion":
      case "move-timeline-landmark":
      case "open-timeline-search":
      case "timeline-page":
      case "timeline-visual":
      case "timeline-search-text":
      case "timeline-repeat-search":
      case "timeline-yank":
      case "timeline-yank-object":
      case "timeline-open-link":
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
        await this.createWorkspaceTerminal(this.#state.modal.workspaceId, { name });
        this.apply({ type: "close-modal" });
        return;
      }
    }
  }

  private apply(action: AppAction): void {
    if (
      action.type === "open-modal" &&
      action.modal.type === "confirm" &&
      action.modal.id === undefined
    ) {
      const modal = action.modal;
      const label = modal.agentId
        ? (this.#state.directory.agents.find((agent) => agent.id === modal.agentId)?.title ??
          modal.agentId)
        : (modal.terminalId ?? modal.workspaceId);
      action = {
        ...action,
        modal: { ...modal, id: ++this.confirmationSequence, ...(label ? { label } : {}) },
      };
    }
    this.#state = reduceApp(this.#state, action);
    this.pruneRetries();
    for (const listener of this.#listeners) listener(this.#state);
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
        ...this.permissionDecisions.get(`${request.agentId}:${request.id}`),
      },
    });
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
      const id = activeLaunchWorkspaceId(this.#state);
      if (id && !this.#state.launchDrafts?.[id]?.profiles) {
        try {
          const profiles = await this.gateway.listTerminalProfiles();
          if (activeLaunchWorkspaceId(this.#state) === id)
            this.apply({ type: "set-launch-draft", workspaceId: id, changes: { profiles } });
        } catch (error) {
          if (activeLaunchWorkspaceId(this.#state) === id)
            this.apply({
              type: "set-launch-draft",
              workspaceId: id,
              changes: {
                error: `Could not load terminal profiles: ${errorDetail(error)}. Choose Terminal and press \\p to retry.`,
              },
            });
        }
      }
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

  private workspacePlacementGeneration = 0;

  private async loadWorkspacePlacement(): Promise<void> {
    const generation = ++this.workspacePlacementGeneration;
    const draft = this.#state.newWorkspace;
    if (!draft) return;
    const project = this.#state.directory.projects.find((item) => item.id === draft.projectId);
    this.apply({
      type: "set-new-workspace",
      draft: {
        ...draft,
        placement: "local",
        placementOptions: { supportsWorktree: false, refs: [] },
        baseRef: undefined,
        placementError: undefined,
        placementLoading: Boolean(project?.path),
      },
    });
    if (!project?.path) return;
    try {
      const options = await this.gateway.getWorkspacePlacement(project.path);
      const current = this.#state.newWorkspace;
      if (!current || generation !== this.workspacePlacementGeneration) return;
      this.apply({
        type: "set-new-workspace",
        draft: {
          ...current,
          placement: options.supportsWorktree ? "worktree" : "local",
          placementOptions: options,
          baseRef: options.defaultRef,
          placementLoading: false,
        },
      });
    } catch (error) {
      const current = this.#state.newWorkspace;
      if (!current || generation !== this.workspacePlacementGeneration) return;
      this.apply({
        type: "set-new-workspace",
        draft: {
          ...current,
          placementLoading: false,
          placementError: errorDetail(error),
          launch: {
            ...current.launch,
            error: `Could not load workspace placement: ${errorDetail(error)}`,
          },
        },
      });
    }
  }

  private async submitNewWorkspace(prompt: string): Promise<void> {
    let draft = this.#state.newWorkspace;
    if (!draft || draft.launch.submitting || draft.placementLoading) return;
    if (draft.placementError) {
      this.apply({
        type: "set-launch-draft",
        workspaceId: NEW_WORKSPACE_DRAFT_ID,
        changes: { [draft.launch.kind === "session" ? "prompt" : "command"]: prompt },
      });
      const generation = this.workspacePlacementGeneration + 1;
      await this.loadWorkspacePlacement();
      draft = this.#state.newWorkspace;
      if (!draft || draft.placementError || generation !== this.workspacePlacementGeneration)
        return;
    }
    const project = this.#state.directory.projects.find((item) => item.id === draft.projectId);
    const provider = this.#state.directory.providers.find(
      (item) => item.id === draft.launch.providerId && item.ready,
    );
    const model = provider?.models.find(
      (item) => item.id === draft.launch.modelId && item.selectable,
    );
    const terminalInput = validateTerminalLaunchInput(draft.launch, prompt);
    const error = !project?.path
      ? "Choose a project with an original checkout directory."
      : draft.placement === "worktree" &&
          !draft.placementOptions?.refs.some((ref) => ref.ref === draft.baseRef)
        ? "Choose an available Base ref."
        : !this.isConnected()
          ? "Reconnect to Paseo, then retry."
          : draft.launch.kind === "session"
            ? !prompt.trim()
              ? "Write a first message before creating a workspace."
              : !provider || !model
                ? "Choose an available provider and model."
                : undefined
            : terminalInput.error === "command"
              ? "Enter one command without control characters or line breaks, then retry."
              : terminalInput.error === "profile"
                ? "Choose an available terminal profile."
                : undefined;
    if (error || !project?.path) {
      this.apply({
        type: "set-launch-draft",
        workspaceId: NEW_WORKSPACE_DRAFT_ID,
        changes: { error, [draft.launch.kind === "session" ? "prompt" : "command"]: prompt },
      });
      return;
    }
    this.apply({
      type: "set-launch-draft",
      workspaceId: NEW_WORKSPACE_DRAFT_ID,
      changes: {
        submitting: true,
        [draft.launch.kind === "session" ? "prompt" : "command"]: prompt,
        error: undefined,
      },
    });
    try {
      const workspace = await this.gateway.createWorkspace({
        projectId: project.id,
        directory: project.path,
        ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
        ...(draft.placement === "worktree" && draft.baseRef
          ? {
              baseRef: draft.baseRef,
              ...((draft.launch.kind === "session" ? prompt : draft.title.trim())
                ? {
                    firstAgentPrompt: draft.launch.kind === "session" ? prompt : draft.title.trim(),
                  }
                : {}),
            }
          : {}),
      });
      this.apply({ type: "directory", update: { type: "workspace-upserted", workspace } });
      this.apply({
        type: "set-launch-draft",
        workspaceId: workspace.id,
        changes: {
          ...draft.launch,
          [draft.launch.kind === "session" ? "prompt" : "command"]: prompt,
          submitting: false,
          error: undefined,
        },
      });
      this.apply({ type: "set-new-workspace", draft: undefined });
      this.#focusGeneration += 1;
      const previous = this.#timelineObservation;
      this.#timelineObservation = undefined;
      this.#observedAgentId = undefined;
      void previous?.release();
      this.apply({ type: "activate-workspace", workspaceId: workspace.id });
      this.apply({ type: "reveal-workspace", workspaceId: workspace.id });
      this.apply({ type: "set-focus", focus: "composer" });
      await this.submitLaunch(workspace.id, prompt);
    } catch (error) {
      this.apply({
        type: "set-launch-draft",
        workspaceId: NEW_WORKSPACE_DRAFT_ID,
        changes: {
          submitting: false,
          error: `Could not create workspace: ${errorDetail(error)}. Press \\s to retry.`,
        },
      });
    }
  }

  private async submitLaunch(workspaceId: string, prompt: string): Promise<void> {
    if (workspaceId === NEW_WORKSPACE_DRAFT_ID) return this.submitNewWorkspace(prompt);
    if (
      !this.activeWorkspace(workspaceId) ||
      activeLaunchWorkspaceId({ ...this.#state, selectedWorkspaceId: workspaceId }) !== workspaceId
    )
      return;
    const draft = launchDraft(this.#state, workspaceId);
    if (draft.submitting) return;
    const update = (changes: Partial<import("../contracts/app-state.js").LaunchDraft>): void => {
      this.apply({ type: "set-launch-draft", workspaceId, changes });
    };
    if (draft.kind === "terminal") {
      const terminalInput = validateTerminalLaunchInput(draft, prompt);
      if (!this.isConnected() || terminalInput.error === "command") {
        update({
          error: !this.isConnected()
            ? "Reconnect to Paseo, then press \\s to retry."
            : "Enter one command without control characters or line breaks, then retry.",
        });
        return;
      }
      update({ submitting: true, command: prompt, error: undefined });
      try {
        let terminal = draft.createdTerminal;
        if (!terminal) {
          const { profile } = terminalInput;
          if (terminalInput.error === "profile")
            throw new Error("Choose an available terminal profile");
          terminal = profile
            ? await this.gateway.createProfileTerminal(workspaceId, profile)
            : await this.gateway.createTerminal(workspaceId);
          update({ createdTerminal: terminal });
        }
        this.gateway.sendTerminalInput(terminal.id, `${prompt}\r`);
        const keepFocus = activeLaunchWorkspaceId(this.#state) === workspaceId;
        this.apply({
          type: "set-terminals",
          workspaceId,
          terminals: [
            ...(this.#state.workspaceTerminals?.[workspaceId] ?? []).filter(
              (item) => item.id !== terminal.id,
            ),
            terminal,
          ],
        });
        this.apply({ type: "complete-launch", workspaceId });
        if (keepFocus) await this.handleIntent({ type: "open-terminal", terminalId: terminal.id });
      } catch (error) {
        update({
          submitting: false,
          error: `Could not launch terminal: ${errorDetail(error)}. Press \\s to retry.`,
        });
      }
      return;
    }
    const provider = this.#state.directory.providers.find(
      (item) => item.id === draft.providerId && item.ready,
    );
    const model = provider?.models.find((item) => item.id === draft.modelId && item.selectable);
    if (!prompt.trim() || !provider || !model || !this.isConnected()) {
      update({
        error: !prompt.trim()
          ? "Write a first message before launching."
          : !provider || !model
            ? "Choose an available provider and model."
            : "Reconnect to Paseo, then press \\s to retry.",
      });
      return;
    }
    update({ submitting: true, prompt, error: undefined });
    try {
      let agentId = draft.createdAgentId;
      if (!agentId) {
        const result = await this.gateway.execute({
          type: "create-agent",
          workspaceId,
          providerId: provider.id,
          modelId: model.id,
          prompt: "",
          ...(draft.modeId ? { modeId: draft.modeId } : {}),
          ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
        });
        if (result.type !== "agent-created")
          throw new Error("Paseo did not return the created session.");
        agentId = result.agentId;
        update({ createdAgentId: agentId });
      }
      await this.gateway.execute({ type: "send-prompt", agentId, prompt });
      const keepFocus = activeLaunchWorkspaceId(this.#state) === workspaceId;
      if (!this.#state.directory.agents.some((agent) => agent.id === agentId))
        this.apply({
          type: "directory",
          update: {
            type: "agent-upserted",
            agent: {
              id: agentId,
              workspaceId,
              title: "New session",
              status: "starting",
              providerId: provider.id,
              modelId: model.id,
              availableModeIds: [],
              availableThinkingLevels: [],
              pendingPermissions: [],
              needsAttention: false,
              archived: false,
            },
          },
        });
      this.apply({ type: "complete-launch", workspaceId });
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
      if (keepFocus) await this.selectAgent(agentId, true);
    } catch (error) {
      update({
        submitting: false,
        error: `Could not launch session: ${errorDetail(error)}. Press \\s to retry.`,
      });
    }
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
    const origin = this.#state.modal;
    if (command.type === "rename-agent") {
      const name = command.name.trim();
      if (!name || /[\p{Cc}\p{Cs}]/u.test(name)) return;
      const agentId = command.agentId;
      const target = this.#state.directory.agents.find((agent) => agent.id === agentId);
      if (!target) return;
      if (name === target.title) {
        if (origin.type === "rename" && origin.agentId === command.agentId)
          this.apply({ type: "close-modal" });
        return;
      }
      command = { ...command, name };
    }
    const confirmation =
      origin.type === "confirm" && "agentId" in command && origin.agentId === command.agentId
        ? origin
        : undefined;
    const token = confirmation?.id;
    const targetKey = confirmation ? `${command.type}:${confirmation.agentId}` : undefined;
    if (token !== undefined && confirmation) {
      if (targetKey && this.inFlightTargets.has(targetKey)) {
        this.apply({
          type: "open-modal",
          modal: {
            ...confirmation,
            unavailableReason: "Request already in progress for this captured session.",
          },
        });
        return;
      }
      if (this.inFlightConfirmations.has(token) || confirmation?.unavailableReason) return;
      if (
        this.#state.connection !== "connected" ||
        !this.#state.directory.agents.some(
          (agent) => agent.id === confirmation.agentId && !agent.archived,
        )
      ) {
        this.apply({
          type: "open-modal",
          modal: { ...confirmation, unavailableReason: "Captured session is no longer available." },
        });
        return;
      }
      this.inFlightConfirmations.add(token);
      if (targetKey) this.inFlightTargets.add(targetKey);
      this.apply({ type: "open-modal", modal: { ...confirmation, busy: true } });
    }
    try {
      const result = await this.gateway.execute(command);
      if (command.type === "detach-agent")
        this.apply({ type: "composer-detached", agentId: command.agentId });
      if (
        token === undefined
          ? this.#state.modal === origin
          : this.#state.modal.type === "confirm" && this.#state.modal.id === token
      )
        this.apply({ type: "close-modal" });
      this.apply({
        type: "notify",
        message:
          result.type === "agent-created" ? `Created agent ${shortId(result.agentId)}.` : "Done.",
      });
    } catch (error) {
      if (
        token !== undefined &&
        this.#state.modal.type === "confirm" &&
        this.#state.modal.id === token
      )
        this.apply({ type: "open-modal", modal: { ...this.#state.modal, busy: false } });
      this.reportError(
        "The Paseo command failed.",
        error,
        this.registerRetry({ type: "command", command }),
        "command",
      );
    } finally {
      if (token !== undefined) this.inFlightConfirmations.delete(token);
      if (targetKey) this.inFlightTargets.delete(targetKey);
    }
  }

  private async respondPermission(
    agentId: string,
    requestId: string,
    allow: boolean,
  ): Promise<void> {
    const target = `permission:${agentId}:${requestId}`;
    if (
      this.inFlightTargets.has(target) ||
      !pendingPermissions(this.#state).some(
        (item) => item.agentId === agentId && item.id === requestId,
      )
    )
      return;
    this.inFlightTargets.add(target);
    const decision = {
      lastDecision: allow ? ("allow" as const) : ("deny" as const),
      submitting: true,
    };
    this.permissionDecisions.set(`${agentId}:${requestId}`, decision);
    this.apply({
      type: "permission-submitting",
      agentId,
      requestId,
      allow: allow ? "allow" : "deny",
    });
    try {
      await this.gateway.execute({ type: "respond-permission", agentId, requestId, allow });
    } catch (error) {
      this.permissionDecisions.set(`${agentId}:${requestId}`, {
        ...decision,
        submitting: false,
        error: errorDetail(error),
      });
      this.apply({ type: "permission-failed", agentId, requestId, error: errorDetail(error) });
    } finally {
      this.inFlightTargets.delete(target);
    }
  }

  private async applyChoice(choice: string): Promise<void> {
    const modal = this.#state.modal;
    if (modal.type === "session-setting") {
      if (modal.busy || this.inFlightTargets.has(`settings:${modal.agentId}`)) return;
      const agent = this.#state.directory.agents.find((item) => item.id === modal.agentId);
      const selected =
        modal.setting === "model"
          ? agent?.modelId
          : modal.setting === "mode"
            ? agent?.modeId
            : agent?.thinkingLevel;
      const choiceItem = sessionSettingChoices(
        this.#state.directory,
        agent,
        modal.setting,
        this.#state.connection !== "connected"
          ? "Disconnected"
          : this.#state.composer.sendingAgentIds.has(modal.agentId)
            ? "Session is busy"
            : undefined,
      ).find((item) => item.value === choice);
      if (!choiceItem || choiceItem.disabled) return;
      if (choice === selected) {
        this.apply({ type: "close-modal" });
        return;
      }
      const model = this.#state.directory.providers
        .find((item) => item.id === agent?.providerId)
        ?.models.find((item) => item.id === choice);
      const command: AgentCommand =
        modal.setting === "model"
          ? {
              type: "set-agent-model",
              agentId: modal.agentId,
              modelId: choice,
              thinkingLevel: model?.defaultThinkingLevel ?? null,
            }
          : modal.setting === "mode"
            ? { type: "set-agent-mode", agentId: modal.agentId, modeId: choice }
            : { type: "set-thinking-level", agentId: modal.agentId, thinkingLevel: choice };
      const busy = { ...modal, busy: true };
      this.inFlightTargets.add(`settings:${modal.agentId}`);
      this.apply({ type: "open-modal", modal: busy });
      let failure: unknown;
      let refreshed = false;
      let notice: string | undefined;
      try {
        const result = await this.gateway.execute(command);
        if (result.type === "ok") notice = result.notice;
      } catch (error) {
        failure = error;
      }
      try {
        const snapshot = await this.gateway.getDirectorySnapshot();
        this.apply({ type: "directory", update: { type: "snapshot", snapshot } });
        refreshed = true;
      } catch (error) {
        failure ??= error;
      }
      this.inFlightTargets.delete(`settings:${modal.agentId}`);
      if (
        this.#state.modal !== busy &&
        this.#state.modal.type === "session-setting" &&
        this.#state.modal.agentId === modal.agentId &&
        this.#state.modal.busy
      )
        this.apply({ type: "open-modal", modal: { ...this.#state.modal, busy: false } });
      if (failure) {
        if (this.#state.modal === busy)
          this.apply({
            type: "open-modal",
            modal: {
              ...modal,
              error: refreshed
                ? "Request failed; confirmed state refreshed"
                : "Request failed; state refresh unavailable",
            },
          });
        this.reportError(
          "Settings request failed; some changes may have applied. Review confirmed settings before retrying.",
          failure,
          undefined,
          "command",
        );
      } else {
        if (this.#state.modal === busy) this.apply({ type: "close-modal" });
        if (notice) this.apply({ type: "notify", message: notice });
      }
      return;
    }
    if (modal.type === "filter") {
      this.apply({ type: "set-filter", filter: choice });
      this.apply({ type: "close-modal" });
      return;
    }
    if (modal.type === "mode" || modal.type === "thinking") {
      const agent = this.#state.directory.agents.find((item) => item.id === modal.agentId);
      const selected = modal.type === "mode" ? agent?.modeId : agent?.thinkingLevel;
      if (choice === selected) {
        this.apply({ type: "close-modal" });
        return;
      }
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
    const retryGeneration = this.#nextRetryToken;
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
      const failed = [...this.#retryOperations.entries()].some(
        ([token, next]) =>
          token > retryGeneration &&
          JSON.stringify(next.operation) === JSON.stringify(entry.operation),
      );
      entry.completed = !failed;
      if (!failed) {
        this.#retryOperations.delete(retry.token);
        this.apply({ type: "notification-retry-completed", token: retry.token });
      }
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

function validateTerminalLaunchInput(
  draft: LaunchDraft,
  command: string,
): { profile: TerminalProfile | undefined; error: "command" | "profile" | undefined } {
  const profile = draft.profiles?.find((item) => item.id === draft.profileId);
  const invalidCommand =
    !command.trim() ||
    Array.from(command).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    });
  return {
    profile,
    error: invalidCommand ? "command" : draft.profileId && !profile ? "profile" : undefined,
  };
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
