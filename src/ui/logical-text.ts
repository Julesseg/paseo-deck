import {
  characterOffsets,
  characterStep,
  completeDelimiterPairs,
  nearestDelimiterObject,
} from "./text-buffer.js";
export interface TextRange {
  readonly start: number;
  readonly end: number;
}
export interface LogicalTextPosition {
  readonly lines: readonly string[];
  readonly line: number;
  readonly column: number;
  readonly goalColumn?: number;
}
export function flattenLines(lines: readonly string[]): string {
  return lines.join("\n");
}
export function offsetAt(
  lines: readonly string[],
  position: { line: number; column: number },
): number {
  return (
    lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) +
    position.column
  );
}
export function cursorLimit(line: string): number {
  return line ? characterStep(line, line.length, -1) : 0;
}
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
export function firstNonblank(line: string): number {
  return clamp(line.search(/\S/u), 0, cursorLimit(line));
}
export function lastNonblank(line: string): number {
  return clamp(line.search(/\s*$/u) - 1, 0, cursorLimit(line));
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
): { line: number; column: number } | undefined {
  const direction = key === "[[" || key === "[]" ? -1 : 1;
  const target = key === "[[" || key === "]]" ? "{" : "}";
  let line = fromLine;
  for (let step = 0; step < count; step += 1) {
    let next = line + direction;
    while (next >= 0 && next < lines.length && !(lines[next] ?? "").startsWith(target)) {
      next += direction;
    }
    if (next < 0 || next >= lines.length) {
      if (step === 0) return undefined;
      break;
    }
    line = next;
  }
  return { line, column: 0 };
}

export function positionAt(
  lines: readonly string[],
  offset: number,
): { line: number; column: number } {
  let remaining = Math.max(0, offset);
  for (let line = 0; line < lines.length; line += 1) {
    const length = (lines[line] ?? "").length;
    if (remaining < length || line === lines.length - 1)
      return { line, column: clamp(remaining, 0, cursorLimit(lines[line] ?? "")) };
    remaining -= length + 1;
  }
  return { line: 0, column: 0 };
}

export function wordClass(character: string, big: boolean): number {
  if (!character || /\s/u.test(character)) return 0;
  return big || /[\p{L}\p{N}_]/u.test(character) ? 1 : 2;
}

function wordMotion(
  lines: readonly string[],
  from: { line: number; column: number },
  key: string,
  count: number,
): { line: number; column: number } {
  return positionAt(
    lines,
    logicalWordOffset(flattenLines(lines), offsetAt(lines, from), key, count),
  );
}
export function logicalWordOffset(
  raw: string,
  fromOffset: number,
  key: string,
  count: number,
): number {
  const offsets = characterOffsets(raw);
  const text = offsets.slice(0, -1).map((at, index) => raw.slice(at, offsets[index + 1]));
  const big = key === key.toUpperCase() || key === "gE";
  const motion = key.toLowerCase();
  let offset = Math.max(
    0,
    offsets.findLastIndex((at) => at <= fromOffset),
  );
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
  return offsets[offset] ?? raw.length;
}

function matchingBracket(
  lines: readonly string[],
  from: { line: number; column: number },
): { line: number; column: number } {
  const text = flattenLines(lines);
  const line = lines[from.line] ?? "";
  const found = line.slice(from.column).search(/[()[\]{}]/u);
  if (found < 0) return from;
  const at = offsetAt(lines, { line: from.line, column: from.column + found });
  const pair = completeDelimiterPairs(text).find((pair) => pair.start === at || pair.end === at);
  return pair ? positionAt(lines, pair.start === at ? pair.end : pair.start) : from;
}

function wordObject(
  raw: string,
  at: number,
  big: boolean,
  around: boolean,
  count: number,
): TextRange | undefined {
  const offsets = characterOffsets(raw);
  const text = offsets.slice(0, -1).map((at, index) => raw.slice(at, offsets[index + 1]));
  let start = Math.max(
    0,
    offsets.findLastIndex((value) => value <= at),
  );
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
  if (around && kind === 0) {
    const nextKind = wordClass(text[end] ?? "", big);
    while (end < text.length && wordClass(text[end] ?? "", big) === nextKind) end++;
  } else if (around) {
    const before = end;
    while (end < text.length && /[ \t]/u.test(text[end] ?? "")) end += 1;
    if (end === before) {
      while (start > 0 && /[ \t]/u.test(text[start - 1] ?? "")) start -= 1;
    }
  }
  return { start: offsets[start] ?? raw.length, end: offsets[end] ?? raw.length };
}

function sentenceObject(text: string, at: number, around: boolean, count: number): TextRange {
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
): TextRange {
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
export function moveLogicalText(
  state: LogicalTextPosition,
  key: string,
  count = 0,
): LogicalTextPosition {
  const amount = Math.max(1, count);
  let line = state.line;
  let column = state.column;
  const vertical = key === "j" || key === "k" || key === "gj" || key === "gk";
  if (key === "h") column = characterStep(state.lines[line] ?? "", column, -amount);
  else if (key === "l") column = characterStep(state.lines[line] ?? "", column, amount);
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
    if (!position) return state;
    line = position.line;
    column = position.column;
  } else if (key === "%") {
    if (count > 0) return state;
    const position = matchingBracket(state.lines, { line, column });
    line = position.line;
    column = position.column;
  }
  line = clamp(line, 0, state.lines.length - 1);
  if (vertical) column = state.goalColumn ?? state.column;
  column = characterStep(
    state.lines[line] ?? "",
    clamp(column, 0, cursorLimit(state.lines[line] ?? "")),
    0,
  );
  const next = {
    ...state,
    line,
    column,
    ...(vertical ? { goalColumn: state.goalColumn ?? state.column } : {}),
  };
  if (!vertical) delete (next as { goalColumn?: number }).goalColumn;
  return next;
}

export function logicalTextObjectRange(
  state: LogicalTextPosition,
  object: string,
  around = false,
  count = 1,
): TextRange | undefined {
  const text = flattenLines(state.lines);
  const at = offsetAt(state.lines, state);
  if (count !== 1) return undefined;
  if (object === "w" || object === "W") return wordObject(text, at, object === "W", around, 1);
  if (object === "s") return sentenceObject(text, at, around, 1);
  if (object === "p") return paragraphObject(state.lines, state.line, around, 1);
  return nearestDelimiterObject(text, at, object, around);
}
