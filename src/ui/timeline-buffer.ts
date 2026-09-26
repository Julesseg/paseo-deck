/** Read-only, Vim-like state for the rendered timeline text.
 *
 * This deliberately operates on rendered plain lines rather than TimelineEvent
 * objects.  Source events remain immutable and ANSI styling never participates
 * in cursor, search, or yank calculations.
 */
export type TimelineBufferMode = "normal" | "visual";
export type TimelineSelectionMode = "character" | "line" | "block";

export interface TimelineBufferState {
  readonly lines: readonly string[];
  readonly line: number;
  readonly column: number;
  readonly goalColumn?: number;
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

export function moveTimelineBuffer(
  state: TimelineBufferState,
  key: string,
  count = 0,
): TimelineBufferState {
  const amount = Math.max(1, count);
  let line = state.line;
  let column = state.column;
  const vertical = key === "j" || key === "k";
  if (key === "h") column -= amount;
  else if (key === "l") column += amount;
  else if (key === "j") line += amount;
  else if (key === "k") line -= amount;
  else if (key === "0") column = 0;
  else if (key === "^") column = firstNonblank(state.lines[line] ?? "");
  else if (key === "$") {
    line += amount - 1;
    column = cursorLimit(state.lines[clamp(line, 0, state.lines.length - 1)] ?? "");
  } else if (key === "gg") {
    line = count > 1 ? count - 1 : 0;
    column = 0;
  } else if (key === "G") {
    line = count > 0 ? count - 1 : state.lines.length - 1;
    column = cursorLimit(state.lines[line] ?? "");
  } else if (key === "+" || key === "-" || key === "_") {
    line += key === "-" ? -amount : key === "+" ? amount : amount - 1;
    column = firstNonblank(state.lines[clamp(line, 0, state.lines.length - 1)] ?? "");
  } else if (key === "|") column = amount - 1;
  else if (["w", "b", "e", "W", "B", "E", "ge", "gE"].includes(key)) {
    const position = wordMotion(state.lines, { line, column }, key, amount);
    line = position.line;
    column = position.column;
  } else if (key === "%") {
    const position = matchingBracket(state.lines, { line, column });
    line = position.line;
    column = position.column;
  }
  line = clamp(line, 0, state.lines.length - 1);
  if (vertical) column = state.goalColumn ?? state.column;
  column = clamp(column, 0, cursorLimit(state.lines[line] ?? ""));
  const next = {
    ...state,
    line,
    column,
    ...(vertical ? { goalColumn: state.goalColumn ?? state.column } : {}),
  };
  if (!vertical) delete (next as { goalColumn?: number }).goalColumn;
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
    const haystack = printableTimelineText(state.lines[index] ?? "").toLocaleLowerCase();
    const match = haystack.indexOf(needle);
    if (match >= 0) {
      const next = {
        ...state,
        line: index,
        column: match,
        search: { query, match: { line: index, start: match, end: match + needle.length } },
      };
      delete (next as { goalColumn?: number }).goalColumn;
      return next;
    }
  }
  return {
    ...state,
    search: { query, match: { line: state.line, start: state.column, end: state.column } },
  };
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
function firstNonblank(line: string): number {
  return clamp(line.search(/\S/u), 0, cursorLimit(line));
}

function positionAt(lines: readonly string[], offset: number): { line: number; column: number } {
  let remaining = Math.max(0, offset);
  for (let line = 0; line < lines.length; line += 1) {
    const length = (lines[line] ?? "").length;
    if (remaining < length || line === lines.length - 1)
      return { line, column: clamp(remaining, 0, cursorLimit(lines[line] ?? "")) };
    remaining -= length + 1;
  }
  return { line: 0, column: 0 };
}

function wordClass(character: string, big: boolean): number {
  if (!character || /\s/u.test(character)) return 0;
  return big || /[\p{L}\p{N}_]/u.test(character) ? 1 : 2;
}

function wordMotion(
  lines: readonly string[],
  from: { line: number; column: number },
  key: string,
  count: number,
): { line: number; column: number } {
  const text = flattenLines(lines);
  const big = key === key.toUpperCase() || key === "gE";
  const motion = key.toLowerCase();
  let offset = offsetAt(lines, from);
  for (let step = 0; step < count; step += 1) {
    if (motion === "w") {
      const kind = wordClass(text[offset] ?? "", big);
      if (kind)
        while (offset < text.length && wordClass(text[offset] ?? "", big) === kind) offset += 1;
      while (offset < text.length && !wordClass(text[offset] ?? "", big)) offset += 1;
    } else if (motion === "b") {
      offset = Math.max(0, offset - 1);
      while (offset > 0 && !wordClass(text[offset] ?? "", big)) offset -= 1;
      const kind = wordClass(text[offset] ?? "", big);
      while (offset > 0 && wordClass(text[offset - 1] ?? "", big) === kind) offset -= 1;
    } else if (motion === "e") {
      if (offset < text.length - 1) offset += 1;
      while (offset < text.length - 1 && !wordClass(text[offset] ?? "", big)) offset += 1;
      const kind = wordClass(text[offset] ?? "", big);
      while (offset < text.length - 1 && wordClass(text[offset + 1] ?? "", big) === kind)
        offset += 1;
    } else if (motion === "ge") {
      offset = Math.max(0, offset - 1);
      const current = wordClass(text[offset] ?? "", big);
      while (offset > 0 && current && wordClass(text[offset - 1] ?? "", big) === current)
        offset -= 1;
      while (offset > 0 && !wordClass(text[offset - 1] ?? "", big)) offset -= 1;
      offset = Math.max(0, offset - 1);
    }
  }
  return positionAt(lines, offset);
}

function matchingBracket(
  lines: readonly string[],
  from: { line: number; column: number },
): { line: number; column: number } {
  const text = flattenLines(lines);
  const pairs: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}",
    ")": "(",
    "]": "[",
    "}": "{",
  };
  const starts = "([{",
    ends = ")]}";
  const line = lines[from.line] ?? "";
  const found = [...line.slice(from.column)].findIndex((character) => character in pairs);
  if (found < 0) return from;
  const at = offsetAt(lines, { line: from.line, column: from.column + found });
  const opening = text[at] ?? "";
  const direction = starts.includes(opening) ? 1 : ends.includes(opening) ? -1 : 0;
  if (!direction) return from;
  let depth = 0;
  for (let index = at; index >= 0 && index < text.length; index += direction) {
    if (text[index] === opening) depth += 1;
    else if (text[index] === pairs[opening]) depth -= 1;
    if (depth === 0) return positionAt(lines, index);
  }
  return from;
}

export function findTimelineCharacter(
  state: TimelineBufferState,
  key: "f" | "F" | "t" | "T",
  character: string,
  count = 1,
): TimelineBufferState {
  const line = state.lines[state.line] ?? "";
  const forward = key === "f" || key === "t";
  let column = state.column;
  for (let index = 0; index < count; index += 1) {
    const found = forward
      ? line.indexOf(character, column + 1)
      : line.lastIndexOf(character, column - 1);
    if (found < 0) return state;
    column = found;
  }
  if (key === "t") column -= 1;
  if (key === "T") column += 1;
  const next = { ...state, column: clamp(column, 0, cursorLimit(line)) };
  delete (next as { goalColumn?: number }).goalColumn;
  return next;
}
