import {
  clamp,
  cursorLimit,
  firstNonblank,
  flattenLines,
  logicalTextObjectRange,
  moveLogicalText,
  offsetAt,
  positionAt,
  wordClass,
} from "./logical-text.js";
import { characterStep, findTextCharacter } from "./text-buffer.js";
/** Read-only, Vim-like state for the rendered timeline text.
 *
 * This deliberately operates on rendered plain lines rather than TimelineEvent
 * objects.  Source events remain immutable and ANSI styling never participates
 * in cursor, search, or yank calculations.
 */
export type TimelineBufferMode = "normal" | "visual";
export type TimelineSelectionMode = "character" | "line" | "block";
export interface TimelinePosition {
  readonly line: number;
  readonly column: number;
}

export interface TimelineBufferState {
  readonly lines: readonly string[];
  readonly line: number;
  readonly column: number;
  readonly goalColumn?: number;
  readonly anchor?: { line: number; column: number };
  readonly selectionMode?: TimelineSelectionMode;
  readonly selectionRange?: TimelineTextRange;
  readonly mode: TimelineBufferMode;
  readonly folded: ReadonlySet<number>;
  readonly search?: {
    query: string;
    match: { line: number; start: number; end: number };
    wholeWord?: boolean;
  };
  readonly lastFind?: { key: "f" | "F" | "t" | "T"; character: string };
  readonly marks?: Readonly<Record<string, TimelinePosition>>;
  readonly jumps?: readonly TimelinePosition[];
  readonly jumpIndex?: number;
}

export interface TimelineTextRange {
  /** Offsets in the rendered lines joined with newline characters. End is exclusive. */
  readonly start: number;
  readonly end: number;
}

export interface TimelineBufferOptions {
  readonly lines?: readonly string[];
  readonly line?: number;
  readonly column?: number;
}

export function createTimelineBuffer(options: TimelineBufferOptions = {}): TimelineBufferState {
  const lines = options.lines?.length ? options.lines.map(printableTimelineText) : [""];
  const line = clamp(options.line ?? 0, 0, lines.length - 1);
  return {
    lines,
    line,
    column: clamp(options.column ?? 0, 0, cursorLimit(lines[line] ?? "")),
    mode: "normal",
    folded: new Set(),
  };
}

export function setTimelineMark(
  state: TimelineBufferState,
  character: string,
): TimelineBufferState {
  if (!/^[A-Za-z]$/u.test(character)) return state;
  return {
    ...state,
    marks: { ...state.marks, [character]: { line: state.line, column: state.column } },
  };
}

/** Record a substantial motion so Ctrl-O and Ctrl-I can traverse it. */
export function recordTimelineJump(
  state: TimelineBufferState,
  target: TimelinePosition,
): TimelineBufferState {
  const destination = clampPosition(state.lines, target);
  if (destination.line === state.line && destination.column === state.column) return state;
  const current = { line: state.line, column: state.column };
  const history = state.jumps?.slice(0, (state.jumpIndex ?? state.jumps.length - 1) + 1) ?? [];
  if (!history.length || !samePosition(history[history.length - 1] as TimelinePosition, current))
    history.push(current);
  history.push(destination);
  const next = { ...state, ...destination, jumps: history, jumpIndex: history.length - 1 };
  delete (next as { goalColumn?: number }).goalColumn;
  delete (next as { selectionRange?: TimelineTextRange }).selectionRange;
  return next;
}

export function jumpTimelineMark(
  state: TimelineBufferState,
  character: string,
  linewise = false,
): TimelineBufferState {
  if (character === "'" || character === "`") {
    const previous = moveTimelineJump(state, -1);
    return character === "'"
      ? { ...previous, column: firstNonblank(previous.lines[previous.line] ?? "") }
      : previous;
  }
  const mark = state.marks?.[character];
  if (!mark) return state;
  const line = clamp(mark.line, 0, state.lines.length - 1);
  return recordTimelineJump(state, {
    line,
    column: linewise ? firstNonblank(state.lines[line] ?? "") : mark.column,
  });
}

export function moveTimelineJump(
  state: TimelineBufferState,
  direction: -1 | 1,
  count = 1,
): TimelineBufferState {
  if (!state.jumps?.length) return state;
  const currentIndex = state.jumpIndex ?? state.jumps.length - 1;
  const index = clamp(currentIndex + direction * Math.max(1, count), 0, state.jumps.length - 1);
  if (index === currentIndex) return state;
  const destination = clampPosition(state.lines, state.jumps[index] as TimelinePosition);
  const next = { ...state, ...destination, jumpIndex: index };
  delete (next as { goalColumn?: number }).goalColumn;
  delete (next as { selectionRange?: TimelineTextRange }).selectionRange;
  return next;
}

