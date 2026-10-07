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
  const base = status.baseRef
    ?.replace(/^refs\/remotes\/origin\//, "")
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "");
  const branches = await metadata.getBranchSuggestions({ cwd: directory, limit: 200 });
  if (branches.error)
    throw new Error(typeof branches.error === "string" ? branches.error : branches.error.message);
  const details = [...(branches.branchDetails ?? [])];
  if (base && !details.some((branch) => branch.name === base)) {
    const defaults = await metadata.getBranchSuggestions({
      cwd: directory,
      query: base,
      limit: 200,
    });
    if (defaults.error)
      throw new Error(typeof defaults.error === "string" ? defaults.error : defaults.error.message);
    details.push(...(defaults.branchDetails ?? []).filter((branch) => branch.name === base));
  }
  const refs = details.flatMap((branch) => [
    ...(branch.hasRemote
      ? [{ label: branch.name, ref: `refs/remotes/origin/${branch.name}`, remote: true }]
      : []),
    ...(branch.hasLocal
      ? [{ label: `${branch.name} (local)`, ref: `refs/heads/${branch.name}`, remote: false }]
      : []),
  ]);
  const defaultRef =
    refs.find((ref) => ref.ref === `refs/remotes/origin/${base}`)?.ref ??
    refs.find((ref) => ref.ref === `refs/heads/${base}`)?.ref ??
    refs[0]?.ref;
  return { supportsWorktree: refs.length > 0, refs, ...(defaultRef ? { defaultRef } : {}) };
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
