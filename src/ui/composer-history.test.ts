import { expect, it } from "vitest";
import { createComposerVim, handleComposerVim, recallComposerPrompt } from "./composer-vim.js";

it("shares an Insert group with Normal undo and redo", () => {
  let state = handleComposerVim(createComposerVim("draft", 0), "i").state;
  state = handleComposerVim(state, "X").state;
  expect(state.text).toBe("Xdraft");
  state = handleComposerVim(state, "\u001a").state;
  expect(state.text).toBe("draft");
  state = handleComposerVim(state, "insert-redo").state;
  expect(state.text).toBe("Xdraft");
  state = handleComposerVim(state, "\u001b").state;
  state = handleComposerVim(state, "u").state;
  expect(state.text).toBe("draft");
});

it("edits grapheme characters and words in Insert and stops removed control aliases", () => {
  let state = { ...createComposerVim("😀é one two", 0), mode: "insert" as const, cursor: 4 };
  state = handleComposerVim(state, "insert-backspace").state as typeof state;
  expect(state.text).toBe("😀 one two");
  state = { ...state, cursor: state.text.length };
  state = handleComposerVim(state, "insert-delete-word-left").state as typeof state;
  expect(state.text).toBe("😀 one ");
  state = handleComposerVim(state, "insert-home").state as typeof state;
  state = handleComposerVim(state, "insert-delete-word-right").state as typeof state;
  expect(state.text).toBe(" one ");
  state = handleComposerVim(state, "insert-end").state as typeof state;
  expect(state.cursor).toBe(5);
  for (const key of ["\u000e", "\u0019", "\u001f", "\t", "\u0018", "\u0014"]) {
    expect(handleComposerVim(state, key).state.text).toBe(" one ");
  }
});

it("stops empty, newest and oldest prompt boundaries without wrapping", () => {
  const draft = createComposerVim("draft", 2);
  expect(recallComposerPrompt(draft, [], -1)).toBe(draft);
  expect(recallComposerPrompt(draft, ["sent"], 1)).toBe(draft);
  const recalled = recallComposerPrompt(draft, ["sent"], -1);
  expect(recallComposerPrompt(recalled, ["sent"], -1)).toBe(recalled);
  const restored = recallComposerPrompt(recalled, ["sent"], 1);
  expect(restored).toMatchObject({ text: "draft", cursor: 2 });
  expect(recallComposerPrompt(restored, ["sent"], 1)).toBe(restored);
});
