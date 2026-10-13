import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runJson } from "./cli.js";
import { PaseoCliError } from "./errors.js";

it.for([false, true])(
  "runs Paseo commands with a removed launch directory: %s",
  async (removed, { skip }) => {
    // Windows prevents deleting a directory while it is a process's cwd.
    if (removed && process.platform === "win32") skip();
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "deck-deleted-cwd-")));
    try {
      // Isolate chdir from Vitest; load the runner before removing the launch directory.
      const { stdout } = await promisify(execFile)(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
        import { rmSync } from "node:fs";
        import { createCliRunner } from ${JSON.stringify(new URL("./cli.ts", import.meta.url).href)};
        process.chdir(${JSON.stringify(directory)});
        process.cwd(); // Also exercise Node's cached cwd after unlinking.
        if (${removed}) rmSync(${JSON.stringify(directory)}, { recursive: true });
        const result = await createCliRunner(process.execPath)([
          "-e", "console.log(JSON.stringify({ cwd: process.cwd() }))"
        ]);
        console.log(JSON.stringify(result));
      `,
      ]);
      const result = JSON.parse(stdout);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).cwd).toBe(removed ? realpathSync(homedir()) : directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

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
