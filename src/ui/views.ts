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
import {
  adjustTreeWidth,
  MAX_TREE_WIDTH,
  MIN_TERMINAL_COLUMNS,
  MIN_TERMINAL_ROWS,
  MIN_TREE_WIDTH,
  shellLayout,
} from "./layout.js";
import { type RenderClock, RenderScheduler } from "./render-scheduler.js";
import { TerminalLifecycle } from "./terminal.js";
import { clipTerminalLine, sanitizeTerminalText } from "./text-safety.js";
import { deriveTreeRows, shortAgentId, type TreeRow, timelineItemDisplay } from "./view-model.js";

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

export interface DeckTuiOptions {
  renderClock?: RenderClock;
  frameMilliseconds?: number;
}

class TreeView implements Component {
  constructor(private state: AppState) {}
  update(state: AppState): void {
    this.state = state;
  }
  invalidate(): void {}
  render(width: number): string[] {
    return [
      `${this.state.focus === "tree" ? "[TREE]" : " Tree "} Projects / workspaces`,
      ...deriveTreeRows(this.state).flatMap((row) => {
        const selected = row.selected ? ">" : " ";
        const branch = row.kind === "agent" ? "•" : row.expanded ? "▾" : "▸";
        const flags =
          row.kind === "agent"
            ? `${row.permissionCount ? " ✓" : ""}${row.attention ? " !" : ""}${row.status ? ` ${row.status}` : ""}`
            : "";
        const secondary = row.kind === "agent" || width < 34 ? "" : treeSecondary(row);
        const primary = clip(
          `${selected}${"  ".repeat(row.depth)}${branch} ${row.label}${flags}${secondary}`,
          width,
        );
        if (row.kind !== "agent" || width < 34) return [primary];
        const metadata = [row.providerModel, row.activityLabel].filter(Boolean).join(" · ");
        return metadata
          ? [primary, clip(`${"  ".repeat(row.depth + 1)}${metadata}`, width)]
          : [primary];
      }),
    ];
  }

  selectedLineRange(width: number): { start: number; end: number } | undefined {
    let line = 1;
    for (const row of deriveTreeRows(this.state)) {
      const height =
        row.kind === "agent" && width >= 34 && (row.providerModel || row.activityLabel) ? 2 : 1;
      if (row.selected) return { start: line, end: line + height - 1 };
      line += height;
    }
    return undefined;
  }
}

class MinimumSizeView implements Component {
  invalidate(): void {}
  render(width: number): string[] {
    return [
      clip("Terminal too small", width),
      clip(
        `Resize to at least ${MIN_TERMINAL_COLUMNS} columns × ${MIN_TERMINAL_ROWS} rows.`,
        width,
      ),
    ];
  }
}

