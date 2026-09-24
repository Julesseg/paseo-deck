import {
  type Component,
  CURSOR_MARKER,
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
  Spacer,
  type Terminal,
  type TUI,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";

import type { AppState, ModalState } from "../contracts/app-state.js";
import type { TimelineEvent, TimelineItem } from "../contracts/domain.js";
import { composerAvailability, selectedComposerDraft } from "../state/composer.js";
import { activeNotification } from "../state/store.js";
import { defaultTerminalAppearance, type TerminalAppearance } from "./capabilities.js";
import {
  type CommandContext,
  commandById,
  commandForKey,
  contextualHelp,
  type ResolvedCommand,
  resolvedCommands,
} from "./commands.js";
import { DeckController, type UiIntent } from "./controller.js";
import {
  adjustTreeWidth,
  MIN_TERMINAL_COLUMNS,
  MIN_TERMINAL_ROWS,
  MIN_TREE_WIDTH,
  NARROW_SIDEBAR_WIDTH,
  shellLayout,
} from "./layout.js";
import { type RenderClock, RenderScheduler } from "./render-scheduler.js";
import { TerminalLifecycle } from "./terminal.js";
import {
  clipTerminalLine,
  sanitizeTerminalText,
  terminalDisplayWidth,
  wrapTerminalProse,
} from "./text-safety.js";
import { DeckTheme } from "./theme.js";
import {
  createTimelineBuffer,
  enterTimelineVisual,
  leaveTimelineVisual,
  moveTimelineBuffer,
  osc52,
  pageTimelineBuffer,
  printableTimelineText,
  replaceTimelineBuffer,
  searchTimelineBuffer,
  selectedTimelineText,
  type TimelineBufferState,
  timelineSelectionColumns,
  toggleTimelineFold,
} from "./timeline-buffer.js";
import { clipboardPlainText, copyTargets, findTimelineMatches } from "./timeline-search.js";
import { deriveTreeRows, shortAgentId, timelineItemDisplay, workspaceTabs } from "./view-model.js";

function markdownTheme(theme: DeckTheme) {
  // TimelineItemView sanitizes the Markdown source before pi-tui tokenises it.
  // The rendered boundary intentionally preserves generated SGR composition.
  return {
    heading: (value: string) => theme.styleRendered("header", value),
    link: (value: string) => theme.styleRendered("focus", value),
    linkUrl: (value: string) => theme.styleRendered("muted", value),
    code: (value: string) => theme.styleRendered("code", value),
    codeBlock: (value: string) => theme.styleRendered("code", value),
    codeBlockBorder: (value: string) => theme.styleRendered("border", value),
    quote: (value: string) => theme.styleRendered("muted", value),
    quoteBorder: (value: string) => theme.styleRendered("border", value),
    hr: (value: string) => theme.styleRendered("border", value),
    listBullet: (value: string) => theme.styleRendered("focus", value),
    bold: (value: string) => theme.styleRendered("header", value),
    italic: (value: string) => theme.styleRendered("muted", value),
    strikethrough: (value: string) => theme.styleRendered("muted", value),
    underline: (value: string) => theme.styleRendered("focus", value),
    highlightCode: (code: string, language?: string) => highlightFencedCode(code, language, theme),
  };
}

function selectTheme(theme: DeckTheme) {
  return {
    selectedPrefix: (value: string) => theme.style("selection", value),
    selectedText: (value: string) => theme.styleRemote("selection", value),
    description: (value: string) => theme.styleRemote("muted", value),
    scrollInfo: (value: string) => theme.style("muted", value),
    noMatch: (value: string) => theme.style("muted", value),
  };
}

export interface DeckTuiOptions {
  renderClock?: RenderClock;
  frameMilliseconds?: number;
  copyText?: (text: string) => Promise<void> | void;
  appearance?: TerminalAppearance;
  treeWidth?: number;
  requestedTheme?: "ember" | "plain";
  requestedSymbolSet?: "unicode" | "ascii";
  onPreferencesChanged?: (preference: {
    treeWidth: number;
    theme?: "ember" | "plain";
    symbolSet?: "unicode" | "ascii";
  }) => void;
  paseoHost?: string;
}

const systemRenderClock: RenderClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function hostLabel(target: string | undefined): string | undefined {
  if (!target?.trim()) return undefined;
  const value = target.trim().replace(/^tcp:\/\//i, "");
  const host = value.split("/")[0]?.trim();
  return host || undefined;
}

class TreeView implements Component {
  constructor(
    private state: AppState,
    private readonly theme: DeckTheme,
    paseoHost?: string,
  ) {
    this.paseoHost = hostLabel(paseoHost);
  }
  private readonly paseoHost: string | undefined;
  private viewportHeight = 0;
  get renderedViewportHeight(): number {
    return this.viewportHeight;
  }
  update(state: AppState): void {
    this.state = state;
  }
  setViewportHeight(height: number): void {
    this.viewportHeight = Math.max(0, height);
  }
  invalidate(): void {}
  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const borderTone = this.state.focus === "tree" ? "focus" : "border";
    const border = this.theme.appearance.symbols === "unicode" ? "│" : "|";
    const frame = (line: string): string => {
      const padding = " ".repeat(Math.max(0, innerWidth - terminalDisplayWidth(line)));
      return this.theme.styleRenderedBackground(
        "sidebar",
        `${this.theme.styleRendered(borderTone, border)}${line}${padding}${this.theme.styleRendered(borderTone, border)}`,
      );
    };
    const sidebarLine = (line: string): string => {
      return frame(line);
    };
    const rows = deriveTreeRows(this.state);
    const header = this.theme.style(
      this.state.focus === "tree" ? "focus" : "header",
      `${this.state.focus === "tree" ? "" : "  "}Projects / workspaces${this.paseoHost ? ` ${this.theme.glyph("bullet")} ${sanitizeTerminalText(this.paseoHost)}` : ""}`,
    );
    const output: string[] = [""];
    if (rows.length === 0) {
      const message =
        this.state.connection === "connecting"
          ? "Connecting to Paseo. Loading projects and workspaces…"
          : this.state.connection === "reconnecting"
            ? "Directory is stale while Paseo reconnects. Your selection and drafts are retained."
            : this.state.connection === "disconnected"
              ? "Paseo is disconnected. Press r to retry."
              : this.state.filter.trim()
                ? `No projects or workspaces match “${sanitizeTerminalText(this.state.filter)}”. Press Esc to clear the filter.`
                : "No projects or workspaces are available yet. Press r to refresh.";
      output.push(
        header,
        ...wrapTerminalProse(this.theme.label(message), width).map((line) =>
          this.theme.styleRendered("muted", line),
        ),
      );
    } else {
      output.push(
        header,
        ...rows.flatMap((row) => {
          const selected = " ";
          const branch =
            row.kind === "project"
              ? this.theme.glyph(row.expanded ? "expanded" : "collapsed")
              : this.theme.appearance.color === "none" ||
                  this.theme.appearance.theme === "plain" ||
                  this.theme.appearance.symbols === "ascii"
                ? ({ attention: "A", working: "W", idle: "I", done: "D" } as const)[
                    row.activity ?? "idle"
                  ]
                : this.theme.styleRendered(
                    row.activity === "attention"
                      ? "attention"
                      : row.activity === "working"
                        ? "running"
                        : row.activity === "done"
                          ? "muted"
                          : "header",
                    "●",
                  );
          const primary = this.theme.clipRendered(
            `${selected}${"  ".repeat(row.depth)}${branch} ${sanitizeTerminalText(row.label)}`,
            innerWidth,
          );
          const tone = row.attention ? "attention" : row.kind === "project" ? "header" : "muted";
          const fill = (line: string): string =>
            `${line}${" ".repeat(Math.max(0, innerWidth - terminalDisplayWidth(line)))}`;
          const background =
            this.state.focus === "tree" && row.selected
              ? "selection"
              : row.kind === "workspace" && row.active
                ? "active-session"
                : undefined;
          const styleRow = (line: string): string =>
            background
              ? this.theme.styleRenderedBackground(background, fill(line))
              : `${this.theme.styleRendered(tone, line)}${" ".repeat(Math.max(0, innerWidth - terminalDisplayWidth(line)))}`;
          const rowLines = row.gapBefore ? [""] : [];
          rowLines.push(styleRow(primary));
          return rowLines;
        }),
      );
    }
    while (output.length < Math.max(0, this.viewportHeight - 1)) output.push("");
    output.push("");
    return output.map(sidebarLine);
  }

  selectedLineRange(_width: number): { start: number; end: number } | undefined {
    let line = 2;
    for (const row of deriveTreeRows(this.state)) {
      const height = (row.gapBefore ?? 0) + 1;
      if (row.selected) return { start: line, end: line + height - 1 };
      line += height;
    }
    return undefined;
  }
}

class SidebarScrollView extends ScrollView {
  constructor(
    private readonly treeView: TreeView,
    options: ConstructorParameters<typeof ScrollView>[1],
  ) {
    super(treeView, options);
  }

  override updateLayout(
    contentHeight: number,
    viewportHeight: number,
    requestRender: () => void,
  ): void {
    const previousHeight = this.treeView.renderedViewportHeight;
    this.treeView.setViewportHeight(viewportHeight);
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    if (previousHeight !== this.treeView.renderedViewportHeight) requestRender();
  }
}

class SessionTabsView implements Component {
  private state: AppState;
  constructor(
    state: AppState,
    private readonly theme: DeckTheme,
  ) {
    this.state = state;
  }
  update(state: AppState): void {
    this.state = state;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const workspaceId = this.state.selectedWorkspaceId;
    const resources = workspaceTabs(this.state);
    if (!resources.length) return [" ".repeat(width)];
    const activeId = workspaceId ? this.state.activeTabIds[workspaceId] : undefined;
    const activeIndex = Math.max(
      0,
      resources.findIndex((resource) => `${resource.kind}:${resource.id}` === activeId),
    );
    const tabs = resources.map((resource) => {
      const attention =
        resource.kind === "session"
          ? resource.agent.needsAttention || resource.agent.pendingPermissions.length > 0
          : resource.terminal.activity === "attention";
      const working =
        resource.kind === "session"
          ? resource.agent.status === "running" || resource.agent.status === "starting"
          : resource.terminal.activity === "working";
      const glyph = resource.kind === "session" ? this.theme.glyph("agent") : "⌁";
      const status = attention
        ? ` ${this.theme.glyph("attention")}`
        : working
          ? ` ${this.theme.glyph("running")}`
          : "";
      const title = resource.kind === "session" ? resource.agent.title : resource.terminal.name;
      return {
        label: ` ${glyph}${status} ${sanitizeTerminalText(title)} `,
        tone: `${resource.kind}:${resource.id}` === activeId ? "tab-active" : "tab-inactive",
        textTone: attention ? "attention" : working ? "running" : "header",
      } as const;
    });
    const positions: number[] = [];
    let totalWidth = 0;
    for (const [index, tab] of tabs.entries()) {
      positions.push(totalWidth);
      totalWidth += terminalDisplayWidth(tab.label) + 2 + (index < tabs.length - 1 ? 1 : 0);
    }
    const ellipsis = this.theme.glyph("ellipsis");
    const ellipsisWidth = terminalDisplayWidth(ellipsis);
    const baseWidth = Math.max(1, width - 2 * ellipsisWidth);
    const activeStart = positions[activeIndex] ?? 0;
    const activeEnd = activeStart + terminalDisplayWidth(tabs[activeIndex]?.label ?? "") + 2;
    let start =
      totalWidth <= width
        ? 0
        : Math.max(
            0,
            Math.min(totalWidth - baseWidth, Math.floor((activeStart + activeEnd - baseWidth) / 2)),
          );
    if (activeEnd - activeStart <= baseWidth) {
      start = Math.min(start, activeStart);
      start = Math.max(start, activeEnd - baseWidth);
    }
    const leading = start > 0 ? ellipsis : "";
    const available = Math.max(0, width - terminalDisplayWidth(leading));
    const trailing = start + available < totalWidth ? ellipsis : "";
    const end = start + Math.max(0, available - terminalDisplayWidth(trailing));
    const pieces = [this.theme.styleRendered("muted", leading)];
    for (const [index, tab] of tabs.entries()) {
      const tabStart = positions[index] ?? 0;
      const cap =
        this.theme.appearance.symbols === "unicode" ? (["", ""] as const) : (["[", "]"] as const);
      const segments = [
        { text: cap[0], kind: "cap" },
        { text: tab.label, kind: "body" },
        { text: cap[1], kind: "cap" },
        { text: index < tabs.length - 1 ? " " : "", kind: "space" },
      ] as const;
      let segmentStart = tabStart;
      for (const segment of segments) {
        const segmentEnd = segmentStart + terminalDisplayWidth(segment.text);
        const visible = sliceTabCells(
          segment.text,
          Math.max(0, start - segmentStart),
          Math.max(0, Math.min(segmentEnd, end) - segmentStart),
        );
        if (visible) {
          pieces.push(
            segment.kind === "cap"
              ? this.theme.styleTabCap(tab.tone, visible)
              : segment.kind === "body"
                ? this.theme.styleTabBody(tab.tone, tab.textTone, visible)
                : visible,
          );
        }
        segmentStart = segmentEnd;
      }
    }
    pieces.push(this.theme.styleRendered("muted", trailing));
    const content = pieces.join("");
    return [`${content}${" ".repeat(Math.max(0, width - terminalDisplayWidth(content)))}`];
  }
}

function sliceTabCells(value: string, from: number, to: number): string {
  if (to <= from) return "";
  let offset = 0;
  let result = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    value,
  )) {
    const next = offset + terminalDisplayWidth(segment);
    if (next > from && offset < to) result += offset >= from && next <= to ? segment : " ";
    offset = next;
  }
  return result;
}

