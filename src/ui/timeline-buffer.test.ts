import { describe, expect, it } from "vitest";
import {
  createTimelineBuffer,
  enterTimelineVisual,
  findTimelineCharacter,
  leaveTimelineVisual,
  moveTimelineBuffer,
  moveTimelineViewport,
  osc52,
  printableTimelineText,
  replaceTimelineBuffer,
  searchTimelineBuffer,
  searchTimelineWord,
  selectedTimelineText,
  selectTimelineTextRange,
  timelineTextObjectRange,
  timelineTextObjectText,
  timelineWordAtCursor,
  toggleTimelineFold,
} from "./timeline-buffer.js";

describe("rendered timeline buffer", () => {
  it("moves over wrapped lines and supports Vim boundaries and words", () => {
    let state = createTimelineBuffer({ lines: ["wrapped text", "second line"] });
    state = moveTimelineBuffer(state, "G");
    expect(state.line).toBe(1);
    state = moveTimelineBuffer(state, "0");
    expect(state.column).toBe(0);
    state = moveTimelineBuffer(state, "w");
    expect(state.column).toBe(7);
    state = moveTimelineBuffer(state, "gg");
    expect(state).toMatchObject({ line: 0, column: 0 });
  });

  it("selects characters or complete lines without changing source text", () => {
    const normal = createTimelineBuffer({ lines: ["hello", "wide 世界"] });
    const visual = moveTimelineBuffer(enterTimelineVisual(normal, "line"), "G");
    expect(selectedTimelineText(visual)).toBe("hello\nwide 世界");
    expect(leaveTimelineVisual(visual)).toMatchObject({ mode: "normal", line: 1 });
  });

  it("searches sanitized rendered text and toggles disclosure folds", () => {
    let state = createTimelineBuffer({ lines: ["Markdown **one**", "tool output"] });
    state = searchTimelineBuffer(state, "OUTPUT");
    expect(state).toMatchObject({ line: 1, column: 5 });
    expect(toggleTimelineFold(state).folded.has(1)).toBe(true);
  });

  it("searches repeated matches on the current line in both directions and wraps", () => {
    const state = createTimelineBuffer({ lines: ["one one one", "two"] });
    const first = searchTimelineBuffer(state, "one");
    expect(first).toMatchObject({ line: 0, column: 4 });
    const second = searchTimelineBuffer(first, "one");
    expect(second).toMatchObject({ line: 0, column: 8 });
    expect(searchTimelineBuffer(second, "one")).toMatchObject({ line: 0, column: 0 });
    expect(searchTimelineBuffer(state, "one", -1)).toMatchObject({ line: 0, column: 8 });
  });

  it("searches the word under the cursor with whole-word matches", () => {
    const state = createTimelineBuffer({ lines: ["cat category cat", "catfish"] });
    expect(timelineWordAtCursor(state)).toBe("cat");
    expect(searchTimelineWord(state, "*")).toMatchObject({ line: 0, column: 13 });
    expect(searchTimelineWord(state, "#")).toMatchObject({ line: 0, column: 13 });
    const next = searchTimelineWord(state, "*");
    expect(searchTimelineBuffer(next, "cat")).toMatchObject({ line: 0, column: 0 });
  });

  it("preserves meaningful streaming position and a Visual selection through reflow", () => {
    const state = enterTimelineVisual(createTimelineBuffer({ lines: ["stable", "old"] }));
    expect(replaceTimelineBuffer(state, ["stable", "new"])).toMatchObject({
      mode: "visual",
      line: 0,
    });
    expect(replaceTimelineBuffer(state, ["new history"])).toMatchObject({
      mode: "visual",
      line: 0,
    });
  });

  it("does not jump to the first repeated line when history grows", () => {
    const state = createTimelineBuffer({ lines: ["same", "middle", "same"], line: 2 });
    expect(replaceTimelineBuffer(state, ["same", "middle", "same", "new"]).line).toBe(2);
  });

  it("moves by visible characters through styled lines and remembers the wanted column", () => {
    let state = createTimelineBuffer({
      lines: ["\u001b[31malphabet\u001b[0m", "x", "\u001b[32msecond line\u001b[0m"],
      column: 6,
    });
    state = moveTimelineBuffer(state, "j");
    expect(state).toMatchObject({ line: 1, column: 0 });
    state = moveTimelineBuffer(state, "j");
    expect(state).toMatchObject({ line: 2, column: 6 });
    state = moveTimelineBuffer(state, "l");
    expect(state.column).toBe(7);
  });

  it("uses word, character-find, bracket, and counted line motions", () => {
    const initial = createTimelineBuffer({ lines: ["  alpha (beta)", "x", "  gamma delta"] });
    expect(moveTimelineBuffer(initial, "^").column).toBe(2);
    expect(moveTimelineBuffer(initial, "w")).toMatchObject({ line: 0, column: 2 });
    expect(moveTimelineBuffer(initial, "W", 2)).toMatchObject({ line: 0, column: 8 });
    expect(moveTimelineBuffer(initial, "G", 2).line).toBe(1);
    expect(moveTimelineBuffer(initial, "gg", 3).line).toBe(2);
    expect(moveTimelineBuffer(initial, "|", 4).column).toBe(3);
    const opening = findTimelineCharacter(initial, "f", "(");
    expect(opening.column).toBe(8);
    expect(moveTimelineBuffer(opening, "%").column).toBe(13);
    expect(findTimelineCharacter(opening, "t", ")").column).toBe(12);
    expect(moveTimelineBuffer(moveTimelineBuffer(initial, "G"), "b")).toMatchObject({
      line: 2,
      column: 8,
    });
  });

  it("moves words across rendered line boundaries", () => {
    const initial = createTimelineBuffer({ lines: ["one", "  two three"] });
    const next = moveTimelineBuffer(initial, "w");
    expect(next).toMatchObject({ line: 1, column: 2 });
    expect(moveTimelineBuffer(next, "b")).toMatchObject({ line: 0, column: 0 });
    expect(moveTimelineBuffer(next, "e")).toMatchObject({ line: 1, column: 4 });
    expect(moveTimelineBuffer(moveTimelineBuffer(next, "w"), "ge")).toMatchObject({
      line: 1,
      column: 4,
    });
  });

  it("yanks printable text through OSC 52 without ANSI controls", () => {
    const text = printableTimelineText(
      "\u001b[31mhello\u001b[0m\u001b]8;;url\u0007link\u001b]8;;\u001b\\",
    );
    expect(text).toBe("hellolink");
    expect(osc52("hello")).toBe("\u001b]52;c;aGVsbG8=\u0007");
  });

  it("moves by sentences, paragraphs, last nonblank, and rejects file percentage", () => {
    const lines = ["One. Two!", "  Three?", "", "Fourth sentence.", "  end  "];
    const initial = createTimelineBuffer({ lines });
    expect(moveTimelineBuffer(initial, ")", 2)).toMatchObject({ line: 1, column: 2 });
    expect(moveTimelineBuffer(createTimelineBuffer({ lines, line: 3 }), "(")).toMatchObject({
      line: 1,
      column: 2,
    });
    expect(moveTimelineBuffer(initial, "}")).toMatchObject({ line: 2, column: 0 });
    expect(moveTimelineBuffer(createTimelineBuffer({ lines, line: 4 }), "{")).toMatchObject({
      line: 2,
      column: 0,
    });
    expect(moveTimelineBuffer(initial, "%", 50).line).toBe(0);
    expect(moveTimelineBuffer(createTimelineBuffer({ lines, line: 4 }), "g_").column).toBe(4);
  });

  it("moves to viewport landmarks, respecting counts", () => {
    const state = createTimelineBuffer({ lines: Array.from({ length: 12 }, (_, i) => `  ${i}`) });
    expect(moveTimelineViewport(state, "H", 3, 5)).toMatchObject({ line: 3, column: 2 });
    expect(moveTimelineViewport(state, "M", 3, 5)).toMatchObject({ line: 5, column: 2 });
    expect(moveTimelineViewport(state, "L", 3, 5, 2)).toMatchObject({ line: 6, column: 2 });
    expect(moveTimelineBuffer(state, "gj", 2).line).toBe(2);
    expect(moveTimelineBuffer(state, "gk", 2).line).toBe(0);
    expect(moveTimelineBuffer(state, "gm").column).toBe(1);
  });

  it("moves between first-column section starts and ends", () => {
    const lines = ["{", "body", "}", "{", "body", "}", "tail"];
    const state = createTimelineBuffer({ lines, line: 3 });
    expect(moveTimelineBuffer(state, "[[").line).toBe(0);
    expect(moveTimelineBuffer(state, "]]").line).toBe(3);
    expect(moveTimelineBuffer(state, "[]").line).toBe(2);
    expect(moveTimelineBuffer(state, "][", 2).line).toBe(5);
  });

  it("repeats character finds forward and backward with counts", () => {
    const state = createTimelineBuffer({ lines: ["a,b,c,d,e"] });
    const first = findTimelineCharacter(state, "f", ",");
    expect(moveTimelineBuffer(first, ";", 2).column).toBe(5);
    const third = moveTimelineBuffer(first, ";", 2);
    expect(moveTimelineBuffer(third, ",").column).toBe(3);
    expect(findTimelineCharacter(state, "t", "d").column).toBe(5);
    const till = findTimelineCharacter(createTimelineBuffer({ lines: ["x.a.a.a"] }), "t", "a");
    expect(till.column).toBe(1);
    expect(moveTimelineBuffer(till, ";").column).toBe(3);
  });

  it("resolves word and WORD objects in rendered text", () => {
    const state = createTimelineBuffer({ lines: ["alpha-one  two"], column: 2 });
    const inner = timelineTextObjectRange(state, "w");
    const around = timelineTextObjectRange(state, "w", true);
    const big = timelineTextObjectRange(state, "W");
    expect(inner && timelineTextObjectText(state, inner)).toBe("alpha");
    expect(around && timelineTextObjectText(state, around)).toBe("alpha");
    expect(big && timelineTextObjectText(state, big)).toBe("alpha-one");
    const visual = inner && selectTimelineTextRange(state, inner);
    expect(visual && selectedTimelineText(visual)).toBe("alpha");
  });

  it("resolves nested delimiters and quoted text objects", () => {
    const state = createTimelineBuffer({
      lines: ['outside (one [two] three) "quoted"'],
      column: 15,
    });
    const brackets = timelineTextObjectRange(state, "[");
    const parens = timelineTextObjectRange(state, "(", true);
    expect(brackets && timelineTextObjectText(state, brackets)).toBe("two");
    expect(parens && timelineTextObjectText(state, parens)).toBe("(one [two] three)");
    const quote = createTimelineBuffer({ lines: state.lines, column: 28 });
    const quoted = timelineTextObjectRange(quote, '"');
    expect(quoted && timelineTextObjectText(quote, quoted)).toBe("quoted");
  });

  it("moves to the end of the previous word with ge and gE", () => {
    const state = createTimelineBuffer({ lines: ["alpha-one two"], column: 11 });
    expect(moveTimelineBuffer(state, "ge").column).toBe(8);
    expect(moveTimelineBuffer(state, "gE").column).toBe(8);
    expect(
      moveTimelineBuffer(createTimelineBuffer({ lines: state.lines, column: 12 }), "ge", 2).column,
    ).toBe(5);
  });

  it("resolves sentence and paragraph text objects", () => {
    const state = createTimelineBuffer({ lines: ["First. Second!", "", "Third paragraph."] });
    const sentence = timelineTextObjectRange(state, "s");
    expect(sentence && timelineTextObjectText(state, sentence)).toBe("First.");
    const paragraph = timelineTextObjectRange(state, "p", true);
    expect(paragraph && timelineTextObjectText(state, paragraph)).toBe("First. Second!\n");
    const visual = paragraph && selectTimelineTextRange(state, paragraph);
    expect(visual && selectedTimelineText(visual)).toBe("First. Second!\n");
  });
});