function samePosition(a: TimelinePosition, b: TimelinePosition): boolean {
  return a.line === b.line && a.column === b.column;
}

function clampPosition(lines: readonly string[], position: TimelinePosition): TimelinePosition {
  const line = clamp(position.line, 0, lines.length - 1);
  return { line, column: clamp(position.column, 0, cursorLimit(lines[line] ?? "")) };
}

export function moveTimelineBuffer(
  state: TimelineBufferState,
  key: string,
  count = 0,
): TimelineBufferState {
  if (key === ";" || key === ",")
    return repeatTimelineCharacterFind(state, key === ",", Math.max(1, count));
  const moved = moveLogicalText(state, key === "_" ? "^" : key, count);
  const next = { ...state, ...moved };
  if (moved.goalColumn === undefined) delete (next as { goalColumn?: number }).goalColumn;
  delete (next as { selectionRange?: TimelineTextRange }).selectionRange;
  return next;
}

export function pageTimelineBuffer(
  state: TimelineBufferState,
  direction: -1 | 1,
  height: number,
): TimelineBufferState {
  return moveTimelineBuffer(state, direction < 0 ? "k" : "j", Math.max(1, height - 1));
}

export function enterTimelineVisual(
  state: TimelineBufferState,
  mode: TimelineSelectionMode = "character",
): TimelineBufferState {
  const next = {
    ...state,
    mode: "visual" as const,
    anchor: { line: state.line, column: state.column },
    selectionMode: mode,
  };
  delete (next as { selectionRange?: TimelineTextRange }).selectionRange;
  return next;
}

export function leaveTimelineVisual(state: TimelineBufferState): TimelineBufferState {
  const next = { ...state, mode: "normal" as const };
  delete (next as { anchor?: unknown }).anchor;
  delete (next as { selectionMode?: unknown }).selectionMode;
  delete (next as { selectionRange?: TimelineTextRange }).selectionRange;
  return next;
}

export function timelineSelection(
  state: TimelineBufferState,
): { start: number; end: number } | undefined {
  if (!state.anchor) return undefined;
  if (state.selectionRange) return state.selectionRange;
  const a = offsetAt(state.lines, state.anchor);
  const b = offsetAt(state.lines, { line: state.line, column: state.column });
  const start = Math.min(a, b);
  const end = characterStep(flattenLines(state.lines), Math.max(a, b), 1);
  if (state.selectionMode === "line") {
    const startLine = Math.min(state.anchor.line, state.line);
    const endLine = Math.max(state.anchor.line, state.line);
    const lineStart = offsetAt(state.lines, { line: startLine, column: 0 });
    const lineEnd = offsetAt(state.lines, {
      line: endLine,
      column: (state.lines[endLine] ?? "").length,
    });
    return { start: lineStart, end: Math.max(lineStart, lineEnd) };
  }
  return { start, end };
}

export function selectedTimelineText(state: TimelineBufferState): string {
  if (state.anchor && state.selectionMode === "block") {
    const firstLine = Math.min(state.anchor.line, state.line);
    const lastLine = Math.max(state.anchor.line, state.line);
    const firstColumn = Math.min(state.anchor.column, state.column);
    const lastColumn = Math.max(state.anchor.column, state.column) + 1;
    return state.lines
      .slice(firstLine, lastLine + 1)
      .map((line) => printableTimelineText(line.slice(firstColumn, lastColumn)))
      .join("\n");
  }
  const selection = timelineSelection(state);
  if (!selection) return "";
  return printableTimelineText(flattenLines(state.lines).slice(selection.start, selection.end));
}

export function timelineSelectionColumns(
  state: TimelineBufferState,
  line: number,
): { start: number; end: number } | undefined {
  if (state.anchor && state.selectionMode === "block") {
    if (
      line < Math.min(state.anchor.line, state.line) ||
      line > Math.max(state.anchor.line, state.line)
    )
      return undefined;
    const start = Math.min(state.anchor.column, state.column);
    return {
      start,
      end: Math.min(
        (state.lines[line] ?? "").length,
        Math.max(state.anchor.column, state.column) + 1,
      ),
    };
  }
  const selection = timelineSelection(state);
  if (!selection) return undefined;
  const lineStart = offsetAt(state.lines, { line, column: 0 });
  const lineEnd = lineStart + (state.lines[line] ?? "").length;
  if (selection.end <= lineStart || selection.start >= lineEnd) return undefined;
  return {
    start: Math.max(0, selection.start - lineStart),
    end: Math.min(lineEnd - lineStart, selection.end - lineStart),
  };
}

