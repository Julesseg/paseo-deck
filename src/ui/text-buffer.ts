/** UTF-16 offsets at grapheme boundaries, shared by editable and read-only buffers. */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function characterOffsets(text: string): number[] {
  return [...segmenter.segment(text)].map((part) => part.index).concat(text.length);
}
export function characterStep(text: string, offset: number, amount: number): number {
  const offsets = characterOffsets(text);
  const current = Math.max(
    0,
    offsets.findLastIndex((value) => value <= offset),
  );
  return offsets[Math.max(0, Math.min(offsets.length - 1, current + amount))] ?? 0;
}
export function isCharacter(text: string): boolean {
  return !/[\p{Cc}\p{Cs}]/u.test(text) && [...segmenter.segment(text)].length === 1;
}
export interface DelimiterPair {
  readonly start: number;
  readonly end: number;
  readonly open: string;
}
/** Quotes are line-local and escaped quotes do not delimit. Brackets nest across lines.
 * Crossed brackets invalidate the open stack rather than inventing a complete pair. */
export function completeDelimiterPairs(text: string): DelimiterPair[] {
  const pairs: DelimiterPair[] = [];
  const stack: { start: number; open: string }[] = [];
  const close: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };
  let quote: { start: number; open: string } | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    if (char === "\n") quote = undefined;
    let escapes = 0;
    for (let before = index - 1; before >= 0 && text[before] === "\\"; before--) escapes++;
    if (escapes % 2) continue;
    if (quote) {
      if (char === quote.open) {
        quote = undefined;
      }
      continue;
    }
    if ("\"'`".includes(char)) {
      quote = { start: index, open: char };
      continue;
    }
    if ("([{<".includes(char)) stack.push({ start: index, open: char });
    else if (close[char]) {
      const top = stack.pop();
      if (top?.open === close[char]) pairs.push({ ...top, end: index });
      else stack.length = 0;
    }
  }
  for (const open of "\"'`") {
    let start: number | undefined;
    for (let index = 0; index < text.length; index++) {
      if (text[index] === "\n") start = undefined;
      if (text[index] !== open) continue;
      let escapes = 0;
      for (let before = index - 1; before >= 0 && text[before] === "\\"; before--) escapes++;
      if (escapes % 2) continue;
      if (start === undefined) start = index;
      else {
        pairs.push({ start, end: index, open });
        start = undefined;
      }
    }
  }
  return pairs;
}
export function nearestDelimiterObject(
  text: string,
  at: number,
  object: string,
  around: boolean,
): { start: number; end: number } | undefined {
  const explicit: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<", B: "{" };
  const open = explicit[object] ?? object;
  const candidates = completeDelimiterPairs(text).filter((pair) =>
    object === "q"
      ? "\"'`".includes(pair.open)
      : object === "b"
        ? "([{<".includes(pair.open)
        : pair.open === open,
  );
  const distance = (pair: DelimiterPair) =>
    at < pair.start ? pair.start - at : at > pair.end ? at - pair.end : 0;
  candidates.sort(
    (a, b) => distance(a) - distance(b) || a.end - a.start - (b.end - b.start) || a.start - b.start,
  );
  const pair = candidates[0];
  return pair
    ? { start: pair.start + (around ? 0 : 1), end: pair.end + (around ? 1 : 0) }
    : undefined;
}

export type CharacterFind = { readonly key: "f" | "F" | "t" | "T"; readonly character: string };
/** Return an explicit missing result. Counts never return a partially resolved find. */
export function findTextCharacter(
  text: string,
  at: number,
  find: CharacterFind,
  count = 1,
  repeat = false,
): number | undefined {
  if (!isCharacter(find.character)) return undefined;
  const forward = find.key === "f" || find.key === "t";
  const start = at <= 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1;
  const newline = text.indexOf("\n", at);
  const end = newline < 0 ? text.length : newline;
  let cursor =
    repeat && (find.key === "t" || find.key === "T")
      ? characterStep(text, at, forward ? 1 : -1)
      : at;
  for (let index = 0; index < Math.max(1, count); index++) {
    if (!forward && cursor <= start) return undefined;
    const next = forward
      ? text.indexOf(find.character, characterStep(text, cursor, 1))
      : text.lastIndexOf(find.character, cursor - 1);
    if (next < start || next >= end || next < 0) return undefined;
    cursor = next;
  }
  return find.key === "t"
    ? characterStep(text, cursor, -1)
    : find.key === "T"
      ? characterStep(text, cursor, 1)
      : cursor;
}
