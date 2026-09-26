import {
  createTimelineBuffer,
  findTimelineCharacter,
  moveTimelineBuffer,
  timelineTextObjectRange,
} from "./timeline-buffer.js";

export type ComposerVimMode = "normal" | "insert" | "visual";
export type ComposerVisualKind = "character" | "line" | "block";
export interface ComposerVimState {
  readonly text: string;
  readonly cursor: number;
  readonly mode: ComposerVimMode;
  readonly visualKind: ComposerVisualKind;
  readonly anchor?: number | undefined;
  readonly pending: string;
  readonly count: string;
  readonly operatorCount: number;
  readonly register: string;
  readonly registerKind: "character" | "line" | "block";
  readonly undo: readonly ComposerSnapshot[];
  readonly redo: readonly ComposerSnapshot[];
  readonly goalColumn?: number | undefined;
  readonly lastFind?: { key: "f" | "F" | "t" | "T"; character: string };
  readonly searchQuery?: string;
  readonly searchDirection?: -1 | 1;
  readonly searchInput?: string | undefined;
  readonly insertSnapshot?: ComposerSnapshot | undefined;
  readonly viewportTop?: number;
  readonly viewportHeight?: number;
  readonly marks: Readonly<Record<string, number>>;
  readonly jumpHistory: readonly number[];
  readonly jumpIndex: number;
}

interface ComposerSnapshot {
  readonly text: string;
  readonly cursor: number;
}

export interface ComposerVimResult {
  readonly state: ComposerVimState;
  readonly handled: boolean;
  readonly yank?: string;
}

export function createComposerVim(text = "", cursor = 0): ComposerVimState {
  return {
    text,
    cursor: clamp(cursor, 0, Math.max(0, text.length - 1)),
    mode: "normal",
    visualKind: "character",
    pending: "",
    count: "",
    operatorCount: 1,
    register: "",
    registerKind: "character",
    undo: [],
    redo: [],
    marks: {},
    jumpHistory: [],
    jumpIndex: -1,
  };
}

/** Supply the editor's visible logical-line window for H/M/L. */
export function setComposerViewport(
  state: ComposerVimState,
  top: number,
  height: number,
): ComposerVimState {
  return { ...state, viewportTop: Math.max(0, top), viewportHeight: Math.max(1, height) };
}

/** Refresh the model after the pi-tui editor handles an Insert key. */
export function syncComposerVim(
  state: ComposerVimState,
  text: string,
  position: { line: number; col: number },
): ComposerVimState {
  return { ...state, text, cursor: positionToOffset(text, position) };
}

export function positionToOffset(text: string, position: { line: number; col: number }): number {
  const lines = text.split("\n");
  const line = clamp(position.line, 0, lines.length - 1);
  let offset = 0;
  for (let index = 0; index < line; index++) offset += (lines[index]?.length ?? 0) + 1;
  return offset + clamp(position.col, 0, lines[line]?.length ?? 0);
}

