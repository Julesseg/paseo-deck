import { describe, expect, it } from "vitest";
import {
  createTimelineBuffer,
  enterTimelineVisual,
  findTimelineCharacter,
  leaveTimelineVisual,
  moveTimelineBuffer,
  osc52,
  printableTimelineText,
  replaceTimelineBuffer,
  searchTimelineBuffer,
  selectedTimelineText,
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

  it("yanks a rectangular Visual Block selection", () => {
    const state = moveTimelineBuffer(
      enterTimelineVisual(createTimelineBuffer({ lines: ["abcdef", "abXYZf"] }), "block"),
      "j",
    );
    const selected = moveTimelineBuffer(state, "l", 3);
    expect(selectedTimelineText(selected)).toBe("abcd\nabXY");
  });

  it("yanks printable text through OSC 52 without ANSI controls", () => {
    const text = printableTimelineText(
      "\u001b[31mhello\u001b[0m\u001b]8;;url\u0007link\u001b]8;;\u001b\\",
    );
    expect(text).toBe("hellolink");
    expect(osc52("hello")).toBe("\u001b]52;c;aGVsbG8=\u0007");
  });
});
