import { describe, expect, it } from "vitest";

import {
  clipTerminalLine,
  sanitizeTerminalText,
  terminalDisplayWidth,
  wrapTerminalText,
} from "./text-safety.js";

describe("terminal text safety", () => {
  it("renders terminal controls as inert text", () => {
    expect(sanitizeTerminalText("before\u001b[2J\rafter\u0007")).toBe("before␛[2J␍after␇");
  });

  it("measures emoji and combining text by terminal cells", () => {
    expect(terminalDisplayWidth("e\u0301🙂")).toBe(3);
    expect(terminalDisplayWidth("界")).toBe(2);
    expect(terminalDisplayWidth("🇫🇷1️⃣")).toBe(4);
  });

  it("hard-wraps tabs and unbroken text within the available cell width", () => {
    const lines = wrapTerminalText("\tconstVeryLongIdentifier🙂", 8);

    expect(lines).toEqual(["    cons", "tVeryLon", "gIdentif", "ier🙂"]);
    expect(lines.every((line) => terminalDisplayWidth(line) <= 8)).toBe(true);
  });

  it("wraps flags and keycaps by their two-cell grapheme width", () => {
    expect(wrapTerminalText("🇫🇷1️⃣🙂", 4)).toEqual(["🇫🇷1️⃣", "🙂"]);
  });

  it("clips styled output by terminal cells without leaking styles", () => {
    const clipped = clipTerminalLine("\u001b[31m🙂🙂wide\u001b[0m", 5);

    expect(terminalDisplayWidth(clipped)).toBe(5);
    expect(clipped).toContain("\u001b[31m");
    expect(clipped.endsWith("\u001b[0m")).toBe(true);
  });
});
