import {
  type Component,
  Editor,
  type Focusable,
  HStack,
  Input,
  Markdown,
  matchesKey,
  type OverlayHandle,
  ScrollView,
  type SelectItem,
  SelectList,
  type Terminal,
  type TUI,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";

import type { AppState, ModalState } from "../contracts/app-state.js";
import type { TimelineEvent, TimelineItem } from "../contracts/domain.js";
import { composerAvailability, selectedComposerDraft } from "../state/composer.js";
import { DeckController, type UiIntent } from "./controller.js";
import { TerminalLifecycle } from "./terminal.js";
import { deriveTreeRows, shortAgentId, timelineItemDisplay } from "./view-model.js";

const plain = (value: string): string => value;
const markdownTheme = {
  heading: plain,
  link: plain,
  linkUrl: plain,
  code: plain,
  codeBlock: plain,
  codeBlockBorder: plain,
  quote: plain,
  quoteBorder: plain,
  hr: plain,
  listBullet: plain,
  bold: plain,
  italic: plain,
  strikethrough: plain,
  underline: plain,
  highlightCode: highlightFencedCode,
};
const selectTheme = {
  selectedPrefix: plain,
  selectedText: plain,
  description: plain,
  scrollInfo: plain,
  noMatch: plain,
};

class TreeView implements Component {
  constructor(private state: AppState) {}
  update(state: AppState): void {
    this.state = state;
  }
  invalidate(): void {}
  render(width: number): string[] {
    return [
      "Projects / workspaces",
      ...deriveTreeRows(this.state).map((row) => {
        const selected = row.selected ? ">" : " ";
        const branch = row.kind === "agent" ? "•" : row.expanded ? "▾" : "▸";
        const flags =
          row.kind === "agent"
            ? `${row.permissionCount ? " ✓" : ""}${row.attention ? " !" : ""}${row.status ? ` ${row.status}` : ""}`
            : "";
        return clip(`${selected}${"  ".repeat(row.depth)}${branch} ${row.label}${flags}`, width);
      }),
    ];
  }
}

class TimelineItemView implements Component {
  private item: TimelineItem;
  private readonly markdown?: Markdown;
  constructor(
    item: TimelineItem,
    private expanded: boolean,
  ) {
    this.item = item;
    if (item.type === "user-message" || item.type === "assistant-message")
      this.markdown = new Markdown(item.text, 2, 0, markdownTheme);
  }
  update(item: TimelineItem, expanded: boolean): void {
    this.item = item;
    this.expanded = expanded;
    if (this.markdown && (item.type === "user-message" || item.type === "assistant-message"))
      this.markdown.setText(item.text);
  }
  invalidate(): void {
    this.markdown?.invalidate();
  }
  render(width: number): string[] {
    if (
      this.markdown &&
      (this.item.type === "user-message" || this.item.type === "assistant-message")
    )
      return [
        this.item.type === "user-message" ? "You" : "Assistant",
        ...this.markdown.render(width),
      ];
    return timelineItemDisplay(this.item, width, this.expanded);
  }
}

class TimelineView implements Component {
  private readonly itemViews = new Map<string, TimelineItemView>();
  private events: readonly TimelineEvent[] = [];
  private expanded = new Set<string>();
  private heading = "Selected agent timeline";
  private selectedIndex = 0;
  updateSelection(state: AppState): void {
    const selected = state.directory.agents.find((agent) => agent.id === state.selectedAgentId);
    this.heading = selected
      ? `Selected agent timeline · ${selected.title} [${shortAgentId(selected.id)}]`
      : "Selected agent timeline";
  }
  update(events: readonly TimelineEvent[]): void {
    this.events = events;
    const ids = new Set(events.map((event) => event.item.id));
    for (const id of this.itemViews.keys()) if (!ids.has(id)) this.itemViews.delete(id);
    for (const event of events) {
      const current = this.itemViews.get(event.item.id);
      if (current) current.update(event.item, this.expanded.has(event.item.id));
      else
        this.itemViews.set(
          event.item.id,
          new TimelineItemView(event.item, this.expanded.has(event.item.id)),
        );
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, events.length - 1));
  }
  moveSelection(direction: -1 | 1): void {
    if (this.events.length === 0) return;
    this.selectedIndex = Math.max(
      0,
      Math.min(this.events.length - 1, this.selectedIndex + direction),
    );
  }
  toggleSelected(): void {
    const selected = this.events[this.selectedIndex];
    if (selected) this.toggle(selected.item.id);
  }
  toggle(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    const event = this.events.find((candidate) => candidate.item.id === id);
    if (event) this.itemViews.get(id)?.update(event.item, this.expanded.has(id));
  }
  invalidate(): void {
    for (const item of this.itemViews.values()) item.invalidate();
  }
  render(width: number): string[] {
    const heading = width < 18 ? "Timeline" : this.heading;
    if (this.events.length === 0) return [heading, "No timeline selected."];
    return [
      heading,
      ...this.events.flatMap((event, index) => {
        const lines = this.itemViews.get(event.item.id)?.render(width) ?? [];
        if (index === this.selectedIndex && lines[0]) lines[0] = `> ${lines[0]}`;
        return lines;
      }),
    ];
  }
}

