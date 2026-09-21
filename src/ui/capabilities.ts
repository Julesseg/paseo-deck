/** Terminal features detected once by the runtime and injected into the UI. */
export type ColorTier = "none" | "ansi16" | "ansi256" | "truecolor";
export type ThemeId = "ember" | "plain";
export type SymbolSet = "unicode" | "ascii";
/** Palette source. `terminal` deliberately delegates hue selection to ANSI. */
export type PaletteId = "terminal" | "ember";
export type TerminalBackground = readonly [red: number, green: number, blue: number];

export interface TerminalAppearance {
  color: ColorTier;
  unicode: boolean;
  theme: ThemeId;
  symbols: SymbolSet;
  palette?: PaletteId;
  /** Terminal default background, queried at runtime when the terminal supports OSC 11. */
  background?: TerminalBackground;
}

export type TerminalEnvironment = Readonly<
  Partial<
    Pick<
      NodeJS.ProcessEnv,
      | "NO_COLOR"
      | "TERM"
      | "COLORTERM"
      | "LANG"
      | "LC_ALL"
      | "PASEO_DECK_ASCII"
      | "PASEO_DECK_THEME"
    >
  >
>;

export const defaultTerminalAppearance: TerminalAppearance = {
  color: "truecolor",
  unicode: true,
  theme: "ember",
  symbols: "unicode",
  palette: "terminal",
};

/** Converts the process environment into a stable, serialisable appearance. */
export function detectTerminalAppearance(environment: TerminalEnvironment): TerminalAppearance {
  const term = environment.TERM?.toLocaleLowerCase() ?? "";
  const colorTerm = environment.COLORTERM?.toLocaleLowerCase() ?? "";
  const noColor = environment.NO_COLOR !== undefined && environment.NO_COLOR !== "";
  const color: ColorTier =
    noColor || term === "dumb"
      ? "none"
      : colorTerm.includes("truecolor") || colorTerm.includes("24bit")
        ? "truecolor"
        : term.includes("256color")
          ? "ansi256"
          : "ansi16";
  const locale = environment.LC_ALL ?? environment.LANG ?? "";
  const unicode = environment.PASEO_DECK_ASCII !== "1" && /utf-?8/i.test(locale);
  return {
    color,
    unicode,
    theme: color === "none" ? "plain" : "ember",
    symbols: unicode ? "unicode" : "ascii",
    palette: configuredPalette(environment) ?? "terminal",
  };
}

/** Reads the opt-in configuration without treating saved preferences as config. */
export function configuredPalette(environment: TerminalEnvironment): PaletteId | undefined {
  return environment.PASEO_DECK_THEME === "ember"
    ? "ember"
    : environment.PASEO_DECK_THEME === "terminal"
      ? "terminal"
      : undefined;
}
