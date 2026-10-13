import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { workspacePlacement } from "./worktree.js";

it("resolves the currently advertised origin default while cached origin HEAD remains stale", async () => {
  const root = mkdtempSync(join(tmpdir(), "deck-origin-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  try {
    git("init", "--bare", "--initial-branch=old-default", origin);
    git("clone", origin, clone);
    git(
      "-C",
      clone,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    );
    git("-C", clone, "push", "origin", "HEAD", "HEAD:advertised-default");
    git("-C", clone, "remote", "set-head", "origin", "old-default");
    git("-C", origin, "symbolic-ref", "HEAD", "refs/heads/advertised-default");
    const metadata = {
      connect: async () => {},
      close: async () => {},
      getCheckoutStatus: async () => ({ isGit: true, baseRef: "old-default" }),
      getBranchSuggestions: async () => ({ branchDetails: [] }),
    };
    expect(await workspacePlacement(metadata, clone)).toMatchObject({
      defaultRef: "refs/remotes/origin/advertised-default",
    });
    expect(git("-C", clone, "symbolic-ref", "refs/remotes/origin/HEAD").trim()).toBe(
      "refs/remotes/origin/old-default",
    );
    git("-C", origin, "symbolic-ref", "HEAD", "refs/heads/nonexistent");
    await expect(workspacePlacement(metadata, clone)).rejects.toThrow("origin default");
    git("-C", clone, "remote", "set-url", "origin", join(root, "missing-origin.git"));
    await expect(workspacePlacement(metadata, clone)).rejects.toThrow("origin default");
    git("-C", clone, "remote", "remove", "origin");
    await expect(workspacePlacement(metadata, clone)).rejects.toThrow("origin default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
