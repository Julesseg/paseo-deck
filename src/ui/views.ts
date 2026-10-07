import { spawn } from "node:child_process";
import {
  type Component,
  CURSOR_MARKER,
  Editor,
  type Focusable,
  getOsc8LinkAtColumn,
  HStack,
  Markdown,
  matchesKey,
  type OverlayHandle,
  ScrollView,
  type SelectItem,
  Spacer,
  sliceByColumn,
  type Terminal,
  type TUI,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { wordWrapLine } from "@earendil-works/pi-tui/dist/components/editor.js";
import type { AppState, ModalState } from "../contracts/app-state.js";
import type { TimelineEvent, TimelineItem } from "../contracts/domain.js";
import {
  activeSessionDraftWorkspaceId,
  composerAvailability,
  selectedComposerDraft,
} from "../state/composer.js";
import { activeLaunchWorkspaceId, launchDraft } from "../state/launch.js";
import { activeNotification } from "../state/store.js";
import { defaultTerminalAppearance, type TerminalAppearance } from "./capabilities.js";
import { type ClipboardAdapter, SharedClipboard, systemClipboard } from "./clipboard.js";
import {
  type CommandContext,
  commandById,
  commandForKey,
  contextualHelp,
  type ResolvedCommand,
  resolvedCommands,
} from "./commands.js";
import {
  applyComposerInsertText,
  applyComposerNativePaste,
  applyComposerPaste,
  type ComposerVimState,
  composerVisualSelection,
  createComposerVim,
  handleComposerVim,
  offsetToPosition,
  positionToOffset,
  recallComposerPrompt,
  setComposerViewport,
  syncComposerVim,
} from "./composer-vim.js";
import { DeckController, type UiIntent } from "./controller.js";
import { ownedInputTerminal } from "./input.js";
import {
  adjustTreeWidth,
  MIN_TERMINAL_COLUMNS,
  MIN_TERMINAL_ROWS,
  MIN_TREE_WIDTH,
  NARROW_SIDEBAR_WIDTH,
  shellLayout,
} from "./layout.js";
import { logicalWordOffset, offsetAt, positionAt } from "./logical-text.js";
import { type RenderClock, RenderScheduler } from "./render-scheduler.js";
import { choiceNavigation, SingleLineField } from "./single-line-field.js";
import { TerminalLifecycle } from "./terminal.js";
import { characterOffsets, characterStep } from "./text-buffer.js";
import {
  clipTerminalLine,
  sanitizeTerminalText,
  terminalDisplayWidth,
  wrapTerminalProse,
} from "./text-safety.js";
import { type BackgroundTone, DeckTheme } from "./theme.js";
import {
  createTimelineBuffer,
  enterTimelineVisual,
  findTimelineCharacter,
  leaveTimelineVisual,
  moveTimelineBuffer,
  moveTimelineViewport,
  osc52,
  pageTimelineBuffer,
  printableTimelineText,
  repeatTimelineCharacterFind,
  replaceTimelineBuffer,
  searchTimelineBuffer,
  searchTimelineWord,
  selectTimelineTextRange,
  type TimelineBufferState,
  type TimelineSelectionMode,
  timelineSelection,
  timelineSelectionColumns,
  timelineTextObjectRange,
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
  readText?: () => Promise<string> | string;
  clipboard?: ClipboardAdapter;
  openLink?: (url: string) => Promise<void> | void;
  appearance?: TerminalAppearance;
  treeWidth?: number;
  requestedTheme?: "ember" | "plain";
  onPreferencesChanged?: (preference: { treeWidth: number; theme?: "ember" | "plain" }) => void;
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
    const innerWidth = Math.max(1, width);
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
    return output.map((line) =>
      this.theme.styleRenderedBackground(
        "sidebar",
        `${line}${" ".repeat(Math.max(0, width - terminalDisplayWidth(line)))}`,
      ),
    );
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
          : resource.kind === "terminal" && resource.terminal.activity === "attention";
      const working =
        resource.kind === "session"
          ? resource.agent.status === "running" || resource.agent.status === "starting"
          : resource.kind === "terminal" && resource.terminal.activity === "working";
      const glyph =
        resource.kind === "session"
          ? this.theme.glyph("agent")
          : resource.kind === "draft"
            ? this.theme.glyph("draft")
            : "⌁";
      const status = attention
        ? ` ${this.theme.glyph("attention")}`
        : working
          ? ` ${this.theme.glyph("running")}`
          : "";
      const title =
        resource.kind === "session"
          ? resource.agent.title
          : resource.kind === "draft"
            ? "New session"
            : resource.terminal.name;
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
    const launchId = activeLaunchWorkspaceId(this.state);
    if (launchId) {
      const draft = launchDraft(this.state, launchId);
      return draft.error
        ? wrapTerminalProse(draft.error, width).map((line) =>
            this.theme.clipRendered(this.theme.styleRendered("failure", line), width),
          )
        : [];
    }
    const workspaceId = activeSessionDraftWorkspaceId(this.state);
    if (workspaceId) {
      const draft = this.state.sessionDrafts[workspaceId];
      return draft?.error
        ? wrapTerminalProse(draft.error, width).map((line) =>
            this.theme.clipRendered(this.theme.styleRendered("failure", line), width),
          )
        : [];
    }
    if (this.state.activeTerminalId) {
      const stale = (this.state.staleTerminalIds ?? new Set()).has(this.state.activeTerminalId)
        ? " STALE"
        : "";
      return [
        this.theme.styleRendered(
          this.state.focus === "timeline" ? "focus" : "header",
          this.theme.clipRendered(
            `${(this.state.terminalMode ?? "normal").toUpperCase()} Terminal${stale}`,
            width,
          ),
        ),
        ...(this.state.terminalLines?.[this.state.activeTerminalId] ?? [])
          .slice(this.state.terminalScrollTop?.[this.state.activeTerminalId] ?? 0)
          .map((line) => clipTerminalLine(line, width)),
      ];
    }
    return this.timeline.render(width);
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
  private canonical: readonly string[] | undefined;
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
    this.canonical = undefined;
    this.renderedWidth = undefined;
    this.renderedLines = undefined;
    if (this.markdown && (item.type === "user-message" || item.type === "assistant-message"))
      this.markdown.setText(sanitizeTerminalText(item.text));
  }
  invalidate(): void {
    this.renderedWidth = undefined;
    this.renderedLines = undefined;
    this.markdown?.invalidate();
    this.canonical = undefined;
  }
  render(width: number): string[] {
    if (this.renderedWidth === width && this.renderedLines) return [...this.renderedLines];
    const lines = this.renderUncached(width);
    this.renderedWidth = width;
    this.renderedLines = lines;
    return [...lines];
  }
  canonicalLines(): readonly string[] {
    this.canonical ??= this.renderUncached(
      Math.max(
        80,
        ...copyTargets(this.item).map((target) => terminalDisplayWidth(target.text) + 32),
      ),
    ).map(printableTimelineText);
    return this.canonical;
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
  private bufferAnchor:
    | {
        cursor: TimelineContentAnchor;
        selection?: TimelineContentAnchor;
        range?: { start: TimelineContentAnchor; end: TimelineContentAnchor };
      }
    | undefined;
  private readonly sessions = new Map<
    string,
    {
      buffer: TimelineBufferState;
      anchor:
        | {
            cursor: TimelineContentAnchor;
            selection?: TimelineContentAnchor;
            range?: { start: TimelineContentAnchor; end: TimelineContentAnchor };
          }
        | undefined;
      keepCursorAtEnd: boolean;
      searchQuery: string;
      viewportAnchor: TimelineContentAnchor | undefined;
      expanded: Set<string>;
    }
  >();
  private previousSelection:
    | { buffer: TimelineBufferState; anchor: TimelineView["bufferAnchor"] }
    | undefined;
  private readonly previousSelections = new Map<
    string,
    { buffer: TimelineBufferState; anchor: TimelineView["bufferAnchor"] }
  >();
  private restoredContentPosition = false;
  private viewportAnchor: TimelineContentAnchor | undefined;
  private remappedViewport: number | undefined;
  private keepCursorAtEnd = true;
  private searchQuery = "";
  private selectionFeedback = "";
  private layout: TimelineLayout | undefined;
  private readonly layouts = new Map<number, TimelineLayout>();
  private readonly rendered = new Map<
    number,
    {
      width: number;
      layout: TimelineLayout;
      buffer: TimelineBufferState;
      heading: string;
      focused: boolean;
      mode: string;
      selectionFeedback: string;
      lines: string[];
    }
  >();
  constructor(
    private readonly theme: DeckTheme,
    private readonly viewportLine: () => number,
  ) {}
  updateSelection(state: AppState): void {
    const previousFollowing = this.state?.selectedAgentId
      ? this.state.timelineNavigation[this.state.selectedAgentId]?.following !== false
      : undefined;
    const nextFollowing = state.selectedAgentId
      ? state.timelineNavigation[state.selectedAgentId]?.following !== false
      : false;
    if (this.state?.selectedAgentId !== state.selectedAgentId) {
      if (!this.bufferAnchor) this.captureBufferAnchor();
      const previous = this.state?.selectedAgentId;
      if (previous && this.previousSelection)
        this.previousSelections.set(previous, this.previousSelection);
      this.previousSelection = state.selectedAgentId
        ? this.previousSelections.get(state.selectedAgentId)
        : undefined;
      if (previous)
        this.sessions.set(previous, {
          buffer: this.buffer,
          anchor: this.bufferAnchor,
          keepCursorAtEnd: this.keepCursorAtEnd,
          searchQuery: this.searchQuery,
          viewportAnchor: this.viewportAnchor,
          expanded: new Set(this.expanded),
        });
      const saved = state.selectedAgentId ? this.sessions.get(state.selectedAgentId) : undefined;
      this.restoredContentPosition = Boolean(saved);
      this.buffer = saved?.buffer ?? createTimelineBuffer();
      this.bufferAnchor = saved?.anchor;
      this.viewportAnchor = saved?.viewportAnchor;
      this.expanded = saved?.expanded ?? new Set();
      for (const event of this.events)
        this.itemViews.get(event.item.id)?.update(event.item, this.expanded.has(event.item.id));
      this.layout = undefined;
      this.layouts.clear();
      this.rendered.clear();
      this.selectedIndex = 0;
      this.searchQuery = saved?.searchQuery ?? "";
      this.keepCursorAtEnd = saved?.keepCursorAtEnd ?? nextFollowing;
    } else if (previousFollowing === false && nextFollowing) {
      this.keepCursorAtEnd = true;
    }
    this.state = state;
    const selected = state.directory.agents.find((agent) => agent.id === state.selectedAgentId);
    this.heading = selected
      ? `Active session timeline ${this.theme.glyph("bullet")} ${sanitizeTerminalText(selected.title)} [${shortAgentId(selected.id)}]`
      : "Active session timeline";
    this.focused = state.focus === "timeline";
  }
  update(events: readonly TimelineEvent[]): void {
    if (events === this.events) return;
    this.captureBufferAnchor();
    this.events = events;
    this.layout = undefined;
    this.layouts.clear();
    this.rendered.clear();
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
  moveText(key: string, count = 0): void {
    this.buffer = moveTimelineBuffer(this.buffer, key, count);
    this.keepCursorAtEnd = key === "G" && count === 0 && this.buffer.mode === "normal";
    this.syncSelectedIndex();
  }
  searchWord(key: "*" | "#" | "g*" | "g#", count: number): void {
    this.buffer = searchTimelineWord(this.buffer, key, count);
    this.keepCursorAtEnd = false;
    this.syncSelectedIndex();
  }
  cursorBodyLine(): number {
    return this.buffer.line;
  }
  findCharacter(key: "f" | "F" | "t" | "T", character: string, count: number): void {
    this.buffer = findTimelineCharacter(this.buffer, key, character, count);
    this.keepCursorAtEnd = false;
  }
  repeatFind(reverse: boolean): void {
    this.buffer = repeatTimelineCharacterFind(this.buffer, reverse);
    this.keepCursorAtEnd = false;
  }
  moveToVisibleLine(line: number): void {
    this.buffer = moveTimelineBuffer(
      { ...this.buffer, line: Math.max(0, Math.min(this.buffer.lines.length - 1, line)) },
      "^",
    );
    this.keepCursorAtEnd = false;
    this.syncSelectedIndex();
  }
  moveViewport(key: "H" | "M" | "L", top: number, height: number, count: number): void {
    this.buffer = moveTimelineViewport(this.buffer, key, top, height, count);
    this.keepCursorAtEnd = false;
    this.syncSelectedIndex();
  }
  textObject(object: string, around: boolean, count: number, select: boolean): string | undefined {
    const range = timelineTextObjectRange(this.buffer, object, around, count);
    if (!range) return undefined;
    if (select) {
      this.buffer = selectTimelineTextRange(this.buffer, range);
      this.keepCursorAtEnd = false;
      return undefined;
    }
    return this.copyCharacterRange(range.start, range.end);
  }
  pageText(direction: -1 | 1, height: number): void {
    this.buffer = pageTimelineBuffer(this.buffer, direction, height);
    this.keepCursorAtEnd = false;
    this.syncSelectedIndex();
  }
  startVisual(selection: TimelineSelectionMode): boolean {
    this.selectionFeedback = "";
    if (this.buffer.mode === "visual") {
      if (this.buffer.selectionMode === selection) {
        this.clearVisual();
        return false;
      }
      this.buffer = { ...this.buffer, selectionMode: selection };
    } else this.buffer = enterTimelineVisual(this.buffer, selection);
    this.keepCursorAtEnd = false;
    return true;
  }
  clearVisual(): void {
    if (this.buffer.mode === "visual") {
      this.captureBufferAnchor();
      this.previousSelection = { buffer: this.buffer, anchor: this.bufferAnchor };
      this.bufferAnchor = undefined;
    }
    this.buffer = leaveTimelineVisual(this.buffer);
  }
  swapEndpoints(): void {
    if (!this.buffer.anchor) return;
    const anchor = { line: this.buffer.line, column: this.buffer.column };
    this.buffer = { ...this.buffer, ...this.buffer.anchor, anchor };
    delete (this.buffer as { selectionRange?: unknown }).selectionRange;
  }
  reselect(): boolean {
    const previous = this.previousSelection;
    if (!previous?.anchor?.selection) return false;
    const layout = this.timelineLayout(this.renderedWidth);
    const cursor = this.resolveBufferAnchor(previous.anchor.cursor, layout, true);
    const anchor = this.resolveBufferAnchor(previous.anchor.selection, layout, true);
    if (!cursor || !anchor) {
      this.previousSelection = undefined;
      return false;
    }
    const rangeStart = previous.anchor.range
      ? this.resolveBufferAnchor(previous.anchor.range.start, layout, true)
      : undefined;
    const rangeEnd = previous.anchor.range
      ? this.resolveBufferAnchor(previous.anchor.range.end, layout, true)
      : undefined;
    if (previous.anchor.range && (!rangeStart || !rangeEnd)) {
      this.previousSelection = undefined;
      return false;
    }
    if (this.buffer.mode === "visual") {
      this.captureBufferAnchor();
      this.previousSelection = { buffer: this.buffer, anchor: this.bufferAnchor };
      this.bufferAnchor = undefined;
    }
    this.buffer = { ...previous.buffer, lines: this.buffer.lines, ...cursor, anchor };
    delete (this.buffer as { selectionRange?: unknown }).selectionRange;
    if (rangeStart && rangeEnd) {
      const from = offsetAt(this.buffer.lines, rangeStart);
      const to = characterStep(
        this.buffer.lines.join("\n"),
        offsetAt(this.buffer.lines, rangeEnd),
        1,
      );
      this.buffer = { ...this.buffer, selectionRange: { start: from, end: to } };
    }
    this.keepCursorAtEnd = false;
    return true;
  }
  searchText(query: string, direction: -1 | 1 = 1): void {
    this.searchQuery = query;
    this.buffer = searchTimelineBuffer(this.buffer, query, direction);
    this.keepCursorAtEnd = false;
    this.syncSelectedIndex();
  }
  repeatSearch(direction: -1 | 1): void {
    if (this.searchQuery)
      this.buffer = searchTimelineBuffer(this.buffer, this.searchQuery, direction);
    this.keepCursorAtEnd = false;
    this.syncSelectedIndex();
  }
  clipboardKind(): "character" | "line" {
    return this.buffer.mode === "visual" && this.buffer.selectionMode === "line"
      ? "line"
      : "character";
  }
  yankText(rows = false): string {
    const range = timelineSelection(this.buffer);
    if (!range || !this.events.length) return "";
    if (rows || this.buffer.selectionMode === "line") {
      const start = positionAt(this.buffer.lines, range.start).line;
      const end = positionAt(this.buffer.lines, Math.max(range.start, range.end - 1)).line;
      return this.copyRows(start, end + 1);
    }
    return this.copyCharacterRange(range.start, range.end);
  }
  yankObject(object: "line" | "event", count = 1): string {
    if (!this.events.length) return "";
    if (object === "line") return this.copyRows(this.buffer.line, this.buffer.line + count);
    return "";
  }
  yankMotion(
    key: string,
    count = 0,
    character?: string,
  ): { text: string; kind: "line" | "character" } | undefined {
    if (!this.events.length) return undefined;
    const original = this.buffer;
    const target =
      character === undefined
        ? moveTimelineBuffer(original, key, count)
        : findTimelineCharacter(original, key as "f" | "F" | "t" | "T", character, count || 1);
    if (
      target.line === original.line &&
      target.column === original.column &&
      !(
        ["e", "E", "ge", "gE", "$", "g$", "g_"].includes(key) &&
        (original.lines[original.line]?.length ?? 0) > 0
      )
    )
      return undefined;
    if (["j", "k", "gj", "gk", "gg", "G", "{", "}", "[[", "]]", "[]", "]["].includes(key)) {
      return {
        text: this.copyRows(
          Math.min(original.line, target.line),
          Math.max(original.line, target.line) + 1,
        ),
        kind: "line",
      };
    }
    const from = offsetAt(original.lines, original);
    let to = offsetAt(original.lines, target);
    if (key === "w" || key === "W")
      to = logicalWordOffset(original.lines.join("\n"), from, key, count || 1);
    const inclusive = [
      "e",
      "E",
      "ge",
      "gE",
      "$",
      "g$",
      "g_",
      "%",
      "f",
      "F",
      "t",
      "T",
      ";",
      ",",
    ].includes(key);
    const start = Math.min(from, to);
    const end = inclusive
      ? characterStep(original.lines.join("\n"), Math.max(from, to), 1)
      : Math.max(from, to);
    return end > start
      ? { text: this.copyCharacterRange(start, end), kind: "character" }
      : undefined;
  }
  private copyRows(start: number, end: number): string {
    return this.buffer.lines
      .slice(start, end)
      .map((line, index) => {
        const event = this.timelineLayout(this.renderedWidth).events[
          this.eventIndexAtBodyLine(start + index)
        ];
        const mapping = event?.positions[start + index - (event?.start ?? 0)];
        return (
          mapping?.region === "body" && line.startsWith("  ") ? line.slice(2) : line
        ).trimEnd();
      })
      .join("\n");
  }
  private copyCharacterRange(start: number, end: number): string {
    const layout = this.timelineLayout(this.renderedWidth);
    const first = positionAt(this.buffer.lines, start);
    const last = positionAt(this.buffer.lines, Math.max(start, end - 1));
    const pieces: { event: number; region: string; start: number; end: number; text: string }[] =
      [];
    for (let row = first.line; row <= last.line; row++) {
      const eventIndex = this.eventIndexAtBodyLine(row);
      const event = layout.events[eventIndex];
      const mapping = event?.positions[row - (event?.start ?? 0)];
      const line = this.buffer.lines[row] ?? "";
      const lo = row === first.line ? first.column : 0;
      const hi = row === last.line ? last.column + 1 : line.length;
      if (!event || !mapping) continue;
      if (mapping.region === "body") {
        const from = mapping.offsets[Math.min(lo, mapping.offsets.length - 1)] ?? 0;
        const tail =
          mapping.offsets[Math.min(Math.max(lo, hi - 1), mapping.offsets.length - 1)] ?? from;
        const to = hi > lo && line.length ? Math.min(event.content.length, tail + 1) : from;
        const previous = pieces.at(-1);
        if (previous?.event === eventIndex && previous.region === "body") {
          previous.end = Math.max(previous.end, to);
          previous.text = event.content.slice(previous.start, previous.end);
        } else
          pieces.push({
            event: eventIndex,
            region: "body",
            start: from,
            end: to,
            text: event.content.slice(from, to),
          });
      } else
        pieces.push({
          event: eventIndex,
          region: "header",
          start: 0,
          end: 0,
          text: line.slice(lo, hi).trimEnd(),
        });
    }
    return printableTimelineText(
      pieces
        .map((piece) => {
          if (piece.region !== "body") return piece.text;
          const event = layout.events[piece.event];
          const lineStart = (event?.content.lastIndexOf("\n", piece.start - 1) ?? -1) + 1;
          const leading = Math.max(0, 2 - (piece.start - lineStart));
          return piece.text
            .slice(piece.text.startsWith(" ".repeat(leading)) ? leading : 0)
            .replaceAll("\n  ", "\n");
        })
        .join("\n"),
    );
  }
  linkAtCursor(): string | undefined {
    const line = this.timelineLayout(this.renderedWidth).lines[this.buffer.line] ?? "";
    const column = this.buffer.column;
    const osc = getOsc8LinkAtColumn(line, column);
    if (osc) return safeWebLink(osc);
    const plain = printableTimelineText(line);
    for (const match of plain.matchAll(/https?:\/\/[^\s<>]+/g)) {
      const start = match.index;
      const raw = match[0];
      if (column >= start && column < start + raw.length)
        return safeWebLink(raw.replace(/[),.;!?]+$/u, ""));
    }
    const item = this.events[this.eventIndexAtBodyLine(this.buffer.line)]?.item;
    if (item?.type === "user-message" || item?.type === "assistant-message") {
      let searchFrom = 0;
      for (const match of item.text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
        const label = match[1];
        if (!label) continue;
        const start = plain.indexOf(label, searchFrom);
        if (start >= 0) searchFrom = start + label.length;
        if (start >= 0 && column >= start && column < start + label.length)
          return safeWebLink(match[2]);
      }
    }
    return undefined;
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
  captureInputState(): () => void {
    this.captureBufferAnchor();
    const buffer = this.buffer;
    const anchor = this.bufferAnchor;
    const following = this.keepCursorAtEnd;
    return () => {
      this.buffer = replaceTimelineBuffer(buffer, this.buffer.lines);
      this.bufferAnchor = anchor;
      this.keepCursorAtEnd = following;
      this.syncSelectedIndex();
    };
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
      this.keepCursorAtEnd = boundary === "end";
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
      this.layout = undefined;
      this.layouts.clear();
      this.rendered.clear();
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
      this.keepCursorAtEnd = false;
    }
  }
  toggleSelected(): void {
    const selected = this.events[this.selectedIndex];
    if (selected) this.toggle(selected.item.id);
  }
  toggle(id: string): void {
    this.captureBufferAnchor();
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    const event = this.events.find((candidate) => candidate.item.id === id);
    if (event) {
      this.itemViews.get(id)?.update(event.item, this.expanded.has(id));
      this.layout = undefined;
      this.layouts.clear();
      this.rendered.clear();
    }
  }
  invalidate(): void {
    for (const item of this.itemViews.values()) item.invalidate();
    this.layout = undefined;
    this.layouts.clear();
    this.rendered.clear();
  }
  render(width: number): string[] {
    if (this.layout && this.layout.width !== width) this.captureBufferAnchor();
    this.renderedWidth = width;
    const mode = this.state?.timelineMode ?? "normal";
    const heading =
      width < 18
        ? `${this.focused ? mode.slice(0, 1).toUpperCase() : ""} Timeline`.trimStart()
        : `${this.focused ? mode.toUpperCase() : "        "} ${this.heading}`;
    if (this.events.length === 0) {
      if (!this.state?.timeline.loading) this.buffer = createTimelineBuffer();
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
    const cached = this.rendered.get(width);
    if (
      cached?.width === width &&
      cached.heading === heading &&
      cached.focused === this.focused &&
      cached.mode === mode &&
      cached.selectionFeedback === this.selectionFeedback &&
      (!this.focused || (cached.layout === this.layout && cached.buffer === this.buffer))
    )
      return cached.lines;
    const layout = this.timelineLayout(width);
    const bodyLines = layout.plainLines;
    const wasVisual = this.buffer.mode === "visual";
    if (this.buffer.lines !== bodyLines)
      this.buffer = replaceTimelineBuffer(this.buffer, bodyLines, true);
    if (this.bufferAnchor) {
      const cursorPosition = this.resolveBufferAnchor(
        this.bufferAnchor.cursor,
        layout,
        false,
        true,
      );
      const cursorLine = cursorPosition?.line;
      const selectionLine = this.bufferAnchor.selection
        ? this.resolveBufferAnchor(this.bufferAnchor.selection, layout, true)
        : undefined;
      if (cursorPosition) this.buffer = { ...this.buffer, ...cursorPosition };
      else {
        const nearest =
          layout.events[Math.min(this.bufferAnchor.cursor.eventIndex, layout.events.length - 1)];
        if (nearest) this.buffer = { ...this.buffer, line: nearest.bodyStart, column: 0 };
      }
      if (
        cursorLine === undefined ||
        (this.bufferAnchor.selection &&
          (selectionLine === undefined ||
            !this.resolveBufferAnchor(this.bufferAnchor.cursor, layout, true)))
      )
        this.buffer = leaveTimelineVisual(this.buffer);
      else if (selectionLine !== undefined && this.buffer.anchor)
        this.buffer = { ...this.buffer, anchor: selectionLine };
      if (this.bufferAnchor.range && this.buffer.mode === "visual") {
        const start = this.resolveBufferAnchor(this.bufferAnchor.range.start, layout, true);
        const end = this.resolveBufferAnchor(this.bufferAnchor.range.end, layout, true);
        if (!start || !end) this.buffer = leaveTimelineVisual(this.buffer);
        else {
          const offset = (line: number) =>
            this.buffer.lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0);
          this.buffer = {
            ...this.buffer,
            selectionRange: {
              start: offset(start.line) + (this.buffer.selectionMode === "line" ? 0 : start.column),
              end:
                offset(end.line) +
                (this.buffer.selectionMode === "line"
                  ? (this.buffer.lines[end.line]?.length ?? 0)
                  : end.column + 1),
            },
          };
        }
      }
      this.bufferAnchor = undefined;
    }
    if (this.viewportAnchor) {
      const position = this.resolveBufferAnchor(this.viewportAnchor, layout, false, true);
      this.remappedViewport = position ? position.line + 1 : undefined;
      this.viewportAnchor = undefined;
    }
    if (
      this.buffer.mode === "normal" &&
      this.state?.selectedAgentId &&
      this.keepCursorAtEnd &&
      this.state.timelineNavigation[this.state.selectedAgentId]?.following !== false
    )
      this.buffer = moveTimelineBuffer(this.buffer, "G");
    this.syncSelectedIndex();
    if (wasVisual && this.buffer.mode !== "visual")
      this.selectionFeedback = "Selection cleared: timeline changed";
    if (
      cached?.layout === layout &&
      cached.heading === heading &&
      cached.focused &&
      this.focused &&
      cached.mode === "normal" &&
      mode === "normal" &&
      cached.buffer.mode === "normal" &&
      this.buffer.mode === "normal" &&
      cached.selectionFeedback === this.selectionFeedback
    ) {
      const lines = cached.lines.slice();
      const previous = cached.buffer.line;
      lines[previous + 1] = this.paintBodyLine(layout, previous, width, false);
      lines[this.buffer.line + 1] = this.paintBodyLine(layout, this.buffer.line, width, true);
      this.rendered.set(width, { ...cached, buffer: this.buffer, lines });
      return lines;
    }
    const lines = [
      this.theme.styleRendered(
        "header",
        this.theme.clipRendered(
          `${heading}${this.selectionFeedback ? ` · ${this.selectionFeedback}` : ""}`,
          width,
        ),
      ),
      ...layout.events.flatMap(({ lines, start }) => {
        return lines.map((_, offset) =>
          this.paintBodyLine(
            layout,
            start + offset,
            width,
            this.focused && this.buffer.line === start + offset,
          ),
        );
      }),
    ];
    this.rendered.set(width, {
      width,
      layout,
      buffer: this.buffer,
      heading,
      focused: this.focused,
      mode,
      selectionFeedback: this.selectionFeedback,
      lines,
    });
    if (this.rendered.size > 8) this.rendered.delete(this.rendered.keys().next().value ?? width);
    return lines;
  }

  private paintBodyLine(
    layout: TimelineLayout,
    bodyLine: number,
    width: number,
    active: boolean,
  ): string {
    const line = layout.lines[bodyLine] ?? "";
    let rendered = line;
    if (this.focused && this.buffer.mode === "visual") {
      const range = timelineSelectionColumns(this.buffer, bodyLine);
      if (range) {
        const plain = layout.plainLines[bodyLine] ?? "";
        rendered = `${plain.slice(0, range.start)}${this.theme.styleBackground("tab-active", plain.slice(range.start, range.end))}${plain.slice(range.end)}`;
      }
    }
    const clipped = clipTerminalLine(rendered, width, this.theme.glyph("ellipsis"));
    if (!active) return clipped;
    const padded = `${clipped}${" ".repeat(Math.max(0, width - terminalDisplayWidth(clipped)))}`;
    const plain = layout.plainLines[bodyLine] ?? "";
    const cursorColumn = Math.min(
      Math.max(0, terminalDisplayWidth(plain.slice(0, this.buffer.column))),
      Math.max(0, width - 1),
    );
    const withCursor = `${sliceByColumn(padded, 0, cursorColumn)}${CURSOR_MARKER}${sliceByColumn(padded, cursorColumn, width - cursorColumn)}`;
    return this.theme.styleRenderedBackground("selection", withCursor);
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

  cursorLineRange(): { start: number; end: number } {
    const line = this.buffer.line + 1;
    return { start: line, end: line };
  }
  setCursorAtAnchor(cursor: { epoch: string; sequence: number }): void {
    if (this.restoredContentPosition || this.bufferAnchor) return;
    const range = this.lineRangeForCursor(cursor);
    if (!range) return;
    this.buffer = { ...this.buffer, line: range.start - 1, column: 0 };
    this.keepCursorAtEnd = false;
    this.syncSelectedIndex();
  }
  private syncSelectedIndex(): void {
    const index = this.eventIndexAtBodyLine(this.buffer.line);
    if (index >= 0) this.selectedIndex = index;
  }
  private captureBufferAnchor(): void {
    const layout = this.layout;
    if (!layout) return;
    const at = (line: number, column: number): TimelineContentAnchor | undefined => {
      const eventIndex = layout.events.findIndex(
        (event) => line >= event.start && line < event.start + event.lines.length,
      );
      const event = layout.events[eventIndex];
      const row = event?.positions[line - event.start];
      return event && row
        ? {
            itemId: event.itemId,
            eventIndex,
            eventOrder: layout.events.map((entry) => entry.itemId),
            region: row.region,
            offset: row.offsets[Math.min(column, row.offsets.length - 1)] ?? 0,
            content: event.content,
            folded: event.folded,
          }
        : undefined;
    };
    const following = this.state?.selectedAgentId
      ? this.state.timelineNavigation[this.state.selectedAgentId]?.following !== false
      : this.keepCursorAtEnd;
    this.viewportAnchor = following
      ? undefined
      : at(Math.max(0, (this.remappedViewport ?? this.viewportLine()) - 1), 0);
    const cursor = at(this.buffer.line, this.buffer.column);
    const selection = this.buffer.anchor
      ? at(this.buffer.anchor.line, this.buffer.anchor.column)
      : undefined;
    const range = timelineSelection(this.buffer);
    const positionAtOffset = (offset: number) => {
      for (let line = 0; line < this.buffer.lines.length; line++) {
        const length = this.buffer.lines[line]?.length ?? 0;
        if (offset <= length) return at(line, offset);
        offset -= length + 1;
      }
      return undefined;
    };
    const rangeStart = range ? positionAtOffset(range.start) : undefined;
    const rangeEnd = range ? positionAtOffset(Math.max(range.start, range.end - 1)) : undefined;
    if (cursor)
      this.bufferAnchor = {
        cursor,
        ...(selection ? { selection } : {}),
        ...(rangeStart && rangeEnd ? { range: { start: rangeStart, end: rangeEnd } } : {}),
      };
  }
  private resolveBufferAnchor(
    anchor: TimelineContentAnchor,
    layout: TimelineLayout,
    strict = false,
    allowNearest = false,
  ): { line: number; column: number } | undefined {
    const event = layout.events.find((event) => event.itemId === anchor.itemId);
    if (!event) {
      if (!allowNearest) return undefined;
      for (let distance = 1; distance < anchor.eventOrder.length; distance++) {
        for (const index of [anchor.eventIndex + distance, anchor.eventIndex - distance]) {
          const survivor = layout.events.find((entry) => entry.itemId === anchor.eventOrder[index]);
          if (survivor) return { line: survivor.bodyStart, column: 0 };
        }
      }
      const fallback = layout.events[Math.min(anchor.eventIndex, layout.events.length - 1)];
      return fallback ? { line: fallback.bodyStart, column: 0 } : undefined;
    }
    if (
      strict &&
      ((event.folded && !anchor.folded) ||
        (anchor.region === "body" &&
          !event.content.startsWith(anchor.content.slice(0, anchor.offset + 1))))
    )
      return undefined;
    if (event.folded && !anchor.folded) return { line: event.bodyStart, column: 0 };
    let nearest: { line: number; column: number } | undefined;
    let distance = Number.POSITIVE_INFINITY;
    for (const [rowIndex, row] of event.positions.entries()) {
      if (row.region !== anchor.region) continue;
      for (const [column, offset] of row.offsets.entries()) {
        const delta = Math.abs(offset - anchor.offset);
        if (delta < distance) {
          nearest = { line: event.start + rowIndex, column };
          distance = delta;
        }
      }
    }
    return nearest ?? { line: event.bodyStart, column: 0 };
  }

  takeRemappedViewport(): number | undefined {
    const line = this.remappedViewport;
    this.remappedViewport = undefined;
    return line;
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
    const cached = this.layouts.get(width);
    if (cached) {
      this.layout = cached;
      return cached;
    }
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
      // The canonical text is independent of viewport width. Map each displayed
      // character sequentially into it, so repeated identical rows have separate
      // offsets and rewrapping never uses row numbers as content identity.
      const canonical = this.itemViews.get(item.id)?.canonicalLines() ?? [];
      const contentStart = primary ? 1 : 0;
      const canonicalText = canonical
        .slice(contentStart)
        .map((line) => line.trimEnd())
        .join("\n");
      let source = 0;
      const positions = lines.map((line, index) => {
        const itemRow = index - gap.length - header.length;
        const region = itemRow < contentStart ? ("header" as const) : ("body" as const);
        const text = printableTimelineText(line).trimEnd();
        if (region === "header")
          return {
            region,
            offsets: Array.from({ length: Math.max(1, text.length) }, (_, column) => column),
          };
        const offsets: number[] = [];
        for (let column = 0; column < text.length; column++) {
          const character = text[column] ?? "";
          if (!/\s/u.test(character)) {
            while (source < canonicalText.length && /\s/u.test(canonicalText[source] ?? ""))
              source++;
          }
          offsets.push(source);
          if (canonicalText[source] === character) source++;
        }
        if (offsets.length === 0) {
          offsets.push(source);
          if (canonicalText[source] === "\n") source++;
        }
        return { region, offsets };
      });
      const layout = {
        itemId: item.id,
        content: canonicalText,
        folded: (item.type === "tool" || item.type === "reasoning") && !this.expanded.has(item.id),
        positions,
        start,
        bodyStart: start + gap.length + header.length,
        lines,
      };
      start += lines.length;
      return layout;
    });
    const lines = events.flatMap((event) => event.lines);
    this.layout = { width, lines, plainLines: lines.map(printableTimelineText), events };
    this.layouts.set(width, this.layout);
    if (this.layouts.size > 8) this.layouts.delete(this.layouts.keys().next().value ?? width);
    return this.layout;
  }
}

