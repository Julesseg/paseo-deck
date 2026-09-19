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
    expect(detectTerminalAppearance({ COLORTERM: "truecolor" }).color).toBe("truecolor");
    expect(detectTerminalAppearance({ TERM: "screen-256color" }).color).toBe("ansi256");
    expect(detectTerminalAppearance({ TERM: "xterm" }).color).toBe("ansi16");
  });

  it("uses ASCII symbols when requested or when the locale is not UTF-8", () => {
    expect(detectTerminalAppearance({ LANG: "C" }).symbols).toBe("ascii");
    expect(detectTerminalAppearance({ LANG: "en_US.UTF-8", PASEO_DECK_ASCII: "1" }).symbols).toBe(
      "ascii",
    );
  });
});
