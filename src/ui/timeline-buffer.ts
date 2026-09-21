/** Read-only, Vim-like state for the rendered timeline text.
 *
 * This deliberately operates on rendered plain lines rather than TimelineEvent
 * objects.  Source events remain immutable and ANSI styling never participates
 * in cursor, search, or yank calculations.
 */
export type TimelineBufferMode = "normal" | "visual";
export type TimelineSelectionMode = "character" | "line";

export interface TimelineBufferState {
  readonly lines: readonly string[];
  readonly line: number;
  readonly column: number;
  readonly anchor?: { line: number; column: number };
  readonly selectionMode?: TimelineSelectionMode;
  readonly mode: TimelineBufferMode;
  readonly folded: ReadonlySet<number>;
  readonly search?: { query: string; match: { line: number; start: number; end: number } };
}

export interface TimelineBufferOptions {
  readonly lines?: readonly string[];
  readonly line?: number;
  readonly column?: number;
}

export function createTimelineBuffer(options: TimelineBufferOptions = {}): TimelineBufferState {
  const lines = options.lines?.length ? [...options.lines] : [""];
  const line = clamp(options.line ?? 0, 0, lines.length - 1);
  return {
    lines,
    line,
    column: clamp(options.column ?? 0, 0, cursorLimit(lines[line] ?? "")),
    mode: "normal",
    folded: new Set(),
  };
}

export function moveTimelineBuffer(
  state: TimelineBufferState,
  key: string,
  count = 1,
): TimelineBufferState {
  const amount = Math.max(1, count);
  let line = state.line;
  let column = state.column;
  if (key === "h") column -= amount;
  else if (key === "l") column += amount;
  else if (key === "j") line += amount;
  else if (key === "k") line -= amount;
  else if (key === "0" || key === "^") column = 0;
  else if (key === "$") column = cursorLimit(state.lines[line] ?? "");
  else if (key === "gg") {
    line = 0;
    column = 0;
  } else if (key === "G") {
    line = state.lines.length - 1;
    column = cursorLimit(state.lines[line] ?? "");
  } else if (key === "w" || key === "e" || key === "b") {
    column = wordMotion(state.lines[line] ?? "", column, key, amount);
  }
  line = clamp(line, 0, state.lines.length - 1);
  column = clamp(column, 0, cursorLimit(state.lines[line] ?? ""));
  return { ...state, line, column };
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
  return {
    ...state,
    mode: "visual",
    anchor: { line: state.line, column: state.column },
    selectionMode: mode,
  };
}

export function leaveTimelineVisual(state: TimelineBufferState): TimelineBufferState {
  const next = { ...state, mode: "normal" as const };
  delete (next as { anchor?: unknown }).anchor;
  delete (next as { selectionMode?: unknown }).selectionMode;
  return next;
}

export function timelineSelection(
  state: TimelineBufferState,
): { start: number; end: number } | undefined {
  if (!state.anchor) return undefined;
  const a = offsetAt(state.lines, state.anchor);
  const b = offsetAt(state.lines, { line: state.line, column: state.column });
  const start = Math.min(a, b);
  const end = Math.max(a, b) + 1;
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
  const selection = timelineSelection(state);
  if (!selection) return "";
  return printableTimelineText(flattenLines(state.lines).slice(selection.start, selection.end));
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
): TimelineBufferState {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    const next = { ...state };
    delete (next as { search?: unknown }).search;
    return next;
  }
  const start = state.search?.match.line ?? state.line;
  for (let step = 1; step <= state.lines.length; step += 1) {
    const index = (start + direction * step + state.lines.length * 2) % state.lines.length;
    const haystack = state.lines[index]?.toLocaleLowerCase() ?? "";
    const match = haystack.indexOf(needle);
    if (match >= 0)
      return {
        ...state,
        line: index,
        column: match,
        search: { query, match: { line: index, start: match, end: match + needle.length } },
      };
  }
  return {
    ...state,
    search: { query, match: { line: state.line, start: state.column, end: state.column } },
  };
}

/** Preserve a cursor across streaming/recovery replacement by line identity. */
export function replaceTimelineBuffer(
  state: TimelineBufferState,
  lines: readonly string[],
): TimelineBufferState {
  const nextLines = lines.length ? [...lines] : [""];
  const old = state.lines[state.line] ?? "";
  const matching = nextLines.indexOf(old);
  const line = matching >= 0 ? matching : clamp(state.line, 0, nextLines.length - 1);
  const next = {
    ...state,
    lines: nextLines,
    line,
    column: clamp(state.column, 0, cursorLimit(nextLines[line] ?? "")),
  };
  if (state.mode === "visual" && matching < 0) return leaveTimelineVisual(next);
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

function flattenLines(lines: readonly string[]): string {
  return lines.join("\n");
}
function offsetAt(lines: readonly string[], position: { line: number; column: number }): number {
  return (
    lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) +
    position.column
  );
}
function cursorLimit(line: string): number {
  return Math.max(0, line.length - 1);
}
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
function wordMotion(line: string, column: number, key: string, count: number): number {
  let result = column;
  for (let i = 0; i < count; i += 1) {
    if (key === "b") {
      while (result > 0 && /\s/.test(line[result - 1] ?? "")) result -= 1;
      while (result > 0 && !/\s/.test(line[result - 1] ?? "")) result -= 1;
    } else {
      while (result < line.length && !/\s/.test(line[result] ?? "")) result += 1;
      while (result < line.length && /\s/.test(line[result] ?? "")) result += 1;
      if (key === "e") result = Math.max(0, result - 1);
    }
  }
  return result;
}
