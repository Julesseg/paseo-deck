import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import type { AppState } from "../contracts/app-state.js";
import type { DirectorySnapshot } from "../contracts/domain.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { PreferenceSession } from "../runtime/preferences.js";
import { createInitialState } from "../state/store.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

const directory: DirectorySnapshot = {
  projects: [{ id: "p", name: "Design project" }],
  providers: [],
  agents: [
    {
      id: "unread",
      workspaceId: "running",
      title: "Unopened Session",
      status: "idle",
      archived: false,
      availableModeIds: [],
      availableThinkingLevels: [],
      pendingPermissions: [],
      needsAttention: true,
      attentionReason: "finished",
    },
  ],
  workspaces: [
    {
      id: "done",
      title: "Done workspace",
      status: "done",
      directory: "/done",
      projectId: "p",
      archived: false,
    },
    {
      id: "running",
      title: "Mixed workspace",
      status: "running",
      directory: "/running",
      projectId: "p",
      archived: false,
    },
    {
      id: "attention",
      title: "Unread workspace",
      status: "attention",
      directory: "/attention",
      projectId: "p",
      archived: false,
    },
    {
      id: "failed",
      title: "Failed workspace",
      status: "failed",
      directory: "/failed",
      projectId: "p",
      archived: false,
    },
    {
      id: "needs_input",
      title: "Waiting workspace",
      status: "needs_input",
      directory: "/waiting",
      projectId: "p",
      archived: false,
    },
  ],
};

async function fixture(snapshot = directory, initialState: AppState = createInitialState()) {
  const gateway = new FakePaseoGateway(snapshot);
  const app = new ApplicationController(gateway, { initialState });
  await app.start();
  const terminal = new RecordingTerminal(120, 55);
  const pending: Promise<void>[] = [];
  const deck = new DeckTui(
    terminal,
    app.state,
    (intent) => {
      pending.push(app.handleIntent(intent));
    },
    { appearance: { color: "none", unicode: false, theme: "plain", symbols: "ascii" } },
  );
  const unsubscribe = app.subscribe((state) => deck.update(state));
  await deck.start();
  return {
    app,
    gateway,
    terminal,
    async input(key: string) {
      terminal.sendInput(key);
      await Promise.all(pending.splice(0));
      await terminal.waitForRender();
    },
    async frame() {
      await terminal.waitForRender();
      return terminal
        .viewport()
        .map((line) => line.slice(0, 34))
        .join("\n");
    },
    async close() {
      unsubscribe();
      await deck.stop();
      await app.releaseObservations();
      await gateway.close();
    },
  };
}

it("initially lists native Workspace buckets in display order without overriding mixed activity", async () => {
  const f = await fixture();
  try {
    const frame = await f.frame();
    const labels = [
      "Waiting for user input",
      "Waiting workspace",
      "Failed",
      "Failed workspace",
      "Ready to review",
      "Unread workspace",
      "Working",
      "Mixed workspace",
      "Done",
      "Done workspace",
    ];
    let after = -1;
    for (const label of labels) {
      const index = frame.indexOf(label, after + 1);
      expect(index, label).toBeGreaterThan(after);
      after = index;
    }
    expect(frame).not.toContain("Unopened Session");
    expect(frame).toContain("R Mixed workspace");
  } finally {
    await f.close();
  }
});

it("toggles grouping and expands headings through Sidebar keys while preserving the Active workspace", async () => {
  const f = await fixture();
  try {
    const active = f.app.state.selectedWorkspaceId;
    await f.input("\u0013");
    await f.input("g");
    await f.input("g");
    await f.input("\r");
    expect(await f.frame()).not.toContain("Waiting workspace");
    await f.input("l");
    expect(await f.frame()).toContain("Waiting workspace");
    await f.input("h");
    expect(await f.frame()).not.toContain("Waiting workspace");
    await f.input("s");
    expect(await f.frame()).toContain("Design project");
    expect(await f.frame()).not.toContain("Ready to review");
    await f.input("g");
    await f.input("g");
    await f.input("\r");
    expect(await f.frame()).toContain("Mixed workspace");
    await f.input("s");
    expect(await f.frame()).toContain("Ready to review");
    expect(f.app.state.selectedWorkspaceId).toBe(active);
  } finally {
    await f.close();
  }
});

it("restores grouping, ordering and heading expansion on the next launch", async () => {
  let saved = "";
  const fs = {
    readFile: async () => saved || '{"version":1,"global":{},"targets":{}}',
    writeAtomic: async (_path: string, value: string) => {
      saved = value;
    },
    remove: async () => {
      saved = "";
    },
  };
  const preferences = await PreferenceSession.open({ type: "default" }, { fs });
  const f = await fixture(directory, preferences.initialState());
  const unsubscribe = f.app.subscribe((state) => preferences.observe(state));
  try {
    await f.input("\u0013");
    await f.input("s");
    await f.input("o");
    await f.input("g");
    await f.input("g");
    await f.input("l");
    await preferences.flush();
  } finally {
    unsubscribe();
    await f.close();
  }
  const restored = await PreferenceSession.open({ type: "default" }, { fs });
  const restarted = await fixture(directory, restored.initialState());
  try {
    expect(restarted.app.state.treeOrder).toBe("alphabetical");
    expect(await restarted.frame()).toContain("Design project");
    expect(await restarted.frame()).toContain("Mixed workspace");
    expect(await restarted.frame()).not.toContain("v Ready to review");
    await restarted.input("\u0013");
    await restarted.input("s");
    expect(await restarted.frame()).toContain("Ready to review");
  } finally {
    await restarted.close();
  }
});