function treeSecondary(row: TreeRow): string {
  if (row.kind === "agent") return "";
  if (row.agentCount === undefined) return "";
  const agents = `${row.agentCount} agent${row.agentCount === 1 ? "" : "s"}`;
  return ` · ${agents}${row.attentionCount ? ` · !${row.attentionCount}` : ""}`;
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
      this.markdown = new Markdown(sanitizeTerminalText(item.text), 2, 0, markdownTheme);
  }
  update(item: TimelineItem, expanded: boolean): void {
    this.item = item;
    this.expanded = expanded;
    if (this.markdown && (item.type === "user-message" || item.type === "assistant-message"))
      this.markdown.setText(sanitizeTerminalText(item.text));
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
        clipTerminalLine(
          this.item.type === "user-message"
            ? `You${this.item.timestamp ? ` · ${this.item.timestamp.slice(11, 16)}` : ""}`
            : `Assistant${this.item.streaming ? " · streaming…" : ""}${this.item.timestamp ? ` · ${this.item.timestamp.slice(11, 16)}` : ""}`,
          width,
        ),
        ...this.markdown.render(width).map((line) => clipTerminalLine(line, width)),
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
  private focused = false;
  private renderedWidth = 80;
  updateSelection(state: AppState): void {
    const selected = state.directory.agents.find((agent) => agent.id === state.selectedAgentId);
    this.heading = selected
      ? `Selected agent timeline · ${selected.title} [${shortAgentId(selected.id)}]`
      : "Selected agent timeline";
    this.focused = state.focus === "timeline";
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
  moveSelectionBoundary(boundary: "start" | "end"): void {
    if (this.events.length > 0)
      this.selectedIndex = boundary === "start" ? 0 : this.events.length - 1;
  }
  moveLandmark(direction: -1 | 1, kind: "turn" | "error"): void {
    const candidates = this.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => landmark(event.item, kind));
    const candidate =
      direction === -1
        ? [...candidates].reverse().find(({ index }) => index < this.selectedIndex)
        : candidates.find(({ index }) => index > this.selectedIndex);
    if (candidate) this.selectedIndex = candidate.index;
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
    this.renderedWidth = width;
    const heading =
      width < 18 ? "Timeline" : `${this.focused ? "[TIMELINE]" : " Timeline  "} ${this.heading}`;
    if (this.events.length === 0) return [heading, "No timeline selected."];
    return [
      clipTerminalLine(heading, width),
      ...this.events.flatMap((event, index) => {
        const lines = this.itemViews.get(event.item.id)?.render(width) ?? [];
        if (index === this.selectedIndex && lines[0]) lines[0] = `> ${lines[0]}`;
        return lines.map((line) => clipTerminalLine(line, width));
      }),
    ];
  }

  selectedLineRange(): { start: number; end: number } | undefined {
    if (this.events.length === 0) return undefined;
    let line = 1;
    for (const [index, event] of this.events.entries()) {
      const height = this.itemViews.get(event.item.id)?.render(this.renderedWidth).length ?? 0;
      if (index === this.selectedIndex) return { start: line, end: line + height - 1 };
      line += height;
    }
    return undefined;
  }

  cursorAtLine(line: number): { epoch: string; sequence: number } | undefined {
    let start = 1;
    for (const event of this.events) {
      const height = this.itemViews.get(event.item.id)?.render(this.renderedWidth).length ?? 0;
      if (line >= start && line < start + height)
        return { epoch: event.epoch, sequence: event.sequence };
      start += height;
    }
    return undefined;
  }

  lineRangeForCursor(cursor: {
    epoch: string;
    sequence: number;
  }): { start: number; end: number } | undefined {
    let start = 1;
    for (const event of this.events) {
      const height = this.itemViews.get(event.item.id)?.render(this.renderedWidth).length ?? 0;
      if (event.epoch === cursor.epoch && event.sequence === cursor.sequence)
        return { start, end: start + height - 1 };
      start += height;
    }
    return undefined;
  }
}

function landmark(item: TimelineItem, kind: "turn" | "error"): boolean {
  return kind === "turn"
    ? item.type === "turn"
    : item.type === "error" || (item.type === "tool" && item.status === "failed");
}

class TimelineScrollView extends ScrollView {
  constructor(
    component: Component,
    private readonly onFollowChange: (following: boolean) => void,
  ) {
    super(component, { follow: "end", primary: true, scrollbar: "auto" });
  }

  override scrollBy(lines: number): number {
    const wasFollowing = this.isFollowingEnd;
    const before = this.scrollTop;
    const remaining = super.scrollBy(lines);
    if (before !== this.scrollTop && wasFollowing !== this.isFollowingEnd)
      this.onFollowChange(this.isFollowingEnd);
    return remaining;
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
    const heading = `${this.state.focus === "composer" ? "[COMPOSER]" : " Composer  "} ${destination}${status}`;
    return [clip(heading, width), ...this.editor.render(width)];
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
    const context = footerContext(this.state, width);
    return [
      clip(
        `${context} · ${this.state.connection}${compact ? "" : ` · ${details} · permissions ${permissions}`}${notification}`,
        width,
      ),
    ];
  }
}

