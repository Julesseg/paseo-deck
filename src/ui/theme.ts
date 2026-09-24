import type { PaletteId, TerminalAppearance, TerminalBackground } from "./capabilities.js";
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

/** Background layers are intentionally separate from semantic foreground hues. */
export type BackgroundTone =
  | "sidebar"
  | "tab-inactive"
  | "tab-active"
  | "active-session"
  | "composer"
  | "selection";

export type DeckGlyph =
  | "agent"
  | "draft"
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

// These are restrained overlays over Ember's dark terminal ground, rather than
// independent panel colours. The small steps preserve hierarchy without making
// the interface feel like a collection of coloured cards.
const emberBackground: Readonly<Record<BackgroundTone, readonly [number, number, number]>> = {
  sidebar: [31, 29, 27],
  "tab-inactive": [55, 51, 47],
  "tab-active": [101, 69, 43],
  "active-session": [45, 42, 37],
  composer: [39, 36, 33],
  selection: [51, 46, 39],
};
const emberBackground256: Readonly<Record<BackgroundTone, number>> = {
  sidebar: 235,
  "tab-inactive": 237,
  "tab-active": 240,
  "active-session": 238,
  composer: 237,
  selection: 239,
};
const emberBackground16: Readonly<Record<BackgroundTone, number>> = {
  sidebar: 40,
  "tab-inactive": 100,
  "tab-active": 43,
  "active-session": 40,
  composer: 100,
  selection: 100,
};
const surfaceOpacity: Readonly<Record<BackgroundTone, number>> = {
  sidebar: 0.035,
  "tab-inactive": 0.16,
  "tab-active": 0.32,
  "active-session": 0.075,
  composer: 0.06,
  selection: 0.1,
};

const unicodeGlyphs: Readonly<Record<DeckGlyph, string>> = {
  agent: "•",
  draft: "✎",
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
  draft: "+",
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
  styleBackground(tone: BackgroundTone, value: string): string {
    return this.styleRenderedBackground(tone, sanitizeTerminalText(value));
  }

  /** Adds a background behind trusted Deck-rendered output. */
  styleRenderedBackground(tone: BackgroundTone, value: string): string {
    const safe = value;
    // A terminal palette belongs to its owner. Do not turn semantic surfaces
    // into bright ANSI swatches on a background we cannot inspect.
    if (
      this.appearance.color === "none" ||
      this.appearance.theme === "plain" ||
      (this.paletteId() === "terminal" && !this.appearance.background)
    )
      return safe;
    const prefix = this.backgroundPrefix(tone);
    // Nested foreground styling resets SGR. Reapply the surface so an outer
    // panel background survives its labels without leaking beyond the line.
    return `${prefix}${safe.replaceAll("\u001b[0m", `\u001b[0m${prefix}`)}\u001b[0m`;
  }

  /** Uses the terminal's own foreground for pills when its background cannot be sampled. */
  styleTabBody(tone: "tab-inactive" | "tab-active", textTone: SemanticTone, value: string): string {
    if (this.appearance.color === "none" || this.appearance.theme === "plain") return value;
    if (this.paletteId() === "terminal" && !this.appearance.background)
      return `\u001b[${tone === "tab-active" ? "7" : "2;7"}m${value}\u001b[0m`;
    return this.styleRenderedBackground(tone, this.styleRendered(textTone, value));
  }

  /** Colours a pill endcap to match the tab body without filling its outside edge. */
  styleTabCap(tone: "tab-inactive" | "tab-active", value: string): string {
    if (this.appearance.color === "none" || this.appearance.theme === "plain") return value;
    if (this.paletteId() === "terminal" && !this.appearance.background)
      return tone === "tab-active" ? value : `\u001b[2m${value}\u001b[0m`;
    if (this.appearance.color === "ansi16")
      return `\u001b[${emberBackground16[tone] - 10}m${value}\u001b[0m`;
    if (this.appearance.color === "ansi256")
      return `\u001b[38;5;${emberBackground256[tone]}m${value}\u001b[0m`;
    const [red, green, blue] = this.backgroundColor(tone);
    return `\u001b[38;2;${red};${green};${blue}m${value}\u001b[0m`;
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
    if (this.appearance.color === "ansi16") return `\u001b[${ansi16[tone]}m`;
    if (this.appearance.color === "ansi256") return `\u001b[38;5;${ansi256[tone]}m`;
    const [red, green, blue] = truecolor[tone];
    return `\u001b[38;2;${red};${green};${blue}m`;
  }

  private backgroundPrefix(tone: BackgroundTone): string {
    if (this.appearance.color === "ansi16") return `\u001b[${emberBackground16[tone]}m`;
    if (this.appearance.color === "ansi256") return `\u001b[48;5;${emberBackground256[tone]}m`;
    const [red, green, blue] = this.backgroundColor(tone);
    return `\u001b[48;2;${red};${green};${blue}m`;
  }

  private backgroundColor(tone: BackgroundTone): readonly [number, number, number] {
    if (!this.appearance.background) return emberBackground[tone];
    if (tone === "tab-active") {
      const dark = relativeLuminance(this.appearance.background) < 0.5;
      return blendBackground(
        this.appearance.background,
        dark ? [207, 132, 66] : [116, 71, 38],
        dark ? 0.4 : 0.28,
      );
    }
    return overlayBackground(this.appearance.background, surfaceOpacity[tone]);
  }

  private paletteId(): PaletteId {
    return this.appearance.palette ?? "ember";
  }
}

/** Builds neutral opacity layers from the terminal's own default background. */
function overlayBackground(
  background: TerminalBackground,
  opacity: number,
): readonly [number, number, number] {
  const target = relativeLuminance(background) < 0.5 ? 255 : 0;
  return blendBackground(background, [target, target, target], opacity);
}

function blendBackground(
  background: TerminalBackground,
  target: TerminalBackground,
  opacity: number,
): readonly [number, number, number] {
  return background.map((channel, index) =>
    Math.round(channel * (1 - opacity) + (target[index] ?? 0) * opacity),
  ) as [number, number, number];
}

function relativeLuminance([red, green, blue]: TerminalBackground): number {
  return (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
}
