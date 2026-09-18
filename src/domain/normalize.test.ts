import { describe, expect, it } from "vitest";
import { normalizeDirectory } from "./normalize.js";

describe("normalizeDirectory", () => {
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
