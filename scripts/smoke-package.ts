import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "paseo-deck-package-"));
const packageDirectory = join(temporaryRoot, "package");
const installDirectory = join(temporaryRoot, "install");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  await mkdir(packageDirectory);
  const packed = await execFileAsync(
    npm,
    ["pack", "--json", "--pack-destination", packageDirectory],
    { cwd: repository },
  );
  const result = JSON.parse(packed.stdout) as Array<{ filename?: unknown }>;
  const filename = result[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not report a tarball filename.");

  const tarball = join(packageDirectory, filename);
  await execFileAsync(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installDirectory,
      tarball,
    ],
    { cwd: repository },
  );

  for (const alias of ["paseo-deck", "pdeck"]) {
    const executable = join(
      installDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? `${alias}.cmd` : alias,
    );
    const { stdout } = await execFileAsync(executable, ["--help"], { cwd: installDirectory });
    if (!stdout.includes("Paseo Deck 0.1.0") || !stdout.includes("Usage: paseo-deck")) {
      throw new Error(`${alias} did not print the expected help output.`);
    }
  }

  console.log("Packed install exposes working paseo-deck and pdeck executables.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