class ContentPane implements Component {
  private state: AppState;
  constructor(
    private readonly timeline: TimelineView,
    private readonly theme: DeckTheme,
    state: AppState,
  ) {
    this.state = state;
  }
  update(state: AppState): void {
    this.state = state;
  }
  invalidate(): void {
    this.timeline.invalidate();
  }
  render(width: number): string[] {
    if (this.state.activeTerminalId) {
      const mode = (this.state.terminalMode ?? "normal").toUpperCase();
      const stale = (this.state.staleTerminalIds ?? new Set()).has(this.state.activeTerminalId)
        ? " STALE"
        : "";
      return [
        this.theme.styleRendered(
          "header",
          this.theme.clipRendered(`${mode} Terminal${stale}`, width),
        ),
        ...(this.state.terminalLines?.[this.state.activeTerminalId] ?? [])
          .slice(this.state.terminalScrollTop?.[this.state.activeTerminalId] ?? 0)
          .map((line) => clipTerminalLine(line, width)),
      ];
    }
    return this.timeline.render(width);
  }
}

/** Paints one vertical edge of the main pane. The layout engine stretches the
 * adjacent content, while this component makes the shell boundary visible in
 * every otherwise-empty row. */
class MainPaneEdge implements Component {
  constructor(
    private readonly terminal: Terminal,
    private readonly theme: DeckTheme,
    private readonly side: "left" | "right",
  ) {}
  invalidate(): void {}
  render(_width: number): string[] {
    const unicode = this.theme.appearance.symbols === "unicode";
    const top = unicode ? (this.side === "left" ? "┌" : "┐") : "+";
    const bottom = unicode ? (this.side === "left" ? "└" : "┘") : "+";
    const middle = unicode ? "│" : "|";
    return Array.from({ length: this.terminal.rows }, (_, row) =>
      this.theme.styleRendered(
        "border",
        row === 0 ? top : row === this.terminal.rows - 1 ? bottom : middle,
      ),
    );
  }
}

class MainPaneRule implements Component {
  constructor(
    private readonly theme: DeckTheme,
    private readonly state: () => AppState,
    private readonly kind: "top" | "bottom",
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const unicode = this.theme.appearance.symbols === "unicode";
    const line = unicode ? "─" : "-";
    const state = this.state();
    const label =
      this.kind === "top" && state.focus === "timeline"
        ? ` ${(state.timelineMode ?? "normal").toUpperCase()} `
        : "";
    const content = label
      ? `${label}${line.repeat(Math.max(0, width - terminalDisplayWidth(label)))}`
      : line.repeat(width);
    const tone = this.kind === "top" && state.focus === "timeline" ? "focus" : "border";
    return [this.theme.styleRendered(tone, content)];
  }
}

class MinimumSizeView implements Component {
  constructor(private readonly theme: DeckTheme) {}
  invalidate(): void {}
  render(width: number): string[] {
    return [
      this.theme.style("failure", this.theme.clipOwnedLabel("Terminal too small", width)),
      this.theme.style(
        "muted",
        this.theme.clipOwnedLabel(
          `Resize to at least ${MIN_TERMINAL_COLUMNS} columns × ${MIN_TERMINAL_ROWS} rows.`,
          width,
        ),
      ),
    ];
  }
}

class TimelineItemView implements Component {
  private item: TimelineItem;
  private readonly markdown?: Markdown;
  private renderedWidth: number | undefined;
  private renderedLines: readonly string[] | undefined;
  constructor(
    item: TimelineItem,
    private expanded: boolean,
    private readonly theme: DeckTheme,
  ) {
    this.item = item;
    if (item.type === "user-message" || item.type === "assistant-message")
      this.markdown = new Markdown(
        sanitizeTerminalText(item.text),
        2,
        0,
        markdownTheme(this.theme),
      );
  }
  update(item: TimelineItem, expanded: boolean): void {
    if (this.item === item && this.expanded === expanded) return;
    this.item = item;
    this.expanded = expanded;
    this.renderedWidth = undefined;
    this.renderedLines = undefined;
    if (this.markdown && (item.type === "user-message" || item.type === "assistant-message"))
      this.markdown.setText(sanitizeTerminalText(item.text));
  }
  invalidate(): void {
    this.renderedWidth = undefined;
    this.renderedLines = undefined;
    this.markdown?.invalidate();
  }
  render(width: number): string[] {
    if (this.renderedWidth === width && this.renderedLines) return [...this.renderedLines];
    const lines = this.renderUncached(width);
    this.renderedWidth = width;
    this.renderedLines = lines;
    return [...lines];
  }
  private renderUncached(width: number): string[] {
    if (
      this.markdown &&
      (this.item.type === "user-message" || this.item.type === "assistant-message")
    )
      return [
        this.theme.clipOwnedLabel(
          this.item.type === "user-message"
            ? `You${this.item.timestamp ? ` ${this.theme.glyph("bullet")} ${this.item.timestamp.slice(11, 16)}` : ""}`
            : `Assistant${this.item.streaming ? ` ${this.theme.glyph("bullet")} streaming${this.theme.glyph("ellipsis")}` : ""}${this.item.timestamp ? ` ${this.theme.glyph("bullet")} ${this.item.timestamp.slice(11, 16)}` : ""}`,
          width,
        ),
        ...this.markdown
          .render(width)
          .map((line) => clipTerminalLine(line, width, this.theme.glyph("ellipsis"))),
      ];
    const lines = timelineItemDisplay(this.item, width, this.expanded, {
      bullet: this.theme.glyph("bullet"),
      ellipsis: this.theme.glyph("ellipsis"),
      divider: this.theme.glyph("divider"),
    });
    const tone = timelineTone(this.item);
    return lines.map((line, index) => {
      if (this.item.type === "tool" && this.item.detail?.diff && index > 0) {
        const diffTone = line.trimStart().startsWith("+")
          ? "running"
          : line.trimStart().startsWith("-")
            ? "failure"
            : "muted";
        return this.theme.styleRendered(diffTone, line);
      }
      return index === 0 && tone ? this.theme.styleRendered(tone, line) : line;
    });
  }
}

function timelineTone(item: TimelineItem): "running" | "permission" | "failure" | undefined {
  if (item.type === "permission" && !item.resolved) return "permission";
  if (item.type === "error" || (item.type === "tool" && item.status === "failed")) return "failure";
  if (item.type === "assistant-message" && item.streaming) return "running";
  if (item.type === "tool" && item.status === "running") return "running";
  if (item.type === "turn" && item.status === "started") return "running";
  return undefined;
}