function footerContext(state: AppState, width: number): string {
  if (state.modal.type !== "none") return "Dialog: Esc";
  if (width < 70) {
    switch (state.focus) {
      case "tree":
        return "Tree j/k Tab";
      case "timeline":
        return "Timeline j/k G [] {}";
      case "composer":
        return "Composer Esc Enter";
    }
  }
  switch (state.focus) {
    case "tree":
      return "Tree: ↑↓ ←→ g/G Tab";
    case "timeline":
      return "Timeline: ↑↓ g/G [] turns {} errors Enter Tab";
    case "composer":
      return "Composer: Esc Ctrl-P/N Enter";
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
  private readonly renderScheduler: RenderScheduler;
  private readonly treeTranscript: ScrollView;
  private readonly transcript: TimelineScrollView;
  private readonly minimumSize: MinimumSizeView;
  private treeWidth = 34;
  private overlay: OverlayHandle | undefined;
  private modalKey = "";
  private state: AppState;

  constructor(
    terminal: Terminal,
    initialState: AppState,
    private readonly emit: (intent: UiIntent) => void,
    options: DeckTuiOptions = {},
  ) {
    this.state = initialState;
    this.tui = new TuiAltScreen(terminal, undefined, undefined, {
      scrollToEndIndicator: () => this.scrollToEndIndicator(),
    });
    this.lifecycle = new TerminalLifecycle(this.tui, terminal);
    this.renderScheduler = new RenderScheduler(
      () => this.tui.requestRender(),
      options.renderClock,
      options.frameMilliseconds,
    );
    this.controller = new DeckController(
      () => this.state,
      (intent) => this.handleControllerIntent(intent),
    );
    this.tree = new TreeView(initialState);
    this.timeline.update(initialState.timeline.items);
    this.timeline.updateSelection(initialState);
    this.composer = new ComposerView(this.tui, initialState, emit);
    this.status = new StatusView(initialState);
    this.minimumSize = new MinimumSizeView();
    this.treeTranscript = new ScrollView(this.tree, { follow: "none", scrollbar: "auto" });
    this.transcript = new TimelineScrollView(this.timeline, (following) => {
      if (following) this.setTimelineFollowing(true);
      else this.pauseTimeline();
    });
    this.setShellLayout();
    this.tui.addInputListener((data) =>
      this.controller.handleKey(data) ? { consume: true } : undefined,
    );
  }

  private setShellLayout(): void {
    const supported = (viewport: { width: number; height: number }): boolean =>
      shellLayout(viewport.width, viewport.height, this.treeWidth).supported;
    this.tui.setLayoutRoot(
      new VStack([
        {
          component: new HStack(
            [
              {
                component: this.treeTranscript,
                basis: this.treeWidth,
                shrink: 1,
                minSize: MIN_TREE_WIDTH,
              },
              { component: this.transcript, basis: 0, grow: 1, minSize: 10 },
            ],
            { gap: 2 },
          ),
          basis: 0,
          grow: 1,
          minSize: 8,
          visible: supported,
        },
        { component: this.composer, basis: "auto", minSize: 3, visible: supported },
        { component: this.status, basis: 1, minSize: 1, visible: supported },
        {
          component: this.minimumSize,
          basis: 0,
          grow: 1,
          visible: (viewport) => !supported(viewport),
        },
      ]),
    );
  }

  start(): void {
    this.lifecycle.start();
  }
  async stop(): Promise<void> {
    this.renderScheduler.stop();
    await this.lifecycle.stop();
  }
  update(state: AppState): void {
    const timelineChanged = state.timeline.items !== this.state.timeline.items;
    const focusChanged = state.focus !== this.state.focus;
    const treeSelectionChanged =
      state.selectedAgentId !== this.state.selectedAgentId ||
      state.selectedWorkspaceId !== this.state.selectedWorkspaceId ||
      state.selectedProjectId !== this.state.selectedProjectId;
    const previousAgentId = this.state.selectedAgentId;
    const recoveryChanged =
      state.timeline.recoveryRevision !== this.state.timeline.recoveryRevision;
    this.state = state;
    this.tree.update(state);
    this.timeline.update(state.timeline.items);
    this.timeline.updateSelection(state);
    this.composer.update(state);
    this.status.update(state);
    this.tui.setFocus(state.focus === "composer" ? this.composer : null);
    this.syncModal();
    const restoredPaused =
      (previousAgentId !== state.selectedAgentId || recoveryChanged) &&
      state.selectedAgentId !== undefined &&
      state.timelineNavigation[state.selectedAgentId]?.following === false;
    if (previousAgentId !== state.selectedAgentId || recoveryChanged)
      this.restoreTimelineNavigation(state);
    if (focusChanged || treeSelectionChanged) {
      if (state.focus === "timeline" && !restoredPaused) this.revealTimelineSelection();
      else if (state.focus === "tree") this.revealTreeSelection();
    }
    if (timelineChanged) this.renderScheduler.request();
    else this.renderScheduler.requestImmediate();
  }
  toggleTimelineItem(itemId: string): void {
    this.timeline.toggle(itemId);
    this.emit({ type: "toggle-timeline-item", itemId });
    this.renderScheduler.requestImmediate();
  }

  private handleControllerIntent(intent: UiIntent): void {
    if (intent.type === "move-timeline-selection") {
      this.timeline.moveSelection(intent.direction);
      this.revealTimelineSelection();
      this.pauseIfScrolledAwayFromEnd();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "move-timeline-selection-boundary") {
      this.timeline.moveSelectionBoundary(intent.boundary);
      if (intent.boundary === "start") this.transcript.scrollToStart();
      else this.transcript.scrollToEnd();
      this.setTimelineFollowing(intent.boundary === "end");
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "move-timeline-landmark") {
      this.timeline.moveLandmark(intent.direction, intent.kind);
      this.revealTimelineSelection();
      this.setTimelineFollowing(false);
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "toggle-selected-timeline-item") {
      this.timeline.toggleSelected();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "adjust-tree-width") {
      this.treeWidth = adjustTreeWidth(this.treeWidth, intent.delta);
      this.setShellLayout();
      this.renderScheduler.requestImmediate();
      return;
    }
    this.emit(intent);
  }

  private scrollToEndIndicator(): string {
    const agentId = this.state.selectedAgentId;
    const navigation = agentId ? this.state.timelineNavigation[agentId] : undefined;
    return navigation && !navigation.following && navigation.unread > 0
      ? `${navigation.unread} new · G end`
      : "↓ End";
  }

  private restoreTimelineNavigation(state: AppState): void {
    const agentId = state.selectedAgentId;
    if (!agentId) return;
    const navigation = state.timelineNavigation[agentId] ?? { following: true, unread: 0 };
    if (navigation.following) {
      this.transcript.scrollToEnd();
      return;
    }
    if (navigation.anchor)
      this.revealRange(this.transcript, this.timeline.lineRangeForCursor(navigation.anchor));
  }

  private setTimelineFollowing(following: boolean): void {
    const agentId = this.state.selectedAgentId;
    if (!agentId) return;
    const anchor = following ? undefined : this.timeline.cursorAtLine(this.transcript.scrollTop);
    this.emit({
      type: "set-timeline-navigation",
      agentId,
      following,
      ...(anchor === undefined ? {} : { anchor }),
    });
  }

  private pauseTimeline(): void {
    const agentId = this.state.selectedAgentId;
    if (!agentId) return;
    this.persistPausedTimeline(agentId, this.timeline.cursorAtLine(this.transcript.scrollTop));
  }

  private pauseIfScrolledAwayFromEnd(): void {
    if (!this.transcript.isFollowingEnd) this.pauseTimeline();
  }

  private persistPausedTimeline(
    agentId: string,
    anchor: { epoch: string; sequence: number } | undefined,
  ): void {
    this.emit({
      type: "set-timeline-navigation",
      agentId,
      following: false,
      ...(anchor === undefined ? {} : { anchor }),
    });
  }

  private revealTreeSelection(): void {
    this.revealRange(this.treeTranscript, this.tree.selectedLineRange(this.treeWidth));
  }

  private revealTimelineSelection(): void {
    this.revealRange(this.transcript, this.timeline.selectedLineRange());
  }

  private revealRange(
    scrollView: ScrollView,
    range: { start: number; end: number } | undefined,
  ): void {
    if (range === undefined) return;
    if (scrollView.viewportHeight <= 0) {
      scrollView.scrollTo(range.start, { disableFollow: true });
      return;
    }
    const top = scrollView.scrollTop;
    const bottom = top + scrollView.viewportHeight - 1;
    if (range.start < top) scrollView.scrollTo(range.start, { disableFollow: true });
    else if (range.end > bottom)
      scrollView.scrollTo(range.end - scrollView.viewportHeight + 1, { disableFollow: true });
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
          "↑↓/j k move · ←→/h l collapse/expand · g/G ends · [/] turns · {} errors · Enter open · Tab focus",
          "i compose · n new · / filter · p permissions · r refresh",
          "o order · v archived · ! attention-only",
          `[ / ] tree width (${MIN_TREE_WIDTH}–${MAX_TREE_WIDTH})`,
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
      visible: (columns, rows) => shellLayout(columns, rows, this.treeWidth).supported,
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
