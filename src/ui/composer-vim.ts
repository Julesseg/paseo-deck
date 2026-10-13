import {
  logicalTextObjectRange,
  logicalWordOffset,
  moveLogicalText,
  wordClass,
} from "./logical-text.js";
import { characterStep, findTextCharacter, isCharacter } from "./text-buffer.js";

export type ComposerVimMode = "normal" | "insert" | "visual";
export type ComposerVisualKind = "character" | "line";
export interface ComposerVimState {
  readonly text: string;
  readonly cursor: number;
  readonly mode: ComposerVimMode;
  readonly visualKind: ComposerVisualKind;
  readonly anchor?: number | undefined;
  readonly previousSelection?:
    | { anchor: number; cursor: number; kind: ComposerVisualKind }
    | undefined;
  readonly pending: string;
  readonly count: string;
  readonly operatorCount: number;
  readonly operatorCountExplicit?: boolean;
  readonly undo: readonly ComposerSnapshot[];
  readonly redo: readonly ComposerSnapshot[];
  readonly historyIndex?: number | undefined;
  readonly historyDraft?: ComposerSnapshot | undefined;
  readonly goalColumn?: number | undefined;
  readonly lastFind?: { key: "f" | "F" | "t" | "T"; character: string };
  readonly searchQuery?: string;
  readonly searchWholeWord?: boolean;
  readonly searchDirection?: -1 | 1;
  readonly searchInput?: string | undefined;
  readonly insertSnapshot?: ComposerSnapshot | undefined;
  readonly viewportTop?: number;
  readonly viewportHeight?: number;
}

interface ComposerSnapshot {
  readonly text: string;
  readonly cursor: number;
}

export interface ComposerVimResult {
  readonly state: ComposerVimState;
  readonly handled: boolean;
  readonly yank?: string;
  readonly copy?: { text: string; kind: "character" | "line" };
  readonly paste?: { before: boolean; count: number };
}

