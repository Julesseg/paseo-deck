import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspacePlacement } from "../contracts/gateway.js";
import type { PaseoTarget } from "./target.js";

/** Narrow exception to ADR-0002: SDK 0.8.0 has no public Git metadata API. */
export interface WorkspaceMetadataClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  getCheckoutStatus(cwd: string): Promise<{
    isGit: boolean;
    baseRef?: string | null;
    mainRepoRoot?: string | null;
    isPaseoOwnedWorktree?: boolean;
    error?: string | { message: string; code?: string } | null;
  }>;
  getBranchSuggestions(options: { cwd: string; limit?: number; query?: string }): Promise<{
    branchDetails?:
      | Array<{ name: string; hasLocal?: boolean | undefined; hasRemote?: boolean | undefined }>
      | undefined;
    error?: string | { message: string; code?: string } | null;
  }>;
}

export function createWorkspaceMetadataClient(target: PaseoTarget): WorkspaceMetadataClient {
  return new DaemonClient({
    url: target.websocketUrl,
    clientId: `deck-workspace-${randomUUID()}`,
    clientType: "cli",
    ...(target.password === undefined ? {} : { password: target.password }),
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

export async function workspacePlacement(
  metadata: WorkspaceMetadataClient,
  directory: string,
  verifyLocal: () => Promise<void> = async () => {},
): Promise<WorkspacePlacement> {
  let status = await metadata.getCheckoutStatus(directory);
  if (
    !status.isGit &&
    (!status.error || (typeof status.error !== "string" && status.error.code === "NOT_GIT_REPO"))
  )
    return { supportsWorktree: false, refs: [] };
  if (status.error)
    throw new Error(typeof status.error === "string" ? status.error : status.error.message);
  if (status.isPaseoOwnedWorktree && status.mainRepoRoot) {
    status = await metadata.getCheckoutStatus(status.mainRepoRoot);
    if (status.error)
      throw new Error(typeof status.error === "string" ? status.error : status.error.message);
  }
  await verifyLocal();
  try {
    const run = async (args: string[]) =>
      (
        await promisify(execFile)("git", ["-C", directory, ...args], {
          timeout: 15_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    const advertisement = await run(["ls-remote", "--symref", "origin", "HEAD"]);
    const targets = advertisement.split("\n").filter((line) => line.startsWith("ref: "));
    const match =
      targets.length === 1 ? /^ref: (refs\/heads\/[^\s]+)\tHEAD$/u.exec(targets[0] ?? "") : null;
    if (!match) throw new Error("Origin did not advertise one symbolic HEAD");
    const defaultRef = `refs/remotes/origin/${match[1]?.slice("refs/heads/".length)}`;
    const names = (
      await run(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"])
    )
      .trim()
      .split("\n")
      .filter((ref) => ref && ref !== "refs/remotes/origin/HEAD");
    if (!names.includes(defaultRef)) names.unshift(defaultRef);
    const refs = names.map((ref) => ({
      label: `${ref} (${ref.startsWith("refs/remotes/") ? "remote" : "local"})`,
      ref,
      remote: ref.startsWith("refs/remotes/"),
    }));
    return { supportsWorktree: true, refs, defaultRef };
  } catch {
    // Git errors can contain authenticated origin URLs; never surface their raw stderr.
    throw new Error(
      "Could not resolve origin default from its current advertisement. Check origin availability and retry.",
    );
  }
}

/** Refresh only the requested remote ref: a deleted branch must fail, not use stale tracking state. */
export async function fetchWorkspaceRemote(directory: string, branch: string): Promise<void> {
  try {
    await promisify(execFile)(
      "git",
      [
        "-C",
        directory,
        "fetch",
        "--prune",
        "origin",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      {
        timeout: 60_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (error) {
    throw new Error(
      `Remote base refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
