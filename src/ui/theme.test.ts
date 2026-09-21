import { describe, expect, it } from "vitest";

import type { TerminalAppearance } from "./capabilities.js";
import { DeckTheme } from "./theme.js";

const noColor: TerminalAppearance = {
  color: "none",
  unicode: false,
  theme: "plain",
  symbols: "ascii",
};

describe("DeckTheme", () => {
  it("keeps semantic labels without emitting SGR in no-colour mode", () => {
    const rendered = new DeckTheme(noColor).style("failure", "bad\u001b[2J");

    expect(rendered).toBe("bad␛[2J");
    expect(rendered).not.toContain("\u001b[");
    expect(
      ["focus", "selection", "failure", "muted"]
        .map((tone) => new DeckTheme(noColor).style(tone as "focus", "label"))
        .join(""),
    ).not.toContain("\u001b[");
  });

  it("allows a persisted plain theme to opt out of colour independently", () => {
    const rendered = new DeckTheme({ ...noColor, color: "truecolor" }).style("focus", "plain");

    expect(rendered).toBe("plain");
  });

  it("uses complete style resets and ASCII glyph fallbacks", () => {
    const theme = new DeckTheme({ ...noColor, color: "ansi16", unicode: false, theme: "ember" });

    expect(theme.style("focus", "selected")).toBe("\u001b[36mselected\u001b[0m");
    expect(theme.glyph("expanded")).toBe("v");
    expect(theme.glyph("permission")).toBe("[P]");
    expect(theme.glyph("end")).toBe("v");
    expect(theme.label("Agent ←→ ↑↓ waiting… · ✓")).toBe("Agent <--> UpDown waiting... - [P]");
  });

  it("treats the requested symbol set as canonical even when Unicode is available", () => {
    const theme = new DeckTheme({
      color: "ansi16",
      unicode: true,
      theme: "ember",
      symbols: "ascii",
    });

    expect(theme.glyph("agent")).toBe("*");
    expect(theme.label("Agent → waiting…")).toBe("Agent -> waiting...");
    expect(theme.clipOwnedLabel("Long → label", 8)).toHaveLength(8);
  });

  it("separates owned labels from sanitised remote text", () => {
    const theme = new DeckTheme({ color: "none", unicode: true, theme: "plain", symbols: "ascii" });

    expect(theme.style("header", "Deck → waiting…")).toBe("Deck -> waiting...");
    expect(theme.styleRemote("header", "Agent → waiting…\u001b[2J")).toBe("Agent → waiting…␛[2J");
  });

  it("uses the terminal palette at every colour tier and supports semantic backgrounds", () => {
    const tones = [
      "focus",
      "selection",
      "running",
      "attention",
      "permission",
      "failure",
      "stale",
      "muted",
      "border",
      "header",
      "code",
    ] as const;
    for (const color of ["ansi16", "ansi256", "truecolor"] as const) {
      const rendered = tones
        .map((tone) =>
          new DeckTheme({
            color,
            unicode: true,
            theme: "ember",
            palette: "terminal",
            symbols: "unicode",
          }).style(tone, "x"),
        )
        .join("");
      expect(rendered).not.toContain("38;");
      expect(rendered).not.toContain("38;2;");
    }
    expect(
      new DeckTheme({
        color: "ansi256",
        unicode: true,
        theme: "ember",
        palette: "terminal",
        symbols: "unicode",
      }).style("focus", "x"),
    ).toBe("\u001b[36mx\u001b[0m");
    expect(
      new DeckTheme({
        color: "truecolor",
        unicode: true,
        theme: "ember",
        palette: "terminal",
        symbols: "unicode",
      }).styleBackground("selection", "x"),
    ).toBe("x");
    expect(
      new DeckTheme({
        color: "none",
        unicode: true,
        theme: "ember",
        palette: "terminal",
        symbols: "unicode",
      }).styleBackground("selection", "x"),
    ).toBe("x");
  });

  it("uses close Ember surface steps and preserves them around rendered labels", () => {
    const theme = new DeckTheme({
      color: "truecolor",
      unicode: true,
      theme: "ember",
      palette: "ember",
      symbols: "unicode",
    });

    expect(theme.styleBackground("sidebar", "x")).toBe("\u001b[48;2;31;29;27mx\u001b[0m");
    expect(theme.styleBackground("selection", "x")).toBe("\u001b[48;2;51;46;39mx\u001b[0m");
    expect(theme.styleRenderedBackground("sidebar", theme.style("focus", "x"))).toBe(
      "\u001b[48;2;31;29;27m\u001b[38;2;125;211;252mx\u001b[0m\u001b[48;2;31;29;27m\u001b[0m",
    );
  });

  it("derives terminal-palette surfaces from the sampled terminal background", () => {
    const theme = new DeckTheme({
      color: "truecolor",
      unicode: true,
      theme: "ember",
      palette: "terminal",
      background: [240, 230, 220],
      symbols: "unicode",
    });

    expect(theme.styleBackground("sidebar", "x")).toBe("\u001b[48;2;232;222;212mx\u001b[0m");
    expect(theme.styleBackground("selection", "x")).toBe("\u001b[48;2;216;207;198mx\u001b[0m");

    const darkTheme = new DeckTheme({ ...theme.appearance, background: [28, 25, 23] });
    expect(darkTheme.styleBackground("sidebar", "x")).toBe("\u001b[48;2;36;33;31mx\u001b[0m");
    expect(darkTheme.styleBackground("selection", "x")).toBe("\u001b[48;2;51;48;46mx\u001b[0m");
  });
});