export function createComposerVim(text = "", cursor = 0): ComposerVimState {
  return {
    text,
    cursor: normalCursor(text, clamp(cursor, 0, Math.max(0, text.length - 1))),
    mode: "normal",
    visualKind: "character",
    pending: "",
    count: "",
    operatorCount: 1,
    undo: [],
    redo: [],
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
  return { ...remapSelection(state, text), text, cursor: positionToOffset(text, position) };
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
  return offset <= 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

function lineEnd(text: string, offset: number): number {
  const end = text.indexOf("\n", offset);
  return end < 0 ? text.length : end;
}

function normalCursor(text: string, offset: number): number {
  const end = lineEnd(text, offset);
  const last = end > lineStart(text, offset) ? characterStep(text, end, -1) : end;
  return characterStep(text, clamp(offset, lineStart(text, offset), last), 0);
}

function clearCommand(state: ComposerVimState): ComposerVimState {
  return { ...state, pending: "", count: "", operatorCount: 1, operatorCountExplicit: false };
}

function jumpTo(state: ComposerVimState, cursor: number): ComposerVimState {
  return { ...clearCommand(state), cursor };
}

function remapSelection(state: ComposerVimState, text: string): ComposerVimState {
  if (text === state.text) return state;
  let start = 0;
  while (start < state.text.length && start < text.length && state.text[start] === text[start])
    start++;
  let end = state.text.length;
  let nextEnd = text.length;
  while (end > start && nextEnd > start && state.text[end - 1] === text[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  const oldLines = state.text.split("\n");
  const newLines = text.split("\n");
  const map = (offset: number): number | undefined => {
    if (oldLines.length === newLines.length) {
      const position = offsetToPosition(state.text, offset);
      const oldLine = oldLines[position.line] ?? "";
      const newLine = newLines[position.line] ?? "";
      let first = 0;
      while (first < oldLine.length && first < newLine.length && oldLine[first] === newLine[first])
        first++;
      let last = oldLine.length;
      let nextLast = newLine.length;
      while (last > first && nextLast > first && oldLine[last - 1] === newLine[nextLast - 1]) {
        last--;
        nextLast--;
      }
      const column =
        position.col < first
          ? position.col
          : position.col >= last
            ? position.col + nextLast - last
            : undefined;
      return column === undefined
        ? undefined
        : positionToOffset(text, { line: position.line, col: column });
    }
    return offset < start ? offset : offset >= end ? offset + nextEnd - end : undefined;
  };
  const previous = state.previousSelection;
  const anchor = previous && map(previous.anchor);
  const cursor = previous && map(previous.cursor);
  return {
    ...state,
    previousSelection:
      previous && anchor !== undefined && cursor !== undefined
        ? { ...previous, anchor, cursor }
        : undefined,
  };
}

function changed(state: ComposerVimState, text: string, cursor: number): ComposerVimState {
  if (text === state.text) return { ...state, cursor: normalCursor(text, cursor) };
  return {
    ...remapSelection(state, text),
    text,
    cursor: normalCursor(text, cursor),
    undo: [...state.undo, { text: state.text, cursor: state.cursor }],
    redo: [],
    historyIndex: undefined,
    historyDraft: undefined,
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

function canonicalMotionKey(key: string): string {
  return (
    (
      {
        "\u007f": "h",
        "\b": "h",
        " ": "l",
        "\u001b[A": "k",
        "\u001b[B": "j",
        "\u001b[C": "l",
        "\u001b[D": "h",
      } as Record<string, string>
    )[key] ?? key
  );
}

function motion(
  state: ComposerVimState,
  key: string,
  amount: number,
  operator = false,
): number | undefined {
  key = canonicalMotionKey(key);
  if (operator && ["w", "W", "b", "B", "e", "E", "ge", "gE"].includes(key))
    return logicalWordOffset(state.text, state.cursor, key, amount);
  const position = offsetToPosition(state.text, state.cursor);
  if (
    ![
      "h",
      "l",
      "j",
      "k",
      "gj",
      "gk",
      "w",
      "W",
      "b",
      "B",
      "e",
      "E",
      "ge",
      "gE",
      "0",
      "g0",
      "^",
      "_",
      "g^",
      "$",
      "g$",
      "g_",
      "gg",
      "G",
      "(",
      ")",
      "{",
      "}",
      "[[",
      "]]",
      "[]",
      "][",
      "%",
      ";",
      ",",
    ].includes(key)
  )
    return undefined;
  if (
    (state.count || state.operatorCountExplicit) &&
    ["0", "g0", "^", "_", "g^", "%"].includes(key)
  )
    return undefined;
  if (key === "h" || key === "l")
    return normalCursor(
      state.text,
      Math.max(
        lineStart(state.text, state.cursor),
        Math.min(
          lineEnd(state.text, state.cursor),
          characterStep(state.text, state.cursor, key === "h" ? -amount : amount),
        ),
      ),
    );
  if (key === ";" || key === ",") {
    const previous = state.lastFind;
    if (!previous) return undefined;
    const opposite = { f: "F", F: "f", t: "T", T: "t" } as const;
    const repeated = key === ";" ? previous.key : opposite[previous.key];
    const cursor =
      repeated === "t" || repeated === "T"
        ? characterStep(state.text, state.cursor, repeated === "t" ? 1 : -1)
        : state.cursor;
    return find({ ...state, cursor }, repeated, previous.character, amount);
  }
  if (key === "^" || key === "_") {
    const line = state.text.slice(
      lineStart(state.text, state.cursor),
      lineEnd(state.text, state.cursor),
    );
    return lineStart(state.text, state.cursor) + (line.search(/\S/) < 0 ? 0 : line.search(/\S/));
  }
  const timeline = { lines: state.text.split("\n"), line: position.line, column: position.col };
  const moved = moveLogicalText(
    state.goalColumn === undefined ? timeline : { ...timeline, goalColumn: state.goalColumn },
    key,
    key === "%" ? 0 : amount,
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
  return findTextCharacter(state.text, state.cursor, { key, character }, amount);
}

function search(
  state: ComposerVimState,
  query: string,
  direction: -1 | 1,
  amount: number,
  wholeWord = state.searchWholeWord ?? false,
): number | undefined {
  if (!query) return undefined;
  const matches: number[] = [];
  const word = (value: string | undefined) => value !== undefined && /[\p{L}\p{N}_]/u.test(value);
  for (let at = state.text.indexOf(query); at >= 0; at = state.text.indexOf(query, at + 1))
    if (!wholeWord || (!word(state.text[at - 1]) && !word(state.text[at + query.length])))
      matches.push(at);
  if (!matches.length) return undefined;
  let cursor = state.cursor;
  for (let index = 0; index < amount; index++)
    cursor =
      direction === 1
        ? (matches.find((at) => at > cursor) ?? matches[0] ?? cursor)
        : ([...matches].reverse().find((at) => at < cursor) ??
          matches[matches.length - 1] ??
          cursor);
  return cursor;
}

function searchWordUnderCursor(state: ComposerVimState, direction: -1 | 1): ComposerVimResult {
  const range = wordObject(state, false, false);
  const query = state.text.slice(range.start, range.end);
  if (!query) return { state: clearCommand(state), handled: true };
  const cursor = search(state, query, direction, count(state), true);
  return {
    state: {
      ...clearCommand(state),
      searchQuery: query,
      searchWholeWord: true,
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

function textObject(
  state: ComposerVimState,
  key: string,
  around: boolean,
): { start: number; end: number; kind: "character" | "line" } | undefined {
  const position = offsetToPosition(state.text, state.cursor);
  const range = logicalTextObjectRange(
    { lines: state.text.split("\n"), line: position.line, column: position.col },
    key,
    around,
  );
  return range
    ? {
        ...range,
        end: key === "p" && state.text[range.end] === "\n" ? range.end + 1 : range.end,
        kind: key === "p" ? "line" : "character",
      }
    : undefined;
}

function countedLineEnd(state: ComposerVimState): number {
  let end = lineEnd(state.text, state.cursor);
  for (let index = 1; index < count(state) && end < state.text.length; index++)
    end = lineEnd(state.text, end + 1);
  return end;
}

function applyOperator(
  state: ComposerVimState,
  operator: string,
  range: { start: number; end: number; kind: "character" | "line" },
  allowEmpty = false,
): ComposerVimResult {
  const start = clamp(range.start, 0, state.text.length);
  const end = clamp(range.end, start, state.text.length);
  if (start === end && range.kind !== "line" && !allowEmpty)
    return { state: clearCommand(state), handled: true };
  const yank = state.text.slice(start, end);
  let next: ComposerVimState = {
    ...clearCommand(state),
    mode: "normal",
    anchor: undefined,
  };
  if (operator === "y")
    return { state: next, handled: true, yank, copy: { text: yank, kind: range.kind } };
  const deletionStart =
    operator === "d" &&
    range.kind === "line" &&
    end === state.text.length &&
    start > 0 &&
    state.text[end - 1] !== "\n"
      ? start - 1
      : start;
  next = replace(
    next,
    deletionStart,
    end,
    operator === "c" && range.kind === "line" && state.text[end - 1] === "\n" ? "\n" : "",
  );
  if (operator === "c") next = { ...enterInsert(state, next), cursor: start };
  return { state: next, handled: true, copy: { text: yank, kind: range.kind } };
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
    end: Math.min(state.text.length, characterStep(state.text, Math.max(anchor, state.cursor), 1)),
    kind: "character",
  };
}

function visualTransform(
  state: ComposerVimState,
  transform: (value: string) => string,
): ComposerVimResult {
  const range = visualRange(state);
  const next = replace(
    leaveVisual(state),
    range.start,
    range.end,
    transform(state.text.slice(range.start, range.end)),
  );
  return {
    state: { ...clearCommand(next), cursor: normalCursor(next.text, range.start) },
    handled: true,
  };
}

function visualJoin(state: ComposerVimState, raw: boolean): ComposerVimResult {
  const range = visualRange({ ...state, visualKind: "line" });
  let end = lineEnd(state.text, Math.max(state.cursor, state.anchor ?? state.cursor));
  if (
    lineStart(state.text, state.cursor) === lineStart(state.text, state.anchor ?? state.cursor) &&
    end < state.text.length
  )
    end = lineEnd(state.text, end + 1);
  const value = state.text
    .slice(range.start, end)
    .split("\n")
    .reduce((left, right) => {
      if (raw) return left + right;
      const body = right.replace(/^[ \t]*/u, "");
      const space = left && !/[ \t]$/u.test(left) && body && !body.startsWith(")") ? " " : "";
      return left + space + body;
    });
  const next = replace(leaveVisual(state), range.start, end, value);
  return {
    state: { ...clearCommand(next), cursor: normalCursor(next.text, range.start) },
    handled: true,
  };
}

function saveSelection(state: ComposerVimState): ComposerVimState {
  return state.mode !== "visual"
    ? state
    : {
        ...state,
        previousSelection: {
          anchor: state.anchor ?? state.cursor,
          cursor: state.cursor,
          kind: state.visualKind,
        },
      };
}

function leaveVisual(state: ComposerVimState): ComposerVimState {
  return { ...clearCommand(saveSelection(state)), mode: "normal", anchor: undefined };
}

function applyVisualOperator(state: ComposerVimState, operator: string): ComposerVimResult {
  return applyOperator(saveSelection(state), operator, visualRange(state));
}

export function composerVisualSelection(
  state: ComposerVimState,
): { start: number; end: number; kind: ComposerVisualKind } | undefined {
  if (state.mode !== "visual") return undefined;
  return { ...visualRange(state), kind: state.visualKind };
}

/** Browse immutable sent copies; each recall is a draft undo operation. */
export function recallComposerPrompt(
  state: ComposerVimState,
  history: readonly string[],
  direction: -1 | 1,
): ComposerVimState {
  const current = state.historyIndex ?? -1;
  const index = Math.max(-1, Math.min(history.length - 1, current - direction));
  if (!history.length || index === current) return state;
  const before = finishComposerInsert(state);
  const saved = current === -1 ? { text: before.text, cursor: before.cursor } : before.historyDraft;
  const text = index === -1 ? (saved?.text ?? "") : (history[index] ?? "");
  const cursor = index === -1 ? (saved?.cursor ?? 0) : direction === -1 ? 0 : text.length;
  return {
    ...remapSelection(before, text),
    text,
    cursor: before.mode === "insert" ? cursor : normalCursor(text, cursor),
    historyIndex: index,
    historyDraft: index === -1 ? undefined : saved,
    undo: [...before.undo, { text: before.text, cursor: before.cursor }],
    redo: [],
  };
}

/** Insert literal terminal paste without allowing payload bytes to become commands. */
export function applyComposerInsertText(
  state: ComposerVimState,
  text: string,
  atomic = false,
): ComposerVimState {
  const before = atomic ? finishComposerInsert(state) : state;
  const inserted = before.text.slice(0, before.cursor) + text + before.text.slice(before.cursor);
  const next: ComposerVimState = {
    ...remapSelection(before, inserted),
    mode: "insert",
    text: inserted,
    cursor: before.cursor + text.length,
    insertSnapshot: before.insertSnapshot ?? { text: before.text, cursor: before.cursor },
    historyIndex: undefined,
    historyDraft: undefined,
  };
  return atomic ? finishComposerInsert(next) : next;
}

/** Close a typing group without changing mode or caret. */
export function finishComposerInsert(state: ComposerVimState): ComposerVimState {
  const snapshot = state.insertSnapshot;
  return {
    ...state,
    insertSnapshot: undefined,
    undo:
      snapshot && snapshot.text !== state.text && state.undo.at(-1)?.text !== snapshot.text
        ? [...state.undo, snapshot]
        : state.undo,
    redo: snapshot && snapshot.text !== state.text ? [] : state.redo,
  };
}

export function undoComposer(state: ComposerVimState, redo = false, amount = 1): ComposerVimState {
  let next = state;
  for (let index = 0; index < amount; index++) {
    const source = redo ? next.redo : next.undo;
    const snapshot = source.at(-1);
    if (!snapshot) break;
    const current = { text: next.text, cursor: next.cursor };
    next = {
      ...remapSelection(next, snapshot.text),
      ...snapshot,
      cursor:
        next.mode === "normal" ? normalCursor(snapshot.text, snapshot.cursor) : snapshot.cursor,
      insertSnapshot: undefined,
      historyIndex: undefined,
      historyDraft: undefined,
      undo: redo ? [...next.undo, current] : source.slice(0, -1),
      redo: redo ? source.slice(0, -1) : [...next.redo, current],
    };
  }
  return next;
}

function handleComposerInsert(state: ComposerVimState, key: string): ComposerVimResult {
  if (key === "\u001a" || key === "insert-redo")
    return {
      state: undoComposer(finishComposerInsert(state), key === "insert-redo"),
      handled: true,
    };
  let cursor = state.cursor;
  let start = cursor;
  let end = cursor;
  let insertion: string | undefined;
  const word = (direction: -1 | 1): number => {
    let at = cursor;
    if (direction === -1) {
      while (at > 0 && /\s/u.test(state.text.slice(characterStep(state.text, at, -1), at)))
        at = characterStep(state.text, at, -1);
      const kind = wordClass(state.text.slice(characterStep(state.text, at, -1), at), false);
      while (
        at > 0 &&
        wordClass(state.text.slice(characterStep(state.text, at, -1), at), false) === kind
      )
        at = characterStep(state.text, at, -1);
    } else {
      while (
        at < state.text.length &&
        /\s/u.test(state.text.slice(at, characterStep(state.text, at, 1)))
      )
        at = characterStep(state.text, at, 1);
      const kind = wordClass(state.text.slice(at, characterStep(state.text, at, 1)), false);
      while (
        at < state.text.length &&
        wordClass(state.text.slice(at, characterStep(state.text, at, 1)), false) === kind
      )
        at = characterStep(state.text, at, 1);
    }
    return at;
  };
  switch (key) {
    case "insert-left":
      cursor = characterStep(state.text, cursor, -1);
      break;
    case "insert-right":
      cursor = characterStep(state.text, cursor, 1);
      break;
    case "insert-word-left":
      cursor = word(-1);
      break;
    case "insert-word-right":
      cursor = word(1);
      break;
    case "insert-home":
      cursor = lineStart(state.text, cursor);
      break;
    case "insert-end":
      cursor = lineEnd(state.text, cursor);
      break;
    case "insert-backspace":
      start = characterStep(state.text, cursor, -1);
      insertion = "";
      break;
    case "insert-delete":
      end = characterStep(state.text, cursor, 1);
      insertion = "";
      break;
    case "insert-delete-word-left":
      start = word(-1);
      insertion = "";
      break;
    case "insert-delete-word-right":
      end = word(1);
      insertion = "";
      break;
    case "insert-newline":
      insertion = "\n";
      break;
    default:
      if (
        key &&
        [...key].every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        )
      )
        insertion = key;
      else return { state, handled: true };
  }
  if (insertion === undefined) return { state: { ...state, cursor }, handled: true };
  const text = state.text.slice(0, start) + insertion + state.text.slice(end);
  if (text === state.text) return { state, handled: true };
  return {
    state: {
      ...remapSelection(state, text),
      text,
      cursor: start + insertion.length,
      historyIndex: undefined,
      historyDraft: undefined,
      insertSnapshot: state.insertSnapshot ?? { text: state.text, cursor: state.cursor },
    },
    handled: true,
  };
}

export function handleComposerVim(state: ComposerVimState, key: string): ComposerVimResult {
  if (key === "\u001b" && state.mode === "visual") {
    return {
      state: state.pending || state.count ? clearCommand(state) : leaveVisual(state),
      handled: true,
    };
  }
  if (key === "\u001b") {
    const finished = state.mode === "insert" ? finishComposerInsert(state) : state;
    return {
      state: {
        ...clearCommand(finished),
        mode: "normal",
        anchor: undefined,
        cursor: normalCursor(state.text, state.cursor),
        searchInput: undefined,
        insertSnapshot: undefined,
      },
      handled: true,
    };
  }
  if (state.mode === "insert") return handleComposerInsert(state, key);
  if (state.pending === "/" || state.pending === "?") {
    if (key === "\r" || key === "\n") {
      const query = state.searchInput || state.searchQuery || "";
      const direction = state.pending === "/" ? 1 : -1;
      const cursor = search(state, query, direction, count(state), false);
      return {
        state: {
          ...jumpTo(state, cursor ?? state.cursor),
          searchInput: undefined,
          searchQuery: query,
          searchWholeWord: false,
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
  if (key === "\r" || key === "\n") return { state: clearCommand(state), handled: true };
  if (state.pending === "r" && state.mode === "visual") {
    if (!isCharacter(key)) return { state: clearCommand(state), handled: true };
    return visualTransform(state, (value) =>
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
        .map((segment) => (segment.segment === "\n" ? "\n" : key))
        .join(""),
    );
  }
  if (state.pending === "r") {
    if (!isCharacter(key)) return { state: clearCommand(state), handled: true };
    const end = characterStep(state.text, state.cursor, count(state));
    if (
      end > lineEnd(state.text, state.cursor) ||
      [
        ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
          state.text.slice(state.cursor, end),
        ),
      ].length < count(state)
    )
      return { state: clearCommand(state), handled: true };
    return {
      state: clearCommand(replace(state, state.cursor, end, key.repeat(count(state)))),
      handled: true,
    };
  }
  if (["f", "F", "t", "T"].includes(state.pending)) {
    const pending = state.pending as "f" | "F" | "t" | "T";
    const cursor = isCharacter(key) ? find(state, pending, key, count(state)) : undefined;
    return {
      state: {
        ...clearCommand(state),
        cursor: cursor ?? state.cursor,
        ...(cursor === undefined ? {} : { lastFind: { key: pending, character: key } }),
      },
      handled: true,
    };
  }
  if (state.pending === "g") {
    if (key === "J" && state.mode === "visual") return visualJoin(state, true);
    if (key === "v") {
      const previous = state.previousSelection;
      if (!previous) return { state: clearCommand(state), handled: true };
      return {
        state: {
          ...clearCommand(saveSelection(state)),
          mode: "visual",
          anchor: previous.anchor,
          cursor: previous.cursor,
          visualKind: previous.kind,
        },
        handled: true,
      };
    }
    const target =
      key === "g"
        ? motion(state, "gg", state.count ? count(state) : 0)
        : key === "e" || key === "E"
          ? motion(state, `g${key}`, count(state))
          : key === "_"
            ? motion(state, "g_", count(state))
            : ["0", "^", "$", "j", "k"].includes(key)
              ? motion(state, `g${key}`, count(state))
              : undefined;
    return { state: { ...clearCommand(state), cursor: target ?? state.cursor }, handled: true };
  }
  if (state.pending === "[" || state.pending === "]") {
    const target =
      key === "[" || key === "]" ? motion(state, state.pending + key, count(state)) : undefined;
    return { state: { ...clearCommand(state), cursor: target ?? state.cursor }, handled: true };
  }
  if (state.pending === "i" || state.pending === "a") {
    const range = state.count ? undefined : textObject(state, key, state.pending === "a");
    if (!range) return { state: clearCommand(state), handled: true };
    if (state.mode === "visual")
      return {
        state: {
          ...clearCommand(state),
          anchor: range.start,
          cursor: Math.max(range.start, characterStep(state.text, range.end, -1)),
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
    const range =
      state.operatorCountExplicit || state.count
        ? undefined
        : textObject(state, key, state.pending[1] === "a");
    return range
      ? applyOperator(state, state.pending[0] ?? "", range, true)
      : { state: clearCommand(state), handled: true };
  }
  if (["d", "c", "y"].includes(state.pending)) {
    const operator = state.pending;
    if (/^[1-9]$/.test(key) || (key === "0" && state.count))
      return { state: { ...state, count: state.count + key }, handled: true };
    if (key === "i" || key === "a")
      return { state: { ...state, pending: operator + key }, handled: true };
    if (["f", "F", "t", "T", "g", "[", "]"].includes(key))
      return { state: { ...state, pending: operator + key }, handled: true };
    const amount = state.operatorCount * count(state);
    if (key === operator) {
      const start = lineStart(state.text, state.cursor);
      let end = start;
      for (let index = 0; index < amount; index++)
        end = Math.min(state.text.length, lineEnd(state.text, end) + 1);
      return applyOperator(state, operator, { start, end, kind: "line" });
    }
    const effectiveKey =
      operator === "c" && ["w", "W"].includes(key) && /\S/u.test(state.text[state.cursor] ?? "")
        ? key === "w"
          ? "e"
          : "E"
        : canonicalMotionKey(key);
    const target = motion(
      state,
      effectiveKey,
      key === "G" && !state.count && !state.operatorCountExplicit ? 0 : amount,
      true,
    );
    if (target === undefined) return { state: clearCommand(state), handled: true };
    let start = Math.min(state.cursor, target);
    let end = Math.max(state.cursor, target);
    if (["e", "E", "$", "%", ";", ","].includes(effectiveKey))
      end = characterStep(state.text, end, 1);
    if (["j", "k", "gg", "G"].includes(effectiveKey)) {
      start = lineStart(state.text, start);
      end = Math.min(state.text.length, lineEnd(state.text, end) + 1);
    }
    return applyOperator(state, operator, {
      start,
      end,
      kind: ["j", "k", "gg", "G"].includes(effectiveKey) ? "line" : "character",
    });
  }
  if (/^[dcy][fFtTg[\]]$/.test(state.pending)) {
    const operator = state.pending[0] ?? "";
    const prefix = state.pending[1] ?? "";
    const target =
      prefix === "[" || prefix === "]"
        ? ["[", "]"].includes(key)
          ? motion(state, prefix + key, state.operatorCount * count(state))
          : undefined
        : prefix === "g"
          ? key === "g"
            ? motion(state, "gg", state.operatorCount * count(state))
            : ["e", "E", "0", "^", "$", "j", "k", "_"].includes(key)
              ? motion(state, `g${key}`, state.operatorCount * count(state), true)
              : undefined
          : isCharacter(key)
            ? find(state, prefix as "f" | "F" | "t" | "T", key, state.operatorCount * count(state))
            : undefined;
    if (target === undefined) return { state: clearCommand(state), handled: true };
    const inclusive =
      "fFtT".includes(prefix) || (prefix === "g" && ["e", "E", "$", "_"].includes(key));
    let start = Math.min(state.cursor, target);
    let end = Math.min(
      state.text.length,
      inclusive
        ? characterStep(state.text, Math.max(state.cursor, target), 1)
        : Math.max(state.cursor, target),
    );
    const linewise = prefix === "g" && ["g", "j", "k"].includes(key);
    if (linewise) {
      start = lineStart(state.text, start);
      end = Math.min(state.text.length, lineEnd(state.text, end) + 1);
    }
    return applyOperator(
      !"fFtT".includes(prefix)
        ? state
        : { ...state, lastFind: { key: prefix as "f" | "F" | "t" | "T", character: key } },
      operator,
      { start, end, kind: linewise ? "line" : "character" },
    );
  }

  if (state.mode === "visual") {
    if (/^[1-9]$/.test(key) || (key === "0" && state.count))
      return { state: { ...state, count: state.count + key }, handled: true };
    if (key === ">" || key === "<") {
      const range = visualRange({ ...state, visualKind: "line" });
      const value = state.text
        .slice(range.start, range.end)
        .split("\n")
        .map((line) => {
          if (!/\S/u.test(line)) return line;
          const leading = line.match(/^[ \t]*/u)?.[0] ?? "";
          const width = leading.replaceAll("\t", "    ").length;
          return (
            " ".repeat(Math.max(0, width + (key === ">" ? 2 : -2) * count(state))) +
            line.slice(leading.length)
          );
        })
        .join("\n");
      return {
        state: clearCommand(replace(leaveVisual(state), range.start, range.end, value)),
        handled: true,
      };
    }
    if (key === "v" || key === "V") {
      const kind = key === "v" ? "character" : "line";
      return {
        state: state.visualKind === kind ? leaveVisual(state) : { ...state, visualKind: kind },
        handled: true,
      };
    }
    if (key === "o" || key === "O")
      return {
        state: {
          ...clearCommand(state),
          anchor: state.cursor,
          cursor: state.anchor ?? state.cursor,
        },
        handled: true,
      };
    if (["D", "X", "C", "S", "R", "Y"].includes(key))
      return applyOperator(
        saveSelection(state),
        key === "Y" ? "y" : ["D", "X"].includes(key) ? "d" : "c",
        visualRange({ ...state, visualKind: "line" }),
      );
    if (["d", "c", "y", "x", "s"].includes(key))
      return applyVisualOperator(state, key === "x" ? "d" : key === "s" ? "c" : key);
    if (["u", "U", "~"].includes(key))
      return visualTransform(state, (value) =>
        key === "u"
          ? value.toLowerCase()
          : key === "U"
            ? value.toUpperCase()
            : [...value]
                .map((char) =>
                  char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase(),
                )
                .join(""),
      );
    if (key === "r") return { state: { ...state, pending: "r" }, handled: true };
    if (key === "J") return visualJoin(state, false);
    if (key === "p" || key === "P")
      return {
        state: clearCommand(state),
        handled: true,
        paste: { before: key === "P", count: count(state) },
      };
    if (key === "i" || key === "a") return { state: { ...state, pending: key }, handled: true };
  } else {
    if (/^[1-9]$/.test(key) || (key === "0" && state.count))
      return { state: { ...state, count: state.count + key }, handled: true };
    if (["d", "c", "y"].includes(key))
      return {
        state: {
          ...state,
          pending: key,
          operatorCount: count(state),
          operatorCountExplicit: Boolean(state.count),
          count: "",
        },
        handled: true,
      };
    if (key === "v" || key === "V")
      return {
        state: {
          ...clearCommand(state),
          mode: "visual",
          anchor: state.cursor,
          visualKind: key === "v" ? "character" : "line",
        },
        handled: true,
      };
    if (["i", "a", "I", "A", "o", "O"].includes(key)) {
      if (state.count) return { state: clearCommand(state), handled: true };
      let next = clearCommand(state);
      if (key === "a")
        next = {
          ...next,
          cursor: Math.min(
            lineEnd(state.text, state.cursor),
            characterStep(state.text, state.cursor, 1),
          ),
        };
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
          ? Math.max(
              lineStart(state.text, state.cursor),
              characterStep(state.text, state.cursor, -count(state)),
            )
          : state.cursor;
      const end =
        key === "X"
          ? state.cursor
          : Math.min(
              lineEnd(state.text, state.cursor),
              characterStep(state.text, state.cursor, count(state)),
            );
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
        end: countedLineEnd(state),
        kind: "character",
      });
    if (key === "S")
      return applyOperator(state, "c", {
        start: lineStart(state.text, state.cursor),
        end: Math.min(state.text.length, countedLineEnd(state) + 1),
        kind: "line",
      });
    if (key === "Y")
      return applyOperator(state, "y", {
        start: lineStart(state.text, state.cursor),
        end: Math.min(state.text.length, countedLineEnd(state) + 1),
        kind: "line",
      });
    if (key === "p" || key === "P") {
      return {
        state: clearCommand(state),
        handled: true,
        paste: { before: key === "P", count: count(state) },
      };
    }
    if (key === "J") {
      let text = state.text;
      const start = lineEnd(text, state.cursor);
      let cursor = start;
      for (let index = 0; index < Math.max(2, count(state)) - 1; index++) {
        if (cursor >= text.length) break;
        const after = text.slice(cursor + 1).match(/^[ \t]*/)?.[0].length ?? 0;
        const right = text.slice(cursor + 1 + after);
        const space =
          cursor > 0 &&
          !/[ \t]/u.test(text[cursor - 1] ?? "") &&
          right &&
          right[0] !== "\n" &&
          right[0] !== ")"
            ? " "
            : "";
        text = `${text.slice(0, cursor)}${space}${right}`;
        cursor = lineEnd(text, cursor);
      }
      return { state: clearCommand(changed(state, text, start)), handled: true };
    }
    if (key === "~") {
      const start = state.cursor;
      const end = Math.min(
        lineEnd(state.text, start),
        characterStep(state.text, start, count(state)),
      );
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
      return {
        state: clearCommand(undoComposer(state, key === "\u0012", count(state))),
        handled: true,
      };
    }

    if (key === "r") return { state: { ...state, pending: "r" }, handled: true };
  }
  if (["f", "F", "t", "T", "g", "[", "]"].includes(key))
    return { state: { ...state, pending: key }, handled: true };
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
    const cursor = motion(state, key, count(state));
    return { state: { ...clearCommand(state), cursor: cursor ?? state.cursor }, handled: true };
  }
  if (key === "%" && state.count) return { state: clearCommand(state), handled: true };
  const mapped = canonicalMotionKey(key);
  const target = motion(state, mapped, state.count ? count(state) : key === "G" ? 0 : 1);
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
  return { state: clearCommand(state), handled: state.mode === "visual" };
}

/** Apply data read from the current system clipboard as one undoable edit. */
export function applyComposerPaste(
  state: ComposerVimState,
  text: string,
  kind: "character" | "line",
  request: { before: boolean; count: number },
): ComposerVimState {
  if (!text) return clearCommand(state);
  if (state.mode === "visual") {
    const range = visualRange(state);
    const next = replace(leaveVisual(state), range.start, range.end, text.repeat(request.count));
    return {
      ...clearCommand(next),
      cursor: normalCursor(next.text, range.start + text.length * request.count - 1),
    };
  }
  let where = request.before
    ? state.cursor
    : Math.min(lineEnd(state.text, state.cursor), characterStep(state.text, state.cursor, 1));
  let value = text.repeat(request.count);
  if (kind === "line") {
    const complete = text.endsWith("\n") ? text : `${text}\n`;
    value = complete.repeat(request.count);
    where = request.before
      ? lineStart(state.text, state.cursor)
      : Math.min(state.text.length, lineEnd(state.text, state.cursor) + 1);
    if (!request.before && state.text && !state.text.endsWith("\n") && where === state.text.length)
      value = `\n${value.replace(/\n$/, "")}`;
  }
  const next = replace(state, where, where, value);
  return {
    ...clearCommand(next),
    cursor: normalCursor(
      next.text,
      kind === "line" ? where + (value.startsWith("\n") ? 1 : 0) : where + value.length - 1,
    ),
  };
}

/** Native paste preserves clipboard contents and enters Insert after the payload. */
export function applyComposerNativePaste(state: ComposerVimState, text: string): ComposerVimState {
  const range =
    state.mode === "visual" ? visualRange(state) : { start: state.cursor, end: state.cursor };
  const next = replace(
    state.mode === "visual" ? leaveVisual(state) : clearCommand(state),
    range.start,
    range.end,
    text,
  );
  return { ...enterInsert(state, next), cursor: range.start + text.length };
}
