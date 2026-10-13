import { expect, it } from "vitest";
import { createInitialState } from "../state/store.js";
import { deriveTreeRows } from "./view-model.js";

it("name, archived and combined activity filters retain only eligible parents and children", () => {
  const state = createInitialState();
  state.treeOrder = "alphabetical";
  state.expandedIds = new Set(["p", "empty"]);
  state.directory = {
    providers: [],
    projects: [
      { id: "p", name: "Project" },
      { id: "empty", name: "Empty" },
    ],
    agents: [],
    workspaces: [
      { id: "a", projectId: "p", title: "Alpha", directory: "/a", archived: false },
      { id: "b", projectId: "p", title: "Beta", directory: "/b", archived: true },
    ],
  };
  state.workspaceTerminals = {
    b: [{ id: "t", workspaceId: "b", name: "Terminal", cwd: "/b", activity: "attention" }],
  };
  const ids = () => deriveTreeRows(state).map((row) => row.id);
  expect(ids()).toEqual(["p", "a"]);
  state.filter = "eMpTy";
  expect(ids()).toEqual(["empty"]);
  state.attentionOnly = true;
  expect(ids()).toEqual([]);
  state.filter = "PROJECT";
  expect(ids()).toEqual([]);
  state.showArchived = true;
  expect(ids()).toEqual(["p", "b"]);
  state.attentionOnly = false;
  expect(ids()).toEqual(["p", "a", "b"]);
  state.filter = "bEtA";
  expect(ids()).toEqual(["p", "b"]);
  state.showArchived = false;
  expect(ids()).toEqual([]);
});

it("name filtering does not match resource identities, directories or Session names", () => {
  const state = createInitialState();
  state.directory = {
    providers: [],
    projects: [{ id: "hidden-project", name: "Shown Project" }],
    agents: [],
    workspaces: [
      {
        id: "hidden-workspace",
        projectId: "hidden-project",
        title: "Shown Workspace",
        directory: "/hidden-directory",
        archived: false,
      },
    ],
  };
  state.filter = "hidden";
  expect(deriveTreeRows(state)).toEqual([]);
});
