import { describe, expect, it } from "vitest";
import { clipboardPlainText, copyTargets, findTimelineMatches } from "./timeline-search.js";

describe("timeline source search and copy", () => {
  const events = [
    {
      epoch: "e",
      sequence: 1,
      item: {
        id: "a",
        type: "assistant-message" as const,
        messageId: "m",
        text: "```ts\n\tconst value = 1;\n```\nneedle",
      },
    },
    {
      epoch: "e",
      sequence: 2,
      item: {
        id: "tool",
        type: "tool" as const,
        callId: "c",
        name: "shell",
        status: "failed" as const,
        output: "  output\n",
        failureSummary: "denied",
      },
    },
  ];

  it("searches source fields by stable event identity, not rendered chrome", () => {
    expect(findTimelineMatches(events, "needle").map((entry) => entry.id)).toEqual(["e:1"]);
    expect(findTimelineMatches(events, "Assistant")).toEqual([]);
  });

  it("offers source-only whole and fenced-code copy targets", () => {
    const [message, tool] = events;
    if (!message || !tool) throw new Error("Expected search fixtures.");
    expect(copyTargets(message.item).map((target) => target)).toEqual([
      { label: "message", text: "```ts\n\tconst value = 1;\n```\nneedle" },
      { label: "code 1", text: "\tconst value = 1;\n" },
    ]);
    expect(copyTargets(tool.item)).toEqual([{ label: "tool output", text: "  output\n" }]);
    expect(
      copyTargets({ id: "error", type: "error", message: "failed", detail: "details" }),
    ).toEqual([{ label: "error", text: "details" }]);
  });

  it("strips ANSI, OSC, and controls while retaining tabs and newlines", () => {
    expect(
      clipboardPlainText("\u001b]8;;https://x\u0007\u001b[31m\tvalue é🙂\n\u001b[0m\u0000"),
    ).toBe("\tvalue é🙂\n");
  });
});