export function offsetToPosition(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, clamp(offset, 0, text.length));
  const lines = before.split("\n");
  return { line: lines.length - 1, col: lines.at(-1)?.length ?? 0 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

function lineEnd(text: string, offset: number): number {
  const end = text.indexOf("\n", offset);
  return end < 0 ? text.length : end;
}

function normalCursor(text: string, offset: number): number {
  const end = lineEnd(text, offset);
  return clamp(offset, lineStart(text, offset), Math.max(lineStart(text, offset), end - 1));
}

function clearCommand(state: ComposerVimState): ComposerVimState {
  return { ...state, pending: "", count: "", operatorCount: 1 };
}

function jumpTo(state: ComposerVimState, cursor: number): ComposerVimState {
  if (cursor === state.cursor) return { ...clearCommand(state), cursor };
  const history = state.jumpHistory.slice(0, state.jumpIndex + 1);
  if (history.at(-1) !== state.cursor) history.push(state.cursor);
  history.push(cursor);
  return { ...clearCommand(state), cursor, jumpHistory: history, jumpIndex: history.length - 1 };
}

function changed(state: ComposerVimState, text: string, cursor: number): ComposerVimState {
  if (text === state.text) return { ...state, cursor: normalCursor(text, cursor) };
  return {
    ...state,
    text,
    cursor: normalCursor(text, cursor),
    undo: [...state.undo, { text: state.text, cursor: state.cursor }],
    redo: [],
  };
}

function enterInsert(before: ComposerVimState, next: ComposerVimState): ComposerVimState {
  return {
    ...next,
    mode: "insert",
    insertSnapshot: { text: before.text, cursor: before.cursor },
  };
}

function replace(
  state: ComposerVimState,
  start: number,
  end: number,
  replacement: string,
): ComposerVimState {
  const text = state.text.slice(0, start) + replacement + state.text.slice(end);
  return changed(state, text, start + replacement.length);
}

function count(state: ComposerVimState): number {
  return Math.max(1, Number(state.count) || 1);
}

function motion(state: ComposerVimState, key: string, amount: number): number | undefined {
  const position = offsetToPosition(state.text, state.cursor);
  if (key === "^" || key === "_") {
    const line = state.text.slice(
      lineStart(state.text, state.cursor),
      lineEnd(state.text, state.cursor),
    );
    return lineStart(state.text, state.cursor) + (line.search(/\S/) < 0 ? 0 : line.search(/\S/));
  }
  if (key === "H" || key === "M" || key === "L") {
    if (state.viewportHeight === undefined) return undefined;
    const lines = state.text.split("\n");
    const top = clamp(state.viewportTop ?? 0, 0, lines.length - 1);
    const bottom = clamp(top + state.viewportHeight - 1, top, lines.length - 1);
    const line =
      key === "H"
        ? clamp(top + amount - 1, top, bottom)
        : key === "L"
          ? clamp(bottom - amount + 1, top, bottom)
          : Math.floor((top + bottom) / 2);
    const value = lines[line] ?? "";
    return positionToOffset(state.text, { line, col: Math.max(0, value.search(/\S/)) });
  }
  if (key === "(" || key === ")") {
    let cursor = state.cursor;
    for (let step = 0; step < amount; step++) {
      const boundaries = [...state.text.matchAll(/[.!?](?:\s+|$)/g)].map(
        (match) => (match.index ?? 0) + match[0].length,
      );
      if (key === ")") cursor = boundaries.find((index) => index > cursor) ?? state.text.length;
      else cursor = boundaries.filter((index) => index < cursor).at(-1) ?? 0;
    }
    return normalCursor(state.text, cursor);
  }
  if (key === "{" || key === "}") {
    const lines = state.text.split("\n");
    let target = position.line;
    for (let step = 0; step < amount; step++) {
      if (key === "}") {
        target = lines.findIndex((line, index) => index > target && line.trim() === "");
        if (target < 0) target = lines.length - 1;
      } else {
        for (target = target - 1; target > 0 && (lines[target] ?? "").trim() !== ""; target--) {}
        target = Math.max(0, target);
      }
    }
    return positionToOffset(state.text, { line: target, col: 0 });
  }
  const timeline = createTimelineBuffer({
    lines: state.text.split("\n"),
    line: position.line,
    column: position.col,
  });
  const moved = moveTimelineBuffer(
    state.goalColumn === undefined ? timeline : { ...timeline, goalColumn: state.goalColumn },
    key,
    amount,
  );
  if (
    moved.line === timeline.line &&
    moved.column === timeline.column &&
    !["0", "gg", "G", "$"].includes(key)
  )
    return undefined;
  return positionToOffset(state.text, { line: moved.line, col: moved.column });
}

function find(
  state: ComposerVimState,
  key: "f" | "F" | "t" | "T",
  character: string,
  amount: number,
): number | undefined {
  let cursor = state.cursor;
  for (let index = 0; index < amount; index++) {
    const position = offsetToPosition(state.text, cursor);
    const found = findTimelineCharacter(
      createTimelineBuffer({
        lines: state.text.split("\n"),
        line: position.line,
        column: position.col,
      }),
      key,
      character,
    );
    const next = positionToOffset(state.text, { line: found.line, col: found.column });
    if (next === cursor) break;
    cursor = next;
  }
  return cursor === state.cursor ? undefined : cursor;
}

function search(
  state: ComposerVimState,
  query: string,
  direction: -1 | 1,
  amount: number,
): number | undefined {
  if (!query) return undefined;
  let cursor = state.cursor;
  for (let index = 0; index < amount; index++) {
    const found =
      direction === 1
        ? state.text.indexOf(query, cursor + 1)
        : state.text.lastIndexOf(query, cursor - 1);
    cursor =
      found >= 0
        ? found
        : direction === 1
          ? state.text.indexOf(query)
          : state.text.lastIndexOf(query);
    if (cursor < 0) return undefined;
  }
  return cursor;
}

function searchWordUnderCursor(state: ComposerVimState, direction: -1 | 1): ComposerVimResult {
  const range = wordObject(state, false, false);
  const query = state.text.slice(range.start, range.end);
  if (!query) return { state: clearCommand(state), handled: true };
  const cursor = search(state, query, direction, count(state));
  return {
    state: {
      ...clearCommand(state),
      searchQuery: query,
      searchDirection: direction,
      cursor: cursor ?? state.cursor,
    },
    handled: true,
  };
}

function wordObject(
  state: ComposerVimState,
  big: boolean,
  around: boolean,
): { start: number; end: number } {
  const text = state.text;
  const isWord = (character: string) =>
    big ? /\S/.test(character) : /[\p{L}\p{N}_]/u.test(character);
  let start = clamp(state.cursor, 0, Math.max(0, text.length - 1));
  if (!isWord(text[start] ?? "") && start > 0 && isWord(text[start - 1] ?? "")) start--;
  while (start > 0 && isWord(text[start - 1] ?? "")) start--;
  let end = start;
  while (end < text.length && isWord(text[end] ?? "")) end++;
  if (around) {
    const right = end;
    while (end < text.length && text[end] !== "\n" && /\s/.test(text[end] ?? "")) end++;
    if (end === right)
      while (start > 0 && text[start - 1] !== "\n" && /\s/.test(text[start - 1] ?? "")) start--;
  }
  return { start, end };
}

function delimitedObject(
  state: ComposerVimState,
  delimiter: string,
  around: boolean,
): { start: number; end: number } | undefined {
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
    "'": ["'", "'"],
    '"': ['"', '"'],
    "`": ["`", "`"],
  };
  const pair = pairs[delimiter];
  if (!pair) return undefined;
  const [open, close] = pair;
  let start = state.text.lastIndexOf(open, state.cursor);
  let end = state.text.indexOf(
    close,
    state.cursor + (open === close && state.text[state.cursor] === open ? 1 : 0),
  );
  if (start < 0 || end < 0 || start === end) return undefined;
  if (open !== close) {
    let depth = 0;
    for (let index = state.cursor; index >= 0; index--) {
      if (state.text[index] === close) depth++;
      if (state.text[index] === open && --depth < 0) {
        start = index;
        break;
      }
    }
    depth = 0;
    for (let index = start; index < state.text.length; index++) {
      if (state.text[index] === open) depth++;
      if (state.text[index] === close && --depth === 0) {
        end = index;
        break;
      }
    }
  }
  return { start: start + (around ? 0 : 1), end: end + (around ? 1 : 0) };
}

