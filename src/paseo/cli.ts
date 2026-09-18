import { spawn } from "node:child_process";
import { PaseoCliError } from "./errors.js";

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type CliRunner = (arguments_: readonly string[]) => Promise<CliResult>;

export function createCliRunner(executable = "paseo"): CliRunner {
  return async (arguments_) =>
    new Promise<CliResult>((resolve, reject) => {
      const child = spawn(executable, [...arguments_], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
    });
}

export async function runJson(runner: CliRunner, arguments_: readonly string[]): Promise<unknown> {
  const result = await runner(arguments_);
  if (result.exitCode !== 0) {
    throw new PaseoCliError(
      "Paseo CLI command failed.",
      result.exitCode,
      result.stderr.trim() || result.stdout.trim(),
    );
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new PaseoCliError(
      "Paseo CLI returned invalid JSON.",
      result.exitCode,
      result.stderr.trim() || result.stdout.trim(),
    );
  }
}
