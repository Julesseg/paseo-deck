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
import { clipboardPlainText, copyTargets, findTimelineMatches } from "./timeline-search.js";
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
  copyText?: (text: string) => Promise<void> | void;
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
  selectEvent(id: string): boolean {
    const index = this.events.findIndex((event) => event.item.id === id);
    if (index === -1) return false;
    this.selectedIndex = index;
    const item = this.events[index]?.item;
    if (
      item &&
      (item.type === "reasoning" || item.type === "tool") &&
      !this.expanded.has(item.id)
    ) {
      this.expanded.add(item.id);
      const view = this.itemViews.get(item.id);
      view?.update(item, true);
      view?.invalidate();
    }
    return true;
  }
  selectPermission(requestId: string): boolean {
    const event = this.events.find(
      (candidate) =>
        candidate.item.type === "permission" && candidate.item.request.id === requestId,
    );
    return event ? this.selectEvent(event.item.id) : false;
  }
  selectedItem(): TimelineItem | undefined {
    return this.events[this.selectedIndex]?.item;
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
      return "Timeline: ↑↓ g/G [] turns {} errors Ctrl-F search · y copy · Enter Tab";
    case "composer":
      return "Composer: Esc Ctrl-P/N Enter";
  }
}

function permissionDialogLines(
  state: AppState,
  modal: Extract<ModalState, { type: "permission" }>,
): readonly string[] {
  const request = state.directory.agents
    .find((agent) => agent.id === modal.agentId)
    ?.pendingPermissions.find((item) => item.id === modal.requestId);
  if (!request) return ["Permission request is no longer pending.", "Esc close"];
  const queue = pendingPermissionCount(state);
  const ordinal = `${(modal.queueIndex ?? 0) + 1}/${queue}`;
  return [
    `Permission ${ordinal}: ${request.operation ?? request.title}`,
    ...(request.workingDirectory ? [`cwd: ${request.workingDirectory}`] : []),
    ...(request.arguments ?? []),
    ...(request.description ? [request.description] : []),
    ...(modal.error ? [`Retryable error: ${modal.error}`] : []),
    modal.submitting
      ? `Submitting ${modal.lastDecision ?? "decision"}; awaiting confirmation…`
      : modal.error && modal.lastDecision
        ? "a allow · d deny · r retry last decision · h/l previous/next · Esc cancel"
        : "a allow · d deny · h/l previous/next · Esc cancel",
  ];
}