it("orders by native recency, applies explicit ordering immediately, and holds automatic positions until Sidebar exit", async () => {
  const snapshot: DirectorySnapshot = {
    ...directory,
    agents: [],
    workspaces: [
      {
        id: "a",
        title: "Alpha",
        status: "done",
        activityAt: "2026-10-13T12:00:00Z",
        projectId: "p",
        directory: "/a",
        archived: false,
      },
      {
        id: "z",
        title: "Zulu",
        status: "done",
        activityAt: "2026-10-13T13:00:00Z",
        projectId: "p",
        directory: "/z",
        archived: false,
      },
      {
        id: "missing",
        title: "Missing time",
        status: "done",
        projectId: "p",
        directory: "/missing",
        archived: false,
      },
    ],
  };
  const f = await fixture(snapshot, { ...createInitialState(), selectedWorkspaceId: "z" });
  const before = (frame: string, left: string, right: string) =>
    expect(frame.indexOf(left)).toBeLessThan(frame.indexOf(right));
  try {
    before(await f.frame(), "Zulu", "Alpha");
    before(await f.frame(), "Alpha", "Missing time");
    await f.input("\u0013");
    expect(f.app.state.sidebarSelection?.id).toBe("z");
    await f.input("o");
    before(await f.frame(), "Alpha", "Zulu");
    expect(f.app.state.sidebarSelection?.id).toBe("z");
    await f.input("o");
    before(await f.frame(), "Zulu", "Alpha");
    const alpha = snapshot.workspaces[0];
    const zulu = snapshot.workspaces[1];
    if (!alpha || !zulu) throw new Error("fixture missing workspaces");
    f.gateway.emitDirectory({
      type: "workspace-upserted",
      workspace: { ...alpha, activityAt: "2026-10-13T14:00:00Z" },
    });
    f.gateway.emitDirectory({
      type: "workspace-upserted",
      workspace: { ...zulu, status: "failed" },
    });
    const frozen = await f.frame();
    expect(frozen).not.toContain("v Failed");
    expect(frozen).toContain("F Zulu");
    before(frozen, "Zulu", "Alpha");
    expect(f.app.state.sidebarSelection?.id).toBe("z");
    await f.input("\u001b");
    const resumed = await f.frame();
    expect(resumed).toContain("v Failed");
    before(resumed, "Failed", "Zulu");
    before(resumed, "Zulu", "Done");
    expect(f.app.state.sidebarSelection?.id).toBe("z");
    expect(f.app.state.selectedWorkspaceId).toBe("z");
  } finally {
    await f.close();
  }
});

it.each(["status", "project"] as const)(
  "combines name, native attention and archive filters in %s grouping without activating a Workspace",
  async (grouping) => {
    const snapshot: DirectorySnapshot = {
      ...directory,
      workspaces: [
        {
          id: "a",
          title: "Seen",
          status: "done",
          projectId: "p",
          directory: "/a",
          archived: false,
        },
        {
          id: "b",
          title: "Review",
          status: "attention",
          projectId: "p",
          directory: "/b",
          archived: true,
        },
      ],
    };
    const f = await fixture(snapshot, {
      ...createInitialState(),
      treeGrouping: grouping,
      expandedIds: new Set([...createInitialState().expandedIds, "p"]),
    });
    try {
      const active = f.app.state.selectedWorkspaceId;
      await f.input("\u0013");
      await f.input("!");
      expect(await f.frame()).not.toContain("Seen");
      expect(await f.frame()).not.toContain("Review");
      await f.input("v");
      expect(await f.frame()).toContain("Review");
      await f.input("/");
      await f.input("s");
      expect(f.app.state.treeGrouping).toBe(grouping);
      expect(await f.frame()).toContain("> s");
      await f.input("zz");
      await f.input("\r");
      expect(await f.frame()).not.toContain("Review");
      await f.input("/");
      await f.input("\u0005");
      await f.input("\u007f");
      await f.input("\u007f");
      await f.input("\u007f");
      await f.input("design");
      await f.input("\r");
      expect(await f.frame()).toContain("Review");
      expect(await f.frame()).not.toContain("Seen");
      expect(f.app.state.selectedWorkspaceId).toBe(active);
    } finally {
      await f.close();
    }
  },
);

it("restores collapsed activity headings while still displaying the first eligible Workspace", async () => {
  const f = await fixture(directory, { ...createInitialState(), expandedIds: new Set() });
  try {
    expect(f.app.state.selectedWorkspaceId).toBe("needs_input");
    expect(await f.frame()).toContain("> Waiting for user input");
    expect(await f.frame()).not.toContain("Waiting workspace");
    await f.input("\u0013");
    await f.input("l");
    expect(await f.frame()).toContain("Waiting workspace");
  } finally {
    await f.close();
  }
});

it("retains a mixed Working Workspace in the attention filter without changing its native bucket", async () => {
  const f = await fixture();
  try {
    await f.input("\u0013");
    await f.input("!");
    const frame = await f.frame();
    expect(frame).toContain("Working");
    expect(frame).toContain("R Mixed workspace");
    expect(frame).not.toContain("Done workspace");
    expect(f.app.state.selectedWorkspaceId).toBe("needs_input");
  } finally {
    await f.close();
  }
});