function textObject(
  state: ComposerVimState,
  key: string,
  around: boolean,
): { start: number; end: number; kind: "character" | "line" } | undefined {
  if (key === "w" || key === "W")
    return { ...wordObject(state, key === "W", around), kind: "character" };
  if (key === "s") {
    const position = offsetToPosition(state.text, state.cursor);
    const range = timelineTextObjectRange(
      createTimelineBuffer({
        lines: state.text.split("\n"),
        line: position.line,
        column: position.col,
      }),
      "s",
      around,
    );
    return range ? { ...range, kind: "character" } : undefined;
  }
  if (key === "p") {
    let start = lineStart(state.text, state.cursor);
    let end = lineEnd(state.text, state.cursor);
    while (start > 0 && state.text.slice(lineStart(state.text, start - 2), start - 1).trim())
      start = lineStart(state.text, start - 2);
    while (
      end < state.text.length &&
      state.text.slice(end + 1, lineEnd(state.text, end + 1)).trim()
    )
      end = lineEnd(state.text, end + 1);
    if (end < state.text.length) end++;
    if (around && end < state.text.length) end++;
    return { start, end, kind: "line" };
  }
  const range = delimitedObject(state, key, around);
  return range ? { ...range, kind: "character" } : undefined;
}

function applyOperator(
  state: ComposerVimState,
  operator: string,
  range: { start: number; end: number; kind: "character" | "line" },
): ComposerVimResult {
  const start = clamp(range.start, 0, state.text.length);
  const end = clamp(range.end, start, state.text.length);
  const yank = state.text.slice(start, end);
  let next: ComposerVimState = {
    ...clearCommand(state),
    register: yank,
    registerKind: range.kind,
    mode: "normal",
    anchor: undefined,
  };
  if (operator === "y") return { state: next, handled: true, yank };
  next = replace(next, start, end, "");
  if (operator === "c") next = { ...enterInsert(state, next), cursor: start };
  return { state: next, handled: true };
}

