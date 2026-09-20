import { describe, expect, it } from "vitest";

import { detectTerminalAppearance } from "./capabilities.js";

describe("detectTerminalAppearance", () => {
  it("honours NO_COLOR and dumb terminals ahead of colour capability", () => {
    expect(
      detectTerminalAppearance({ NO_COLOR: "1", TERM: "xterm-256color", LANG: "en_US.UTF-8" }),
    ).toMatchObject({ color: "none", theme: "plain", unicode: true });
    expect(detectTerminalAppearance({ TERM: "dumb" })).toMatchObject({ color: "none" });
  });

  it("detects truecolor, 256-colour, and conservative ansi terminals", () => {
    expect(detectTerminalAppearance({ COLORTERM: "truecolor" })).toMatchObject({
      color: "truecolor",
      palette: "terminal",
    });
    expect(detectTerminalAppearance({ TERM: "screen-256color" })).toMatchObject({
      color: "ansi256",
      palette: "terminal",
    });
    expect(detectTerminalAppearance({ TERM: "xterm" })).toMatchObject({
      color: "ansi16",
      palette: "terminal",
    });
  });

  it("allows explicit Ember or terminal palette configuration", () => {
    expect(detectTerminalAppearance({ PASEO_DECK_THEME: "ember" }).palette).toBe("ember");
    expect(detectTerminalAppearance({ PASEO_DECK_THEME: "terminal" }).palette).toBe("terminal");
    expect(detectTerminalAppearance({ PASEO_DECK_THEME: "unknown" }).palette).toBe("terminal");
  });

  it("uses ASCII symbols when requested or when the locale is not UTF-8", () => {
    expect(detectTerminalAppearance({ LANG: "C" }).symbols).toBe("ascii");
    expect(detectTerminalAppearance({ LANG: "en_US.UTF-8", PASEO_DECK_ASCII: "1" }).symbols).toBe(
      "ascii",
    );
  });
});
