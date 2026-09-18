import { describe, expect, it } from "vitest";

import {
  adjustTreeWidth,
  MAX_TREE_WIDTH,
  MIN_TERMINAL_COLUMNS,
  MIN_TERMINAL_ROWS,
  MIN_TREE_WIDTH,
  shellLayout,
} from "./layout.js";

describe("shellLayout", () => {
  it("has an explicit supported-size boundary", () => {
    expect(shellLayout(MIN_TERMINAL_COLUMNS, MIN_TERMINAL_ROWS, 30)).toMatchObject({
      supported: true,
      treeWidth: 30,
    });
    expect(shellLayout(MIN_TERMINAL_COLUMNS - 1, MIN_TERMINAL_ROWS, 30)).toMatchObject({
      supported: false,
    });
    expect(shellLayout(MIN_TERMINAL_COLUMNS, MIN_TERMINAL_ROWS - 1, 30)).toMatchObject({
      supported: false,
    });
  });

  it("keeps tree width within safe keyboard bounds", () => {
    expect(adjustTreeWidth(MIN_TREE_WIDTH, -1)).toBe(MIN_TREE_WIDTH);
    expect(adjustTreeWidth(MAX_TREE_WIDTH, 1)).toBe(MAX_TREE_WIDTH);
    expect(adjustTreeWidth(30, 2)).toBe(32);
  });
});