function visualRange(state: ComposerVimState): {
  start: number;
  end: number;
  kind: "character" | "line";
} {
  const anchor = state.anchor ?? state.cursor;
  if (state.visualKind === "line") {
    const first = Math.min(anchor, state.cursor);
    const last = Math.max(anchor, state.cursor);
    const end = lineEnd(state.text, last);
    return {
      start: lineStart(state.text, first),
      end: Math.min(state.text.length, end + 1),
      kind: "line",
    };
  }
  return {
    start: Math.min(anchor, state.cursor),
    end: Math.min(state.text.length, Math.max(anchor, state.cursor) + 1),
    kind: "character",
  };
}

function applyVisualOperator(state: ComposerVimState, operator: string): ComposerVimResult {
  if (state.visualKind !== "block") return applyOperator(state, operator, visualRange(state));
  const anchor = offsetToPosition(state.text, state.anchor ?? state.cursor);
  const cursor = offsetToPosition(state.text, state.cursor);
  const firstLine = Math.min(anchor.line, cursor.line);
  const lastLine = Math.max(anchor.line, cursor.line);
  const firstColumn = Math.min(anchor.col, cursor.col);
  const lastColumn = Math.max(anchor.col, cursor.col) + 1;
  const lines = state.text.split("\n");
  const selected = lines
    .slice(firstLine, lastLine + 1)
    .map((line) => line.slice(firstColumn, lastColumn));
  const yank = selected.join("\n");
  let next: ComposerVimState = {
    ...clearCommand(state),
    mode: "normal",
    anchor: undefined,
    register: yank,
    registerKind: "block",
    cursor: positionToOffset(state.text, { line: firstLine, col: firstColumn }),
  };
  if (operator === "y") return { state: next, handled: true, yank };
  for (let line = firstLine; line <= lastLine; line++) {
    const value = lines[line] ?? "";
    lines[line] = value.slice(0, firstColumn) + value.slice(lastColumn);
  }
  next = changed(
    next,
    lines.join("\n"),
    positionToOffset(lines.join("\n"), { line: firstLine, col: firstColumn }),
  );
  if (operator === "c") next = enterInsert(state, next);
  return { state: next, handled: true };
}

export function composerVisualSelection(
  state: ComposerVimState,
): { start: number; end: number; kind: ComposerVisualKind } | undefined {
  if (state.mode !== "visual") return undefined;
  return { ...visualRange(state), kind: state.visualKind };
}

