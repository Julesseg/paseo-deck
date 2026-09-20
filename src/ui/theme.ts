import type { PaletteId, TerminalAppearance } from "./capabilities.js";
import { clipTerminalLine, sanitizeTerminalText, terminalDisplayWidth } from "./text-safety.js";

export type SemanticTone =
  | "focus"
  | "selection"
  | "running"
  | "attention"
  | "permission"
  | "failure"
  | "stale"
  | "muted"
  | "border"
  | "header"
  | "code";

export type DeckGlyph =
  | "agent"
  | "expanded"
  | "collapsed"
  | "permission"
  | "attention"
  | "running"
  | "failure"
  | "bullet"
  | "divider"
  | "ellipsis"
  | "end";

const ansi16: Readonly<Record<SemanticTone, number>> = {
  focus: 36,
  selection: 33,
  running: 36,
  attention: 33,
  permission: 35,
  failure: 31,
  stale: 33,
  muted: 90,
  border: 90,
  header: 37,
  code: 36,
};

const ansi256: Readonly<Record<SemanticTone, number>> = {
  focus: 109,
  selection: 215,
  running: 109,
  attention: 214,
  permission: 176,
  failure: 203,
  stale: 180,
  muted: 245,
  border: 245,
  header: 223,
  code: 151,
};

const truecolor: Readonly<Record<SemanticTone, readonly [number, number, number]>> = {
  focus: [125, 211, 252],
  selection: [251, 191, 36],
  running: [110, 231, 183],
  attention: [251, 191, 36],
  permission: [216, 180, 254],
  failure: [252, 165, 165],
  stale: [253, 230, 138],
  muted: [168, 162, 158],
  border: [120, 113, 108],
  header: [245, 245, 244],
  code: [134, 239, 172],
};

const unicodeGlyphs: Readonly<Record<DeckGlyph, string>> = {
  agent: "•",
  expanded: "▾",
  collapsed: "▸",
  permission: "✓",
  attention: "!",
  running: "…",
  failure: "×",
  bullet: "·",
  divider: "─",
  ellipsis: "…",
  end: "↓",
};
const asciiGlyphs: Readonly<Record<DeckGlyph, string>> = {
  agent: "*",
  expanded: "v",
  collapsed: ">",
  permission: "[P]",
  attention: "[!]",
  running: "...",
  failure: "[x]",
  bullet: "-",
  divider: "-",
  ellipsis: "...",
  end: "v",
};

/** Semantic styling boundary. It sanitizes content before adding only its own SGR. */
export class DeckTheme {
  constructor(private _appearance: TerminalAppearance) {}
  get appearance(): TerminalAppearance {
    return this._appearance;
  }
  setAppearance(appearance: TerminalAppearance): void {
    this._appearance = appearance;
  }

  /** Styles a Deck-owned label after making it inert and normalising its symbols. */
  style(tone: SemanticTone, value: string): string {
    return this.styleRendered(tone, this.label(sanitizeTerminalText(value)));
  }

  /** Styles remote text after sanitising it, without transliterating its content. */
  styleRemote(tone: SemanticTone, value: string): string {
    return this.styleRendered(tone, sanitizeTerminalText(value));
  }

  /** Styles a semantic background while retaining the same safety boundary. */
  styleBackground(tone: SemanticTone, value: string): string {
    const safe = this.label(sanitizeTerminalText(value));
    if (this.appearance.color === "none" || this.appearance.theme === "plain") return safe;
    return `${this.backgroundPrefix(tone)}${safe}\u001b[0m`;
  }

  /**
   * Styles trusted internal render output without sanitising it again. Callers
   * must only pass Deck-generated text or Markdown sourced through the
   * TimelineItemView sanitisation boundary.
   */
  styleRendered(tone: SemanticTone, value: string): string {
    const safe = value;
    if (this.appearance.color === "none" || this.appearance.theme === "plain") return safe;
    const prefix = this.prefix(tone);
    return `${prefix}${safe}\u001b[0m`;
  }

  glyph(name: DeckGlyph): string {
    return (this.appearance.symbols === "unicode" ? unicodeGlyphs : asciiGlyphs)[name];
  }

  /** Applies the conservative symbol set to UI labels after text is made inert. */
  label(value: string): string {
    if (this.appearance.symbols === "unicode") return value;
    return value
      .replaceAll("→", "->")
      .replaceAll("←", "<-")
      .replaceAll("↑", "Up")
      .replaceAll("↓", "Down")
      .replaceAll("·", asciiGlyphs.bullet)
      .replaceAll("…", asciiGlyphs.ellipsis)
      .replaceAll("─", asciiGlyphs.divider)
      .replaceAll("✓", asciiGlyphs.permission)
      .replaceAll("▾", asciiGlyphs.expanded)
      .replaceAll("▸", asciiGlyphs.collapsed)
      .replaceAll("•", asciiGlyphs.agent);
  }

  /** Clips Deck-owned labels after applying the requested symbol set. */
  clipOwnedLabel(value: string, width: number): string {
    const safe = this.label(sanitizeTerminalText(value));
    if (terminalDisplayWidth(safe) <= width) return safe;
    const suffix = this.glyph("ellipsis");
    const available = Math.max(0, width - terminalDisplayWidth(suffix));
    let result = "";
    for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      safe,
    )) {
      if (terminalDisplayWidth(result + segment.segment) > available) break;
      result += segment.segment;
    }
    return clipTerminalLine(`${result}${suffix}`, width, suffix);
  }

  /** Clips remote content without changing any of its printable characters. */
  clipRemoteText(value: string, width: number): string {
    return clipTerminalLine(sanitizeTerminalText(value), width, this.glyph("ellipsis"));
  }

  /** Clips already-safe mixed chrome and remote content without transliteration. */
  clipRendered(value: string, width: number): string {
    return clipTerminalLine(value, width, this.glyph("ellipsis"));
  }

  private prefix(tone: SemanticTone): string {
    const palette = this.paletteId();
    if (palette === "terminal") return `\u001b[${ansi16[tone]}m`;
    if (this.appearance.color === "ansi16")
      return `\u001b[${ansi16[tone]}m`;
    if (this.appearance.color === "ansi256") return `\u001b[38;5;${ansi256[tone]}m`;
    const [red, green, blue] = truecolor[tone];
    return `\u001b[38;2;${red};${green};${blue}m`;
  }

  private backgroundPrefix(tone: SemanticTone): string {
    const palette = this.paletteId();
    if (palette === "terminal") return `\u001b[${ansi16[tone] + 10}m`;
    if (this.appearance.color === "ansi16") {
      const foreground = ansi16[tone];
      return `\u001b[${foreground + 10}m`;
    }
    if (this.appearance.color === "ansi256") return `\u001b[48;5;${ansi256[tone]}m`;
    const [red, green, blue] = truecolor[tone];
    return `\u001b[48;2;${red};${green};${blue}m`;
  }

  private paletteId(): PaletteId {
    return this.appearance.palette ?? "ember";
  }
}
