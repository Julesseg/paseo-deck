import { describe, expect, it } from "vitest";
import { runJson } from "./cli.js";
import { PaseoCliError } from "./errors.js";

describe("Paseo CLI runner parsing", () => {
  it("returns parsed JSON", async () => {
    await expect(
      runJson(
        async () => ({ stdout: '{"ok":true}', stderr: "", exitCode: 0 }),
        ["stop", "agent-1"],
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("keeps stderr in a typed error", async () => {
    await expect(
      runJson(
        async () => ({ stdout: "", stderr: "agent is busy", exitCode: 2 }),
        ["stop", "agent-1"],
      ),
    ).rejects.toMatchObject({
      name: "PaseoCliError",
      exitCode: 2,
      detail: "agent is busy",
    });
  });

  it("rejects non-JSON success output", async () => {
    await expect(
      runJson(async () => ({ stdout: "not json", stderr: "", exitCode: 0 }), ["stop", "agent-1"]),
    ).rejects.toBeInstanceOf(PaseoCliError);
  });
});
