import { logicalTextObjectRange, logicalWordOffset, moveLogicalText } from "./logical-text.js";
import { characterStep, findTextCharacter, isCharacter } from "./text-buffer.js";

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
  readonly operatorCountExplicit?: boolean;
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
): ComposerVimResult {
  const start = clamp(range.start, 0, state.text.length);
  const end = clamp(range.end, start, state.text.length);
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
  if (key === "\r" || key === "\n") return { state: clearCommand(state), handled: true };
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
    const range =
      state.operatorCountExplicit || state.count
        ? undefined
        : textObject(state, key, state.pending[1] === "a");
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
        state: {
          ...state,
          pending: key,
          operatorCount: count(state),
          operatorCountExplicit: Boolean(state.count),
          count: "",
        },
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
      let next = state;
      for (let index = 0; index < count(state); index++) {
        const source = key === "u" ? next.undo : next.redo;
        const snapshot = source.at(-1);
        if (!snapshot) break;
        const current = { text: next.text, cursor: next.cursor };
        next = {
          ...next,
          ...snapshot,
          undo: key === "u" ? source.slice(0, -1) : [...next.undo, current],
          redo: key === "u" ? [...next.redo, current] : source.slice(0, -1),
        };
      }
      return { state: clearCommand(next), handled: true };
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
  return { state: clearCommand(state), handled: false };
}

/** Apply data read from the current system clipboard as one undoable edit. */
export function applyComposerPaste(
  state: ComposerVimState,
  text: string,
  kind: "character" | "line",
  request: { before: boolean; count: number },
): ComposerVimState {
  if (!text) return clearCommand(state);
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
