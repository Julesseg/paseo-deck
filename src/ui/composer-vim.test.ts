import { describe, expect, it } from "vitest";
import {
  type ComposerVimState,
  composerVisualSelection,
  createComposerVim,
  handleComposerVim,
  offsetToPosition,
  positionToOffset,
  setComposerViewport,
  syncComposerVim,
} from "./composer-vim.js";

function keys(text: string, cursor: number, sequence: readonly string[]): ComposerVimState {
  return sequence.reduce(
    (state, key) => handleComposerVim(state, key).state,
    createComposerVim(text, cursor),
  );
}

describe("composer Vim buffer", () => {
  it("maps cursor offsets to editor positions across lines", () => {
    const text = "one\ntwo three";
    expect(positionToOffset(text, { line: 1, col: 3 })).toBe(7);
    expect(offsetToPosition(text, 7)).toEqual({ line: 1, col: 3 });
    expect(syncComposerVim(createComposerVim(), text, { line: 1, col: 3 })).toMatchObject({
      text,
      cursor: 7,
    });
  });

  it("moves by words, lines, counts, and character finds", () => {
    const text = "one two\nthree four";
    expect(keys(text, 0, ["w", "w"]).cursor).toBe(8);
    expect(keys(text, 0, ["2", "w"]).cursor).toBe(8);
    expect(keys(text, 12, ["0"]).cursor).toBe(8);
    expect(keys(text, 0, ["G"]).cursor).toBe(17);
    expect(keys(text, 0, ["g", "g"]).cursor).toBe(0);
    expect(keys(text, 0, ["f", "t"]).cursor).toBe(4);
    expect(keys(text, 0, ["f", "t", ";"]).cursor).toBe(4);
  });

  it("supports operator motions and text objects", () => {
    expect(keys("one two three", 0, ["d", "w"]).text).toBe("two three");
    expect(keys("one two three", 5, ["c", "i", "w"])).toMatchObject({
      text: "one  three",
      mode: "insert",
    });
    expect(keys("one two three", 5, ["d", "a", "w"]).text).toBe("one three");
    expect(keys("call(one)", 6, ["d", "i", "("]).text).toBe("call()");
    expect(keys("alpha\nbeta\ngamma", 7, ["d", "d"]).text).toBe("alpha\ngamma");
    expect(keys("one two three", 0, ["d", "f", "t"]).text).toBe("wo three");
    expect(keys("one two three", 0, ["d", "2", "w"]).text).toBe("three");
  });

  it("searches forward and backward, repeats, and accepts replacement search input", () => {
    const text = "one two one two";
    expect(keys(text, 0, ["/", "o", "n", "e", "\r"]).cursor).toBe(8);
    expect(keys(text, 0, ["/", "o", "n", "e", "\r", "n"]).cursor).toBe(0);
    expect(keys(text, 8, ["?", "t", "w", "o", "\r"]).cursor).toBe(4);
    expect(keys(text, 8, ["?", "t", "w", "o", "\r", "N"]).cursor).toBe(12);
  });

  it("yanks and pastes without changing text during yank", () => {
    const initial = createComposerVim("first\nsecond");
    const yank = handleComposerVim(handleComposerVim(initial, "y").state, "y");
    expect(yank.yank).toBe("first\n");
    expect(yank.state.text).toBe(initial.text);
    expect(handleComposerVim(yank.state, "p").paste).toEqual({ before: false, count: 1 });
  });

  it("selects characters or lines and edits a selection", () => {
    const visual = keys("one\ntwo", 0, ["v", "l", "l"]);
    expect(composerVisualSelection(visual)).toEqual({ start: 0, end: 3, kind: "character" });
    expect(handleComposerVim(visual, "d").state.text).toBe("\ntwo");
    const lineVisual = keys("one\ntwo", 0, ["V", "j"]);
    expect(composerVisualSelection(lineVisual)).toEqual({ start: 0, end: 7, kind: "line" });
    expect(handleComposerVim(lineVisual, "d").state.text).toBe("");
  });

  it("does not enter removed Visual Block mode", () => {
    const state = keys("abcd\nefgh", 1, ["\u0016"]);
    expect(state.mode).toBe("normal");
    expect(composerVisualSelection(state)).toBeUndefined();
  });

  it("opens a line, deletes, then undoes and redoes", () => {
    const opened = keys("one\ntwo", 0, ["o"]);
    expect(opened).toMatchObject({ text: "one\n\ntwo", mode: "insert", cursor: 4 });
    const deleted = keys("one two", 0, ["x"]);
    expect(deleted.text).toBe("ne two");
    expect(handleComposerVim(deleted, "u").state.text).toBe("one two");
    expect(handleComposerVim(handleComposerVim(deleted, "u").state, "\u0012").state.text).toBe(
      "ne two",
    );
  });

  it("keeps Normal Enter inert and leaves global Ctrl-U out of Insert editing", () => {
    expect(keys("one\n  two", 0, ["\r"]).cursor).toBe(0);
    const insertion = {
      ...syncComposerVim(createComposerVim("one\nsecond"), "one\nsecond", { line: 1, col: 6 }),
      mode: "insert" as const,
    };
    expect(handleComposerVim(insertion, "\u0015").state).toMatchObject({
      text: "one\nsecond",
      cursor: 10,
      mode: "insert",
    });
  });

  it("treats an Insert session as one undoable change", () => {
    const initial = createComposerVim("one");
    const inserted = handleComposerVim(initial, "A").state;
    const synced = syncComposerVim(inserted, "one two", { line: 0, col: 7 });
    const normal = handleComposerVim(synced, "\u001b").state;
    expect(normal).toMatchObject({ text: "one two", mode: "normal" });
    expect(handleComposerVim(normal, "u").state.text).toBe("one");
  });

  it("moves across sentences and paragraphs and joins lines", () => {
    expect(keys("One. Two! Three?", 0, [")"]).cursor).toBe(5);
    expect(keys("One. Two! Three?", 5, ["("]).cursor).toBe(0);
    expect(keys("one\ntwo\n\nthree", 0, ["}"]).cursor).toBe(8);
    expect(keys("one\n two", 0, ["J"]).text).toBe("one two");
    expect(keys("Ab", 0, ["~"]).text).toBe("ab");
  });

  it("leaves excluded viewport, marks and jump aliases inert", () => {
    const view = setComposerViewport(createComposerVim("zero\none\ntwo"), 1, 2);
    for (const key of ["H", "M", "L", "m", "'", "`", "\u000f", "\u0009"])
      expect(handleComposerVim(view, key).state.cursor).toBe(0);
  });
});