class TimelineView implements Component {
  private readonly itemViews = new Map<string, TimelineItemView>();
  private events: readonly TimelineEvent[] = [];
  private expanded = new Set<string>();
  private heading = "Active session timeline";
  private selectedIndex = 0;
  private focused = false;
  private renderedWidth = 80;
  private state: AppState | undefined;
  private buffer: TimelineBufferState = createTimelineBuffer();
  private searchQuery = "";
  private selectionFeedback = "";
  private layout: TimelineLayout | undefined;
  constructor(private readonly theme: DeckTheme) {}
  updateSelection(state: AppState): void {
    this.state = state;
    const selected = state.directory.agents.find((agent) => agent.id === state.selectedAgentId);
    this.heading = selected
      ? `Active session timeline ${this.theme.glyph("bullet")} ${sanitizeTerminalText(selected.title)} [${shortAgentId(selected.id)}]`
      : "Active session timeline";
    this.focused = state.focus === "timeline";
  }
  update(events: readonly TimelineEvent[]): void {
    if (events === this.events) return;
    this.events = events;
    this.layout = undefined;
    const ids = new Set(events.map((event) => event.item.id));
    for (const id of this.itemViews.keys()) if (!ids.has(id)) this.itemViews.delete(id);
    for (const event of events) {
      const current = this.itemViews.get(event.item.id);
      if (current) current.update(event.item, this.expanded.has(event.item.id));
      else
        this.itemViews.set(
          event.item.id,
          new TimelineItemView(event.item, this.expanded.has(event.item.id), this.theme),
        );
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, events.length - 1));
  }
  moveText(key: Parameters<typeof moveTimelineBuffer>[1]): void {
    this.buffer = moveTimelineBuffer(this.buffer, key === "g" ? "gg" : key);
  }
  pageText(direction: -1 | 1, height: number): void {
    this.buffer = pageTimelineBuffer(this.buffer, direction, height);
  }
  startVisual(line: boolean): void {
    this.selectionFeedback = "";
    this.buffer = enterTimelineVisual(this.buffer, line ? "line" : "character");
    this.state = this.state ? { ...this.state, timelineMode: "visual" } : this.state;
  }
  clearVisual(): void {
    this.buffer = leaveTimelineVisual(this.buffer);
  }
  searchText(query: string, direction: -1 | 1 = 1): void {
    this.searchQuery = query;
    this.buffer = searchTimelineBuffer(this.buffer, query, direction);
  }
  repeatSearch(direction: -1 | 1): void {
    if (this.searchQuery)
      this.buffer = searchTimelineBuffer(this.buffer, this.searchQuery, direction);
  }
  yankText(): string {
    return selectedTimelineText(this.buffer);
  }
  yankOsc52(): string {
    return osc52(this.yankText());
  }
  toggleTextFold(): void {
    this.buffer = toggleTimelineFold(this.buffer);
    const line = this.buffer.line;
    const event = this.events[this.eventIndexAtBodyLine(line)];
    if (event) this.toggle(event.item.id);
  }
  restoreSelectionCursor(): void {
    this.buffer = {
      ...this.buffer,
      mode: "normal",
      line: this.eventBodyLine(this.selectedIndex),
      column: 0,
    };
  }
  moveSelection(direction: -1 | 1): void {
    if (this.events.length === 0) return;
    this.selectedIndex = Math.max(
      0,
      Math.min(this.events.length - 1, this.selectedIndex + direction),
    );
    this.buffer = moveTimelineBuffer(this.buffer, direction < 0 ? "k" : "j");
  }
  moveSelectionBoundary(boundary: "start" | "end"): void {
    if (this.events.length > 0) {
      this.selectedIndex = boundary === "start" ? 0 : this.events.length - 1;
      this.buffer = moveTimelineBuffer(this.buffer, boundary === "start" ? "gg" : "G");
    }
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
    if (candidate) {
      this.selectedIndex = candidate.index;
      this.buffer = { ...this.buffer, line: this.eventBodyLine(candidate.index), column: 0 };
    }
  }
  toggleSelected(): void {
    const selected = this.events[this.selectedIndex];
    if (selected) this.toggle(selected.item.id);
  }
  toggle(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    const event = this.events.find((candidate) => candidate.item.id === id);
    if (event) {
      this.itemViews.get(id)?.update(event.item, this.expanded.has(id));
      this.layout = undefined;
    }
  }
  invalidate(): void {
    for (const item of this.itemViews.values()) item.invalidate();
    this.layout = undefined;
  }
  render(width: number): string[] {
    this.renderedWidth = width;
    const mode = this.state?.timelineMode ?? "normal";
    const heading =
      width < 18
        ? `${this.focused ? mode.slice(0, 1).toUpperCase() : ""} Timeline`.trimStart()
        : `${this.focused ? mode.toUpperCase() : "        "} ${this.heading}`;
    if (this.events.length === 0) {
      const message =
        width < 18
          ? this.state?.connection === "connecting"
            ? "Connecting…"
            : this.state?.timeline.loading
              ? "Loading…"
              : this.state?.connection === "reconnecting"
                ? "Reconnecting…"
                : this.state?.selectedAgentId
                  ? "No activity yet."
                  : "No timeline. Choose a session tab."
          : this.state?.connection === "connecting"
            ? "Connecting to Paseo. Timeline will load after an agent is selected."
            : this.state?.timeline.loading
              ? "Loading timeline history…"
              : this.state?.connection === "reconnecting"
                ? "Timeline is stale while Paseo reconnects; waiting for recovery."
                : this.state?.selectedAgentId
                  ? "No timeline selected. New activity will appear here."
                  : this.state?.selectedWorkspaceId && workspaceTabs(this.state).length === 0
                    ? "No timeline selected. Create a session or terminal in this workspace."
                    : "No timeline selected. Choose a session tab to read its timeline.";
      return [
        this.theme.styleRendered("header", this.theme.clipRendered(heading, width)),
        ...wrapTerminalProse(this.theme.label(message), width).map((line) =>
          this.theme.styleRendered("muted", line),
        ),
      ];
    }
    const layout = this.timelineLayout(width);
    const bodyLines = layout.lines;
    const wasVisual = this.buffer.mode === "visual";
    this.buffer = replaceTimelineBuffer(this.buffer, bodyLines);
    if (wasVisual && this.buffer.mode !== "visual")
      this.selectionFeedback = "Selection cleared: timeline changed";
    return [
      this.theme.styleRendered(
        "header",
        this.theme.clipRendered(
          `${heading}${this.selectionFeedback ? ` · ${this.selectionFeedback}` : ""}`,
          width,
        ),
      ),
      ...layout.events.flatMap(({ lines, start }) => {
        return lines.map((line, offset) => {
          const bodyLine = start + offset;
          let rendered = line;
          if (this.focused && this.buffer.mode === "visual") {
            const range = timelineSelectionColumns(this.buffer, bodyLine);
            if (range) {
              const plain = printableTimelineText(rendered);
              rendered = `${plain.slice(0, range.start)}${this.theme.styleBackground("selection", plain.slice(range.start, range.end))}${plain.slice(range.end)}`;
            }
          }
          if (this.focused && this.buffer.mode === "normal" && this.buffer.line === bodyLine)
            rendered = `${this.theme.style("selection", "> ")}${rendered}`;
          return clipTerminalLine(rendered, width, this.theme.glyph("ellipsis"));
        });
      }),
    ];
  }

  private eventBodyLine(index: number): number {
    return this.timelineLayout(this.renderedWidth).events[index]?.bodyStart ?? 0;
  }
  private eventIndexAtBodyLine(line: number): number {
    for (const [index, event] of this.timelineLayout(this.renderedWidth).events.entries())
      if (line >= event.start && line < event.start + event.lines.length) return index;
    return -1;
  }

  selectedLineRange(): { start: number; end: number } | undefined {
    if (this.events.length === 0) return undefined;
    const event = this.timelineLayout(this.renderedWidth).events[this.selectedIndex];
    return event ? { start: event.start + 1, end: event.start + event.lines.length } : undefined;
  }

  cursorAtLine(line: number): { epoch: string; sequence: number } | undefined {
    for (const [index, event] of this.timelineLayout(this.renderedWidth).events.entries())
      if (line >= event.start + 1 && line < event.start + event.lines.length + 1)
        return this.events[index]
          ? { epoch: this.events[index].epoch, sequence: this.events[index].sequence }
          : undefined;
    return undefined;
  }

  lineRangeForCursor(cursor: {
    epoch: string;
    sequence: number;
  }): { start: number; end: number } | undefined {
    for (const [index, event] of this.events.entries())
      if (event.epoch === cursor.epoch && event.sequence === cursor.sequence) {
        const layout = this.timelineLayout(this.renderedWidth).events[index];
        return layout
          ? { start: layout.start + 1, end: layout.start + layout.lines.length }
          : undefined;
      }
    return undefined;
  }

  /** Build event lines and turn headers once per width instead of repeatedly walking history. */
  private timelineLayout(width: number): TimelineLayout {
    if (this.layout?.width === width) return this.layout;
    let group = "implicit:0";
    let priorGroup: string | undefined;
    let ordinal = 0;
    let start = 0;
    const events = this.events.map((event) => {
      const item = event.item;
      if (item.type === "user-message") group = `user:${item.id}`;
      else if (item.type === "turn") group = `turn:${item.turnId ?? item.id}`;
      else if (item.type === "assistant-message" && item.turnId) group = `turn:${item.turnId}`;
      const firstInGroup = group !== priorGroup;
      // Explicit turn records are the visual boundaries between turns. Avoid
      // inflating long streamed message histories with separator rows for
      // every provider-assigned turn id.
      const gap = firstInGroup && priorGroup && item.type === "turn" ? [""] : [];
      if (firstInGroup) ordinal += 1;
      priorGroup = group;
      const itemLines = this.itemViews.get(item.id)?.render(width) ?? [];
      const primary = item.type === "user-message" || item.type === "assistant-message";
      const prominent = item.type === "error" || (item.type === "tool" && item.status === "failed");
      const children =
        primary || prominent
          ? itemLines
          : itemLines.map((line) =>
              clipTerminalLine(`  ${line}`, width, this.theme.glyph("ellipsis")),
            );
      const header =
        firstInGroup && !primary && item.type !== "turn"
          ? [
              this.theme.styleRendered(
                "border",
                this.theme.clipRendered(
                  `${this.theme.glyph("divider")} Turn ${ordinal} ${this.theme.glyph("divider")}`,
                  width,
                ),
              ),
            ]
          : [];
      const lines = [...gap, ...header, ...children];
      const layout = { start, bodyStart: start + gap.length + header.length, lines };
      start += lines.length;
      return layout;
    });
    this.layout = { width, lines: events.flatMap((event) => event.lines), events };
    return this.layout;
  }
}

type TimelineLayout = {
  width: number;
  lines: readonly string[];
  events: readonly { start: number; bodyStart: number; lines: readonly string[] }[];
};

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

class BorderlessEditor extends Editor {
  override render(width: number): string[] {
    const lines = super.render(width);
    // Editor's stock chrome is a pair of horizontal rules. ComposerView owns
    // the one enclosing border so prompt and controls remain one region.
    return lines.length >= 2 ? lines.slice(1, -1) : lines;
  }
}

