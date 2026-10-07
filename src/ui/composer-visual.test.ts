import { expect, it } from "vitest";
import { composerVisualSelection, createComposerVim, handleComposerVim } from "./composer-vim.js";

function keys(text: string, cursor: number, inputs: string[]) {
  let state = createComposerVim(text, cursor);
  for (const key of inputs) state = handleComposerVim(state, key).state;
  return state;
}
it("preserves backward Unicode endpoints through swapping, exiting and reselection", () => {
  const state = keys("😀é xyz", 2, ["v", "h", "o", "\u001b", "g", "v"]);
  expect(state.mode).toBe("visual");
  expect(state.cursor).toBe(2);
  expect(composerVisualSelection(state)).toEqual({ start: 0, end: 4, kind: "character" });
});
it("shifts nonblank touched lines by a count, preserving body tabs and whitespace lines", () => {
  const state = keys("\tfoo\tx\n \t\n  bar", 0, ["V", "G", "3", ">"]);
  expect(state.text).toBe("          foo\tx\n \t\n        bar");
  expect(state.mode).toBe("normal");
  expect(handleComposerVim(state, "u").state.text).toBe("\tfoo\tx\n \t\n  bar");
});
it("supports full-line aliases and case, replacement and join actions as single edits", () => {
  expect(keys("one\ntwo\nthree", 1, ["v", "D"]).text).toBe("two\nthree");
  expect(keys("one\ntwo", 1, ["v", "R"]).mode).toBe("insert");
  expect(keys("one\ntwo", 1, ["v", "R"]).text).toBe("\ntwo");
  expect(keys("aBc\ndEf", 0, ["v", "l", "U"]).text).toBe("ABc\ndEf");
  expect(keys("😀é\nx", 0, ["v", "j", "r", "Q"]).text).toBe("QQ\nQ");
  expect(keys("one\n  two\nthree", 1, ["v", "J"]).text).toBe("one two\nthree");
  expect(keys("one\n  two\nthree", 1, ["v", "g", "J"]).text).toBe("one  two\nthree");
});
it("replaces a backward selection with clipboard text as one edit and native paste enters Insert", async () => {
  const { applyComposerPaste, applyComposerNativePaste } = await import("./composer-vim.js");
  const visual = keys("one two", 2, ["v", "h", "h"]);
  expect(handleComposerVim(visual, "p").paste).toEqual({ before: false, count: 1 });
  const pasted = applyComposerPaste(visual, "NEW", "character", { before: false, count: 1 });
  expect(pasted.text).toBe("NEW two");
  expect(pasted.mode).toBe("normal");
  expect(handleComposerVim(pasted, "u").state.text).toBe("one two");
  const native = applyComposerNativePaste(visual, "😀\nhello");
  expect(native.text).toBe("😀\nhello two");
  expect(native.mode).toBe("insert");
  expect(native.cursor).toBe(8);
});
it("remaps surviving saved endpoints and invalidates replaced endpoints", () => {
  let state = keys("abc def", 4, ["v", "l", "\u001b", "0", "x", "g", "v"]);
  expect(composerVisualSelection(state)).toEqual({ start: 3, end: 5, kind: "character" });
  state = handleComposerVim(state, "d").state;
  expect(handleComposerVim(handleComposerVim(state, "g").state, "v").state.mode).toBe("normal");
});
it("cancels pending Visual input before Escape exits and missing objects leave selection intact", () => {
  let state = keys("one two", 0, ["v", "l", "r", "\u001b"]);
  expect(state.mode).toBe("visual");
  expect(composerVisualSelection(state)).toEqual({ start: 0, end: 2, kind: "character" });
  state = handleComposerVim(handleComposerVim(state, "i").state, "q").state;
  expect(composerVisualSelection(state)).toEqual({ start: 0, end: 2, kind: "character" });
  expect(keys("one two", 0, ["v", "2", "i", "w"]).anchor).toBe(0);
  expect(keys("one two", 0, ["\u0016"]).mode).toBe("normal");
});
it("exchanges current and previous selections and remaps indentation body endpoints", () => {
  let state = keys("abc\ndef", 1, ["v", "j", "\u001b", "0", "v", "l", "g", "v"]);
  expect(state.anchor).toBe(1);
  expect(state.cursor).toBe(5);
  state = handleComposerVim(state, ">").state;
  state = handleComposerVim(handleComposerVim(state, "g").state, "v").state;
  expect(state.anchor).toBe(3);
  expect(state.cursor).toBe(9);
  expect(state.text).toBe("  abc\n  def");
});
it.each(["D", "X"])("%s deletes touched complete lines and copies linewise", (key) => {
  const state = keys("one\ntwo\nthree", 1, ["v", "j"]);
  const result = handleComposerVim(state, key);
  expect(result.state.text).toBe("three");
  expect(result.copy).toEqual({ text: "one\ntwo\n", kind: "line" });
});
it.each(["C", "S", "R"])("%s changes touched complete lines and keeps one logical line", (key) => {
  const result = handleComposerVim(keys("one\ntwo\nthree", 1, ["v", "j"]), key);
  expect(result.state.text).toBe("\nthree");
  expect(result.state.mode).toBe("insert");
  expect(result.copy).toEqual({ text: "one\ntwo\n", kind: "line" });
});
it("clamps left shifts, preserves whitespace-only lines and keeps body tabs", () => {
  const state = keys("\tfoo\tx\n \t\n  bar", 0, ["V", "G", "9", "<"]);
  expect(state.text).toBe("foo\tx\n \t\nbar");
  expect(handleComposerVim(state, "u").state.text).toBe("\tfoo\tx\n \t\n  bar");
});
it("line yank records ownership while returning to the active endpoint and gv restores character type", () => {
  const result = handleComposerVim(keys("one\ntwo", 1, ["v", "j"]), "Y");
  expect(result.copy).toEqual({ text: "one\ntwo", kind: "line" });
  expect(result.state.cursor).toBe(5);
  expect(keys("one\ntwo", 1, ["v", "j", "Y", "g", "v"]).visualKind).toBe("character");
});
it("idle or canceled input leaves Visual selection and clipboard alone", () => {
  const selected = keys("abc", 0, ["v", "l"]);
  for (const key of ["\r", "\n", "\u0016", "\u0002", "H", "L", "|"]) {
    const result = handleComposerVim(selected, key);
    expect(result.state.text).toBe("abc");
    expect(result.state.mode).toBe("visual");
    expect(composerVisualSelection(result.state)).toEqual({ start: 0, end: 2, kind: "character" });
    expect(result.copy).toBeUndefined();
  }
  const pending = handleComposerVim(selected, "f").state;
  const result = handleComposerVim(pending, "z");
  expect(composerVisualSelection(result.state)).toEqual({ start: 0, end: 2, kind: "character" });
  expect(result.copy).toBeUndefined();
});
it("remaps a saved body selection through undoing indentation", () => {
  const state = keys("abc\ndef", 1, ["v", "j", ">", "u", "g", "v"]);
  expect(state.text).toBe("abc\ndef");
  expect(composerVisualSelection(state)).toEqual({ start: 1, end: 6, kind: "character" });
});
