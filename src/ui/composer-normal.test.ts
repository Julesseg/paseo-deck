import { describe, expect, it } from "vitest";
import { applyComposerPaste, createComposerVim, handleComposerVim } from "./composer-vim.js";

function keys(text: string, cursor: number, sequence: string[]) {
  return sequence.reduce(
    (state, key) => handleComposerVim(state, key).state,
    createComposerVim(text, cursor),
  );
}
function result(text: string, cursor: number, sequence: string[]) {
  let result = { state: createComposerVim(text, cursor), handled: true } as ReturnType<
    typeof handleComposerVim
  >;
  for (const key of sequence) result = handleComposerVim(result.state, key);
  return result;
}
describe("reviewed Composer Normal targets", () => {
  it("matches delimiters with bare percent and cancels numbered percent", () => {
    expect(keys("(one)\ntwo", 0, ["%"]).cursor).toBe(4);
    expect(keys("(one)\ntwo", 0, ["2", "%"]).cursor).toBe(0);
  });
  it("uses caret for underscore and inclusive counted last nonblank aliases", () => {
    expect(keys("  one two  ", 6, ["d", "_"]).text).toBe("  two  ");
    expect(keys("one  \ntwo  \nthree", 0, ["2", "g", "_"]).cursor).toBe(8);
    expect(keys("one  ", 0, ["d", "g", "_"]).text).toBe("  ");
    expect(result("one two", 5, ["y", "g", "E"]).copy?.text).toBe("e tw");
  });
  it("finds nearest complete pairs outside them, nested pairs and empty changes", () => {
    expect(keys('before "one" after', 0, ["d", "i", "q"]).text).toBe('before "" after');
    expect(keys("before [one] after", 0, ["d", "a", "b"]).text).toBe("before  after");
    expect(keys("(outer [inner])", 9, ["d", "i", "b"]).text).toBe("(outer [])");
    expect(keys("()", 0, ["c", "i", "b"])).toMatchObject({ text: "()", mode: "insert", cursor: 1 });
    expect(keys("broken (thing", 0, ["c", "i", "b"])).toMatchObject({
      text: "broken (thing",
      mode: "normal",
      cursor: 0,
    });
    expect(keys('"one"', 0, ["2", "d", "i", "q"]).text).toBe('"one"');
  });
  it("keeps failed counted finds atomic and repeats till beyond its prior match", () => {
    expect(keys("a x b", 0, ["2", "f", "x"]).cursor).toBe(0);
    expect(keys("a x b", 0, ["c", "2", "f", "x"])).toMatchObject({
      text: "a x b",
      cursor: 0,
      mode: "normal",
    });
    expect(keys("a x b x c", 0, ["t", "x", ";"]).cursor).toBe(5);
    expect(keys("a x b x c", 0, ["f", "x", "d", ";"]).text).toBe("a  c");
  });
  it("edits graphemes without splitting emoji or combining marks and replacement stays on its line", () => {
    expect(keys("😀éx", 0, ["l"]).cursor).toBe(2);
    expect(keys("😀éx", 0, ["x"]).text).toBe("éx");
    expect(keys("😀éx", 2, ["X"]).text).toBe("éx");
    expect(keys("😀éx", 0, ["2", "r", "🦊"]).text).toBe("🦊🦊x");
    expect(keys("ab\ncd", 1, ["2", "r", "x"]).text).toBe("ab\ncd");
  });
  it("multiplies motion counts and applies counted line edits and ordinary join counts once", () => {
    expect(keys("a b c d e f g", 0, ["2", "d", "3", "w", "u"]).text).toBe("a b c d e f g");
    expect(keys("a b c d e f g", 0, ["2", "d", "3", "w"]).text).toBe("g");
    expect(keys("one\ntwo\nthree", 1, ["2", "D"]).text).toBe("o\nthree");
    expect(result("one\ntwo\nthree", 0, ["2", "Y"]).copy?.text).toBe("one\ntwo\n");
    expect(keys("one\n  two\nthree", 0, ["2", "J"]).text).toBe("one two\nthree");
  });
  it("cancels excluded/count-unsupported commands and composes section operators", () => {
    for (const sequence of [
      ["2", "i"],
      ["2", "^"],
      ["1", "d", "%"],
      ["g", "m"],
      ["H"],
      ["+"],
      ["|"],
      ["m"],
      ["\u000f"],
    ])
      expect(keys("  one\n{\ntwo\n}\nthree", 3, sequence)).toMatchObject({
        text: "  one\n{\ntwo\n}\nthree",
        cursor: 3,
        mode: "normal",
      });
    expect(keys("one\n{\ntwo\n}\nthree", 0, ["d", "]", "]"]).text).toBe("{\ntwo\n}\nthree");
  });
  it("requests fresh clipboard for paste and inserts owned lines above/below with one undo", () => {
    const state = createComposerVim("one\ntwo", 0);
    const request = handleComposerVim(handleComposerVim(state, "2").state, "p");
    expect(request.paste).toEqual({ before: false, count: 2 });
    expect(request.state.text).toBe(state.text);
    expect(applyComposerPaste(request.state, "X\n", "line", { before: false, count: 2 }).text).toBe(
      "one\nX\nX\ntwo",
    );
    expect(applyComposerPaste(state, "X\n", "character", { before: true, count: 1 }).text).toBe(
      "X\none\ntwo",
    );
    expect(
      applyComposerPaste(createComposerVim("one"), "last", "line", { before: false, count: 1 })
        .text,
    ).toBe("one\nlast");
    expect(
      applyComposerPaste(createComposerVim(""), "last\n", "line", { before: false, count: 1 }).text,
    ).toBe("last\n");
  });
});