class ComposerView implements Component, Focusable {
  focused = false;
  private readonly editor: Editor;
  private selectedAgentId: string | undefined;
  private state: AppState;
  constructor(tui: TUI, state: AppState, emit: (intent: UiIntent) => void) {
    this.state = state;
    this.selectedAgentId = state.selectedAgentId;
    this.editor = new Editor(tui, { borderColor: plain, selectList: selectTheme }, { paddingX: 1 });
    this.editor.setText(selectedComposerDraft(state));
    this.editor.onChange = (text) => emit({ type: "set-composer-text", text });
    this.editor.onSubmit = (prompt) => {
      if (this.selectedAgentId && prompt.trim())
        emit({ type: "submit-composer", agentId: this.selectedAgentId, prompt });
    };
  }
  update(state: AppState): void {
    this.state = state;
    this.selectedAgentId = state.selectedAgentId;
    const draft = selectedComposerDraft(state);
    if (this.editor.getText() !== draft) this.editor.setText(draft);
  }
  invalidate(): void {
    this.editor.invalidate();
  }
  render(width: number): string[] {
    this.editor.focused = this.focused;
    const agent = this.state.directory.agents.find((item) => item.id === this.selectedAgentId);
    const availability = this.selectedAgentId
      ? composerAvailability(this.state, this.selectedAgentId)
      : { canSend: false as const, reason: "missing" as const };
    const destination = agent ? `Prompt → ${agent.title}` : "Prompt → no agent selected";
    const status =
      this.selectedAgentId && this.state.composer.sendingAgentIds.has(this.selectedAgentId)
        ? " · sending…"
        : !availability.canSend
          ? ` · ${availability.reason}`
          : "";
    return [clip(`${destination}${status}`, width), ...this.editor.render(width)];
  }
  handleInput(data: string): void {
    this.editor.handleInput(data);
  }
}

class StatusView implements Component {
  constructor(private state: AppState) {}
  update(state: AppState): void {
    this.state = state;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const selected = this.state.directory.agents.find(
      (agent) => agent.id === this.state.selectedAgentId,
    );
    const usage = this.state.timeline.usage ?? selected?.lastUsage;
    const usageDetails = usage
      ? [
          usage.contextTokens !== undefined
            ? `context ${usage.contextTokens}${usage.contextWindow ? `/${usage.contextWindow}` : ""}`
            : undefined,
          usage.inputTokens !== undefined ? `in ${usage.inputTokens}` : undefined,
          usage.outputTokens !== undefined ? `out ${usage.outputTokens}` : undefined,
        ]
          .filter(Boolean)
          .join(" · ")
      : undefined;
    const details = selected
      ? `${selected.providerId ?? "unknown"}/${selected.modelId ?? "unknown"}${selected.modeId ? ` · ${selected.modeId}` : ""}${selected.thinkingLevel ? ` · ${selected.thinkingLevel}` : ""}${usageDetails ? ` · ${usageDetails}` : ""}`
      : "no agent selected";
    const permissions = this.state.directory.agents.reduce(
      (total, agent) => total + agent.pendingPermissions.length,
      0,
    );
    const compact = width < 70;
    const notification = this.state.notification
      ? ` · ${this.state.notification.kind}: ${this.state.notification.message}${this.state.notification.detail ? " · E details" : ""}`
      : "";
    return [
      clip(
        `${this.state.connection}${compact ? "" : ` · ${details} · permissions ${permissions}`}${notification}`,
        width,
      ),
    ];
  }
}

class Dialog implements Component, Focusable {
  focused = false;
  constructor(
    private readonly lines: readonly string[],
    private readonly onKey: (data: string) => boolean,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    return this.lines.map((line) => clip(line, width));
  }
  handleInput(data: string): void {
    this.onKey(data);
  }
}

class InputDialog implements Component, Focusable {
  focused = false;
  private readonly input = new Input();
  constructor(
    private readonly title: string,
    value: string,
    submit: (value: string) => void,
    private readonly cancel: () => void,
  ) {
    this.input.setValue(value);
    this.input.onSubmit = submit;
  }
  invalidate(): void {
    this.input.invalidate();
  }
  render(width: number): string[] {
    this.input.focused = this.focused;
    return [clip(this.title, width), ...this.input.render(width), "Enter confirm · Esc cancel"];
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.cancel();
    else this.input.handleInput(data);
  }
}

