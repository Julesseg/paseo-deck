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
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required; run this smoke test through npm.");
const npmCliPath = npmCli;

function runNpm(arguments_: string[], cwd = repository) {
  return execFileAsync(process.execPath, [npmCliPath, ...arguments_], { cwd });
}

try {
  await mkdir(packageDirectory);
  const packed = await runNpm(["pack", "--json", "--pack-destination", packageDirectory]);
  const result = JSON.parse(packed.stdout) as Array<{ filename?: unknown }>;
  const filename = result[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not report a tarball filename.");

  const tarball = join(packageDirectory, filename);
  await runNpm([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    installDirectory,
    tarball,
  ]);

  for (const alias of ["paseo-deck", "pdeck"]) {
    const { stdout } = await runNpm(
      ["exec", "--offline", "--prefix", installDirectory, "--", alias, "--help"],
      installDirectory,
    );
    if (!stdout.includes("Paseo Deck 0.1.0") || !stdout.includes("Usage: paseo-deck")) {
      throw new Error(`${alias} did not print the expected help output.`);
    }
  }

  console.log("Packed install exposes working paseo-deck and pdeck executables.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
