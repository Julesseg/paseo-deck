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
  const amount = Math.max(1, count);
  let line = state.line;
  let column = state.column;
  const vertical = key === "j" || key === "k" || key === "gj" || key === "gk";
  if (key === "h") column -= amount;
  else if (key === "l") column += amount;
  else if (key === "j" || key === "gj") line += amount;
  else if (key === "k" || key === "gk") line -= amount;
  else if (key === "0" || key === "g0") column = 0;
  else if (key === "^" || key === "g^") column = firstNonblank(state.lines[line] ?? "");
  else if (key === "$" || key === "g$") {
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
  else if (key === "gm" || key === "gM")
    column = Math.floor(cursorLimit(state.lines[line] ?? "") / 2);
  else if (["w", "b", "e", "W", "B", "E", "ge", "gE"].includes(key)) {
    const position = wordMotion(state.lines, { line, column }, key, amount);
    line = position.line;
    column = position.column;
  } else if (key === "g_") {
    line += amount - 1;
    column = lastNonblank(state.lines[clamp(line, 0, state.lines.length - 1)] ?? "");
  } else if (key === "(" || key === ")") {
    const position = sentenceMotion(state.lines, { line, column }, key === "(" ? -1 : 1, amount);
    line = position.line;
    column = position.column;
  } else if (key === "{" || key === "}") {
    const position = paragraphMotion(state.lines, { line, column }, key === "{" ? -1 : 1, amount);
    line = position.line;
    column = position.column;
  } else if (["[[", "]]", "[]", "]["].includes(key)) {
    const position = sectionMotion(state.lines, line, key, amount);
    line = position.line;
    column = position.column;
  } else if (key === "%") {
    if (count > 0) {
      line = clamp(Math.ceil((count * state.lines.length) / 100) - 1, 0, state.lines.length - 1);
      column = firstNonblank(state.lines[line] ?? "");
    } else {
      const position = matchingBracket(state.lines, { line, column });
      line = position.line;
      column = position.column;
    }
  } else if (key === ";" || key === ",") {
    return repeatTimelineCharacterFind(state, key === ",", amount);
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
function lastNonblank(line: string): number {
  return clamp(line.search(/\s*$/u) - 1, 0, cursorLimit(line));
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

function sentenceStarts(text: string): number[] {
  const starts = [0];
  // A Vim sentence ends at punctuation followed by whitespace, or at a blank line.
  const boundary = /[.!?]["')\]]*(?:\s+|$)|\n\s*\n/gu;
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].length;
    let start = end;
    while (start < text.length && /\s/u.test(text[start] ?? "")) start += 1;
    if (start < text.length && starts.at(-1) !== start) starts.push(start);
  }
  return starts;
}

function sentenceMotion(
  lines: readonly string[],
  from: { line: number; column: number },
  direction: -1 | 1,
  count: number,
): { line: number; column: number } {
  const starts = sentenceStarts(flattenLines(lines));
  let offset = offsetAt(lines, from);
  for (let step = 0; step < count; step += 1) {
    const next =
      direction > 0
        ? starts.find((start) => start > offset)
        : starts.findLast((start) => start < offset);
    if (next === undefined) break;
    offset = next;
  }
  return positionAt(lines, offset);
}

function paragraphMotion(
  lines: readonly string[],
  from: { line: number; column: number },
  direction: -1 | 1,
  count: number,
): { line: number; column: number } {
  let line = from.line;
  for (let step = 0; step < count; step += 1) {
    let probe = line + direction;
    while (probe >= 0 && probe < lines.length && (lines[probe] ?? "").trim() !== "") {
      probe += direction;
    }
    if (probe < 0 || probe >= lines.length) {
      line = direction > 0 ? lines.length - 1 : 0;
      break;
    }
    line = probe;
    // Adjacent blank lines belong to one paragraph boundary.
    while (
      line + direction >= 0 &&
      line + direction < lines.length &&
      (lines[line + direction] ?? "").trim() === ""
    ) {
      line += direction;
    }
  }
  return { line, column: firstNonblank(lines[line] ?? "") };
}

function sectionMotion(
  lines: readonly string[],
  fromLine: number,
  key: string,
  count: number,
): { line: number; column: number } {
  const direction = key === "[[" || key === "[]" ? -1 : 1;
  const target = key === "[[" || key === "]]" ? "{" : "}";
  let line = fromLine;
  for (let step = 0; step < count; step += 1) {
    let next = line + direction;
    while (next >= 0 && next < lines.length && !(lines[next] ?? "").startsWith(target)) {
      next += direction;
    }
    if (next < 0 || next >= lines.length) break;
    line = next;
  }
  return { line, column: 0 };
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
      const current = wordClass(text[offset] ?? "", big);
      let previous = offset - 1;
      if (current && wordClass(text[previous] ?? "", big) === current) {
        while (previous >= 0 && wordClass(text[previous] ?? "", big) === current) previous -= 1;
      }
      while (previous >= 0 && !wordClass(text[previous] ?? "", big)) previous -= 1;
      offset = Math.max(0, previous);
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
  const found = line.slice(from.column).search(/[()[\]{}]/u);
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
  if (character.length !== 1) return state;
  const line = state.lines[state.line] ?? "";
  const forward = key === "f" || key === "t";
  let column = state.column;
  for (let index = 0; index < Math.max(1, count); index += 1) {
    const found = forward
      ? line.indexOf(character, column + 1)
      : line.lastIndexOf(character, column - 1);
    if (found < 0) return state;
    column = found;
  }
  if (key === "t") column -= 1;
  if (key === "T") column += 1;
  const next = {
    ...state,
    column: clamp(column, 0, cursorLimit(line)),
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
  const text = flattenLines(state.lines);
  const at = offsetAt(state.lines, { line: state.line, column: state.column });
  const repetitions = Math.max(1, count);
  if (object === "w" || object === "W")
    return wordObject(text, at, object === "W", around, repetitions);
  if (object === "s") return sentenceObject(text, at, around, repetitions);
  if (object === "p") return paragraphObject(state.lines, state.line, around, repetitions);
  const pairs: Record<string, [string, string]> = {
    "(": ["(", ")"],
    ")": ["(", ")"],
    b: ["(", ")"],
    "[": ["[", "]"],
    "]": ["[", "]"],
    "{": ["{", "}"],
    "}": ["{", "}"],
    B: ["{", "}"],
    "<": ["<", ">"],
    ">": ["<", ">"],
  };
  if (object in pairs) {
    const [open, close] = pairs[object] as [string, string];
    return pairedObject(text, at, open, close, around, repetitions);
  }
  if (object === '"' || object === "'" || object === "`")
    return quotedObject(text, at, object, around);
  return undefined;
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

function wordObject(
  text: string,
  at: number,
  big: boolean,
  around: boolean,
  count: number,
): TimelineTextRange | undefined {
  let start = at;
  while (start < text.length && !wordClass(text[start] ?? "", big)) start += 1;
  if (start >= text.length) return undefined;
  const kind = wordClass(text[start] ?? "", big);
  while (start > 0 && wordClass(text[start - 1] ?? "", big) === kind) start -= 1;
  let end = start;
  for (let word = 0; word < count; word += 1) {
    const current = wordClass(text[end] ?? "", big);
    while (end < text.length && wordClass(text[end] ?? "", big) === current) end += 1;
    if (word < count - 1) {
      while (end < text.length && !wordClass(text[end] ?? "", big)) end += 1;
      if (end >= text.length) break;
    }
  }
  if (around) {
    const before = end;
    while (end < text.length && /[ \t]/u.test(text[end] ?? "")) end += 1;
    if (end === before) {
      while (start > 0 && /[ \t]/u.test(text[start - 1] ?? "")) start -= 1;
    }
  }
  return { start, end };
}

function pairedObject(
  text: string,
  at: number,
  open: string,
  close: string,
  around: boolean,
  count: number,
): TimelineTextRange | undefined {
  let left = -1;
  let right = -1;
  for (let layer = 0; layer < count; layer += 1) {
    let depth = 0;
    for (let i = left < 0 ? at : left - 1; i >= 0; i -= 1) {
      if (text[i] === close) depth += 1;
      if (text[i] === open && --depth < 0) {
        left = i;
        break;
      }
    }
    if (left < 0) return undefined;
    depth = 0;
    for (let i = left; i < text.length; i += 1) {
      if (text[i] === open) depth += 1;
      if (text[i] === close && --depth === 0) {
        right = i;
        break;
      }
    }
    if (right < at) return undefined;
  }
  if (right < 0) return undefined;
  return { start: left + (around ? 0 : 1), end: right + (around ? 1 : 0) };
}

function quotedObject(
  text: string,
  at: number,
  quote: string,
  around: boolean,
): TimelineTextRange | undefined {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const lineEndIndex = text.indexOf("\n", at);
  const lineEnd = lineEndIndex < 0 ? text.length : lineEndIndex;
  const positions: number[] = [];
  for (let i = lineStart; i < lineEnd; i += 1) {
    if (text[i] === quote && (i === 0 || text[i - 1] !== "\\")) positions.push(i);
  }
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const left = positions[i] as number;
    const right = positions[i + 1] as number;
    if (at >= left && at <= right)
      return { start: left + (around ? 0 : 1), end: right + (around ? 1 : 0) };
  }
  return undefined;
}

function sentenceObject(
  text: string,
  at: number,
  around: boolean,
  count: number,
): TimelineTextRange {
  const starts = sentenceStarts(text);
  const startIndex = Math.max(
    0,
    starts.findLastIndex((value) => value <= at),
  );
  const start = starts[startIndex] ?? 0;
  let end = starts[startIndex + count] ?? text.length;
  if (!around) while (end > start && /\s/u.test(text[end - 1] ?? "")) end -= 1;
  return { start, end };
}

function paragraphObject(
  lines: readonly string[],
  atLine: number,
  around: boolean,
  count: number,
): TimelineTextRange {
  let first = atLine;
  while (first > 0 && (lines[first - 1] ?? "").trim() !== "") first -= 1;
  let last = atLine;
  while (last + 1 < lines.length && (lines[last + 1] ?? "").trim() !== "") last += 1;
  for (let i = 1; i < count && last + 1 < lines.length; i += 1) {
    last += 1;
    while (last + 1 < lines.length && (lines[last + 1] ?? "").trim() !== "") last += 1;
  }
  if (around) while (last + 1 < lines.length && (lines[last + 1] ?? "").trim() === "") last += 1;
  return {
    start: offsetAt(lines, { line: first, column: 0 }),
    end: offsetAt(lines, { line: last, column: (lines[last] ?? "").length }),
  };
}