class ChoiceDialog implements Component {
  private readonly list: SelectList;
  constructor(
    title: string,
    items: SelectItem[],
    choose: (value: string) => void,
    cancel: () => void,
  ) {
    this.list = new SelectList(items, 8, selectTheme);
    this.list.onSelect = (item) => choose(item.value);
    this.list.onCancel = cancel;
    this.title = title;
  }
  private readonly title: string;
  invalidate(): void {
    this.list.invalidate();
  }
  render(width: number): string[] {
    return [clip(this.title, width), ...this.list.render(width)];
  }
  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}

/** Bridges immutable store state to reusable pi-tui components and modal overlays. */
export class DeckTui {
  readonly tui: TuiAltScreen;
  private readonly lifecycle: TerminalLifecycle;
  private readonly controller: DeckController;
  private readonly tree: TreeView;
  private readonly timeline = new TimelineView();
  private readonly composer: ComposerView;
  private readonly status: StatusView;
  private overlay: OverlayHandle | undefined;
  private modalKey = "";
  private state: AppState;

  constructor(
    terminal: Terminal,
    initialState: AppState,
    private readonly emit: (intent: UiIntent) => void,
  ) {
    this.state = initialState;
    this.tui = new TuiAltScreen(terminal, undefined, undefined, {
      scrollToEndIndicator: () => "↓ End",
    });
    this.lifecycle = new TerminalLifecycle(this.tui, terminal);
    this.controller = new DeckController(
      () => this.state,
      (intent) => this.handleControllerIntent(intent),
    );
    this.tree = new TreeView(initialState);
    this.timeline.update(initialState.timeline.items);
    this.timeline.updateSelection(initialState);
    this.composer = new ComposerView(this.tui, initialState, emit);
    this.status = new StatusView(initialState);
    const transcript = new ScrollView(this.timeline, {
      follow: "end",
      primary: true,
      scrollbar: "auto",
    });
    this.tui.setLayoutRoot(
      new VStack([
        {
          component: new HStack(
            [
              { component: this.tree, basis: 30, shrink: 1, minSize: 18 },
              { component: transcript, basis: 0, grow: 1, minSize: 12 },
            ],
            { gap: 2 },
          ),
          basis: 0,
          grow: 1,
          minSize: 3,
        },
        { component: this.composer, basis: "auto", minSize: 3 },
        { component: this.status, basis: 1, minSize: 1 },
      ]),
    );
    this.tui.addInputListener((data) =>
      this.controller.handleKey(data) ? { consume: true } : undefined,
    );
  }

  start(): void {
    this.lifecycle.start();
  }
  async stop(): Promise<void> {
    await this.lifecycle.stop();
  }
  update(state: AppState): void {
    this.state = state;
    this.tree.update(state);
    this.timeline.update(state.timeline.items);
    this.timeline.updateSelection(state);
    this.composer.update(state);
    this.status.update(state);
    this.tui.setFocus(state.focus === "composer" ? this.composer : null);
    this.syncModal();
    this.tui.requestRender();
  }
  toggleTimelineItem(itemId: string): void {
    this.timeline.toggle(itemId);
    this.emit({ type: "toggle-timeline-item", itemId });
    this.tui.requestRender();
  }

  private handleControllerIntent(intent: UiIntent): void {
    if (intent.type === "move-timeline-selection") {
      this.timeline.moveSelection(intent.direction);
      this.tui.requestRender();
      return;
    }
    if (intent.type === "toggle-selected-timeline-item") {
      this.timeline.toggleSelected();
      this.tui.requestRender();
      return;
    }
    this.emit(intent);
  }