class ComposerView implements Component, Focusable {
  focused = false;
  private readonly editor: BorderlessEditor;
  private selectedAgentId: string | undefined;
  private state: AppState;
  private visualAnchor: { line: number; col: number } | undefined;
  constructor(
    tui: TUI,
    state: AppState,
    private readonly emit: (intent: UiIntent) => void,
    private readonly theme: DeckTheme,
  ) {
    this.state = state;
    this.selectedAgentId = state.selectedAgentId;
    this.editor = new BorderlessEditor(
      tui,
      {
        borderColor: (value) => this.theme.style(this.focused ? "focus" : "muted", value),
        selectList: selectTheme(this.theme),
      },
      { paddingX: 1 },
    );
    this.editor.setText(selectedComposerDraft(state));
    this.editor.onChange = (text) => emit({ type: "set-composer-text", text });
    this.editor.onSubmit = (prompt) => {
      if (this.selectedAgentId && prompt.trim())
        emit({ type: "submit-composer", agentId: this.selectedAgentId, prompt });
    };
  }
  update(state: AppState): void {
    const previousMode = this.state.composerMode;
    this.state = state;
    this.selectedAgentId = state.selectedAgentId;
    const draft = selectedComposerDraft(state);
    if (this.editor.getText() !== draft) this.editor.setText(draft);
    if (state.composerMode === "visual" && previousMode !== "visual")
      this.visualAnchor = this.editor.getCursor();
    if (state.composerMode !== "visual") this.visualAnchor = undefined;
  }
  invalidate(): void {
    this.editor.invalidate();
  }
  render(width: number): string[] {
    this.editor.focused =
      this.focused &&
      (this.state.composerMode === undefined || this.state.composerMode === "insert");
    const agent = this.state.directory.agents.find((item) => item.id === this.selectedAgentId);
    const availability = this.selectedAgentId
      ? composerAvailability(this.state, this.selectedAgentId)
      : { canSend: false as const, reason: "missing" as const };
    const destination = agent
      ? `Prompt ${this.theme.label("→")} ${sanitizeTerminalText(agent.title)}`
      : this.theme.label("Prompt → no agent selected");
    const status =
      this.selectedAgentId && this.state.composer.sendingAgentIds.has(this.selectedAgentId)
        ? ` ${this.theme.glyph("bullet")} sending${this.theme.glyph("running")}`
        : !availability.canSend
          ? ` ${this.theme.glyph("bullet")} ${availability.reason}`
          : "";
    const mode = this.state.composerMode ?? "normal";
    const selection = this.visualSelection();
    const selectionCue = selection
      ? ` ${this.theme.glyph("bullet")} selected ${selection.text.length} chars`
      : "";
    const heading =
      `${this.state.focus === "composer" ? mode.toUpperCase() : ""} ${destination}${status}${selectionCue}`.trim();
    const innerWidth = Math.max(1, width - 2);
    const controlRow = composerControlRow(this.state, this.theme, innerWidth);
    const controls =
      innerWidth < 55 ? this.theme.clipRendered(`Prompt ${controlRow}`, innerWidth) : controlRow;
    const unicode = this.theme.appearance.symbols === "unicode";
    const topLeft = unicode ? "┌" : "+";
    const topRight = unicode ? "┐" : "+";
    const bottomLeft = unicode ? "└" : "+";
    const bottomRight = unicode ? "┘" : "+";
    const horizontal = unicode ? "─" : "-";
    const vertical = unicode ? "│" : "|";
    const topLabel = ` ${heading} `;
    const top = `${topLeft}${this.theme.clipRendered(`${topLabel}${horizontal.repeat(Math.max(0, innerWidth - terminalDisplayWidth(topLabel)))}`, innerWidth)}${topRight}`;
    const body = this.editor
      .render(innerWidth)
      .map(
        (line) =>
          `${vertical}${this.theme.clipRendered(`${line}${" ".repeat(Math.max(0, innerWidth - terminalDisplayWidth(line)))}`, innerWidth)}${vertical}`,
      );
    const lines = [
      this.theme.styleRendered(this.focused ? "focus" : "muted", top),
      ...body,
      this.theme.styleRendered(
        this.focused ? "focus" : "muted",
        `${vertical}${controls}${" ".repeat(Math.max(0, innerWidth - terminalDisplayWidth(controls)))}${vertical}`,
      ),
      this.theme.styleRendered(
        this.focused ? "focus" : "muted",
        `${bottomLeft}${horizontal.repeat(innerWidth)}${bottomRight}`,
      ),
    ];
    return lines.map((line) =>
      this.theme.styleRenderedBackground(
        "composer",
        `${line}${" ".repeat(Math.max(0, width - terminalDisplayWidth(line)))}`,
      ),
    );
  }
  handleInput(data: string): void {
    if (this.state.composerMode === "visual") {
      this.handleVisualInput(data);
      return;
    }
    // pi-tui's editor treats Enter as submit. In Insert mode the composer is
    // a multiline buffer, so normalize the terminal's Enter byte to the
    // editor's explicit newline path. Normal mode owns submission instead.
    if (data === "\r" || data === "\n") {
      if (this.state.composerMode === "normal") {
        const prompt = this.editor.getText();
        if (this.selectedAgentId && prompt.trim())
          this.emit({ type: "submit-composer", agentId: this.selectedAgentId, prompt });
        return;
      }
      this.editor.handleInput("\n");
      return;
    }
    this.editor.handleInput(data);
  }

  private handleVisualInput(data: string): void {
    const motion: Record<string, string> = {
      h: "\u001b[D",
      l: "\u001b[C",
      j: "\u001b[B",
      k: "\u001b[A",
      "0": "\u0001",
      "^": "\u0001",
      $: "\u0005",
      w: "\u001b[1;5C",
      b: "\u001b[1;5D",
    };
    if (motion[data]) {
      this.editor.handleInput(motion[data]);
      return;
    }
    if (data === "d" || data === "x" || data === "c") {
      const selection = this.visualSelection();
      if (!selection) return;
      this.editor.setText(selection.before + selection.after);
      this.emit({ type: "set-composer-mode", mode: data === "c" ? "insert" : "normal" });
      return;
    }
    if (data === "i" || data === "a") {
      this.emit({ type: "set-composer-mode", mode: "insert" });
      return;
    }
    if (data === "y") this.emit({ type: "set-composer-mode", mode: "normal" });
  }

  private visualSelection():
    | { before: string; text: string; after: string; start: number; end: number }
    | undefined {
    if (!this.visualAnchor) return undefined;
    const text = this.editor.getText();
    const positions = [this.visualAnchor, this.editor.getCursor()];
    const offsets = positions.map(
      (position) =>
        this.editor
          .getLines()
          .slice(0, position.line)
          .reduce((total, line) => total + line.length + 1, 0) + position.col,
    );
    const start = Math.min(...offsets);
    const end = Math.min(text.length, Math.max(...offsets) + 1);
    return {
      before: text.slice(0, start),
      text: text.slice(start, end),
      after: text.slice(end),
      start,
      end,
    };
  }
}

/** The compact session-control row is intentionally derived from commands so
 * its cues and availability cannot drift from help or the command palette. */
export function composerControlRow(state: AppState, theme: DeckTheme, width: number): string {
  const agent = state.directory.agents.find((item) => item.id === state.selectedAgentId);
  const modelCommand = commandById(state, "model");
  const model = modelCommand?.disabledReason ? "unavailable" : (agent?.modelId ?? "-");
  const thinking = agent?.thinkingLevel ?? "-";
  const mode = agent?.modeId ?? "-";
  const controls = [
    [commandById(state, "model")?.shortcuts[0] ?? "m", model],
    [commandById(state, "thinking")?.shortcuts[0] ?? "z", thinking],
    [commandById(state, "operational-mode")?.shortcuts[0] ?? "o", mode],
  ] as const;
  const left = controls
    .map(([key, current]) => `${theme.style("muted", `[${key}]`)} ${theme.style("focus", current)}`)
    .join("  ");
  const cues = controls.map(([key]) => theme.style("muted", `[${key}]`)).join(" ");
  const sending = agent && state.composer.sendingAgentIds.has(agent.id);
  const activity = sending
    ? `${theme.glyph("running")} sending`
    : agent?.status === "running"
      ? `${theme.glyph("running")} active`
      : "";
  const usage = state.timeline.usage ?? agent?.lastUsage;
  const tokenUsage = usage?.contextTokens === undefined ? "" : `context ${usage.contextTokens}`;
  const right = [activity, tokenUsage].filter(Boolean).join(` ${theme.glyph("bullet")} `);
  const plainLength = terminalDisplayWidth;
  if (plainLength(left) > width) {
    if (!right || plainLength(cues) + plainLength(right) + 1 >= width)
      return theme.clipRendered(cues, width);
    const gap = " ".repeat(Math.max(1, width - plainLength(cues) - plainLength(right)));
    return theme.clipRendered(`${cues}${gap}${right}`, width);
  }
  if (!right || plainLength(left) + plainLength(right) + 1 >= width)
    return theme.clipRendered(left, width);
  const gap = " ".repeat(Math.max(1, width - plainLength(left) - plainLength(right)));
  return theme.clipRendered(`${left}${gap}${right}`, width);
}

class SessionActivityView implements Component {
  constructor(
    private readonly state: () => AppState,
    private readonly theme: DeckTheme,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const state = this.state();
    const agent = state.directory.agents.find((item) => item.id === state.selectedAgentId);
    const sending = agent && state.composer.sendingAgentIds.has(agent.id);
    const activity = sending ? "sending" : agent?.status === "running" ? "active" : "idle";
    return [
      this.theme.styleRendered(
        sending || agent?.status === "running" ? "running" : "muted",
        this.theme.clipRendered(
          `Session activity ${this.theme.glyph("bullet")} ${activity}`,
          width,
        ),
      ),
    ];
  }
}

