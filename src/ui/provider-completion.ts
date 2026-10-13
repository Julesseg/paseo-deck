import type { ProviderCommand } from "../contracts/gateway.js";
import type { ComposerVimState } from "./composer-vim.js";
import { finishComposerInsert } from "./composer-vim.js";

export interface CompletionReference {
  start: number;
  end: number;
  query: string;
}

export function completionReference(text: string, cursor: number): CompletionReference | undefined {
  let start = cursor;
  while (start > 0 && !/\s/u.test(text[start - 1] ?? "")) start--;
  if (
    text[start] !== "/" ||
    cursor <= start ||
    (start > 0 && text[start - 1] !== " " && text[start - 1] !== "\n")
  )
    return;
  let end = cursor;
  while (end < text.length && !/\s/u.test(text[end] ?? "")) end++;
  if (text.slice(start + 1, end).includes("/")) return;
  return { start, end, query: text.slice(start + 1, cursor) };
}

export function completionItems(
  items: readonly ProviderCommand[],
  reference: CompletionReference,
): readonly ProviderCommand[] {
  const query = reference.query.toLocaleLowerCase();
  return items.filter((item) => {
    if (reference.start !== 0 && item.kind !== "skill") return false;
    let at = 0;
    for (const character of item.name.toLocaleLowerCase()) if (character === query[at]) at++;
    return at === query.length;
  });
}

export function acceptCompletion(
  state: ComposerVimState,
  reference: CompletionReference,
  name: string,
): ComposerVimState {
  const before = finishComposerInsert(state);
  const reuse = before.text[reference.end] === " ";
  const insertion = `/${name} `;
  return {
    ...before,
    text:
      before.text.slice(0, reference.start) +
      insertion +
      before.text.slice(reference.end + (reuse ? 1 : 0)),
    cursor: reference.start + insertion.length,
    mode: "insert",
    historyIndex: undefined,
    historyDraft: undefined,
    undo: [...before.undo, { text: before.text, cursor: before.cursor }],
    redo: [],
  };
}
