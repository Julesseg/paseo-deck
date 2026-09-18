import { describe, expect, it } from "vitest";
import { narrowLayout } from "./layout.js";

describe("narrowLayout", () => {
  it("preserves the tree, timeline and composer before secondary details", () => {
    expect(narrowLayout(70)).toEqual({
      showTree: true,
      showTimeline: true,
      showComposer: true,
      showSecondaryDetails: false,
      compactTree: true,
    });
    expect(narrowLayout(130).showSecondaryDetails).toBe(true);
  });
});