function pendingPermissionCount(state: AppState): number {
  return state.directory.agents.reduce(
    (total, agent) => total + agent.pendingPermissions.length,
    0,
  );
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

class CreationPromptDialog implements Component, Focusable {
  focused = false;
  private readonly editor: Editor;
  constructor(
    tui: TUI,
    private readonly workspace: string,
    initial: string,
    private readonly submit: (value: string) => void,
    private readonly back: () => void,
  ) {
    this.editor = new Editor(tui, { borderColor: plain, selectList: selectTheme }, { paddingX: 1 });
    this.editor.setText(initial);
    this.editor.onSubmit = (value) => this.submit(value);
  }
  invalidate(): void {
    this.editor.invalidate();
  }
  render(width: number): string[] {
    this.editor.focused = this.focused;
    return [
      clip(`Initial prompt · ${this.workspace}`, width),
      ...this.editor.render(width),
      "Enter submits · Esc back",
    ];
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.back();
    else this.editor.handleInput(data);
  }
}

class SearchDialog implements Component, Focusable {
  focused = false;
  private readonly input = new Input();
  constructor(
    private readonly result: () => string,
    private readonly change: (value: string) => void,
    private readonly close: () => void,
    private readonly navigate: (direction: -1 | 1) => void,
  ) {
    this.input.onSubmit = () => this.navigate(1);
  }
  invalidate(): void {
    this.input.invalidate();
  }
  render(width: number): string[] {
    this.input.focused = this.focused;
    return [
      "Search timeline",
      ...this.input.render(width),
      this.result(),
      "Enter next · Ctrl-P previous · Esc cancel",
    ];
  }
  handleInput(data: string): void {
    if (data === "\u001b" || matchesKey(data, "escape")) {
      this.close();
      return;
    }
    if (data === "\u000e") {
      this.navigate(1);
      return;
    }
    if (data === "\u0010") {
      this.navigate(-1);
      return;
    }
    if (data === "\r" || matchesKey(data, "enter")) {
      this.navigate(1);
      return;
    }
    this.input.handleInput(data);
    this.change(this.input.getValue());
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

class SearchableChoiceDialog implements Component, Focusable {
  focused = false;
  private readonly query = new Input();
  private selected = 0;
  constructor(
    private readonly title: string,
    private readonly items: readonly CreationChoice[],
    private readonly choose: (value: string) => void,
    private readonly back: () => void,
    preferredValue?: string,
  ) {
    const index =
      preferredValue === undefined ? -1 : items.findIndex((item) => item.value === preferredValue);
    if (index >= 0) this.selected = index;
  }
  invalidate(): void {
    this.query.invalidate();
  }
  render(width: number): string[] {
    this.query.focused = this.focused;
    const matches = this.matches();
    return [
      this.title,
      ...this.query.render(width),
      ...matches
        .slice(0, 8)
        .map(
          (item, index) =>
            `${index === this.selected ? "> " : "  "}${item.label}${item.description ? ` — ${item.description}` : ""}`,
        ),
      "Type to filter · ↑↓ select · Enter choose · Esc back",
    ].map((line) => clip(line, width));
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.back();
      return;
    }
    const matches = this.matches();
    if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down"))
      this.selected = Math.min(Math.max(0, matches.length - 1), this.selected + 1);
    else if (matchesKey(data, "enter")) {
      const item = matches[this.selected];
      if (item && !item.disabled) this.choose(item.value);
    } else {
      this.query.handleInput(data);
      this.selected = 0;
    }
  }
  private matches(): readonly CreationChoice[] {
    const query = this.query.getValue().toLocaleLowerCase();
    return this.items.filter((item) => item.label.toLocaleLowerCase().includes(query));
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
  private searchMatches = findTimelineMatches([], "");
  private searchIndex = 0;
  private searchQuery = "";
  private searchFeedback = "Type to search source text.";
  private localSnapshot:
    | {
        itemId?: string;
        scrollTop: number;
        following: boolean;
        anchor?: { epoch: string; sequence: number };
      }
    | undefined;
  private state: AppState;

  constructor(
    private readonly terminal: Terminal,
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
    this.copyText = options.copyText ?? ((text) => this.writeOsc52(text));
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
    this.tui.addInputListener((data) => {
      // Local overlays have no AppState modal, so keep global bindings from
      // interpreting their editor/list input.
      if (this.modalKey.startsWith("__timeline-")) {
        if (data === "\u0003")
          return this.controller.handleKey(data) ? { consume: true } : undefined;
        if (data === "\u001b") {
          this.restoreLocalOverlay();
          return { consume: true };
        }
        if (this.modalKey === "__timeline-search" && data === "\u000e") {
          this.moveTimelineSearch(1);
          return { consume: true };
        }
        if (this.modalKey === "__timeline-search" && data === "\u0010") {
          this.moveTimelineSearch(-1);
          return { consume: true };
        }
        if (this.modalKey === "__timeline-search" && data === "\r") {
          this.moveTimelineSearch(1);
          return { consume: true };
        }
        return undefined;
      }
      return this.controller.handleKey(data) ? { consume: true } : undefined;
    });
  }

  private readonly copyText: (text: string) => Promise<void> | void;

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
    if (
      state.modal.type === "permission" &&
      state.modal.agentId === state.selectedAgentId &&
      state.modal.requestId &&
      this.timeline.selectPermission(state.modal.requestId)
    )
      this.revealTimelineSelection();
    if (timelineChanged && this.modalKey === "__timeline-search")
      this.refreshTimelineSearchResults();
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
    if (intent.type === "open-timeline-search") {
      this.openTimelineSearch();
      return;
    }
    if (intent.type === "open-timeline-copy") {
      this.openTimelineCopy();
      return;
    }
    this.emit(intent);
  }

  private openTimelineSearch(): void {
    this.captureLocalSnapshot();
    this.searchMatches = findTimelineMatches(this.state.timeline.items, "");
    this.searchIndex = 0;
    this.searchQuery = "";
    this.searchFeedback = "Type to search source text.";
    this.modalKey = "__timeline-search";
    this.overlay?.hide();
    this.overlay = this.tui.showOverlay(
      new SearchDialog(
        () => this.searchFeedback,
        (query) => this.updateTimelineSearch(query),
        () => this.restoreLocalOverlay(),
        (direction) => this.moveTimelineSearch(direction),
      ),
      { width: "70%", minWidth: 28, maxHeight: "70%", margin: 1 },
    );
  }

  private updateTimelineSearch(query: string): void {
    this.searchQuery = query;
    this.searchMatches = findTimelineMatches(this.state.timeline.items, query);
    this.searchIndex = 0;
    const match = this.searchMatches[0];
    if (!match) {
      this.searchFeedback = query.trim() ? "No matches." : "Type to search source text.";
    } else {
      this.timeline.selectEvent(match.event.item.id);
      this.revealTimelineSelection();
      this.searchFeedback = `${this.searchMatches.length} match${this.searchMatches.length === 1 ? "" : "es"} · result 1`;
    }
    this.renderScheduler.requestImmediate();
  }

  private moveTimelineSearch(direction: -1 | 1): void {
    if (this.searchMatches.length === 0) return;
    this.searchIndex =
      (this.searchIndex + direction + this.searchMatches.length) % this.searchMatches.length;
    const match = this.searchMatches[this.searchIndex];
    if (match && this.timeline.selectEvent(match.event.item.id)) this.revealTimelineSelection();
    this.searchFeedback = `${this.searchMatches.length} matches · result ${this.searchIndex + 1}`;
    this.renderScheduler.requestImmediate();
  }

  private openTimelineCopy(): void {
    const item = this.timeline.selectedItem();
    const targets = item ? copyTargets(item) : [];
    if (targets.length === 0) {
      this.searchFeedback = "Selected item has nothing to copy.";
      this.emit({ type: "notify", message: this.searchFeedback });
      return;
    }
    this.captureLocalSnapshot();
    this.modalKey = "__timeline-copy";
    this.overlay?.hide();
    this.overlay = this.tui.showOverlay(
      new ChoiceDialog(
        "Copy selected timeline item",
        targets.map((target, index) => ({ value: String(index), label: target.label })),
        (choice) => void this.copyTimelineTarget(targets[Number(choice)]?.text),
        () => this.restoreLocalOverlay(),
      ),
      { width: "70%", minWidth: 28, maxHeight: "70%", margin: 1 },
    );
  }

  private async copyTimelineTarget(value: string | undefined): Promise<void> {
    if (value === undefined) return;
    try {
      await this.copyText(clipboardPlainText(value));
      this.searchFeedback = "Copied.";
      this.emit({ type: "notify", message: this.searchFeedback });
    } catch {
      this.searchFeedback = "Copy failed.";
      this.emit({ type: "notify", message: this.searchFeedback, kind: "error" });
    }
    this.restoreLocalOverlay();
    this.renderScheduler.requestImmediate();
  }

  private restoreLocalOverlay(): void {
    const snapshot = this.localSnapshot;
    this.disposeLocalOverlay();
    if (snapshot) {
      if (snapshot.itemId) this.timeline.selectEvent(snapshot.itemId);
      if (snapshot.following) this.transcript.scrollToEnd();
      else this.transcript.scrollTo(snapshot.scrollTop, { disableFollow: true });
      this.setTimelineFollowing(snapshot.following, snapshot.anchor);
    }
    this.tui.setFocus(this.state.focus === "composer" ? this.composer : null);
    this.renderScheduler.requestImmediate();
  }

  private disposeLocalOverlay(): void {
    this.overlay?.hide();
    this.overlay = undefined;
    this.modalKey = "";
    this.localSnapshot = undefined;
  }

  private captureLocalSnapshot(): void {
    if (this.localSnapshot) return;
    const itemId = this.timeline.selectedItem()?.id;
    const anchor = this.timeline.cursorAtLine(this.transcript.scrollTop);
    this.localSnapshot = {
      scrollTop: this.transcript.scrollTop,
      following: this.transcript.isFollowingEnd,
      ...(itemId === undefined ? {} : { itemId }),
      ...(anchor === undefined ? {} : { anchor }),
    };
  }

  private refreshTimelineSearchResults(): void {
    const selectedId = this.searchMatches[this.searchIndex]?.event.item.id;
    this.searchMatches = findTimelineMatches(this.state.timeline.items, this.searchQuery);
    if (this.searchMatches.length === 0) {
      this.searchIndex = 0;
      this.searchFeedback = this.searchQuery.trim()
        ? "No matches. Results changed."
        : "Type to search source text.";
      return;
    }
    const nextIndex = this.searchMatches.findIndex((match) => match.event.item.id === selectedId);
    this.searchIndex = nextIndex === -1 ? 0 : nextIndex;
    const match = this.searchMatches[this.searchIndex];
    if (match) this.timeline.selectEvent(match.event.item.id);
    this.searchFeedback = `${this.searchMatches.length} matches · result ${this.searchIndex + 1} · updated`;
  }

  private writeOsc52(text: string): void {
    this.terminal.write(`\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007`);
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

  private setTimelineFollowing(
    following: boolean,
    rememberedAnchor?: { epoch: string; sequence: number },
  ): void {
    const agentId = this.state.selectedAgentId;
    if (!agentId) return;
    const anchor = following
      ? undefined
      : (rememberedAnchor ?? this.timeline.cursorAtLine(this.transcript.scrollTop));
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
    if (this.modalKey.startsWith("__timeline-")) {
      if (this.state.modal.type === "none") return;
      this.disposeLocalOverlay();
    }
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
          "Timeline: Ctrl-F search · y copy selected source",
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
      component = new Dialog(permissionDialogLines(this.state, modal), (data) =>
        this.controller.handleKey(data),
      );
    else if (modal.type === "error-details")
      component = new Dialog([`Error: ${modal.message}`, modal.detail, "Esc close"], (data) => {
        if (matchesKey(data, "escape")) close();
        return true;
      });
    else if (modal.type === "create-agent" && modal.step === "prompt")
      component = new CreationPromptDialog(
        this.tui,
        this.state.directory.workspaces.find((workspace) => workspace.id === modal.workspaceId)
          ?.title ?? modal.workspaceId,
        modal.prompt ?? "",
        (prompt) => this.emit({ type: "create-choice", choice: prompt }),
        () => this.emit({ type: "creation-back" }),
      );
    else if (modal.type === "create-agent" && modal.step === "confirm")
      component = new Dialog(
        [
          `Create in ${this.state.directory.workspaces.find((workspace) => workspace.id === modal.workspaceId)?.title ?? modal.workspaceId}`,
          `${modal.providerId ?? ""}/${modal.modelId ?? ""}${modal.modeId ? ` · ${modal.modeId}` : ""}${modal.thinkingLevel ? ` · ${modal.thinkingLevel}` : ""}`,
          ...(modal.error ? [`Retryable error: ${modal.error}`] : []),
          modal.submitting ? "Creating…" : "Enter confirms · Esc cancels",
        ],
        (data) => {
          if (matchesKey(data, "enter") && !modal.submitting)
            this.emit({ type: "create-choice", choice: "__confirm__" });
          else if (matchesKey(data, "escape") && !modal.submitting)
            this.emit({ type: "creation-back" });
          return true;
        },
      );
    else {
      if (modal.type === "create-agent") {
        const choices = creationChoices(this.state, modal);
        component = new SearchableChoiceDialog(
          `${titleForModal(modal.step)} · ${this.state.directory.workspaces.find((workspace) => workspace.id === modal.workspaceId)?.title ?? modal.workspaceId}`,
          choices,
          (choice) => this.emit({ type: "create-choice", choice }),
          () => this.emit({ type: "creation-back" }),
          modal.step === "provider"
            ? modal.providerId
            : modal.step === "model"
              ? (modal.modelId ??
                this.state.directory.providers.find((item) => item.id === modal.providerId)
                  ?.defaultModelId)
              : modal.step === "mode"
                ? (modal.modeId ??
                  this.state.directory.providers.find((item) => item.id === modal.providerId)
                    ?.defaultModeId)
                : modal.step === "thinking"
                  ? (modal.thinkingLevel ??
                    selectedCreationModel(this.state, modal)?.defaultThinkingLevel)
                  : undefined,
        );
      } else {
        component = new ChoiceDialog(
          titleForModal(modal.type),
          agentChoices(this.state, modal.type),
          (choice) => this.emit({ type: "create-choice", choice }),
          close,
        );
      }
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

export type CreationChoice = SelectItem & { disabled: boolean };

function selectedCreationModel(
  state: AppState,
  modal: Extract<ModalState, { type: "create-agent" }>,
) {
  return state.directory.providers
    .find((provider) => provider.id === modal.providerId)
    ?.models.find((model) => model.id === modal.modelId);
}

export function creationChoices(
  state: AppState,
  modal: Extract<ModalState, { type: "create-agent" }>,
): CreationChoice[] {
  const type = modal.step;
  if (type === "provider")
    return state.directory.providers.map((provider) => ({
      value: provider.id,
      label: `${provider.name}${state.creationDefaults[modal.workspaceId]?.providerId === provider.id ? " (default)" : ""}`,
      disabled: !provider.ready,
      ...(provider.ready
        ? {}
        : { description: `unavailable: ${provider.unavailableReason ?? "not ready"}` }),
    }));
  const provider = state.directory.providers.find((candidate) => candidate.id === modal.providerId);
  if (type === "model")
    return (provider?.models ?? []).map((model) => ({
      value: model.id,
      label: `${model.name}${state.creationDefaults[modal.workspaceId]?.modelId === model.id ? " (default)" : ""}`,
      disabled: !model.selectable,
      ...(model.selectable
        ? {}
        : { description: `unavailable: ${model.unavailableReason ?? "not selectable"}` }),
    }));
  if (type === "mode")
    return (provider?.modeIds ?? []).map((value) => ({ value, label: value, disabled: false }));
  if (type === "thinking") {
    const model = provider?.models.find((candidate) => candidate.id === modal.modelId);
    return (model?.thinkingLevels ?? []).map((value) => ({ value, label: value, disabled: false }));
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
