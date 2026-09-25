import { describe, expect, it } from "vitest";
import { normalizeDirectory } from "./normalize.js";

describe("normalizeDirectory", () => {
  it("uses the live projectId identity while retaining legacy project identities", () => {
    const directory = normalizeDirectory({
      projects: [
        { projectId: "live-project", name: "Live project" },
        { id: "legacy-id", name: "Legacy id" },
        { projectKey: "legacy-key", projectName: "Legacy key" },
      ],
    });

    expect(directory.projects).toEqual([
      { id: "live-project", name: "Live project" },
      { id: "legacy-id", name: "Legacy id" },
      { id: "legacy-key", name: "Legacy key" },
    ]);
  });

  it("reads the SDK project display name and root path", () => {
    const directory = normalizeDirectory({
      projects: [
        {
          projectId: "prj_123",
          projectDisplayName: "Paseo Deck",
          projectRootPath: "/repo",
        },
      ],
    });

    expect(directory.projects).toEqual([{ id: "prj_123", name: "Paseo Deck", path: "/repo" }]);
  });

  it("normalizes incomplete directory data without losing stable identities", () => {
    const directory = normalizeDirectory({
      projects: [{ id: "project-1", name: "Deck" }],
      workspaces: [{ id: "workspace-1", projectId: "project-1", directory: "/tmp/deck" }],
      agents: [{ id: "agent-1", workspaceId: "workspace-1", status: "busy", title: "" }],
      providers: [{ id: "codex", models: [{ id: "gpt", selectable: true }] }],
    });

    expect(directory).toMatchObject({
      projects: [{ id: "project-1", name: "Deck" }],
      workspaces: [{ id: "workspace-1", projectId: "project-1", title: "/tmp/deck" }],
      agents: [{ id: "agent-1", workspaceId: "workspace-1", status: "unknown", title: "agent-1" }],
      providers: [{ id: "codex", name: "codex", models: [{ id: "gpt", name: "gpt" }] }],
    });
  });
});