class StatusView implements Component {
  constructor(
    private state: AppState,
    private readonly theme: DeckTheme,
    private readonly now: () => number = Date.now,
  ) {}
  update(state: AppState): void {
    this.state = state;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const separator = ` ${this.theme.glyph("bullet")} `;
    const selected = this.state.directory.agents.find(
      (agent) => agent.id === this.state.selectedAgentId,
    );
    const activeTerminal = this.state.selectedWorkspaceId
      ? (this.state.workspaceTerminals?.[this.state.selectedWorkspaceId] ?? []).find(
          (terminal) => terminal.id === this.state.activeTerminalId,
        )
      : undefined;
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
          .join(separator)
      : undefined;
    const details = selected
      ? [selected.providerId ?? "unknown", selected.modelId ?? "unknown"]
          .map((value) => sanitizeTerminalText(value))
          .join("/")
          .concat(
            selected.modeId ? `${separator}${sanitizeTerminalText(selected.modeId)}` : "",
            selected.thinkingLevel
              ? `${separator}${sanitizeTerminalText(selected.thinkingLevel)}`
              : "",
            usageDetails ? `${separator}${usageDetails}` : "",
          )
      : activeTerminal
        ? `terminal ${sanitizeTerminalText(activeTerminal.name)}`
        : "no active resource";
    const permissions = this.state.directory.agents.reduce(
      (total, agent) => total + agent.pendingPermissions.length,
      0,
    );
    const compact = width < 70;
    const recovery = this.state.recovery;
    const connection =
      this.state.connection === "reconnecting"
        ? `reconnecting #${recovery.attempt}${recovery.since === undefined ? "" : ` ${this.theme.glyph("bullet")} ${elapsed(recovery.since, this.now())}`}${recovery.directoryStale ? ` ${this.theme.glyph("bullet")} stale` : ""}`
        : this.state.connection;
    const active = activeNotification(this.state);
    const notification = active
      ? ` ${this.theme.glyph("bullet")} ${active.kind}${active.failureKind ? `/${active.failureKind}` : ""}: ${sanitizeTerminalText(active.message)}${active.detail ? ` ${this.theme.glyph("bullet")} E details` : ""}${active.retry ? ` ${this.theme.glyph("bullet")} R retry` : ""}${this.state.notifications.length > 1 ? ` ${this.theme.glyph("bullet")} ${this.state.notifications.length} notices ${this.theme.glyph("bullet")} N review` : ""}`
      : "";
    const line = this.theme.clipRendered(
      `${details}${separator}${connection}${compact ? "" : `${separator}permissions ${permissions}`}${notification}`,
      width,
    );
    const tone =
      this.state.connection === "reconnecting"
        ? "stale"
        : active?.kind === "error"
          ? "failure"
          : "muted";
    return [this.theme.styleRendered(tone, line)];
  }
}

function elapsed(since: number, now: number): string {
  return `${Math.max(0, Math.floor((now - since) / 1_000))}s`;
}

type DialogLine = string | { value: string; owned: boolean };

