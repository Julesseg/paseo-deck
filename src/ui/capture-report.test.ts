import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("captures actual assembled Visual modes and the final motion frame", async () => {
  const output = await mkdtemp(join(tmpdir(), "deck-capture-"));
  try {
    execFileSync(
      process.execPath,
      [
        resolve("node_modules/tsx/dist/cli.mjs"),
        resolve("scripts/capture-ui-report.ts"),
        output,
        "composer-visual-character",
        "timeline-buffer-visual-line",
      ],
      { timeout: 15_000 },
    );
    const composer = JSON.parse(
      await readFile(join(output, "composer-visual-character.cells.json"), "utf8"),
    );
    const timeline = JSON.parse(
      await readFile(join(output, "timeline-buffer-visual-line.cells.json"), "utf8"),
    );
    expect(composer.viewport.join("\n")).toContain("VISUAL Prompt → Atlas · selected 6 chars");
    expect(timeline.viewport.join("\n")).toContain("VISUAL Active session timeline");
    expect(timeline.timelineMode).toBe("visual");
    expect(composer.composerMode).toBe("visual");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