  private syncModal(): void {
    const key = JSON.stringify(this.state.modal);
    if (key === this.modalKey) return;
    this.overlay?.unfocus({ target: this.state.focus === "composer" ? this.composer : null });
    this.overlay?.hide();
    this.overlay = undefined;
    this.modalKey = key;
    const modal = this.state.modal;
    if (modal.type === "none") return;
    const close = (): void => this.emit({ type: "close-modal" });
    let component: Component;
    if (modal.type === "help")
      component = new Dialog(
        [
          "Paseo Deck keys",
          "j/k move · h/l collapse/expand · Enter open · Tab focus",
          "i compose · n new · / filter · p permissions · r refresh",
          "x stop · A archive · d detach · e rename · m mode · t thinking",
          "? help · E error details · q quit · Esc cancel",
        ],
        (data) => {
          if (matchesKey(data, "escape") || data === "?") close();
          return true;
        },
      );
    else if (modal.type === "filter")
      component = new InputDialog(
        "Filter sessions",
        modal.query,
        (value) => this.emit({ type: "create-choice", choice: value }),
        close,
      );
    else if (modal.type === "rename")
      component = new InputDialog(
        "Rename agent",
        modal.value,
        (value) =>
          this.emit({
            type: "command",
            command: { type: "rename-agent", agentId: modal.agentId, name: value },
          }),
        close,
      );
    else if (modal.type === "confirm")
      component = new Dialog(
        [
          `${modal.action} this agent?`,
          ...(modal.draftWarning ? ["This agent has an unsent draft; it will be preserved."] : []),
          "Enter confirms · Esc cancels",
        ],
        (data) => {
          if (matchesKey(data, "enter")) this.controller.confirm(modal);
          else if (matchesKey(data, "escape")) close();
          return true;
        },
      );
    else if (modal.type === "permission")
      component = new Dialog(
        [
          `Permission: ${modal.request.title}`,
          modal.request.description ?? "",
          "a allow · d deny · Esc cancel",
        ],
        (data) => this.controller.handleKey(data),
      );
    else if (modal.type === "error-details")
      component = new Dialog([`Error: ${modal.message}`, modal.detail, "Esc close"], (data) => {
        if (matchesKey(data, "escape")) close();
        return true;
      });
    else if (modal.type === "create-agent" && modal.step === "prompt")
      component = new InputDialog(
        "Initial prompt",
        "",
        (prompt) => this.emit({ type: "create-choice", choice: prompt }),
        close,
      );
    else {
      const choices =
        modal.type === "create-agent"
          ? creationChoices(this.state, modal)
          : agentChoices(this.state, modal.type);
      component = new ChoiceDialog(
        titleForModal(modal.type === "create-agent" ? modal.step : modal.type),
        choices,
        (choice) => this.emit({ type: "create-choice", choice }),
        close,
      );
    }
    this.overlay = this.tui.showOverlay(component, {
      width: "70%",
      minWidth: 28,
      maxHeight: "70%",
      margin: 1,
    });
  }
}

export function creationChoices(
  state: AppState,
  modal: Extract<ModalState, { type: "create-agent" }>,
): SelectItem[] {
  const type = modal.step;
  if (type === "provider")
    return state.directory.providers
      .filter((provider) => provider.ready)
      .map((provider) => ({ value: provider.id, label: provider.name }));
  const provider = state.directory.providers.find((candidate) => candidate.id === modal.providerId);
  if (type === "model")
    return (provider?.models ?? [])
      .filter((model) => model.selectable)
      .map((model) => ({ value: model.id, label: model.name }));
  if (type === "mode") return (provider?.modeIds ?? []).map((value) => ({ value, label: value }));
  if (type === "thinking") {
    const model = provider?.models.find((candidate) => candidate.id === modal.modelId);
    return (model?.thinkingLevels ?? []).map((value) => ({ value, label: value }));
  }
  return [];
}

export function agentChoices(state: AppState, type: "mode" | "thinking"): SelectItem[] {
  const agent = state.directory.agents.find((candidate) => candidate.id === state.selectedAgentId);
  const provider = state.directory.providers.find(
    (candidate) => candidate.id === agent?.providerId,
  );
  const model = provider?.models.find((candidate) => candidate.id === agent?.modelId);
  const values =
    type === "mode"
      ? agent?.availableModeIds.length
        ? agent.availableModeIds
        : provider?.modeIds
      : agent?.availableThinkingLevels.length
        ? agent.availableThinkingLevels
        : model?.thinkingLevels;
  return (values ?? []).map((value) => ({ value, label: value }));
}

function titleForModal(type: string): string {
  return (
    {
      provider: "Choose provider",
      model: "Choose model",
      mode: "Choose mode",
      thinking: "Choose thinking level",
    }[type] ?? "Choose option"
  );
}
function clip(value: string, width: number): string {
  return width <= 1
    ? value.slice(0, Math.max(0, width))
    : value.length > width
      ? `${value.slice(0, width - 1)}…`
      : value;
}

/** Deliberately modest ANSI highlighting for Markdown's fenced code hook. */
export function highlightFencedCode(code: string, _language?: string): string[] {
  const keyword =
    /\b(const|let|var|function|return|if|else|for|while|class|import|export|async|await|def|fn)\b/g;
  const string = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  return code
    .split("\n")
    .map((line) =>
      line.replace(keyword, "\u001b[36m$1\u001b[39m").replace(string, "\u001b[33m$1\u001b[39m"),
    );
}