export function toggleTimelineFold(state: TimelineBufferState): TimelineBufferState {
  const folded = new Set(state.folded);
  if (folded.has(state.line)) folded.delete(state.line);
  else folded.add(state.line);
  return { ...state, folded };
}

export function searchTimelineBuffer(
  state: TimelineBufferState,
  query: string,
  direction: -1 | 1 = 1,
  wholeWord = state.search?.query === query && !!state.search.wholeWord,
): TimelineBufferState {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    const next = { ...state };
    delete (next as { search?: unknown }).search;
    return next;
  }
  const haystack = flattenLines(state.lines).toLocaleLowerCase();
  const from = offsetAt(state.lines, { line: state.line, column: state.column });
  const candidate = findSearchMatch(haystack, needle, from + direction, direction, wholeWord);
  const match =
    candidate >= 0
      ? candidate
      : direction > 0
        ? findSearchMatch(haystack, needle, 0, direction, wholeWord)
        : findSearchMatch(haystack, needle, haystack.length, direction, wholeWord);
  if (match >= 0) {
    const position = positionAt(state.lines, match);
    const next = {
      ...state,
      ...position,
      search: {
        query,
        wholeWord,
        match: {
          line: position.line,
          start: position.column,
          end: position.column + needle.length,
        },
      },
    };
    delete (next as { goalColumn?: number }).goalColumn;
    delete (next as { selectionRange?: TimelineTextRange }).selectionRange;
    return next;
  }
  return {
    ...state,
    search: {
      query,
      wholeWord,
      match: { line: state.line, start: state.column, end: state.column },
    },
  };
}

function findSearchMatch(
  text: string,
  needle: string,
  from: number,
  direction: -1 | 1,
  wholeWord: boolean,
): number {
  if (direction < 0 && from < 0) return -1;
  let candidate =
    direction > 0 ? text.indexOf(needle, Math.max(0, from)) : text.lastIndexOf(needle, from);
  while (candidate >= 0) {
    const before = wordClass(text[candidate - 1] ?? "", false);
    const after = wordClass(text[candidate + needle.length] ?? "", false);
    if (!wholeWord || (before !== 1 && after !== 1)) return candidate;
    candidate =
      direction > 0 ? text.indexOf(needle, candidate + 1) : text.lastIndexOf(needle, candidate - 1);
  }
  return -1;
}

export function timelineWordAtCursor(state: TimelineBufferState): string | undefined {
  const line = state.lines[state.line] ?? "";
  let start = state.column;
  while (start < line.length && wordClass(line[start] ?? "", false) !== 1) start += 1;
  if (start >= line.length) return undefined;
  let end = start;
  while (start > 0 && wordClass(line[start - 1] ?? "", false) === 1) start -= 1;
  while (end < line.length && wordClass(line[end] ?? "", false) === 1) end += 1;
  return line.slice(start, end);
}

export function searchTimelineWord(
  state: TimelineBufferState,
  key: "*" | "#" | "g*" | "g#",
  count = 1,
): TimelineBufferState {
  const word = timelineWordAtCursor(state);
  if (!word) return state;
  const direction = key === "#" || key === "g#" ? -1 : 1;
  const wholeWord = key === "*" || key === "#";
  let next = state;
  for (let i = 0; i < Math.max(1, count); i += 1)
    next = searchTimelineBuffer(next, word, direction, wholeWord);
  return next;
}

/** Keep the closest matching rendered line when history changes or reflows. */
export function replaceTimelineBuffer(
  state: TimelineBufferState,
  lines: readonly string[],
  plain = false,
): TimelineBufferState {
  if (lines === state.lines) return state;
  const nextLines = lines.length ? (plain ? lines : lines.map(printableTimelineText)) : [""];
  const old = state.lines[state.line] ?? "";
  const matching = nextLines.reduce<number>(
    (closest, value, index) =>
      value !== old ||
      (closest >= 0 && Math.abs(closest - state.line) <= Math.abs(index - state.line))
        ? closest
        : index,
    -1,
  );
  const line = matching >= 0 ? matching : clamp(state.line, 0, nextLines.length - 1);
  const next = {
    ...state,
    lines: nextLines,
    line,
    column: clamp(state.column, 0, cursorLimit(nextLines[line] ?? "")),
    ...(state.anchor
      ? {
          anchor: {
            line: clamp(state.anchor.line, 0, nextLines.length - 1),
            column: clamp(
              state.anchor.column,
              0,
              cursorLimit(nextLines[clamp(state.anchor.line, 0, nextLines.length - 1)] ?? ""),
            ),
          },
        }
      : {}),
  };
  delete (next as { selectionRange?: TimelineTextRange }).selectionRange;
  return next;
}