export function handleComposerVim(state: ComposerVimState, key: string): ComposerVimResult {
  if (key === "\u001b") {
    const snapshot = state.mode === "insert" ? state.insertSnapshot : undefined;
    const alreadyStored = snapshot && state.undo.at(-1)?.text === snapshot.text;
    return {
      state: {
        ...clearCommand(state),
        mode: "normal",
        anchor: undefined,
        cursor: normalCursor(state.text, state.cursor),
        searchInput: undefined,
        insertSnapshot: undefined,
        undo:
          snapshot && snapshot.text !== state.text && !alreadyStored
            ? [...state.undo, snapshot]
            : state.undo,
        redo: snapshot && snapshot.text !== state.text ? [] : state.redo,
      },
      handled: true,
    };
  }
  if (state.mode === "insert") {
    if (key === "\u0015" || key === "\u0017") {
      const start =
        key === "\u0015"
          ? lineStart(state.text, state.cursor)
          : wordObject({ ...state, cursor: Math.max(0, state.cursor - 1) }, false, false).start;
      const text = state.text.slice(0, start) + state.text.slice(state.cursor);
      return { state: { ...state, text, cursor: start }, handled: true };
    }
    return { state, handled: false };
  }
  if (state.pending === "/" || state.pending === "?") {
    if (key === "\r" || key === "\n") {
      const query = state.searchInput || state.searchQuery || "";
      const direction = state.pending === "/" ? 1 : -1;
      const cursor = search(state, query, direction, count(state));
      return {
        state: {
          ...jumpTo(state, cursor ?? state.cursor),
          searchInput: undefined,
          searchQuery: query,
          searchDirection: direction,
        },
        handled: true,
      };
    }
    if (key === "\u007f" || key === "\b")
      return {
        state: { ...state, searchInput: state.searchInput?.slice(0, -1) ?? "" },
        handled: true,
      };
    if (key.length === 1 && key >= " ")
      return { state: { ...state, searchInput: (state.searchInput ?? "") + key }, handled: true };
    return { state, handled: true };
  }
  if (state.pending === "r") {
    if (key.length !== 1) return { state: clearCommand(state), handled: true };
    const end = Math.min(state.text.length, state.cursor + count(state));
    return {
      state: clearCommand(replace(state, state.cursor, end, key.repeat(end - state.cursor))),
      handled: true,
    };
  }
  if (["f", "F", "t", "T"].includes(state.pending)) {
    const pending = state.pending as "f" | "F" | "t" | "T";
    const cursor = key.length === 1 ? find(state, pending, key, count(state)) : undefined;
    return {
      state: {
        ...clearCommand(state),
        cursor: cursor ?? state.cursor,
        lastFind: { key: pending, character: key },
      },
      handled: true,
    };
  }
  if (state.pending === "g") {
    if (key === "*" || key === "#") return searchWordUnderCursor(state, key === "*" ? 1 : -1);
    const target =
      key === "g"
        ? motion(state, "gg", state.count ? count(state) : 0)
        : key === "e" || key === "E"
          ? motion(state, `g${key}`, count(state))
          : key === "_"
            ? Math.max(lineStart(state.text, state.cursor), lineEnd(state.text, state.cursor) - 1)
            : ["0", "^", "$", "j", "k", "m", "M"].includes(key)
              ? motion(state, `g${key}`, count(state))
              : undefined;
    return { state: { ...clearCommand(state), cursor: target ?? state.cursor }, handled: true };
  }
  if (state.pending === "[" || state.pending === "]") {
    const target =
      key === "[" || key === "]" ? motion(state, state.pending + key, count(state)) : undefined;
    return { state: { ...clearCommand(state), cursor: target ?? state.cursor }, handled: true };
  }
  if (state.pending === "m") {
    return key.length === 1
      ? {
          state: { ...clearCommand(state), marks: { ...state.marks, [key]: state.cursor } },
          handled: true,
        }
      : { state: clearCommand(state), handled: true };
  }
  if (state.pending === "'" || state.pending === "`") {
    const marked = state.marks[key];
    if (marked === undefined) return { state: clearCommand(state), handled: true };
    const value = state.text.slice(lineStart(state.text, marked), lineEnd(state.text, marked));
    const cursor =
      state.pending === "'"
        ? lineStart(state.text, marked) + Math.max(0, value.search(/\S/))
        : marked;
    return { state: jumpTo(state, cursor), handled: true };
  }
  if (state.pending === "i" || state.pending === "a") {
    const range = textObject(state, key, state.pending === "a");
    if (!range) return { state: clearCommand(state), handled: true };
    if (state.mode === "visual")
      return {
        state: {
          ...clearCommand(state),
          anchor: range.start,
          cursor: Math.max(range.start, range.end - 1),
          visualKind: range.kind,
        },
        handled: true,
      };
    return { state: clearCommand(state), handled: true };
  }
  if (
    state.pending.startsWith("di") ||
    state.pending.startsWith("da") ||
    state.pending.startsWith("ci") ||
    state.pending.startsWith("ca") ||
    state.pending.startsWith("yi") ||
    state.pending.startsWith("ya")
  ) {
    const range = textObject(state, key, state.pending[1] === "a");
    return range
      ? applyOperator(state, state.pending[0] ?? "", range)
      : { state: clearCommand(state), handled: true };
  }
  if (["d", "c", "y"].includes(state.pending)) {
    const operator = state.pending;
    if (/^[1-9]$/.test(key) || (key === "0" && state.count))
      return { state: { ...state, count: state.count + key }, handled: true };
    if (key === "i" || key === "a")
      return { state: { ...state, pending: operator + key }, handled: true };
    if (["f", "F", "t", "T", "g"].includes(key))
      return { state: { ...state, pending: operator + key }, handled: true };
    const amount = state.operatorCount * count(state);
    if (key === operator || key === "_") {
      const start = lineStart(state.text, state.cursor);
      let end = start;
      for (let index = 0; index < amount; index++)
        end = Math.min(state.text.length, lineEnd(state.text, end) + 1);
      return applyOperator(state, operator, { start, end, kind: "line" });
    }
    const target = motion(
      state,
      key,
      key === "G" && !state.count && state.operatorCount === 1 ? 0 : amount,
    );
    if (target === undefined) return { state: clearCommand(state), handled: true };
    let start = Math.min(state.cursor, target);
    let end = Math.max(state.cursor, target);
    if (["e", "E", "$", "%"].includes(key)) end++;
    if (["j", "k", "gg", "G", "+", "-"].includes(key)) {
      start = lineStart(state.text, start);
      end = Math.min(state.text.length, lineEnd(state.text, end) + 1);
    }
    return applyOperator(state, operator, {
      start,
      end,
      kind: ["j", "k", "gg", "G"].includes(key) ? "line" : "character",
    });
  }
  if (/^[dcy][fFtTg]$/.test(state.pending)) {
    const operator = state.pending[0] ?? "";
    const prefix = state.pending[1] ?? "";
    const target =
      prefix === "g"
        ? key === "g"
          ? motion(state, "gg", state.operatorCount * count(state))
          : key === "e" || key === "E"
            ? motion(state, `g${key}`, state.operatorCount * count(state))
            : undefined
        : key.length === 1
          ? find(state, prefix as "f" | "F" | "t" | "T", key, state.operatorCount * count(state))
          : undefined;
    if (target === undefined) return { state: clearCommand(state), handled: true };
    const inclusive = prefix === "f" || prefix === "F" || (prefix === "g" && key === "e");
    const start = Math.min(state.cursor, target);
    const end = Math.min(state.text.length, Math.max(state.cursor, target) + (inclusive ? 1 : 0));
    return applyOperator(state, operator, { start, end, kind: "character" });
  }

  if (state.mode === "visual") {
    if (key === "v" || key === "V" || key === "\u0016") {
      const kind = key === "v" ? "character" : key === "V" ? "line" : "block";
      return {
        state:
          state.visualKind === kind
            ? { ...state, mode: "normal", anchor: undefined }
            : { ...state, visualKind: kind },
        handled: true,
      };
    }
    if (["d", "c", "y", "x"].includes(key))
      return applyVisualOperator(state, key === "x" ? "d" : key);
  } else {
    if (/^[1-9]$/.test(key) || (key === "0" && state.count))
      return { state: { ...state, count: state.count + key }, handled: true };
    if (["d", "c", "y"].includes(key))
      return {
        state: { ...state, pending: key, operatorCount: count(state), count: "" },
        handled: true,
      };
    if (key === "v" || key === "V" || key === "\u0016")
      return {
        state: {
          ...clearCommand(state),
          mode: "visual",
          anchor: state.cursor,
          visualKind: key === "v" ? "character" : key === "V" ? "line" : "block",
        },
        handled: true,
      };
    if (["i", "a", "I", "A", "o", "O"].includes(key)) {
      let next = clearCommand(state);
      if (key === "a")
        next = { ...next, cursor: Math.min(lineEnd(state.text, state.cursor), state.cursor + 1) };
      if (key === "I") next = { ...next, cursor: motion(state, "^", 1) ?? state.cursor };
      if (key === "A") next = { ...next, cursor: lineEnd(state.text, state.cursor) };
      if (key === "o" || key === "O") {
        const where =
          key === "o" ? lineEnd(state.text, state.cursor) : lineStart(state.text, state.cursor);
        next = replace(next, where, where, "\n");
        next = { ...next, cursor: where + (key === "o" ? 1 : 0) };
      }
      return { state: enterInsert(state, next), handled: true };
    }
    if (key === "x" || key === "X" || key === "s") {
      const start =
        key === "X"
          ? Math.max(lineStart(state.text, state.cursor), state.cursor - count(state))
          : state.cursor;
      const end =
        key === "X"
          ? state.cursor
          : Math.min(lineEnd(state.text, state.cursor), state.cursor + count(state));
      const result = applyOperator(state, key === "s" ? "c" : "d", {
        start,
        end,
        kind: "character",
      });
      return result;
    }
    if (key === "D" || key === "C")
      return applyOperator(state, key === "D" ? "d" : "c", {
        start: state.cursor,
        end: lineEnd(state.text, state.cursor),
        kind: "character",
      });
    if (key === "S")
      return applyOperator(state, "c", {
        start: lineStart(state.text, state.cursor),
        end: Math.min(state.text.length, lineEnd(state.text, state.cursor) + 1),
        kind: "line",
      });
    if (key === "Y")
      return applyOperator(state, "y", {
        start: lineStart(state.text, state.cursor),
        end: Math.min(state.text.length, lineEnd(state.text, state.cursor) + 1),
        kind: "line",
      });
    if (key === "p" || key === "P") {
      if (state.registerKind === "block") {
        const lines = state.text.split("\n");
        const position = offsetToPosition(state.text, state.cursor);
        const column = position.col + (key === "p" ? 1 : 0);
        for (const [index, value] of state.register.split("\n").entries()) {
          const line = position.line + index;
          while (lines.length <= line) lines.push("");
          const current = lines[line] ?? "";
          const padded = current.padEnd(column, " ");
          lines[line] = padded.slice(0, column) + value + padded.slice(column);
        }
        return {
          state: clearCommand(changed(state, lines.join("\n"), state.cursor)),
          handled: true,
        };
      }
      const insertion =
        state.registerKind === "line"
          ? key === "p"
            ? Math.min(state.text.length, lineEnd(state.text, state.cursor) + 1)
            : lineStart(state.text, state.cursor)
          : state.cursor + (key === "p" ? 1 : 0);
      const register =
        state.registerKind === "line" &&
        key === "p" &&
        insertion === state.text.length &&
        !state.text.endsWith("\n")
          ? `\n${state.register.replace(/\n$/, "")}`
          : state.register;
      const next = replace(state, insertion, insertion, register);
      return { state: clearCommand(next), handled: true };
    }
    if (key === "J") {
      let text = state.text;
      const start = lineEnd(text, state.cursor);
      let cursor = start;
      for (let index = 0; index < count(state); index++) {
        if (cursor >= text.length) break;
        const after = text.slice(cursor + 1).match(/^\s*/)?.[0].length ?? 0;
        text = `${text.slice(0, cursor)} ${text.slice(cursor + 1 + after)}`;
        cursor = lineEnd(text, cursor);
      }
      return { state: clearCommand(changed(state, text, start)), handled: true };
    }
    if (key === "~") {
      const start = state.cursor;
      const end = Math.min(lineEnd(state.text, start), start + count(state));
      const swapped = [...state.text.slice(start, end)]
        .map((char) => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()))
        .join("");
      const next = replace(state, start, end, swapped);
      return {
        state: clearCommand({ ...next, cursor: normalCursor(next.text, end) }),
        handled: true,
      };
    }
    if (key === "u" || key === "\u0012") {
      const source = key === "u" ? state.undo : state.redo;
      const snapshot = source.at(-1);
      if (!snapshot) return { state: clearCommand(state), handled: true };
      const current = { text: state.text, cursor: state.cursor };
      return {
        state: clearCommand({
          ...state,
          ...snapshot,
          undo: key === "u" ? source.slice(0, -1) : [...state.undo, current],
          redo: key === "u" ? [...state.redo, current] : source.slice(0, -1),
        }),
        handled: true,
      };
    }
    if (key === "r") return { state: { ...state, pending: "r" }, handled: true };
  }
  if (["f", "F", "t", "T", "g", "[", "]"].includes(key))
    return { state: { ...state, pending: key }, handled: true };
  if (key === "m" || key === "'" || key === "`")
    return { state: { ...state, pending: key }, handled: true };
  if (key === "\u000f" || key === "\u0009") {
    const index = clamp(
      state.jumpIndex + (key === "\u000f" ? -1 : 1),
      0,
      state.jumpHistory.length - 1,
    );
    const cursor = state.jumpHistory[index];
    return {
      state:
        cursor === undefined
          ? clearCommand(state)
          : { ...clearCommand(state), cursor, jumpIndex: index },
      handled: true,
    };
  }
  if (key === "\r" || key === "\n") {
    const target = motion(state, "+", count(state));
    return { state: { ...clearCommand(state), cursor: target ?? state.cursor }, handled: true };
  }
  if (key === "/" || key === "?")
    return { state: { ...state, pending: key, searchInput: "" }, handled: true };
  if (key === "n" || key === "N") {
    const direction = state.searchDirection ?? 1;
    const cursor = search(
      state,
      state.searchQuery ?? "",
      key === "n" ? direction : direction === 1 ? -1 : 1,
      count(state),
    );
    return { state: { ...clearCommand(state), cursor: cursor ?? state.cursor }, handled: true };
  }
  if (key === "*" || key === "#") return searchWordUnderCursor(state, key === "*" ? 1 : -1);
  if (key === ";" || key === ",") {
    const previous = state.lastFind;
    if (!previous) return { state: clearCommand(state), handled: true };
    const opposite: Record<"f" | "F" | "t" | "T", "f" | "F" | "t" | "T"> = {
      f: "F",
      F: "f",
      t: "T",
      T: "t",
    };
    const cursor = find(
      state,
      key === ";" ? previous.key : opposite[previous.key],
      previous.character,
      count(state),
    );
    return { state: { ...clearCommand(state), cursor: cursor ?? state.cursor }, handled: true };
  }
  const controlMotion: Record<string, string> = {
    "\u0010": "k",
    "\u000e": "j",
    "\u007f": "h",
    "\b": "h",
    " ": "l",
    "\u0015": "k",
    "\u0004": "j",
    "\u0002": "k",
    "\u0006": "j",
    "\u001b[A": "k",
    "\u001b[B": "j",
    "\u001b[C": "l",
    "\u001b[D": "h",
  };
  const mapped = controlMotion[key] ?? key;
  const viewportAmount =
    key === "\u0015" || key === "\u0004"
      ? Math.max(1, Math.floor((state.viewportHeight ?? 1) / 2))
      : key === "\u0002" || key === "\u0006"
        ? Math.max(1, (state.viewportHeight ?? 1) - 1)
        : 1;
  const target = motion(
    state,
    mapped,
    state.count ? count(state) * viewportAmount : key === "G" ? 0 : viewportAmount,
  );
  if (target !== undefined)
    return {
      state: {
        ...clearCommand(state),
        cursor: target,
        goalColumn: ["j", "k"].includes(key)
          ? (state.goalColumn ?? offsetToPosition(state.text, state.cursor).col)
          : undefined,
      },
      handled: true,
    };
  return { state: clearCommand(state), handled: false };
}