type TimelineContentAnchor = {
  itemId: string;
  eventIndex: number;
  eventOrder: readonly string[];
  region: "header" | "body";
  offset: number;
  content: string;
  folded: boolean;
};

type TimelineLayout = {
  width: number;
  lines: readonly string[];
  plainLines: readonly string[];
  events: readonly {
    itemId: string;
    content: string;
    folded: boolean;
    positions: readonly { region: "header" | "body"; offsets: readonly number[] }[];
    start: number;
    bodyStart: number;
    lines: readonly string[];
  }[];
};

function landmark(item: TimelineItem, kind: "turn" | "error"): boolean {
  return kind === "turn"
    ? item.type === "turn"
    : item.type === "error" || (item.type === "tool" && item.status === "failed");
}

function safeWebLink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function openWebLink(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Opening link failed: ${code}`)),
    );
  });
}

class TimelineScrollView extends ScrollView {
  constructor(
    component: Component,
    private readonly onFollowChange: (following: boolean) => void,
    private readonly remappedViewport: () => number | undefined,
  ) {
    super(component, { follow: "end", primary: true, scrollbar: "auto" });
  }

  override updateLayout(
    contentHeight: number,
    viewportHeight: number,
    requestRender: () => void,
  ): void {
    const remapped = this.remappedViewport();
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    if (remapped !== undefined) this.scrollTo(remapped, { disableFollow: true });
  }

  override scrollBy(lines: number): number {
    const wasFollowing = this.isFollowingEnd;
    const before = this.scrollTop;
    const remaining = super.scrollBy(lines);
    if (before !== this.scrollTop || wasFollowing !== this.isFollowingEnd)
      this.onFollowChange(this.isFollowingEnd);
    return remaining;
  }
}

class BorderlessEditor extends Editor {
  override render(width: number): string[] {
    const lines = super.render(width);
    // The stock editor draws horizontal rules; the composer uses a background.
    return lines.length >= 2 ? lines.slice(1, -1) : lines;
  }
}

class ComposerView implements Component, Focusable {
  focused = false;
  private editor: BorderlessEditor;
  private readonly makeEditor: (text: string) => BorderlessEditor;
  private resourceKey: string;
  private readonly resources = new Map<
    string,
    { editor: BorderlessEditor; vim: ComposerVimState }
  >();
  private selectedAgentId: string | undefined;
  private draftWorkspaceId: string | undefined;
  private state: AppState;
  private vim: ComposerVimState;
  private inputRevision = 0;
  private visibleEditorLines = 3;
  constructor(
    tui: TUI,
    state: AppState,
    private readonly emit: (intent: UiIntent) => void,
    private readonly theme: DeckTheme,
    private readonly clipboard: SharedClipboard,
  ) {
    this.state = state;
    this.selectedAgentId = state.selectedAgentId;
    this.draftWorkspaceId = activeSessionDraftWorkspaceId(state);
    this.resourceKey = this.keyFor(state);
    this.makeEditor = (text) => {
      const editor = new BorderlessEditor(
        tui,
        {
          borderColor: (value) => this.theme.style(this.focused ? "focus" : "muted", value),
          selectList: selectTheme(this.theme),
        },
        { paddingX: 1 },
      );
      editor.setText(text);
      editor.onChange = (text) => emit({ type: "set-composer-text", text });
      editor.onSubmit = (prompt) => this.submit(prompt);
      return editor;
    };
    this.editor = this.makeEditor(selectedComposerDraft(state));
    this.vim = {
      ...createComposerVim(
        this.editor.getText(),
        positionToOffset(this.editor.getText(), this.editor.getCursor()),
      ),
      mode: state.composerMode ?? "insert",
    };
    if (state.composerMode === "visual") this.vim = { ...this.vim, anchor: this.vim.cursor };
  }
  private keyFor(state: AppState): string {
    if (state.newWorkspace) return "new-workspace";
    const draft = activeSessionDraftWorkspaceId(state);
    if (draft) return `draft:${draft}`;
    const launch = activeLaunchWorkspaceId(state);
    if (launch) return `launch:${launch}`;
    return `session:${state.selectedAgentId ?? "none"}`;
  }
  private submit(prompt: string): void {
    const launchId = activeLaunchWorkspaceId(this.state);
    if (launchId) this.emit({ type: "submit-launch", workspaceId: launchId, prompt });
    else if (this.draftWorkspaceId && prompt.trim())
      this.emit({ type: "submit-session-draft", workspaceId: this.draftWorkspaceId, prompt });
    else if (this.selectedAgentId && prompt.trim())
      this.emit({ type: "submit-composer", agentId: this.selectedAgentId, prompt });
  }
  update(state: AppState): void {
    const key = this.keyFor(state);
    const changed = key !== this.resourceKey;
    if (changed) {
      this.cancelPendingInput();
      this.resources.set(this.resourceKey, { editor: this.editor, vim: this.vim });
      this.resourceKey = key;
      const saved = this.resources.get(key);
      this.editor = saved?.editor ?? this.makeEditor(selectedComposerDraft(state));
      this.vim = saved?.vim ?? {
        ...createComposerVim(selectedComposerDraft(state)),
        mode: state.composerMode === undefined ? "insert" : "normal",
      };
    }
    this.state = state;
    this.selectedAgentId = state.selectedAgentId;
    this.draftWorkspaceId = activeSessionDraftWorkspaceId(state);
    const draft = selectedComposerDraft(state);
    if (this.editor.getText() !== draft) {
      this.editor.setText(draft);
      this.vim = { ...createComposerVim(draft), mode: this.vim.mode };
    }
    this.vim = syncComposerVim(this.vim, this.editor.getText(), this.editor.getCursor());
    if (changed) {
      if (state.composerMode !== this.vim.mode)
        this.emit({ type: "set-composer-mode", mode: this.vim.mode });
    } else if ((state.composerMode ?? "insert") !== this.vim.mode)
      this.vim = {
        ...this.vim,
        mode: state.composerMode ?? "insert",
        anchor: state.composerMode === "visual" ? this.vim.cursor : undefined,
      };
    else if (state.composerMode === "visual" && this.vim.anchor === undefined)
      this.vim = { ...this.vim, anchor: this.vim.cursor };
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
    const launchId = activeLaunchWorkspaceId(this.state);
    const launch = launchId ? launchDraft(this.state, launchId) : undefined;
    const destination = launch
      ? this.theme.label(
          this.state.newWorkspace
            ? `New workspace · ${launch.kind === "session" ? "First message" : "First command"}`
            : launch.kind === "session"
              ? "Launch Session · First message"
              : "Launch Terminal · First command",
        )
      : this.draftWorkspaceId
        ? this.theme.label("First message → New session")
        : agent
          ? `Prompt ${this.theme.label("→")} ${sanitizeTerminalText(agent.title)}`
          : this.theme.label("Prompt → no agent selected");
    const draft =
      launch ??
      (this.draftWorkspaceId ? this.state.sessionDrafts[this.draftWorkspaceId] : undefined);
    const status = draft
      ? draft.submitting
        ? ` ${this.theme.glyph("bullet")} creating${this.theme.glyph("running")}`
        : draft.error
          ? ` ${this.theme.glyph("bullet")} retry`
          : ""
      : this.selectedAgentId && this.state.composer.sendingAgentIds.has(this.selectedAgentId)
        ? ` ${this.theme.glyph("bullet")} sending${this.theme.glyph("running")}`
        : !availability.canSend
          ? ` ${this.theme.glyph("bullet")} ${availability.reason}`
          : "";
    const mode = this.state.composerMode ?? "normal";
    const selection = composerVisualSelection(this.vim);
    const selectionCue = selection
      ? ` ${this.theme.glyph("bullet")} selected ${selection.end - selection.start} chars`
      : "";
    const heading =
      `${this.state.focus === "composer" ? mode.toUpperCase() : ""} ${destination}${status}${selectionCue}`.trim();
    const innerWidth = Math.max(1, width);
    const controlRow = composerControlRow(this.state, this.theme, innerWidth);
    const controls =
      innerWidth < 55 ? this.theme.clipRendered(`Prompt ${controlRow}`, innerWidth) : controlRow;
    const body = this.highlightVisualSelection(this.editor.render(innerWidth), innerWidth);
    this.visibleEditorLines = Math.max(1, body.length);
    const lines = [
      this.theme.styleRendered(
        this.focused ? "focus" : "muted",
        ` ${this.theme.clipRendered(heading, Math.max(1, innerWidth - 1))}`,
      ),
      ...(this.state.newWorkspace
        ? [
            ` ${this.theme.clipOwnedLabel(`Project · ${this.state.directory.projects.find((project) => project.id === this.state.newWorkspace?.projectId)?.name ?? "Choose project"}`, Math.max(1, innerWidth - 1))}`,
            ` ${this.theme.clipOwnedLabel(this.state.newWorkspace.placementLoading ? "Loading workspace placement…" : this.state.newWorkspace.placementError ? "Workspace placement unavailable · Retry through palette" : `${this.state.newWorkspace.placementOptions?.supportsWorktree ? "" : ""}${this.state.newWorkspace.placement === "worktree" ? "Worktree" : "Local"} · ${this.state.directory.projects.find((project) => project.id === this.state.newWorkspace?.projectId)?.path ?? "Original checkout unavailable"}`, Math.max(1, innerWidth - 1))}`,
            ...(this.state.newWorkspace.placement === "worktree"
              ? [
                  ` ${this.theme.clipOwnedLabel(`Base ref · ${this.state.newWorkspace.placementOptions?.refs.find((ref) => ref.ref === this.state.newWorkspace?.baseRef)?.label ?? "Choose base"}`, Math.max(1, innerWidth - 1))}`,
                ]
              : []),
            ` ${this.theme.clipOwnedLabel(`Title · ${this.state.newWorkspace.title || "Optional"}`, Math.max(1, innerWidth - 1))}`,
          ]
        : []),
      ...body,
      ` ${this.theme.clipRendered(controls, Math.max(1, innerWidth - 1))}`,
    ];
    return lines.map((line) =>
      this.theme.styleRenderedBackground(
        "composer",
        `${line}${" ".repeat(Math.max(0, width - terminalDisplayWidth(line)))}`,
      ),
    );
  }
  get hasPendingCommand(): boolean {
    return Boolean(this.vim.pending || this.vim.count);
  }

  handleInput(data: string): void {
    this.inputRevision++;
    const launchId = activeLaunchWorkspaceId(this.state);
    if (launchId && launchDraft(this.state, launchId).submitting) return;
    if (data.startsWith("\u001b[200~") && this.vim.mode === "visual") {
      const text = data.slice(6).replace("\u001b[201~", "").replace(/\r\n?/gu, "\n");
      this.applyVimResult({ state: applyComposerNativePaste(this.vim, text), handled: true });
      return;
    }
    if (data.startsWith("\u001b[200~")) {
      const payload = data.slice(6, data.endsWith("\u001b[201~") ? -6 : undefined);
      this.applyVimResult({
        state: applyComposerInsertText(
          syncComposerVim(this.vim, this.editor.getText(), this.editor.getCursor()),
          payload,
          true,
        ),
        handled: true,
      });
      return;
    }
    if (this.state.composerMode === "visual" || this.state.composerMode === "normal") {
      this.handleVimInput(data);
      return;
    }
    const current = syncComposerVim(this.vim, this.editor.getText(), this.editor.getCursor());
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const up = matchesKey(data, "up");
      if ((up && current.cursor === 0) || (!up && current.cursor === current.text.length)) {
        this.applyVimResult({
          state: recallComposerPrompt(current, this.sentPrompts(), up ? -1 : 1),
          handled: true,
        });
      } else {
        this.editor.handleInput(up ? "\u001b[A" : "\u001b[B");
        this.vim = syncComposerVim(current, this.editor.getText(), this.editor.getCursor());
      }
      return;
    }
    const bindings: readonly [string, readonly Parameters<typeof matchesKey>[1][]][] = [
      ["insert-left", ["left", "ctrl+b"]],
      ["insert-right", ["right", "ctrl+f"]],
      ["insert-word-left", ["alt+left", "ctrl+left", "alt+b"]],
      ["insert-word-right", ["alt+right", "ctrl+right", "alt+f"]],
      ["insert-home", ["home", "ctrl+home", "ctrl+a"]],
      ["insert-end", ["end", "ctrl+end", "ctrl+e"]],
      ["insert-backspace", ["backspace", "shift+backspace"]],
      ["insert-delete", ["delete", "shift+delete"]],
      ["insert-delete-word-left", ["ctrl+w", "alt+backspace"]],
      ["insert-delete-word-right", ["alt+d", "alt+delete"]],
      ["insert-newline", ["enter", "alt+enter", "shift+enter", "ctrl+j"]],
      ["insert-redo", ["ctrl+shift+z"]],
      ["\u001a", ["ctrl+z"]],
    ];
    const key =
      bindings.find(([, chords]) => chords.some((chord) => matchesKey(data, chord)))?.[0] ??
      (data === "\n" || data === "\u001b\r" ? "insert-newline" : data);
    this.applyVimResult(handleComposerVim(current, key));
  }

  private sentPrompts(): readonly string[] {
    return this.resourceKey.startsWith("session:") && this.selectedAgentId
      ? (this.state.composer.histories[this.selectedAgentId] ?? [])
      : [];
  }

  private handleVimInput(data: string): void {
    if (this.vim.pending === "g" && data === "?") {
      this.cancelPendingInput();
      this.emit({ type: "open-help" });
      return;
    }
    const current = setComposerViewport(
      syncComposerVim(this.vim, this.editor.getText(), this.editor.getCursor()),
      0,
      this.visibleEditorLines,
    );
    if (
      current.mode === "normal" &&
      !current.pending &&
      !current.count &&
      ((data === "k" && offsetToPosition(current.text, current.cursor).line === 0) ||
        (data === "j" && !current.text.slice(current.cursor).includes("\n")))
    ) {
      this.applyVimResult({
        state: recallComposerPrompt(current, this.sentPrompts(), data === "k" ? -1 : 1),
        handled: true,
      });
      return;
    }
    if (data === "\r" && current.mode === "normal" && !current.pending && !current.count) {
      this.editor.onSubmit?.(current.text);
      return;
    }
    this.applyVimResult(handleComposerVim(current, data));
  }

  private highlightVisualSelection(body: string[], width: number): string[] {
    const selection = composerVisualSelection(this.vim);
    if (!selection) return body;
    const rows: { text: string; offset: number }[] = [];
    let offset = 0;
    for (const line of this.vim.text.split("\n")) {
      for (const chunk of wordWrapLine(line, Math.max(1, width - 2)))
        rows.push({ text: chunk.text, offset: offset + chunk.startIndex });
      offset += line.length + 1;
    }
    const cursorRow = Math.max(
      0,
      rows.findIndex(
        (row, index) =>
          this.vim.cursor >= row.offset && this.vim.cursor < (rows[index + 1]?.offset ?? Infinity),
      ),
    );
    const top = Math.max(0, cursorRow - body.length + 1);
    return rows.slice(top, top + body.length).map((row) => {
      const offsets = characterOffsets(row.text);
      let text = "";
      for (let index = 0; index < offsets.length - 1; index++) {
        const start = offsets[index] ?? 0;
        const end = offsets[index + 1] ?? row.text.length;
        let character = row.text.slice(start, end);
        const at = row.offset + start;
        if (at === this.vim.cursor) character = `\u001b[7m${character}\u001b[27m`;
        if (at >= selection.start && at < selection.end)
          character = this.theme.styleRenderedBackground("selection", character);
        text += character;
      }
      if (!row.text && row.offset === this.vim.cursor) text = "\u001b[7m \u001b[27m";
      return ` ${text}${" ".repeat(Math.max(0, width - 1 - terminalDisplayWidth(row.text)))}`;
    });
  }

  private applyVimResult(result: ReturnType<typeof handleComposerVim>): void {
    const previousMode = this.vim.mode;
    this.vim = result.state;
    if (this.editor.getText() !== result.state.text) this.editor.setText(result.state.text);
    this.placeCursor(offsetToPosition(result.state.text, result.state.cursor));
    if (result.copy)
      void this.clipboard.write(result.copy.text, result.copy.kind).catch(() => {
        this.emit({ type: "notify", message: "Clipboard write failed.", kind: "error" });
      });
    if (result.paste) {
      const paste = result.paste;
      const capturedState = this.vim;
      const capturedRevision = this.inputRevision;
      const capturedResource = this.clipboardResource();
      void this.clipboard
        .read()
        .then((value) => {
          if (
            this.inputRevision !== capturedRevision ||
            this.clipboardResource() !== capturedResource ||
            this.vim.text !== capturedState.text ||
            this.vim.cursor !== capturedState.cursor ||
            this.vim.mode !== capturedState.mode ||
            this.vim.anchor !== capturedState.anchor
          )
            return;
          const selection = composerVisualSelection(capturedState);
          this.applyVimResult({
            state: applyComposerPaste(capturedState, value.text, value.kind, paste),
            handled: true,
            ...(selection && !paste.before && value.text
              ? {
                  copy: {
                    text: capturedState.text.slice(selection.start, selection.end),
                    kind: selection.kind,
                  },
                }
              : {}),
          });
        })
        .catch(() =>
          this.emit({ type: "notify", message: "Clipboard read failed.", kind: "error" }),
        );
    }
    if (previousMode !== result.state.mode)
      this.emit({ type: "set-composer-mode", mode: result.state.mode });
  }

  private clipboardResource(): string {
    return this.state.newWorkspace
      ? "new-workspace"
      : `${this.state.selectedWorkspaceId ?? ""}:${this.state.activeTerminalId ?? ""}:${this.selectedAgentId ?? this.draftWorkspaceId ?? activeLaunchWorkspaceId(this.state) ?? ""}`;
  }

  cancelPendingInput(): void {
    this.inputRevision++;
    this.vim = {
      ...this.vim,
      pending: "",
      count: "",
      operatorCount: 1,
      operatorCountExplicit: false,
      searchInput: undefined,
    };
  }

  private placeCursor(target: { line: number; col: number }): void {
    const current = this.editor.getCursor();
    if (current.line === target.line && current.col === target.col) return;
    const arrow = target.line < current.line ? "\u001b[A" : "\u001b[B";
    // Arrows traverse displayed rows; a logical line can span several of them.
    for (
      let remaining = this.editor.getText().length + 1;
      this.editor.getCursor().line !== target.line && remaining > 0;
      remaining--
    )
      this.editor.handleInput(arrow);
    this.editor.handleInput("\u0001");
    const prefix = (this.editor.getText().split("\n")[target.line] ?? "").slice(0, target.col);
    for (let index = 0; index < characterOffsets(prefix).length - 1; index++)
      this.editor.handleInput("\u001b[C");
  }
}

/** The existing session's controls use the command inventory for their cues and availability. */
export function composerControlRow(state: AppState, theme: DeckTheme, width: number): string {
  const launchId = activeLaunchWorkspaceId(state);
  const launch = launchId ? launchDraft(state, launchId) : undefined;
  const kindControl = launch
    ? `${theme.style("muted", "Resource")} ${launch.kind === "session" ? "Session" : "Terminal"}  `
    : "";
  if (launch?.kind === "terminal") {
    const profile = launch.profiles?.find((item) => item.id === launch.profileId);
    return theme.clipRendered(
      `${kindControl}${theme.style("muted", "Profile")} ${sanitizeTerminalText(profile?.name ?? "Default shell")}`,
      width,
    );
  }
  const draftWorkspaceId = activeSessionDraftWorkspaceId(state);
  if (draftWorkspaceId || launch) {
    const draft = launch ?? (draftWorkspaceId ? state.sessionDrafts[draftWorkspaceId] : undefined);
    const controls = [
      ["Provider", draft?.providerId ?? "provider"],
      ["Model", draft?.modelId ?? "model"],
      ["Thinking", draft?.thinkingLevel ?? "thinking"],
      ["Mode", draft?.modeId ?? "mode"],
    ] as const;
    return theme.clipRendered(
      kindControl +
        controls
          .map(
            ([key, value]) => `${theme.style("muted", `[${key}]`)} ${theme.style("focus", value)}`,
          )
          .join("  "),
      width,
    );
  }
  const agent = state.directory.agents.find((item) => item.id === state.selectedAgentId);
  const modelCommand = commandById(state, "model");
  const model = modelCommand?.disabledReason ? "unavailable" : (agent?.modelId ?? "-");
  const thinking = agent?.thinkingLevel ?? "-";
  const mode = agent?.modeId ?? "-";
  const controls = [
    [commandById(state, "model")?.shortcuts[0] ?? "Model", model],
    [commandById(state, "thinking")?.shortcuts[0] ?? "Think", thinking],
    [commandById(state, "operational-mode")?.shortcuts[0] ?? "Mode", mode],
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
    const launchId = activeLaunchWorkspaceId(state);
    if (launchId)
      return [
        this.theme.style(
          "muted",
          state.newWorkspace
            ? state.newWorkspace.launch.submitting
              ? "Creating workspace…"
              : "Workspace draft · unsent"
            : launchDraft(state, launchId).submitting
              ? "Launching…"
              : "Workspace activity · idle",
        ),
      ];
    const draftId = activeSessionDraftWorkspaceId(state);
    if (draftId) {
      const draft = state.sessionDrafts[draftId];
      return [
        this.theme.styleRendered(
          "muted",
          this.theme.clipRendered(
            `Session draft ${this.theme.glyph("bullet")} ${draft?.submitting ? "creating" : "unsent"}`,
            width,
          ),
        ),
      ];
    }
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
    const details = this.state.newWorkspace
      ? "new workspace draft"
      : selected
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
          : activeSessionDraftWorkspaceId(this.state)
            ? "session draft"
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
  private readonly input = new SingleLineField();
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
  private readonly input = new SingleLineField();
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
  content: readonly (string | { text: string; background: BackgroundTone })[],
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
  const frame = (contentLine: string | { text: string; background: BackgroundTone }): string => {
    const line = typeof contentLine === "string" ? contentLine : contentLine.text;
    const withoutMarker = line.replaceAll(CURSOR_MARKER, "");
    const body =
      line.includes(CURSOR_MARKER) && terminalDisplayWidth(withoutMarker) <= innerWidth
        ? line
        : theme.clipRendered(withoutMarker, innerWidth);
    const padded = `${body}${" ".repeat(Math.max(0, innerWidth - terminalDisplayWidth(body.replaceAll(CURSOR_MARKER, ""))))}`;
    const surface =
      typeof contentLine === "string"
        ? padded
        : theme.styleRenderedBackground(contentLine.background, padded);
    return theme.styleRenderedBackground(
      "composer",
      `${theme.styleRendered("border", vertical)}${surface}${theme.styleRendered("border", vertical)}`,
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

export class SearchableChoiceDialog implements Component, Focusable {
  focused = false;
  private readonly query: SingleLineField;
  private selected = 0;
  constructor(
    private readonly title: string,
    private readonly items: readonly CreationChoice[],
    private readonly choose: (value: string) => void,
    private readonly back: () => void,
    preferredValue?: string,
    private readonly maxVisible = 8,
    private readonly theme: DeckTheme = new DeckTheme(defaultTerminalAppearance),
    private readonly desktopNewTabStyle = false,
  ) {
    this.query = new SingleLineField({ prompt: desktopNewTabStyle ? "" : "Filter: " });
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
    this.selected = Math.max(0, Math.min(this.selected, matches.length - 1));
    const start = Math.max(
      0,
      Math.min(this.selected - Math.floor(this.maxVisible / 2), matches.length - this.maxVisible),
    );
    const visible = matches.slice(start, start + this.maxVisible);
    const backgroundSelection = this.desktopNewTabStyle && this.theme.supportsBackground();
    const selectionBackground =
      this.theme.appearance.color === "ansi16" ? "tab-active" : "selection";
    return framedChoicePickerLines(
      this.title,
      [
        ...this.query
          .render(Math.max(1, width - (this.desktopNewTabStyle ? 3 : 2)))
          .map((text) =>
            this.desktopNewTabStyle
              ? { text: ` ${text}`, background: "active-session" as const }
              : text,
          ),
        ...visible.flatMap((item, index) => {
          const lines: Array<string | { text: string; background: BackgroundTone }> = [];
          if (item.category && (index === 0 || visible[index - 1]?.category !== item.category)) {
            if (this.desktopNewTabStyle && index > 0) {
              lines.push(
                this.theme.styleRendered(
                  "border",
                  (this.theme.appearance.symbols === "unicode" ? "─" : "-").repeat(
                    Math.max(1, width - 2),
                  ),
                ),
              );
            }
            const heading = this.theme.clipOwnedLabel(
              `${this.desktopNewTabStyle ? " " : ""}${item.category}`,
              Math.max(1, width - 2),
            );
            lines.push(
              this.desktopNewTabStyle ? this.theme.styleRendered("muted", heading) : heading,
            );
          }
          const selected = start + index === this.selected;
          const label = this.theme.clipOwnedLabel(
            `${selected && !backgroundSelection ? "> " : "  "}${item.label}${item.description ? ` - ${item.description}` : ""}`,
            Math.max(1, width - 2),
          );
          lines.push(
            selected && backgroundSelection
              ? { text: label, background: selectionBackground }
              : label,
          );
          return lines;
        }),
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
    const direction = choiceNavigation(data);
    if (direction !== undefined)
      this.selected = Math.max(0, Math.min(matches.length - 1, this.selected + direction));
    else if (data !== "\n" && matchesKey(data, "enter")) {
      const item = matches[this.selected];
      if (item && !item.disabled) this.choose(item.value);
    } else {
      const before = this.query.getValue();
      this.query.handleInput(data);
      if (before !== this.query.getValue()) this.selected = 0;
    }
  }
  private matches(): readonly CreationChoice[] {
    const query = this.query.getValue().toLocaleLowerCase();
    if (!query) return this.items;
    const matches = this.items
      .map((item, index) => ({
        item,
        index,
        score: fuzzyChoiceScore(`${item.category ?? ""} ${item.label}`, query),
      }))
      .filter(({ score }) => score >= 0);
    if (matches.some(({ item }) => item.category)) return matches.map(({ item }) => item);
    return matches
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
  private readonly query = new SingleLineField();
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
    this.selected = Math.max(0, Math.min(this.selected, matches.length - 1));
    const start = Math.max(0, this.selected - 8);
    return [
      this.theme.clipOwnedLabel("Command palette", width),
      ...this.query.render(width),
      ...matches.slice(start, start + 9).map((command, index) => {
        const shortcut = command.shortcuts.join(" / ");
        const suffix = command.disabledReason ? ` - ${command.disabledReason}` : "";
        return this.theme.clipOwnedLabel(
          `${start + index === this.selected ? "> " : "  "}${command.label}  ${shortcut}${suffix}`,
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
    const direction = choiceNavigation(data);
    if (direction !== undefined)
      this.selected = Math.max(0, Math.min(matches.length - 1, this.selected + direction));
    else if (data !== "\n" && matchesKey(data, "enter")) {
      const command = matches[this.selected];
      if (command && !command.disabledReason) this.choose(command.id);
    } else {
      const before = this.query.getValue();
      this.query.handleInput(data);
      if (before !== this.query.getValue()) this.selected = 0;
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
  private suspendedQuit:
    | {
        key: string;
        app: OverlayHandle | undefined;
        local: OverlayHandle | undefined;
        localKey: string;
        stack: { handle: OverlayHandle; key: string }[];
        snapshot: DeckTui["localSnapshot"];
      }
    | undefined;

  private localOverlay: OverlayHandle | undefined;
  private localOverlayKey = "";
  private readonly localOverlayStack: { handle: OverlayHandle; key: string }[] = [];
  private searchMatches = findTimelineMatches([], "");
  private searchIndex = 0;
  private searchQuery = "";
  private searchDirection: -1 | 1 = 1;
  private searchFeedback = "Type to search source text.";
  private localSnapshot:
    | {
        restoreInput: () => void;
        agentId: string | undefined;
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
    this.onPreferencesChanged = options.onPreferencesChanged;
    this.theme = new DeckTheme(this.effectiveAppearance());
    this.reconnectClock = options.renderClock ?? systemRenderClock;
    this.tui = new TuiAltScreen(
      ownedInputTerminal(
        terminal,
        () =>
          Boolean(this.state.activeTerminalId) &&
          this.state.focus === "timeline" &&
          this.state.modal.type === "none" &&
          !this.localOverlayKey,
      ),
      undefined,
      undefined,
      {
        scrollToEndIndicator: () => this.scrollToEndIndicator(),
      },
    );
    this.lifecycle = new TerminalLifecycle(this.tui, terminal);
    this.renderScheduler = new RenderScheduler(
      () => this.tui.requestRender(),
      this.reconnectClock,
      options.frameMilliseconds,
    );
    this.clipboard = new SharedClipboard(
      options.clipboard ?? {
        read: options.readText ?? systemClipboard.read,
        write: options.copyText ?? systemClipboard.write,
      },
    );
    this.openLink = options.openLink ?? openWebLink;
    this.controller = new DeckController(
      () => this.state,
      (intent) => this.handleControllerIntent(intent),
    );
    this.tree = new TreeView(initialState, this.theme, options.paseoHost);
    this.tabs = new SessionTabsView(initialState, this.theme);
    this.timeline = new TimelineView(this.theme, () => this.transcript?.scrollTop ?? 0);
    this.timeline.update(initialState.timeline.items);
    this.timeline.updateSelection(initialState);
    this.contentPane = new ContentPane(this.timeline, this.theme, initialState);
    this.composer = new ComposerView(
      this.tui,
      initialState,
      (intent) => this.handleControllerIntent(intent),
      this.theme,
      this.clipboard,
    );
    this.status = new StatusView(initialState, this.theme, () => this.reconnectClock.now());
    this.minimumSize = new MinimumSizeView(this.theme);
    this.treeTranscript = new SidebarScrollView(this.tree, { follow: "none", scrollbar: "auto" });
    this.transcript = new TimelineScrollView(
      this.contentPane,
      (following) => {
        if (following) this.setTimelineFollowing(true);
        else this.pauseTimeline();
      },
      () => this.timeline.takeRemappedViewport(),
    );
    this.setShellLayout();
    this.tui.addInputListener((data) => {
      const terminalOwns =
        Boolean(this.state.activeTerminalId) &&
        this.state.focus === "timeline" &&
        this.state.modal.type === "none" &&
        !this.localOverlayKey;
      if (!terminalOwns) {
        if (data === "\u0013" || data === "\u000b") {
          const picker =
            this.localOverlayKey === "__command-palette" ||
            [
              "new-tab",
              "draft-setting",
              "launch-profile",
              "new-workspace-project",
              "new-workspace-placement",
              "new-workspace-base",
              "mode",
              "thinking",
            ].includes(this.state.modal.type);
          const creationPicker =
            this.state.modal.type === "create-agent" &&
            !["prompt", "confirm"].includes(this.state.modal.step);
          if (data === "\u000b" && (picker || creationPicker)) return undefined;
          const destination = data === "\u0013" ? "tree" : "timeline";
          const available =
            destination === "tree" ||
            Boolean(
              this.state.selectedAgentId &&
                !activeSessionDraftWorkspaceId(this.state) &&
                !activeLaunchWorkspaceId(this.state),
            );
          if (
            available &&
            (this.state.focus !== destination ||
              this.localOverlayKey ||
              this.state.modal.type !== "none")
          ) {
            this.prepareInputTransition();
            this.emit({ type: "set-focus", focus: destination });
          }
          return { consume: true };
        }
        if (data === "\u0010") {
          if (this.localOverlayKey !== "__command-palette") {
            this.prepareInputTransition();
            this.openCommandPalette();
          }
          return { consume: true };
        }
        if (data === "\u0015" || data === "\u0004") {
          if (
            this.state.focus === "timeline" &&
            !this.localOverlayKey &&
            this.state.modal.type === "none"
          ) {
            this.controller.handleKey(data);
            return { consume: true };
          }
          this.handleControllerIntent({
            type: "scroll-timeline",
            direction: data === "\u0015" ? -1 : 1,
          });
          if (this.localSnapshot)
            this.localSnapshot = {
              ...this.localSnapshot,
              scrollTop: this.transcript.scrollTop,
              following: this.transcript.isFollowingEnd,
            };
          return { consume: true };
        }
      }
      if (
        !this.localOverlayKey &&
        this.state.modal.type === "none" &&
        !this.state.activeTerminalId
      ) {
        if (data.startsWith("\u001b[200~")) {
          if (this.state.focus === "composer") this.composer.handleInput(data);
          return { consume: true };
        }
        if (
          this.state.focus === "composer" &&
          ((data === "\u001b" && this.state.composerMode !== undefined) ||
            !commandForKey(this.state, data))
        ) {
          if (
            !(data === "\u001b" && this.state.composerMode !== undefined) &&
            !this.composer.hasPendingCommand &&
            this.controller.handleKey(data)
          )
            return { consume: true };
          this.composer.handleInput(data);
          return { consume: true };
        }
      }
      // Local overlays have no AppState modal, so keep global bindings from
      // interpreting their editor/list input.
      // Help and palette are intentionally global nested overlays. They are
      // available above an editor/dialog without handing ordinary keys through.
      if (data === "\u0003") return this.controller.handleKey(data) ? { consume: true } : undefined;

      const global = commandForKey(this.state, data);
      if (
        global?.id === "command-palette" ||
        (global?.id === "help" &&
          !(this.state.focus === "composer" && this.state.composerMode === "insert") &&
          !(this.state.focus === "timeline" && this.state.terminalMode === "insert"))
      )
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
          this.moveTimelineSearch(this.searchDirection);
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

  private readonly clipboard: SharedClipboard;
  private readonly openLink: (url: string) => Promise<void> | void;

  private setShellLayout(): void {
    const supported = (viewport: { width: number; height: number }): boolean =>
      shellLayout(viewport.width, viewport.height, this.treeWidth).supported;
    const centeredTabs = new HStack(
      [
        { component: new Spacer(1), basis: 4, grow: 1, shrink: 1, minSize: 1 },
        { component: this.tabs, basis: 100, shrink: 1, minSize: 1 },
        { component: new Spacer(1), basis: 4, grow: 1, shrink: 1, minSize: 1 },
      ],
      { align: "stretch" },
    );
    const mainPane = new HStack(
      [
        {
          component: new VStack([
            {
              component: centeredTabs,
              basis: 1,
              minSize: 1,
              visible: () =>
                !activeLaunchWorkspaceId(this.state) && workspaceTabs(this.state).length > 0,
            },
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
                          viewport.height >= 20 &&
                          (!this.state.activeTerminalId || Boolean(this.state.newWorkspace)),
                      },
                      { component: this.transcript, basis: 0, grow: 1, minSize: 3 },
                      {
                        component: new Spacer(2),
                        basis: 2,
                        minSize: 0,
                        visible: (viewport) =>
                          viewport.height >= 24 &&
                          (!this.state.activeTerminalId || Boolean(this.state.newWorkspace)),
                      },
                      {
                        component: new Spacer(1),
                        basis: 1,
                        minSize: 0,
                        visible: (viewport) =>
                          viewport.height >= 18 &&
                          viewport.height < 24 &&
                          (!this.state.activeTerminalId || Boolean(this.state.newWorkspace)),
                      },
                      {
                        component: new SessionActivityView(() => this.state, this.theme),
                        basis: 1,
                        minSize: 1,
                        visible: (viewport) =>
                          viewport.height >= 24 &&
                          (!this.state.activeTerminalId || Boolean(this.state.newWorkspace)),
                      },
                      {
                        component: this.composer,
                        basis: "auto",
                        minSize: 4,
                        visible: () =>
                          !this.state.activeTerminalId || Boolean(this.state.newWorkspace),
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
          ]),
          basis: 0,
          grow: 1,
          minSize: 8,
        },
        { component: new Spacer(1), basis: 1, minSize: 1 },
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
    this.syncTimelineCursor();
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
    this.terminal.write("\u001b[0 q");
  }
  private syncTimelineCursor(): void {
    const visible =
      this.state.focus === "timeline" &&
      this.state.timeline.items.length > 0 &&
      !this.state.activeTerminalId &&
      !this.state.newWorkspace &&
      this.state.modal.type === "none" &&
      !this.localOverlay;
    if (this.tui.getShowHardwareCursor() === visible) return;
    this.tui.setShowHardwareCursor(visible);
    this.terminal.write(visible ? "\u001b[2 q" : "\u001b[0 q");
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
    if (focusChanged || state.selectedAgentId !== previousAgentId) {
      this.controller.cancelPendingInput();
      this.composer.cancelPendingInput();
    }
    this.state = state;
    this.tabs.update(state);
    this.contentPane.update(state);
    this.syncReconnectTicker();
    this.tree.update(state);
    this.timeline.update(state.timeline.items);
    this.timeline.updateSelection(state);
    this.syncTimelineCursor();
    this.composer.update(state);
    this.status.update(state);
    this.tui.setFocus(
      state.focus === "composer" && (!state.activeTerminalId || Boolean(state.newWorkspace))
        ? this.composer
        : null,
    );
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
      if (
        state.focus === "timeline" &&
        !restoredPaused &&
        (previousAgentId !== state.selectedAgentId ||
          recoveryChanged ||
          state.timelineNavigation[state.selectedAgentId ?? ""]?.following !== false)
      )
        this.revealTimelineCursor();
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
    if (intent.type === "timeline-word-search") {
      this.timeline.searchWord(intent.key, intent.count);
      this.revealTimelineCursor();
      this.pauseTimeline();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "move-timeline-text") {
      this.timeline.moveText(intent.key, intent.count);
      this.revealTimelineCursor();
      if (
        intent.key === "G" &&
        intent.count === undefined &&
        this.state.timelineMode !== "visual"
      ) {
        this.transcript.scrollToEnd();
        this.setTimelineFollowing(true);
      } else {
        this.transcript.scrollTo(this.transcript.scrollTop, { disableFollow: true });
        this.pauseTimeline();
      }
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "timeline-find-character" || intent.type === "timeline-repeat-find") {
      if (intent.type === "timeline-find-character")
        this.timeline.findCharacter(intent.key, intent.character, intent.count);
      else this.timeline.repeatFind(intent.reverse);
      this.revealTimelineCursor();
      this.pauseTimeline();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "timeline-viewport-motion") {
      const top = Math.max(0, this.transcript.scrollTop - 1);
      const height = Math.max(1, this.transcript.viewportHeight);
      this.timeline.moveViewport(intent.key, top, height, intent.count);
      this.revealTimelineCursor();
      this.pauseTimeline();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "timeline-page") {
      const amount = Math.max(1, this.transcript.viewportHeight - 2);
      this.timeline.pageText(intent.direction, amount + 1);
      this.transcript.scrollBy(intent.direction * amount);
      this.revealTimelineCursor();
      this.pauseTimeline();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "timeline-swap-endpoints") {
      this.timeline.swapEndpoints();
      this.revealTimelineCursor();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "timeline-reselect") {
      if (this.timeline.reselect()) {
        this.emit({ type: "set-timeline-mode", mode: "visual" });
        this.revealTimelineCursor();
        this.pauseTimeline();
        this.renderScheduler.requestImmediate();
      }
      return;
    }
    if (intent.type === "timeline-visual") {
      const visual = this.timeline.startVisual(intent.selection);
      this.emit({ type: "set-timeline-mode", mode: visual ? "visual" : "normal" });
      this.pauseTimeline();
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
    if (intent.type === "timeline-yank-motion") {
      const copy = this.timeline.yankMotion(intent.key, intent.count, intent.character);
      if (copy?.text) void this.copyTimelineTarget(copy.text, copy.kind);
      return;
    }
    if (intent.type === "timeline-yank") {
      const kind = intent.rows ? "line" : this.timeline.clipboardKind();
      const value = this.timeline.yankText(intent.rows);
      if (value) void this.copyTimelineTarget(value, kind);
      this.timeline.clearVisual();
      this.emit({ type: "set-timeline-mode", mode: "normal" });

      return;
    }
    if (intent.type === "timeline-yank-object") {
      const value = this.timeline.yankObject(intent.object, intent.count);
      if (value)
        void this.copyTimelineTarget(value, intent.object === "line" ? "line" : "character");
      else this.emit({ type: "notify", message: "No timeline text at cursor." });
      return;
    }
    if (intent.type === "timeline-text-object") {
      const value = this.timeline.textObject(
        intent.object,
        intent.around,
        intent.count,
        intent.action === "select",
      );
      if (intent.action === "yank") {
        if (value === undefined)
          this.emit({ type: "notify", message: "No text object at timeline cursor." });
        else if (value) void this.copyTimelineTarget(value);
      } else this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "timeline-open-link") {
      const url = this.timeline.linkAtCursor();
      if (url)
        void Promise.resolve()
          .then(() => this.openLink(url))
          .catch((error: unknown) =>
            this.emit({
              type: "notify",
              message: `Could not open link: ${String(error)}`,
              kind: "error",
            }),
          );
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
      this.timeline.startVisual("character");
    if (intent.type === "scroll-timeline") {
      const amount = Math.max(1, Math.floor(this.transcript.viewportHeight / 2));
      const before = this.transcript.scrollTop;
      this.transcript.scrollBy(intent.direction * amount);
      if (
        this.state.focus === "timeline" &&
        this.state.timelineMode !== "visual" &&
        !this.localOverlayKey &&
        this.state.modal.type === "none"
      ) {
        const delta = this.transcript.scrollTop - before;
        if (delta) this.timeline.pageText(delta < 0 ? -1 : 1, Math.abs(delta) + 1);
      }
      this.pauseTimeline();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "move-timeline-selection") {
      this.timeline.moveSelection(intent.direction);
      this.revealTimelineSelection();
      this.pauseTimeline();
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
      this.timeline.invalidate();
      this.emitPreferences();
      this.renderScheduler.requestImmediate();
      return;
    }
    if (intent.type === "open-timeline-search") {
      this.openTimelineSearch(intent.direction ?? 1);
      return;
    }
    if (intent.type === "open-command-palette") {
      if (this.localOverlayKey !== "__command-palette") this.prepareInputTransition();
      this.openCommandPalette();
      return;
    }
    if (intent.type === "open-help") {
      this.controller.cancelPendingInput();
      this.composer.cancelPendingInput();
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
      symbols: this.detectedAppearance.symbols,
    };
  }

  private async sampleTerminalBackground(): Promise<void> {
    const background = await this.tui.queryTerminalBackgroundColor({ timeoutMs: 120 });
    if (!background || !this.started) return;
    this.terminalBackground = [background.r, background.g, background.b];
    this.theme.setAppearance(this.effectiveAppearance());
    this.timeline.invalidate();
    this.tui.requestRender();
  }

  private openTimelineSearch(direction: -1 | 1): void {
    this.searchDirection = direction;
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

  private prepareInputTransition(): void {
    while (this.localOverlayKey) this.restoreLocalOverlay();
    this.controller.cancelPendingInput();
    this.composer.cancelPendingInput();
    if (this.state.modal.type !== "none") this.emit({ type: "close-modal" });
    if (this.state.modal.type !== "none") this.emit({ type: "close-modal" });
    this.disposeLocalOverlay();
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
          ...(context === "timeline"
            ? [
                "Read-only: shared motions/counts/finds; yy/Y counted rows; y + motion/object.",
                "v/V character/row selection; o/O swaps; gv restores; y/Y copies then Normal.",
                "Ctrl-U/D: Normal moves cursor with viewport; Visual/background preserves endpoints.",
                "Ctrl-B/F or PageUp/Down pages; H/M/L targets visible rows. Only bare Normal G follows.",
                "Normal gx opens cursor link; za folds; [t/]t turns; [e/]e errors, never retry.",
                "Character copy rejoins wraps; row copy retains displayed rows. Escape cancels pending first.",
              ]
            : []),
          ...(context === "composer"
            ? [
                "Normal Enter sends; Insert Enter/Alt-Enter adds a newline.",
                "Pending-command and Visual Enter never send.",
                "Normal: h/l j/k w/W b/B e/E ge/gE; 0 ^/_ $; g0/g^/g$/gj/gk/g_.",
                "gg/G numbered lines; () sentences; {} paragraphs; [[/]]/[]/][ sections; bare % matches.",
                "f/F/t/T + character; ;/, repeat. Counts multiply with d/c/y motions.",
                "i/a/I/A/o/O Insert; x/X s/S D/C; d/c/y + motion; dd/cc/yy/Y lines.",
                "i/a objects: w/W s/p q nearest quote; b nearest bracket; explicit delimiters.",
                "r replaces; J joins; ~ toggles case; u/Ctrl-R undo/redo. No counted objects.",
                "Uncounted j/k recalls at logical boundaries; counted/operator/Visual stays in draft.",
                "Insert: arrows move wrapped rows, reach outer start/end, then recall history.",
                "Insert: Enter/Alt-Enter newline; Ctrl-Z/Ctrl-Shift-Z shares draft undo; Esc finishes group.",
                "Insert: Ctrl-B/F character, Alt-B/F word, Home/End line; Ctrl-W/Alt-D delete word.",
                "p/P reads system clipboard; Deck-owned line copies paste below/above.",
                "Visual: v/V character/line; o/O swaps endpoints; gv restores/exchanges selection.",
                "Visual d/x c/s; D/X C/S/R whole lines; y/Y copies; u/U/~ case; r replaces.",
                "Visual J/gJ joins; counted >/< shifts by two spaces; p replaces and copies removed text; P preserves clipboard.",
                "Native Visual paste replaces once and enters Insert; Escape cancels pending input before exiting.",
              ]
            : []),
          ...contextualHelp(this.state, context).map((command) => commandHelpLine(command)),
        ],
        (data) => {
          if (matchesKey(data, "escape")) this.restoreLocalOverlay();
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
    this.searchIndex = this.searchDirection === 1 ? 0 : this.searchMatches.length - 1;
    const match = this.searchMatches[this.searchIndex];
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

  private async copyTimelineTarget(
    value: string | undefined,
    kind: "character" | "line" = "character",
  ): Promise<void> {
    if (value === undefined) return;
    try {
      await this.clipboard.write(clipboardPlainText(value), kind);
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
      this.syncTimelineCursor();
      this.renderScheduler.requestImmediate();
      return;
    }
    const snapshot = this.localSnapshot;
    this.disposeLocalOverlay();
    this.appOverlay?.setHidden(false);
    this.appOverlay?.focus();
    if (snapshot && snapshot.agentId === this.state.selectedAgentId) {
      if (snapshot.itemId) this.timeline.selectEvent(snapshot.itemId);
      snapshot.restoreInput();
      if (snapshot.following) this.transcript.scrollToEnd();
      else this.transcript.scrollTo(snapshot.scrollTop, { disableFollow: true });
      this.setTimelineFollowing(snapshot.following, snapshot.anchor);
    }
    if (!this.appOverlay)
      this.tui.setFocus(
        this.state.focus === "composer" &&
          (!this.state.activeTerminalId || Boolean(this.state.newWorkspace))
          ? this.composer
          : null,
      );
    this.syncTimelineCursor();
    this.renderScheduler.requestImmediate();
  }

  private disposeLocalOverlay(): void {
    this.localOverlay?.hide();
    for (const overlay of this.localOverlayStack) overlay.handle.hide();
    this.localOverlayStack.length = 0;
    this.localOverlay = undefined;
    this.localOverlayKey = "";
    this.localSnapshot = undefined;
    this.syncTimelineCursor();
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
    this.syncTimelineCursor();
  }

  private captureLocalSnapshot(): void {
    if (this.localSnapshot) return;
    const itemId = this.timeline.selectedItem()?.id;
    const anchor = this.timeline.cursorAtLine(this.transcript.scrollTop);
    this.localSnapshot = {
      restoreInput: this.timeline.captureInputState(),
      agentId: this.state.selectedAgentId,
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
    if (navigation.anchor) {
      this.timeline.setCursorAtAnchor(navigation.anchor);
      this.revealRange(this.transcript, this.timeline.lineRangeForCursor(navigation.anchor));
    }
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

  private revealTimelineCursor(): void {
    this.revealRange(this.transcript, this.timeline.cursorLineRange());
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
    this.controller.cancelPendingInput();
    this.composer.cancelPendingInput();
    if (
      this.state.modal.type === "confirm" &&
      this.state.modal.action === "quit" &&
      !this.suspendedQuit
    ) {
      this.suspendedQuit = {
        key: this.appModalKey,
        app: this.appOverlay,
        local: this.localOverlay,
        localKey: this.localOverlayKey,
        stack: [...this.localOverlayStack],
        snapshot: this.localSnapshot,
      };
      this.appOverlay?.setHidden(true);
      this.localOverlay?.setHidden(true);
      this.appOverlay = undefined;
      this.localOverlay = undefined;
      this.localOverlayKey = "";
      this.localOverlayStack.length = 0;
      this.localSnapshot = undefined;
    } else if (this.suspendedQuit) {
      const saved = this.suspendedQuit;
      this.suspendedQuit = undefined;
      this.appOverlay?.hide();
      if (key === saved.key) {
        this.appOverlay = saved.app;
        this.localOverlay = saved.local;
        this.localOverlayKey = saved.localKey;
        this.localOverlayStack.push(...saved.stack);
        this.localSnapshot = saved.snapshot;
        this.appModalKey = key;
        (this.localOverlay ?? this.appOverlay)?.setHidden(false);
        (this.localOverlay ?? this.appOverlay)?.focus();
        return;
      }
      saved.app?.hide();
      saved.local?.hide();
      for (const overlay of saved.stack) overlay.handle.hide();
    }
    this.disposeLocalOverlay();
    this.appOverlay?.unfocus({
      target:
        this.state.focus === "composer" &&
        (!this.state.activeTerminalId || Boolean(this.state.newWorkspace))
          ? this.composer
          : null,
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
          ...(this.state.focus === "composer"
            ? [
                "Normal Enter sends; Insert Enter/Alt-Enter adds a newline.",
                "Pending-command and Visual Enter never send.",
                "Normal: h/l j/k w/W b/B e/E ge/gE; 0 ^/_ $; g0/g^/g$/gj/gk/g_.",
                "gg/G numbered lines; () sentences; {} paragraphs; [[/]]/[]/][ sections; bare % matches.",
                "f/F/t/T + character; ;/, repeat. Counts multiply with d/c/y motions.",
                "i/a/I/A/o/O Insert; x/X s/S D/C; d/c/y + motion; dd/cc/yy/Y lines.",
                "i/a objects: w/W s/p q nearest quote; b nearest bracket; explicit delimiters.",
                "r replaces; J joins; ~ toggles case; u/Ctrl-R undo/redo. No counted objects.",
                "Uncounted j/k recalls at logical boundaries; counted/operator/Visual stays in draft.",
                "Insert: arrows move wrapped rows, reach outer start/end, then recall history.",
                "Insert: Enter/Alt-Enter newline; Ctrl-Z/Ctrl-Shift-Z shares draft undo; Esc finishes group.",
                "Insert: Ctrl-B/F character, Alt-B/F word, Home/End line; Ctrl-W/Alt-D delete word.",
                "p/P reads system clipboard; Deck-owned line copies paste below/above.",
                "Visual: v/V character/line; o/O swaps endpoints; gv restores/exchanges selection.",
                "Visual d/x c/s; D/X C/S/R whole lines; y/Y copies; u/U/~ case; r replaces.",
                "Visual J/gJ joins; counted >/< shifts by two spaces; p replaces and copies removed text; P preserves clipboard.",
                "Native Visual paste replaces once and enters Insert; Escape cancels pending input before exiting.",
              ]
            : []),
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
    else if (modal.type === "new-tab") {
      const choices = [
        {
          value: "session",
          choice: { kind: "session" as const },
          label: "Agent",
          disabled: false,
        },
        {
          value: "terminal",
          choice: { kind: "terminal" as const },
          label: "Terminal",
          disabled: false,
        },
        ...(modal.profiles ?? []).map((profile) => ({
          value: `profile:${profile.id}`,
          choice: { kind: "profile" as const, profileId: profile.id },
          label: profile.name,
          disabled: false,
          category: "Terminal profiles",
        })),
      ];
      component = new SearchableChoiceDialog(
        "New Tab",
        choices,
        (value) => {
          const selected = choices.find((item) => item.value === value);
          if (selected) this.emit({ type: "new-tab-choice", choice: selected.choice });
        },
        close,
        "session",
        Math.max(1, this.choicePickerMaxVisible(true) - 2),
        this.theme,
        true,
      );
      overlayOptions = {
        width: centeredChoicePickerWidth(this.terminal.columns, "New Tab", choices),
        maxHeight: Math.max(1, this.terminal.rows - 2),
        margin: 1,
        visible: (columns, rows) => shellLayout(columns, rows, this.treeWidth).supported,
      };
    } else if (modal.type === "new-workspace-placement" || modal.type === "new-workspace-base") {
      const placement = modal.type === "new-workspace-placement";
      const choices = placement
        ? [
            {
              value: "local",
              label: "Local",
              description: "Use the original checkout",
              disabled: false,
            },
            {
              value: "worktree",
              label: "Worktree",
              description: "Create a Paseo-managed worktree",
              disabled: false,
            },
          ]
        : (this.state.newWorkspace?.placementOptions?.refs ?? []).map((ref) => ({
            value: ref.ref,
            label: ref.label,
            disabled: false,
            description: ref.remote
              ? `Refresh origin/${ref.label} before creating`
              : "Use on-disk branch without fetching",
          }));
      const title = placement ? "Workspace placement" : "Base ref";
      component = new SearchableChoiceDialog(
        title,
        choices,
        (value) => {
          if (placement && (value === "local" || value === "worktree"))
            this.emit({ type: "new-workspace-placement-choice", placement: value });
          else this.emit({ type: "new-workspace-base-choice", ref: value });
        },
        close,
        placement ? this.state.newWorkspace?.placement : this.state.newWorkspace?.baseRef,
        this.choicePickerMaxVisible(true),
        this.theme,
      );
      overlayOptions = {
        width: centeredChoicePickerWidth(this.terminal.columns, title, choices),
        maxHeight: Math.max(1, this.terminal.rows - 2),
        margin: 1,
      };
    } else if (modal.type === "new-workspace-title") {
      component = new InputDialog(
        "Workspace title (optional)",
        this.state.newWorkspace?.title ?? "",
        (title) => this.emit({ type: "set-new-workspace-title", title }),
        close,
        this.theme,
      );
    } else if (modal.type === "new-workspace-project") {
      const choices = this.state.directory.projects.map((project) => ({
        value: project.id,
        label: project.name,
        description: project.path ?? "Original checkout unavailable",
        disabled: !project.path,
      }));
      component = new SearchableChoiceDialog(
        "Choose project",
        choices,
        (projectId) => this.emit({ type: "new-workspace-project-choice", projectId }),
        close,
        this.state.newWorkspace?.projectId,
        this.choicePickerMaxVisible(true),
        this.theme,
      );
      overlayOptions = {
        width: centeredChoicePickerWidth(this.terminal.columns, "Choose project", choices),
        maxHeight: Math.max(1, this.terminal.rows - 2),
        margin: 1,
      };
    } else if (modal.type === "launch-profile") {
      const draft = launchDraft(this.state, modal.workspaceId);
      const choices = [
        {
          value: "",
          label: "Default shell",
          disabled: false,
          description: "Use the daemon default terminal",
        },
        ...(draft.profiles ?? []).map((profile) => ({
          value: profile.id,
          label: profile.name,
          disabled: false,
          description: profile.command,
        })),
      ];
      const title = "Choose terminal profile";
      component = new SearchableChoiceDialog(
        title,
        choices,
        (profileId) => this.emit({ type: "launch-profile-choice", profileId }),
        close,
        draft.profileId ?? "",
        this.choicePickerMaxVisible(true),
        this.theme,
      );
      overlayOptions = {
        width: centeredChoicePickerWidth(this.terminal.columns, title, choices),
        maxHeight: Math.max(1, this.terminal.rows - 2),
        margin: 1,
        visible: (columns, rows) => shellLayout(columns, rows, this.treeWidth).supported,
      };
    } else if (modal.type === "draft-setting") {
      const draft =
        activeLaunchWorkspaceId(this.state) === modal.workspaceId
          ? launchDraft(this.state, modal.workspaceId)
          : this.state.sessionDrafts[modal.workspaceId];
      const choices = creationChoices(this.state, {
        type: "create-agent",
        workspaceId: modal.workspaceId,
        step: modal.setting,
        ...(draft?.providerId ? { providerId: draft.providerId } : {}),
        ...(draft?.modelId ? { modelId: draft.modelId } : {}),
      });
      const title = titleForModal(modal.setting);
      component = new SearchableChoiceDialog(
        title,
        choices,
        (choice) => this.emit({ type: "draft-setting-choice", choice }),
        close,
        modal.setting === "provider"
          ? draft?.providerId
          : modal.setting === "model"
            ? draft?.modelId
            : modal.setting === "mode"
              ? draft?.modeId
              : draft?.thinkingLevel,
        this.choicePickerMaxVisible(true),
        this.theme,
      );
      overlayOptions = {
        width: centeredChoicePickerWidth(this.terminal.columns, title, choices),
        maxHeight: Math.max(1, this.terminal.rows - 2),
        margin: 1,
        visible: (columns, rows) => shellLayout(columns, rows, this.treeWidth).supported,
      };
    } else if (modal.type === "create-terminal")
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
    else if (modal.type === "confirm")
      component = new Dialog(
        [
          modal.action === "quit"
            ? "Quit and discard unsent work?"
            : `${modal.action} ${modal.label ?? modal.agentId ?? modal.terminalId ?? modal.workspaceId ?? "draft"}?`,
          modal.unavailableReason ??
            (modal.busy
              ? "Working… Escape dismisses; request continues."
              : "Enter confirms · Escape cancels"),
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
        component = new SearchableChoiceDialog(
          titleForModal(modal.type),
          agentChoices(
            this.state,
            modal.type === "mode" || modal.type === "thinking" ? modal.type : "mode",
          ).map((item) => ({ ...item, disabled: false })),
          (choice) => this.emit({ type: "create-choice", choice }),
          close,
          this.state.directory.agents.find((agent) => agent.id === modal.agentId)?.[
            modal.type === "mode" ? "modeId" : "thinkingLevel"
          ],
          this.choicePickerMaxVisible(true),
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

export type CreationChoice = SelectItem & { disabled: boolean; category?: string };

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
