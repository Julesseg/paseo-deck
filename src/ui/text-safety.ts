const escapeCharacter = String.fromCharCode(0x1b);
const sgr = new RegExp(`^${escapeCharacter}\\[[0-?]*[ -/]*m`);

/** Replaces control characters from timeline data with visible, inert glyphs. */
export function sanitizeTerminalText(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (character === "\n" || character === "\t") return character;
      if (code <= 0x1f) return String.fromCodePoint(0x2400 + code);
      if (code === 0x7f) return "␡";
      if (code >= 0x80 && code <= 0x9f) return "�";
      return character;
    })
    .join("");
}

/** Counts terminal cells, excluding only app-produced SGR styling. */
export function terminalDisplayWidth(value: string): number {
  return styledTokens(safeStyledText(value)).reduce((width, grapheme) => {
    return width + (isSgr(grapheme) ? 0 : graphemeWidth(grapheme));
  }, 0);
}

/** Splits untrusted timeline text into pane-safe physical lines. */
export function wrapTerminalText(value: string, width: number): string[] {
  const available = Math.max(1, width);
  return sanitizeTerminalText(value)
    .replaceAll("\t", "    ")
    .split("\n")
    .flatMap((line) => wrapLine(line, available));
}

/** Wraps app-owned explanatory copy at words, with hard wrapping for oversized words. */
export function wrapTerminalProse(value: string, width: number): string[] {
  const available = Math.max(1, width);
  return sanitizeTerminalText(value)
    .replaceAll("\t", "    ")
    .split("\n")
    .flatMap((line) => wrapProseLine(line, available));
}

/** Clips a rendered line while retaining safe ANSI styling created by the UI. */
export function clipTerminalLine(value: string, width: number, overflowSuffix = "…"): string {
  const available = Math.max(0, width);
  if (available === 0) return "";
  const tokens = styledTokens(safeStyledText(value).replaceAll("\n", " ").replaceAll("\t", "    "));
  let used = 0;
  let clipped = false;
  let result = "";
  let styled = false;
  for (const token of tokens) {
    if (isSgr(token)) {
      result += token;
      styled = true;
      continue;
    }
    const tokenWidth = graphemeWidth(token);
    if (used + tokenWidth > available) {
      clipped = true;
      break;
    }
    result += token;
    used += tokenWidth;
  }
  if (clipped) {
    const suffixWidth = terminalDisplayWidth(overflowSuffix);
    while (used + suffixWidth > available && result) {
      const tokens = styledTokens(result);
      const last = tokens.pop();
      if (last === undefined) break;
      result = tokens.join("");
      if (!isSgr(last)) used -= graphemeWidth(last);
    }
    if (suffixWidth <= available) result += overflowSuffix;
  }
  return styled ? `${result}\u001b[0m` : result;
}

function wrapLine(value: string, width: number): string[] {
  if (!value) return [""];
  return hardWrapLine(value, width);
}

function wrapProseLine(value: string, width: number): string[] {
  if (!value) return [""];
  const words = value.split(/(\s+)/).filter(Boolean);
  if (words.length > 1) return wrapWords(words, width);
  return hardWrapLine(value, width);
}

function wrapWords(words: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (/^\s+$/.test(word)) continue;
    const candidate = line ? `${line} ${word}` : word;
    if (terminalDisplayWidth(candidate) <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    const wrapped = hardWrapLine(word, width);
    line = wrapped.pop() ?? "";
    lines.push(...wrapped);
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

function hardWrapLine(value: string, width: number): string[] {
  if (!value) return [""];
  const lines: string[] = [];
  let line = "";
  let used = 0;
  for (const grapheme of graphemes(value)) {
    const cellWidth = graphemeWidth(grapheme);
    if (used > 0 && used + cellWidth > width) {
      lines.push(line);
      line = "";
      used = 0;
    }
    if (cellWidth > width) {
      lines.push(clipTerminalLine(grapheme, width));
      continue;
    }
    line += grapheme;
    used += cellWidth;
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

function safeStyledText(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const candidate = value.slice(index);
    const match = sgr.exec(candidate)?.[0];
    if (match) {
      result += match;
      index += match.length;
      continue;
    }
    const code = value.codePointAt(index) ?? 0;
    const character = String.fromCodePoint(code);
    result += sanitizeTerminalText(character);
    index += character.length;
  }
  return result;
}

function graphemes(value: string): string[] {
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value);
  return Array.from(segments, (segment) => segment.segment);
}

function styledTokens(value: string): string[] {
  const tokens: string[] = [];
  let remaining = value;
  while (remaining) {
    const match = sgr.exec(remaining)?.[0];
    if (match) {
      tokens.push(match);
      remaining = remaining.slice(match.length);
      continue;
    }
    const escapeIndex = remaining.indexOf(escapeCharacter);
    const plain = escapeIndex === -1 ? remaining : remaining.slice(0, escapeIndex);
    tokens.push(...graphemes(plain));
    remaining = escapeIndex === -1 ? "" : remaining.slice(escapeIndex);
  }
  return tokens;
}

function isSgr(value: string): boolean {
  return sgr.test(value);
}

function graphemeWidth(value: string): number {
  if (isZeroWidthGrapheme(value)) return 0;
  if (/\p{Regional_Indicator}/u.test(value) || /^[0-9#*]\ufe0f?\u20e3$/u.test(value)) return 2;
  if (/\p{Extended_Pictographic}/u.test(value) || value.includes("\u200d")) return 2;
  const code = value.codePointAt(0) ?? 0;
  return isWide(code) ? 2 : 1;
}

function isZeroWidthGrapheme(value: string): boolean {
  return [...value].every(
    (character) =>
      /\p{Mark}/u.test(character) ||
      character === "\u200d" ||
      character === "\ufe0e" ||
      character === "\ufe0f",
  );
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}