export function printableTimelineText(value: string): string {
  const esc = String.fromCharCode(27);
  const osc = new RegExp(
    `${esc}\\][^${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${esc}\\\\)`,
    "g",
  );
  const csi = new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, "g");
  return value
    .replaceAll(osc, "")
    .replaceAll(csi, "")
    .split("")
    .filter(
      (character) => character === "\n" || character === "\t" || character.charCodeAt(0) >= 0x20,
    )
    .join("")
    .replaceAll(esc, "");
}

export function osc52(value: string): string {
  const encoded = Buffer.from(printableTimelineText(value), "utf8").toString("base64");
  return `\u001b]52;c;${encoded}\u0007`;
}

/** H/M/L use the visible viewport rather than the whole history. */
export function moveTimelineViewport(
  state: TimelineBufferState,
  key: "H" | "M" | "L",
  topLine: number,
  height: number,
  count = 0,
): TimelineBufferState {
  const first = clamp(topLine, 0, state.lines.length - 1);
  const last = clamp(first + Math.max(1, height) - 1, first, state.lines.length - 1);
  const line =
    key === "H"
      ? clamp(first + Math.max(1, count) - 1, first, last)
      : key === "L"
        ? clamp(last - Math.max(1, count) + 1, first, last)
        : Math.floor((first + last) / 2);
  const next = { ...state, line, column: firstNonblank(state.lines[line] ?? "") };
  delete (next as { goalColumn?: number }).goalColumn;
  delete (next as { selectionRange?: TimelineTextRange }).selectionRange;
  return next;
}

export function findTimelineCharacter(
  state: TimelineBufferState,
  key: "f" | "F" | "t" | "T",
  character: string,
  count = 1,
): TimelineBufferState {
  const column = findTextCharacter(
    state.lines[state.line] ?? "",
    state.column,
    { key, character },
    count,
  );
  if (column === undefined) return state;
  const next = {
    ...state,
    column: clamp(column, 0, cursorLimit(state.lines[state.line] ?? "")),
    lastFind: { key, character },
  };
  delete (next as { goalColumn?: number }).goalColumn;
  delete (next as { selectionRange?: TimelineTextRange }).selectionRange;
  return next;
}

export function repeatTimelineCharacterFind(
  state: TimelineBufferState,
  reverse = false,
  count = 1,
): TimelineBufferState {
  if (!state.lastFind) return state;
  const key = reverse
    ? ({ f: "F", F: "f", t: "T", T: "t" } as const)[state.lastFind.key]
    : state.lastFind.key;
  // A till motion parks one cell before/after its match. Skip that match when
  // repeating, otherwise `;` would remain on the same character forever.
  const probe =
    key === "t" || key === "T"
      ? { ...state, column: state.column + (key === "t" ? 1 : -1) }
      : state;
  const found = findTimelineCharacter(probe, key, state.lastFind.character, count);
  return found === probe ? state : { ...found, lastFind: state.lastFind };
}

/** Resolve Vim text objects against the same rendered text used for cursor movement. */
export function timelineTextObjectRange(
  state: TimelineBufferState,
  object: string,
  around = false,
  count = 1,
): TimelineTextRange | undefined {
  return logicalTextObjectRange(state, object, around, count);
}

export function timelineTextObjectText(
  state: TimelineBufferState,
  range: TimelineTextRange,
): string {
  return flattenLines(state.lines).slice(range.start, range.end);
}

/** Turn a resolved object into a characterwise Visual selection. */
export function selectTimelineTextRange(
  state: TimelineBufferState,
  range: TimelineTextRange,
): TimelineBufferState {
  if (range.end <= range.start) return state;
  const anchor = positionAt(state.lines, range.start);
  const cursor = positionAt(state.lines, range.end - 1);
  const next = {
    ...state,
    mode: "visual" as const,
    selectionMode: "character" as const,
    selectionRange: range,
    anchor,
    ...cursor,
  };
  delete (next as { goalColumn?: number }).goalColumn;
  return next;
}