it("keeps changed whole lines separate and treats g line aliases like their plain forms", () => {
  expect(keys("one\ntwo\nthree", 0, ["c", "c"])).toMatchObject({
    text: "\ntwo\nthree",
    mode: "insert",
    cursor: 0,
  });
  expect(keys("one\ntwo\nthree", 0, ["d", "g", "j"]).text).toBe("three");
  expect(keys("one\ntwo\nthree", 6, ["d", "g", "g"]).text).toBe("three");
  expect(keys("one two", 0, ["c", "w"])).toMatchObject({ text: " two", mode: "insert" });
});

it("uses word classes for punctuation and whitespace objects and Unicode word endpoints", () => {
  expect(keys("one... two", 4, ["d", "i", "w"]).text).toBe("one two");
  expect(keys("one   two", 4, ["d", "i", "w"]).text).toBe("onetwo");
  expect(keys("😀😀 x", 0, ["e"]).cursor).toBe(2);
  expect(keys("😀😀 x", 0, ["d", "e"]).text).toBe(" x");
});

it("preserves cursor and clipboard for absent sections and crossed delimiter targets", () => {
  expect(keys("plain text", 4, ["]", "]"]).cursor).toBe(4);
  expect(keys("plain text", 4, ["c", "]", "]"])).toMatchObject({
    text: "plain text",
    cursor: 4,
    mode: "normal",
  });
  expect(keys("([)]", 0, ["%"]).cursor).toBe(0);
  expect(keys("first\nsecond\n\nthird", 0, ["d", "i", "p"]).text).toBe("\nthird");
});

it("keeps newline and grapheme boundaries through joins, case changes and counted undo", () => {
  expect(keys("one \n  two", 0, ["J"]).text).toBe("one two");
  expect(keys("one\n\nthree", 0, ["J"]).text).toBe("one\nthree");
  expect(keys("éX", 0, ["~"]).text).toBe("ÉX");
  expect(keys("abc", 0, ["x", "x", "2", "u"]).text).toBe("abc");
  expect(keys("\none", 0, ["d", "d"]).text).toBe("one");
  expect(keys("abc", 0, ["d", "F", "a"]).text).toBe("abc");
});

it("includes the final word character when a forward word operator reaches EOF", () => {
  expect(keys("last", 0, ["d", "w"]).text).toBe("");
  expect(keys("one two", 0, ["2", "d", "w"]).text).toBe("");
  expect(keys("x", 0, ["d", "e"]).text).toBe("");
});

it("accepts the reviewed character and line aliases after operators", () => {
  expect(keys("abc", 0, ["d", " "]).text).toBe("bc");
  expect(keys("abc", 2, ["d", "\u007f"]).text).toBe("ac");
  expect(keys("one\ntwo\nthree", 0, ["d", "\u001b[B"]).text).toBe("three");
});

it("removes the preceding line separator when deleting the final complete line", () => {
  expect(result("one\ntwo", 4, ["d", "d"])).toMatchObject({
    state: { text: "one" },
    copy: { text: "two", kind: "line" },
  });
  expect(keys("one\ntwo", 4, ["c", "c"])).toMatchObject({
    text: "one\n",
    mode: "insert",
    cursor: 4,
  });
});

it("chooses the nearest complete quote type, including nested other quote types and escaped quotes", () => {
  expect(keys(`"outer 'inner' end"`, 9, ["d", "i", "q"]).text).toBe(`"outer '' end"`);
  expect(keys('before "a\\"b" after', 0, ["d", "i", "q"]).text).toBe('before "" after');
});

it("does not overwrite clipboard or enter Insert for an empty motion range", () => {
  expect(result("one", 0, ["c", "^"])).toMatchObject({
    state: { text: "one", cursor: 0, mode: "normal" },
  });
  expect(result("one", 0, ["c", "^"]).copy).toBeUndefined();
  expect(result("one", 0, ["X"]).copy).toBeUndefined();
  expect(result("()", 0, ["c", "i", "b"])).toMatchObject({
    state: { mode: "insert" },
    copy: { text: "", kind: "character" },
  });
});