function permissionDialogLines(
  state: AppState,
  modal: Extract<ModalState, { type: "permission" }>,
): readonly DialogLine[] {
  const request = state.directory.agents
    .find((agent) => agent.id === modal.agentId)
    ?.pendingPermissions.find((item) => item.id === modal.requestId);
  if (!request) return ["Permission request is no longer pending."];
  const queue = pendingPermissionCount(state);
  const ordinal = `${(modal.queueIndex ?? 0) + 1}/${queue}`;
  return [
    `Permission ${ordinal}`,
    { value: `Operation: ${request.operation ?? request.title}`, owned: false },
    ...(request.workingDirectory
      ? [{ value: `cwd: ${request.workingDirectory}`, owned: false }]
      : []),
    ...(request.arguments ?? []).map((value) => ({ value, owned: false })),
    ...(request.description ? [{ value: request.description, owned: false }] : []),
    ...(modal.error ? [`Retryable error: ${modal.error}`] : []),
    modal.submitting
      ? `Submitting ${modal.lastDecision ?? "decision"}; awaiting confirmation…`
      : modal.error && modal.lastDecision
        ? "a allow · d deny · r retry last decision · h/l previous/next"
        : "a allow · d deny · h/l previous/next",
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
    private readonly lines: readonly DialogLine[],
    private readonly onKey: (data: string) => boolean,
    private readonly theme: DeckTheme,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    return this.lines.map((line) =>
      typeof line === "string"
        ? this.theme.clipOwnedLabel(line, width)
        : this.theme.clipRemoteText(line.value, width),
    );
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
    private readonly theme: DeckTheme,
  ) {
    this.input.setValue(value);
    this.input.onSubmit = submit;
  }
  invalidate(): void {
    this.input.invalidate();
  }
  render(width: number): string[] {
    this.input.focused = this.focused;
    return [this.theme.clipOwnedLabel(this.title, width), ...this.input.render(width)];
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
    private readonly theme: DeckTheme,
  ) {
    this.editor = new Editor(
      tui,
      {
        borderColor: (value) => this.theme.style("border", value),
        selectList: selectTheme(this.theme),
      },
      { paddingX: 1 },
    );
    this.editor.setText(initial);
    this.editor.onSubmit = (value) => this.submit(value);
  }
  invalidate(): void {
    this.editor.invalidate();
  }
  render(width: number): string[] {
    this.editor.focused = this.focused;
    return [
      this.theme.clipOwnedLabel(
        `Initial prompt ${this.theme.glyph("bullet")} ${this.workspace}`,
        width,
      ),
      ...this.editor.render(width),
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
    private readonly theme: DeckTheme,
  ) {
    this.input.onSubmit = () => this.navigate(1);
  }
  invalidate(): void {
    this.input.invalidate();
  }
  render(width: number): string[] {
    this.input.focused = this.focused;
    return [
      this.theme.clipOwnedLabel("Search timeline", width),
      ...this.input.render(width),
      this.theme.clipOwnedLabel(this.result(), width),
      this.theme.clipOwnedLabel(`Ctrl-P previous ${this.theme.glyph("bullet")} Ctrl-N next`, width),
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

function framedChoicePickerLines(
  title: string,
  content: readonly string[],
  width: number,
  theme: DeckTheme,
): string[] {
  const innerWidth = Math.max(1, width - 2);
  const unicode = theme.appearance.symbols === "unicode";
  const [topLeft, topRight, bottomLeft, bottomRight, horizontal, vertical] = unicode
    ? ["┌", "┐", "└", "┘", "─", "│"]
    : ["+", "+", "+", "+", "-", "|"];
  const label = ` ${theme.label(title)} `;
  const top = `${topLeft}${theme.clipRendered(
    `${label}${horizontal.repeat(Math.max(0, innerWidth - terminalDisplayWidth(label)))}`,
    innerWidth,
  )}${topRight}`;
  const frame = (line: string): string => {
    const withoutMarker = line.replaceAll(CURSOR_MARKER, "");
    const body =
      line.includes(CURSOR_MARKER) && terminalDisplayWidth(withoutMarker) <= innerWidth
        ? line
        : theme.clipRendered(withoutMarker, innerWidth);
    const padded = `${body}${" ".repeat(Math.max(0, innerWidth - terminalDisplayWidth(body.replaceAll(CURSOR_MARKER, ""))))}`;
    return theme.styleRenderedBackground(
      "composer",
      `${theme.styleRendered("border", vertical)}${padded}${theme.styleRendered("border", vertical)}`,
    );
  };
  return [
    theme.styleRenderedBackground("composer", theme.styleRendered("border", top)),
    ...content.map(frame),
    theme.styleRenderedBackground(
      "composer",
      theme.styleRendered("border", `${bottomLeft}${horizontal.repeat(innerWidth)}${bottomRight}`),
    ),
  ];
}

function centeredChoicePickerWidth(
  terminalColumns: number,
  title: string,
  items: readonly SelectItem[],
): number {
  const widestItem = items.reduce(
    (width, item) =>
      Math.max(
        width,
        terminalDisplayWidth(`${item.label}${item.description ? ` - ${item.description}` : ""}`),
      ),
    0,
  );
  // The window follows its content but stops before it dominates a wide pane.
  const desired = Math.max(28, terminalDisplayWidth(title) + 4, widestItem + 6);
  return Math.min(Math.max(1, terminalColumns - 2), Math.min(64, desired));
}

class ChoiceDialog implements Component {
  private readonly list: SelectList;
  constructor(
    title: string,
    items: SelectItem[],
    choose: (value: string) => void,
    cancel: () => void,
    maxVisible: number,
    preferredValue: string | undefined,
    private readonly theme: DeckTheme,
  ) {
    this.list = new SelectList(items, maxVisible, selectTheme(theme));
    if (preferredValue !== undefined) {
      const index = items.findIndex((item) => item.value === preferredValue);
      if (index >= 0) this.list.setSelectedIndex(index);
    }
    this.list.onSelect = (item) => choose(item.value);
    this.list.onCancel = cancel;
    this.title = title;
  }
  private readonly title: string;
  invalidate(): void {
    this.list.invalidate();
  }
  render(width: number): string[] {
    return framedChoicePickerLines(
      this.title,
      this.list.render(Math.max(1, width - 2)),
      width,
      this.theme,
    );
  }
  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}

class SearchableChoiceDialog implements Component, Focusable {
  focused = false;
  private readonly query = new Input({ prompt: "Filter: " });
  private selected = 0;
  constructor(
    private readonly title: string,
    private readonly items: readonly CreationChoice[],
    private readonly choose: (value: string) => void,
    private readonly back: () => void,
    preferredValue?: string,
    private readonly maxVisible = 8,
    private readonly theme: DeckTheme = new DeckTheme(defaultTerminalAppearance),
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
    const start = Math.max(
      0,
      Math.min(this.selected - Math.floor(this.maxVisible / 2), matches.length - this.maxVisible),
    );
    const visible = matches.slice(start, start + this.maxVisible);
    return framedChoicePickerLines(
      this.title,
      [
        ...this.query.render(Math.max(1, width - 2)),
        ...visible.map((item, index) =>
          this.theme.clipOwnedLabel(
            `${start + index === this.selected ? "> " : "  "}${item.label}${item.description ? ` - ${item.description}` : ""}`,
            Math.max(1, width - 2),
          ),
        ),
        ...(visible.length < matches.length
          ? [
              this.theme.clipOwnedLabel(
                `  ${this.selected + 1}/${matches.length}`,
                Math.max(1, width - 2),
              ),
            ]
          : []),
      ],
      width,
      this.theme,
    );
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
    if (!query) return this.items;
    return this.items
      .map((item, index) => ({ item, index, score: fuzzyChoiceScore(item.label, query) }))
      .filter(({ score }) => score >= 0)
      .sort((left, right) => left.score - right.score || left.index - right.index)
      .map(({ item }) => item);
  }
}

function fuzzyChoiceScore(label: string, query: string): number {
  const text = label.toLocaleLowerCase();
  let previous = -1;
  let score = 0;
  for (const character of query) {
    const found = text.indexOf(character, previous + 1);
    if (found < 0) return -1;
    score += found - previous - 1;
    previous = found;
  }
  return score;
}

class CommandPaletteDialog implements Component, Focusable {
  focused = false;
  private readonly query = new Input();
  private selected = 0;
  constructor(
    private readonly commands: () => readonly ResolvedCommand[],
    private readonly choose: (id: string) => void,
    private readonly cancel: () => void,
    private readonly theme: DeckTheme,
  ) {}
  invalidate(): void {
    this.query.invalidate();
  }
  render(width: number): string[] {
    this.query.focused = this.focused;
    const matches = this.matches();
    return [
      this.theme.clipOwnedLabel("Command palette", width),
      ...this.query.render(width),
      ...matches.slice(0, 9).map((command, index) => {
        const shortcut = command.shortcuts.join(" / ");
        const suffix = command.disabledReason ? ` - ${command.disabledReason}` : "";
        return this.theme.clipOwnedLabel(
          `${index === this.selected ? "> " : "  "}${command.label}  ${shortcut}${suffix}`,
          width,
        );
      }),
    ];
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.cancel();
      return;
    }
    const matches = this.matches();
    if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down"))
      this.selected = Math.min(Math.max(0, matches.length - 1), this.selected + 1);
    else if (matchesKey(data, "enter")) {
      const command = matches[this.selected];
      if (command && !command.disabledReason) this.choose(command.id);
    } else {
      this.query.handleInput(data);
      this.selected = 0;
    }
  }
  private matches(): readonly ResolvedCommand[] {
    const query = this.query.getValue().toLocaleLowerCase();
    return this.commands().filter((command) =>
      `${command.label} ${command.group} ${command.shortcuts.join(" ")}`
        .toLocaleLowerCase()
        .includes(query),
    );
  }
}

function commandHelpLine(command: ResolvedCommand): string {
  const suffix = command.disabledReason ? ` — unavailable: ${command.disabledReason}` : "";
  return `${command.shortcuts.join(" / ")}  ${command.label}${suffix}`;
}

/** Bridges immutable store state to reusable pi-tui components and modal overlays. */
export class DeckTui {
  readonly tui: TuiAltScreen;
  private readonly lifecycle: TerminalLifecycle;
  private readonly controller: DeckController;
  private readonly tree: TreeView;
  private readonly tabs: SessionTabsView;
  private readonly timeline: TimelineView;
  private readonly composer: ComposerView;
  private readonly status: StatusView;
  private readonly renderScheduler: RenderScheduler;
  private readonly reconnectClock: RenderClock;
  private reconnectTicker: unknown;
  private started = false;
  private readonly treeTranscript: ScrollView;
  private sidebarOverlay: OverlayHandle | undefined;
  private readonly transcript: TimelineScrollView;
  private readonly contentPane: ContentPane;
  private readonly minimumSize: MinimumSizeView;
  private treeWidth: number;
  private appOverlay: OverlayHandle | undefined;
  private appModalKey = "";
  private localOverlay: OverlayHandle | undefined;
  private localOverlayKey = "";
  private readonly localOverlayStack: { handle: OverlayHandle; key: string }[] = [];
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
  private readonly theme: DeckTheme;
  private readonly detectedAppearance: TerminalAppearance;
  private readonly onPreferencesChanged?: DeckTuiOptions["onPreferencesChanged"];
  private requestedTheme: "ember" | "plain" | undefined;
  private requestedSymbolSet: "unicode" | "ascii" | undefined;
  private terminalBackground: TerminalAppearance["background"];

  constructor(
    private readonly terminal: Terminal,
    initialState: AppState,
    private readonly emit: (intent: UiIntent) => void,
    options: DeckTuiOptions = {},
  ) {
    this.treeWidth = adjustTreeWidth(options.treeWidth ?? 34, 0);
    this.state = initialState;
    this.detectedAppearance = options.appearance ?? defaultTerminalAppearance;
    this.requestedTheme = options.requestedTheme;
    this.requestedSymbolSet = options.requestedSymbolSet;
    this.onPreferencesChanged = options.onPreferencesChanged;
    this.theme = new DeckTheme(this.effectiveAppearance());
    this.reconnectClock = options.renderClock ?? systemRenderClock;
    this.tui = new TuiAltScreen(terminal, undefined, undefined, {
      scrollToEndIndicator: () => this.scrollToEndIndicator(),
    });
    this.lifecycle = new TerminalLifecycle(this.tui, terminal);
    this.renderScheduler = new RenderScheduler(
      () => this.tui.requestRender(),
      this.reconnectClock,
      options.frameMilliseconds,
    );
    this.copyText = options.copyText ?? ((text) => this.writeOsc52(text));
    this.controller = new DeckController(
      () => this.state,
      (intent) => this.handleControllerIntent(intent),
    );
    this.tree = new TreeView(initialState, this.theme, options.paseoHost);
    this.tabs = new SessionTabsView(initialState, this.theme);
    this.timeline = new TimelineView(this.theme);
    this.timeline.update(initialState.timeline.items);
    this.timeline.updateSelection(initialState);
    this.contentPane = new ContentPane(this.timeline, this.theme, initialState);
    this.composer = new ComposerView(this.tui, initialState, emit, this.theme);
    this.status = new StatusView(initialState, this.theme, () => this.reconnectClock.now());
    this.minimumSize = new MinimumSizeView(this.theme);
    this.treeTranscript = new SidebarScrollView(this.tree, { follow: "none", scrollbar: "auto" });
    this.transcript = new TimelineScrollView(this.contentPane, (following) => {
      if (following) this.setTimelineFollowing(true);
      else this.pauseTimeline();
    });
    this.setShellLayout();
    this.tui.addInputListener((data) => {
      // Local overlays have no AppState modal, so keep global bindings from
      // interpreting their editor/list input.
      // Help and palette are intentionally global nested overlays. They are
      // available above an editor/dialog without handing ordinary keys through.
      if (data === "\u0003") return this.controller.handleKey(data) ? { consume: true } : undefined;
      const global = commandForKey(this.state, data);
      if (global?.id === "command-palette" || global?.id === "help")
        return this.controller.handleKey(data) ? { consume: true } : undefined;
      if (this.localOverlayKey.startsWith("__timeline-")) {
        if (data === "\u0003")
          return this.controller.handleKey(data) ? { consume: true } : undefined;
        if (data === "\u001b") {
          this.restoreLocalOverlay();
          return { consume: true };
        }
        if (this.localOverlayKey === "__timeline-search" && data === "\u000e") {
          this.moveTimelineSearch(1);
          return { consume: true };
        }
        if (this.localOverlayKey === "__timeline-search" && data === "\u0010") {
          this.moveTimelineSearch(-1);
          return { consume: true };
        }
        if (this.localOverlayKey === "__timeline-search" && data === "\r") {
          this.moveTimelineSearch(1);
          return { consume: true };
        }
        return undefined;
      }
      if (this.localOverlayKey === "__command-palette" || this.localOverlayKey === "__help") {
        if (data === "\u001b") {
          this.restoreLocalOverlay();
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
    const mainPane = new HStack(
      [
        { component: new MainPaneEdge(this.terminal, this.theme, "left"), basis: 1, minSize: 1 },
        {
          component: new VStack([
            {
              component: new MainPaneRule(this.theme, () => this.state, "top"),
              basis: 1,
              minSize: 1,
            },
            { component: this.tabs, basis: 1, minSize: 1 },
            {
              component: new HStack(
                [
                  {
                    component: new Spacer(1),
                    basis: 4,
                    grow: 1,
                    shrink: 1,
                    minSize: 1,
                  },
                  {
                    component: new VStack([
                      {
                        component: new Spacer(1),
                        basis: 1,
                        minSize: 0,
                        visible: (viewport) =>
                          viewport.height >= 20 && !this.state.activeTerminalId,
                      },
                      { component: this.transcript, basis: 0, grow: 1, minSize: 3 },
                      {
                        component: new Spacer(2),
                        basis: 2,
                        minSize: 0,
                        visible: (viewport) =>
                          viewport.height >= 24 && !this.state.activeTerminalId,
                      },
                      {
                        component: new Spacer(1),
                        basis: 1,
                        minSize: 0,
                        visible: (viewport) =>
                          viewport.height >= 18 &&
                          viewport.height < 24 &&
                          !this.state.activeTerminalId,
                      },
                      {
                        component: new SessionActivityView(() => this.state, this.theme),
                        basis: 1,
                        minSize: 1,
                        visible: (viewport) =>
                          viewport.height >= 24 && !this.state.activeTerminalId,
                      },
                      {
                        component: this.composer,
                        basis: "auto",
                        minSize: 4,
                        visible: () => !this.state.activeTerminalId,
                      },
                    ]),
                    basis: 100,
                    shrink: 1,
                    minSize: 1,
                  },
                  {
                    component: new Spacer(1),
                    basis: 4,
                    grow: 1,
                    shrink: 1,
                    minSize: 1,
                  },
                ],
                { align: "stretch" },
              ),
              basis: 0,
              grow: 1,
              minSize: 7,
            },
            { component: this.status, basis: 1, minSize: 1 },
            {
              component: new MainPaneRule(this.theme, () => this.state, "bottom"),
              basis: 1,
              minSize: 1,
            },
          ]),
          basis: 0,
          grow: 1,
          minSize: 8,
        },
        { component: new MainPaneEdge(this.terminal, this.theme, "right"), basis: 1, minSize: 1 },
      ],
      { align: "stretch" },
    );
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
                visible: (viewport) =>
                  shellLayout(viewport.width, viewport.height, this.treeWidth).supported &&
                  !shellLayout(viewport.width, viewport.height, this.treeWidth).narrow,
              },
              {
                component: mainPane,
                basis: 0,
                grow: 1,
                minSize: 10,
              },
            ],
            { gap: 2 },
          ),
          basis: 0,
          grow: 1,
          minSize: 8,
          visible: supported,
        },
        {
          component: this.minimumSize,
          basis: 0,
          grow: 1,
          visible: (viewport) => !supported(viewport),
        },
      ]),
    );
    this.syncSidebarOverlay();
  }

  private syncSidebarOverlay(): void {
    const narrow = shellLayout(this.terminal.columns, this.terminal.rows, this.treeWidth).narrow;
    const shouldShow = narrow && this.state.focus === "tree" && this.state.modal.type === "none";
    if (shouldShow && !this.sidebarOverlay) {
      this.sidebarOverlay = this.tui.showOverlay(this.treeTranscript, {
        width: NARROW_SIDEBAR_WIDTH,
        minWidth: MIN_TREE_WIDTH,
        maxHeight: "100%",
        margin: 0,
        visible: (columns, rows) =>
          shellLayout(columns, rows, this.treeWidth).supported &&
          shellLayout(columns, rows, this.treeWidth).narrow &&
          this.state.focus === "tree" &&
          this.state.modal.type === "none",
      });
      this.sidebarOverlay.focus();
    } else if (!shouldShow && this.sidebarOverlay) {
      this.sidebarOverlay.hide();
      this.sidebarOverlay = undefined;
    }
  }

  start(): void {
    this.started = true;
    this.lifecycle.start();
    void this.sampleTerminalBackground();
    this.syncReconnectTicker();
  }
  async stop(): Promise<void> {
    this.started = false;
    this.sidebarOverlay?.hide();
    this.sidebarOverlay = undefined;
    this.stopReconnectTicker();
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
    this.tabs.update(state);
    this.contentPane.update(state);
    this.syncReconnectTicker();
    this.tree.update(state);
    this.timeline.update(state.timeline.items);
    this.timeline.updateSelection(state);
    this.composer.update(state);
    this.status.update(state);
    this.tui.setFocus(state.focus === "composer" && !state.activeTerminalId ? this.composer : null);
    this.syncModal();
    this.syncSidebarOverlay();
    if (
      state.modal.type === "permission" &&
      state.modal.agentId === state.selectedAgentId &&
      state.modal.requestId &&
      this.timeline.selectPermission(state.modal.requestId)
    )
      this.revealTimelineSelection();
    if (timelineChanged && this.localOverlayKey === "__timeline-search")
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
      // Nested main-column layouts measure scroll views on the next frame.
      // Repeat the reveal after that measurement so selected rows remain visible.
      if (state.focus === "tree")
        this.reconnectClock.setTimeout(() => this.revealTreeSelection(), 10);
    }
    if (timelineChanged) this.renderScheduler.request();
    else this.renderScheduler.requestImmediate();
  }

  private syncReconnectTicker(): void {
    const shouldTick =
      this.started &&
      this.state.connection === "reconnecting" &&
      this.state.recovery.since !== undefined;
    if (!shouldTick) {
      this.stopReconnectTicker();
      return;
    }
    if (this.reconnectTicker !== undefined) return;
    this.reconnectTicker = this.reconnectClock.setTimeout(() => {
      this.reconnectTicker = undefined;
      if (!this.started) return;
      this.renderScheduler.requestImmediate();
      this.syncReconnectTicker();
    }, 1_000);
  }

  private stopReconnectTicker(): void {
    if (this.reconnectTicker === undefined) return;
    this.reconnectClock.clearTimeout(this.reconnectTicker);
    this.reconnectTicker = undefined;
  }
  toggleTimelineItem(itemId: string): void {
    this.timeline.toggle(itemId);
    this.emit({ type: "toggle-timeline-item", itemId });
    this.renderScheduler.requestImmediate();
  }

  /** Entry point for application-level timeline intents in production wiring. */
  handleTimelineIntent(intent: UiIntent): void {
    this.handleControllerIntent(intent);
  }

  private handleControllerIntent(intent: UiIntent): void {
    if (intent.type === "move-timeline-text") {
      this.timeline.moveText(intent.key);
      this.revealTimelineSelection();
      this.pauseIfScrolledAwayFromEnd();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "timeline-page") {
      this.timeline.pageText(intent.direction, this.transcript.viewportHeight);
      this.pauseIfScrolledAwayFromEnd();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "timeline-visual") {
      this.timeline.startVisual(intent.line);
      this.emit({ type: "set-timeline-mode", mode: "visual" });
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "timeline-search-text") {
      this.timeline.searchText(intent.query, intent.direction);
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "timeline-repeat-search") {
      this.timeline.repeatSearch(intent.direction);
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "timeline-yank") {
      const value = this.timeline.yankText();
      if (value) void this.copyTimelineTarget(value);
      else this.emit({ type: "notify", message: "No timeline text selected." });
      return;
    }
    if (intent.type === "timeline-fold") {
      this.timeline.toggleTextFold();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "set-timeline-mode" && intent.mode === "normal")
      this.timeline.clearVisual();
    if (intent.type === "set-timeline-mode" && intent.mode === "visual")
      this.timeline.startVisual(false);
    if (intent.type === "scroll-timeline") {
      const amount = Math.max(1, Math.floor(this.transcript.viewportHeight * 0.75));
      if (this.state.focus === "timeline")
        this.timeline.pageText(intent.direction, this.transcript.viewportHeight);
      this.transcript.scrollBy(intent.direction * amount);
      this.pauseIfScrolledAwayFromEnd();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "move-timeline-selection") {
      this.timeline.moveSelection(intent.direction);
      this.revealTimelineSelection();
      this.pauseIfScrolledAwayFromEnd();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "move-timeline-selection-boundary") {
      this.timeline.moveSelectionBoundary(intent.boundary);
      if (intent.boundary === "start") this.transcript.scrollTo(0, { disableFollow: true });
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
      if (this.state.timeline.agentId) this.timeline.toggleTextFold();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "adjust-tree-width") {
      this.treeWidth = adjustTreeWidth(this.treeWidth, intent.delta);
      this.emitPreferences();
      this.setShellLayout();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "toggle-theme") {
      this.requestedTheme =
        (this.requestedTheme ?? this.detectedAppearance.theme) === "ember" ? "plain" : "ember";
      this.theme.setAppearance(this.effectiveAppearance());
      this.emitPreferences();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "toggle-symbol-set") {
      if (!this.detectedAppearance.unicode) {
        this.emit({ type: "notify", message: "ASCII symbols are required by this terminal." });
        return;
      }
      this.requestedSymbolSet =
        this.effectiveAppearance().symbols === "unicode" ? "ascii" : "unicode";
      this.theme.setAppearance(this.effectiveAppearance());
      this.emitPreferences();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "open-timeline-search") {
      this.openTimelineSearch();
      return;
    }
    if (intent.type === "open-timeline-copy") {
      if (this.timeline.yankText()) this.handleControllerIntent({ type: "timeline-yank" });
      else this.openTimelineCopy();
      return;
    }
    if (intent.type === "open-command-palette") {
      this.openCommandPalette();
      return;
    }
    if (intent.type === "open-help") {
      this.openHelp();
      return;
    }
    if (intent.type === "invoke-command") {
      this.controller.invokeCommand(intent.id);
      return;
    }
    this.emit(intent);
  }

  private emitPreferences(): void {
    this.onPreferencesChanged?.({
      treeWidth: this.treeWidth,
      ...(this.requestedTheme ? { theme: this.requestedTheme } : {}),
      ...(this.requestedSymbolSet ? { symbolSet: this.requestedSymbolSet } : {}),
    });
  }

  private effectiveAppearance(): TerminalAppearance {
    return {
      ...this.detectedAppearance,
      theme:
        this.detectedAppearance.color === "none"
          ? "plain"
          : (this.requestedTheme ?? this.detectedAppearance.theme),
      palette:
        this.requestedTheme === "ember" ? "ember" : (this.detectedAppearance.palette ?? "ember"),
      ...(this.terminalBackground ? { background: this.terminalBackground } : {}),
      symbols: this.detectedAppearance.unicode
        ? (this.requestedSymbolSet ?? this.detectedAppearance.symbols)
        : "ascii",
    };
  }

  private async sampleTerminalBackground(): Promise<void> {
    const background = await this.tui.queryTerminalBackgroundColor({ timeoutMs: 120 });
    if (!background || !this.started) return;
    this.terminalBackground = [background.r, background.g, background.b];
    this.theme.setAppearance(this.effectiveAppearance());
    this.tui.requestRender();
  }

  private openTimelineSearch(): void {
    this.captureLocalSnapshot();
    this.searchMatches = this.state.timeline.agentId
      ? []
      : findTimelineMatches(this.state.timeline.items, "");
    this.searchIndex = 0;
    this.searchQuery = "";
    this.searchFeedback = this.state.timeline.agentId
      ? "Search rendered timeline text."
      : "Type to search source text.";
    this.showLocalOverlay(
      "__timeline-search",
      new SearchDialog(
        () => this.searchFeedback,
        (query) => this.updateTimelineSearch(query),
        () => this.restoreLocalOverlay(),
        (direction) => this.moveTimelineSearch(direction),
        this.theme,
      ),
      { width: "70%", minWidth: 28, maxHeight: "70%", margin: 1 },
    );
  }

  private openCommandPalette(): void {
    if (this.localOverlayKey === "__command-palette") return;
    this.captureLocalSnapshot();
    this.showLocalOverlay(
      "__command-palette",
      new CommandPaletteDialog(
        () => resolvedCommands(this.state).filter((command) => command.palette !== false),
        (id) => {
          this.restoreLocalOverlay();
          this.controller.invokeCommand(id);
        },
        () => this.restoreLocalOverlay(),
        this.theme,
      ),
      { width: "70%", minWidth: 32, maxHeight: "70%", margin: 1 },
    );
  }

  private openHelp(): void {
    if (this.localOverlayKey === "__help") return;
    this.captureLocalSnapshot();
    const context = this.topInteractionContext();
    this.showLocalOverlay(
      "__help",
      new Dialog(
        [
          `Paseo Deck keys · ${context}`,
          ...contextualHelp(this.state, context).map((command) => commandHelpLine(command)),
        ],
        (data) => {
          if (matchesKey(data, "escape") || data === "?") this.restoreLocalOverlay();
          return true;
        },
        this.theme,
      ),
      { width: "70%", minWidth: 28, maxHeight: "70%", margin: 1 },
    );
  }

  private topInteractionContext(): CommandContext {
    if (this.localOverlayKey === "__command-palette") return "palette";
    if (this.state.modal.type !== "none") return this.state.modal.type;
    return this.state.focus;
  }

  private updateTimelineSearch(query: string): void {
    this.searchQuery = query;
    this.timeline.searchText(query);
    if (this.state.timeline.agentId) {
      this.searchMatches = [];
      this.searchFeedback = query.trim()
        ? "Searching rendered timeline text."
        : "Type to search rendered timeline text.";
      this.renderScheduler.requestImmediate();
      return;
    }
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
    this.timeline.searchText(this.searchQuery, direction);
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
    this.showLocalOverlay(
      "__timeline-copy",
      new ChoiceDialog(
        "Copy selected timeline item",
        targets.map((target, index) => ({ value: String(index), label: target.label })),
        (choice) => void this.copyTimelineTarget(targets[Number(choice)]?.text),
        () => this.restoreLocalOverlay(),
        8,
        undefined,
        this.theme,
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
    if (this.localOverlayStack.length > 0) {
      this.localOverlay?.hide();
      const previous = this.localOverlayStack.pop();
      if (previous) {
        this.localOverlay = previous.handle;
        this.localOverlayKey = previous.key;
        this.localOverlay.setHidden(false);
        this.localOverlay.focus();
      }
      this.renderScheduler.requestImmediate();
      return;
    }
    const snapshot = this.localSnapshot;
    this.disposeLocalOverlay();
    this.appOverlay?.setHidden(false);
    this.appOverlay?.focus();
    if (snapshot) {
      if (snapshot.itemId) this.timeline.selectEvent(snapshot.itemId);
      this.timeline.restoreSelectionCursor();
      if (snapshot.following) this.transcript.scrollToEnd();
      else this.transcript.scrollTo(snapshot.scrollTop, { disableFollow: true });
      this.setTimelineFollowing(snapshot.following, snapshot.anchor);
    }
    if (!this.appOverlay)
      this.tui.setFocus(
        this.state.focus === "composer" && !this.state.activeTerminalId ? this.composer : null,
      );
    this.renderScheduler.requestImmediate();
  }

  private disposeLocalOverlay(): void {
    this.localOverlay?.hide();
    for (const overlay of this.localOverlayStack) overlay.handle.hide();
    this.localOverlayStack.length = 0;
    this.localOverlay = undefined;
    this.localOverlayKey = "";
    this.localSnapshot = undefined;
  }

  private showLocalOverlay(
    key: string,
    component: Component,
    options: Parameters<TUI["showOverlay"]>[1],
  ): void {
    if (this.localOverlay) {
      this.localOverlay.setHidden(true);
      this.localOverlayStack.push({ handle: this.localOverlay, key: this.localOverlayKey });
    }
    this.appModalKey = JSON.stringify(this.state.modal);
    if (this.localOverlayStack.length === 0) this.appOverlay?.setHidden(true);
    this.localOverlayKey = key;
    this.localOverlay = this.tui.showOverlay(component, options);
    this.localOverlay.focus();
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
      ? `${navigation.unread} new ${this.theme.glyph("bullet")} G end`
      : `${this.theme.glyph("end")} End`;
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
    const viewportHeight = Math.min(scrollView.viewportHeight, Math.max(1, this.terminal.rows - 4));
    if (viewportHeight <= 0) {
      scrollView.scrollTo(range.start, { disableFollow: true });
      return;
    }
    const top = scrollView.scrollTop;
    const bottom = top + viewportHeight - 1;
    if (range.start < top) scrollView.scrollTo(range.start, { disableFollow: true });
    else if (range.end > bottom)
      scrollView.scrollTo(range.end - viewportHeight + 1, { disableFollow: true });
  }

  private syncModal(): void {
    const key = JSON.stringify(this.state.modal);
    if (key === this.appModalKey) return;
    this.disposeLocalOverlay();
    this.appOverlay?.unfocus({
      target:
        this.state.focus === "composer" && !this.state.activeTerminalId ? this.composer : null,
    });
    this.appOverlay?.hide();
    this.appOverlay = undefined;
    this.appModalKey = key;
    const modal = this.state.modal;
    if (modal.type === "none") return;
    const close = (): void => this.emit({ type: "close-modal" });
    let component: Component;
    let overlayOptions: Parameters<TUI["showOverlay"]>[1] = {
      width: "70%",
      minWidth: 28,
      maxHeight: "70%",
      margin: 1,
      visible: (columns, rows) => shellLayout(columns, rows, this.treeWidth).supported,
    };
    if (modal.type === "help")
      component = new Dialog(
        [
          `Paseo Deck keys · ${this.state.focus}`,
          ...contextualHelp(this.state).map((command) => commandHelpLine(command)),
        ],
        (data) => {
          if (matchesKey(data, "escape") || data === "?") close();
          return true;
        },
        this.theme,
      );
    else if (modal.type === "filter")
      component = new InputDialog(
        "Filter sessions",
        modal.query,
        (value) => this.emit({ type: "create-choice", choice: value }),
        close,
        this.theme,
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
        this.theme,
      );
    else if (modal.type === "create-terminal")
      component = new InputDialog(
        `Create terminal in ${modal.workspaceId}`,
        modal.name,
        (value) => {
          this.emit({ type: "set-terminal-name", name: value });
          this.emit({ type: "submit-terminal-name" });
        },
        close,
        this.theme,
      );
    else if (modal.type === "confirm" && modal.action === "kill-terminal") {
      const choices = [
        { value: "no", label: "No", description: "Keep terminal running", disabled: false },
        {
          value: "yes",
          label: "Yes",
          description: "Terminate terminal and its process",
          disabled: false,
        },
      ];
      const title = "Terminate terminal?";
      component = new SearchableChoiceDialog(
        title,
        choices,
        (choice) => (choice === "yes" ? this.controller.confirm(modal) : close()),
        close,
        "no",
        this.choicePickerMaxVisible(true),
        this.theme,
      );
      overlayOptions = {
        width: centeredChoicePickerWidth(this.terminal.columns, title, choices),
        maxHeight: Math.max(1, this.terminal.rows - 2),
        margin: 1,
        visible: (columns, rows) => shellLayout(columns, rows, this.treeWidth).supported,
      };
    } else if (modal.type === "confirm")
      component = new Dialog(
        [
          `${modal.action === "archive" ? "Archive" : modal.action === "stop" ? "Stop" : "Detach"} this session?`,
          ...(modal.draftWarning
            ? ["This session has an unsent draft; it will be preserved."]
            : []),
        ],
        (data) => {
          if (matchesKey(data, "enter")) this.controller.confirm(modal);
          else if (matchesKey(data, "escape")) close();
          return true;
        },
        this.theme,
      );
    else if (modal.type === "permission")
      component = new Dialog(
        permissionDialogLines(this.state, modal),
        (data) => this.controller.handleKey(data),
        this.theme,
      );
    else if (modal.type === "notifications")
      component = new Dialog(
        notificationDialogLines(this.state, modal.index),
        (data) => this.controller.handleKey(data),
        this.theme,
      );
    else if (modal.type === "error-details")
      component = new Dialog(
        [`Error: ${modal.message}`, modal.detail],
        (data) => {
          if (matchesKey(data, "escape")) close();
          return true;
        },
        this.theme,
      );
    else if (modal.type === "create-agent" && modal.step === "prompt")
      component = new CreationPromptDialog(
        this.tui,
        this.state.directory.workspaces.find((workspace) => workspace.id === modal.workspaceId)
          ?.title ?? modal.workspaceId,
        modal.prompt ?? "",
        (prompt) => this.emit({ type: "create-choice", choice: prompt }),
        () => this.emit({ type: "creation-back" }),
        this.theme,
      );
    else if (modal.type === "create-agent" && modal.step === "confirm")
      component = new Dialog(
        [
          `Create in ${this.state.directory.workspaces.find((workspace) => workspace.id === modal.workspaceId)?.title ?? modal.workspaceId}`,
          `${modal.providerId ?? ""}/${modal.modelId ?? ""}${modal.modeId ? ` · ${modal.modeId}` : ""}${modal.thinkingLevel ? ` · ${modal.thinkingLevel}` : ""}`,
          ...(modal.error ? [`Retryable error: ${modal.error}`] : []),
          modal.submitting ? "Creating…" : "Ready to create.",
        ],
        (data) => {
          if (matchesKey(data, "enter") && !modal.submitting)
            this.emit({ type: "create-choice", choice: "__confirm__" });
          else if (matchesKey(data, "escape") && !modal.submitting)
            this.emit({ type: "creation-back" });
          return true;
        },
        this.theme,
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
          this.choicePickerMaxVisible(true),
          this.theme,
        );
      } else {
        component = new ChoiceDialog(
          titleForModal(modal.type),
          agentChoices(
            this.state,
            modal.type === "mode" || modal.type === "thinking" ? modal.type : "mode",
          ),
          (choice) => this.emit({ type: "create-choice", choice }),
          close,
          this.choicePickerMaxVisible(false),
          this.state.directory.agents.find((agent) => agent.id === modal.agentId)?.[
            modal.type === "mode" ? "modeId" : "thinkingLevel"
          ],
          this.theme,
        );
      }
      const choiceItems =
        modal.type === "create-agent"
          ? creationChoices(this.state, modal)
          : agentChoices(
              this.state,
              modal.type === "mode" || modal.type === "thinking" ? modal.type : "mode",
            );
      overlayOptions = {
        width: centeredChoicePickerWidth(
          this.terminal.columns,
          titleForModal(modal.type === "create-agent" ? modal.step : modal.type),
          choiceItems,
        ),
        maxHeight: Math.max(1, this.terminal.rows - 2),
        margin: 1,
        visible: (columns, rows) => shellLayout(columns, rows, this.treeWidth).supported,
      };
    }
    this.appOverlay = this.tui.showOverlay(component, overlayOptions);
  }

  private choicePickerMaxVisible(searchable: boolean): number {
    // Leave room for the single border, title, optional filter, and scroll marker.
    return Math.max(1, this.terminal.rows - (searchable ? 6 : 5));
  }
}

function notificationDialogLines(state: AppState, index: number): readonly string[] {
  if (state.notifications.length === 0) return ["No notifications."];
  const active = state.notifications[index] ?? state.notifications.at(-1);
  if (!active) return ["No notifications."];
  return [
    `Notifications ${index + 1}/${state.notifications.length}`,
    ...state.notifications.map(
      (item, at) =>
        `${at === index ? ">" : " "} ${item.kind}${item.failureKind ? `/${item.failureKind}` : ""}: ${item.message}`,
    ),
    ...(active.detail ? ["E details"] : []),
    ...(active.retry ? ["R retry"] : []),
  ];
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
/** Deliberately modest ANSI highlighting for Markdown's fenced code hook. */
export function highlightFencedCode(
  code: string,
  _language?: string,
  theme: DeckTheme = new DeckTheme(defaultTerminalAppearance),
): string[] {
  const keyword =
    /\b(const|let|var|function|return|if|else|for|while|class|import|export|async|await|def|fn)\b/g;
  const string = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  return sanitizeTerminalText(code)
    .split("\n")
    .map((line) =>
      line
        .replace(keyword, (match) => theme.styleRendered("code", match))
        .replace(string, (match) => theme.styleRendered("attention", match)),
    );
}
