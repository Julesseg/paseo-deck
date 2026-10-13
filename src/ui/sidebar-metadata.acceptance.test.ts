import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import type { AppState } from "../contracts/app-state.js";
import type { DirectorySnapshot } from "../contracts/domain.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { PreferenceSession, targetScope } from "../runtime/preferences.js";
import { createInitialState } from "../state/store.js";
import { RecordingTerminal } from "./terminal.js";
import { terminalDisplayWidth } from "./text-safety.js";
import type { DeckTuiOptions } from "./views.js";
import { DeckTui } from "./views.js";

const now = Date.parse("2026-10-13T12:00:00Z");
const directory: DirectorySnapshot = {
  projects: [{ id: "p", name: "Design project" }],
  providers: [],
  agents: [],
  workspaces: [
    {
      id: "w",
      title: "Review workspace",
      status: "attention",
      activityAt: "2026-10-13T11:57:00Z",
      projectId: "p",
      directory: "/w",
      archived: false,
    },
    {
      id: "missing",
      title: "Missing native time",
      status: "done",
      projectId: "p",
      directory: "/missing",
      archived: false,
    },
  ],
};

const reviewWorkspace = directory.workspaces[0];
const missingWorkspace = directory.workspaces[1];
if (!reviewWorkspace || !missingWorkspace) throw new Error("Missing Sidebar fixtures");

async function fixture(
  options: DeckTuiOptions = {},
  initial: Partial<AppState> = {},
  snapshot = directory,
  columns = 130,
  rows = 45,
) {
  const gateway = new FakePaseoGateway(snapshot);
  const app = new ApplicationController(gateway, {
    initialState: { ...createInitialState(), ...initial },
  });
  await app.start();
  const terminal = new RecordingTerminal(columns, rows);
  const pending: Promise<void>[] = [];
  const deck = new DeckTui(
    terminal,
    app.state,
    (intent) => {
      pending.push(app.handleIntent(intent));
    },
    {
      appearance: { color: "none", unicode: false, theme: "plain", symbols: "ascii" },
      renderClock: {
        now: () => now,
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      ...options,
    },
  );
  const unsubscribe = app.subscribe((state) => deck.update(state));
  deck.start();
  return {
    terminal,
    app,
    gateway,
    async input(key: string) {
      terminal.sendInput(key);
      await Promise.all(pending.splice(0));
      await terminal.waitForRender();
    },
    async frame() {
      await terminal.waitForRender();
      return terminal.viewport();
    },
    async close() {
      unsubscribe();
      await deck.stop();
      await app.releaseObservations();
      await gateway.close();
    },
  };
}

it("renders Project metadata and native ages below Workspace titles, switching to Status metadata in Project grouping", async () => {
  const f = await fixture();
  try {
    const lines = await f.frame();
    const title = lines.findIndex((line) => line.includes("Review workspace"));
    expect(lines[title + 1]).toContain("[/] [ Design project ]");
    expect(lines[title + 1]).toContain("[t] 3m");
    const missing = lines.findIndex((line) => line.includes("Missing native time"));
    expect(lines[missing + 1]).toContain("[t] -");
    await f.input("\u0013");
    await f.input("s");
    await f.input("g");
    await f.input("g");
    await f.input("l");
    const project = await f.frame();
    const projectTitle = project.findIndex((line) => line.includes("Review workspace"));
    expect(project[projectTitle + 1]).toContain("[/] [ Ready to review ]");
    expect(project[projectTitle + 1]).toContain("[t] 3m");
  } finally {
    await f.close();
  }
});

it("keeps blank rows around headings and reveals both lines of the highlighted Workspace in a short Sidebar", async () => {
  const snapshot: DirectorySnapshot = {
    ...directory,
    workspaces: Array.from({ length: 12 }, (_, index) => ({
      ...reviewWorkspace,
      id: `workspace-${index}`,
      title: `Workspace ${String(index).padStart(2, "0")}`,
      status: "done" as const,
    })),
  };
  const f = await fixture({}, {}, snapshot, 130, 12);
  try {
    await f.input("\u0013");
    await f.input("g");
    await f.input("g");
    const lines = await f.frame();
    const heading = lines.findIndex((line) => line.includes("v Done"));
    expect(lines[heading - 1]?.slice(0, 34).trim()).toBe("");
    expect(lines[heading + 1]?.slice(0, 34).trim()).toBe("");
    await f.input("j");
    expect(f.app.state.sidebarSelection?.id).toBe("workspace-0");
    await f.input("G");
    const bottom = await f.frame();
    const title = bottom.findIndex((line) => line.includes("Workspace 11"));
    expect(title).toBeGreaterThanOrEqual(0);
    expect(bottom[title + 1]).toContain("Design project");
    expect(bottom[title + 1]).toContain("[t] 3m");
  } finally {
    await f.close();
  }
});

it("refreshes compact native ages without a gateway update and releases the refresh timer on exit", async () => {
  let time = now;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const f = await fixture(
    {
      renderClock: {
        now: () => time,
        setTimeout: (callback, delay) => {
          const id = ++nextId;
          timers.set(id, { at: time + delay, callback });
          return id;
        },
        clearTimeout: (handle) => {
          timers.delete(handle as number);
        },
      },
    },
    {},
    {
      ...directory,
      workspaces: [
        { ...reviewWorkspace, activityAt: new Date(now).toISOString() },
        {
          ...missingWorkspace,
          id: "hour",
          title: "Hour workspace",
          activityAt: "2026-10-13T10:00:00Z",
        },
        {
          ...missingWorkspace,
          id: "day",
          title: "Day workspace",
          activityAt: "2026-10-09T12:00:00Z",
        },
        {
          ...missingWorkspace,
          id: "invalid",
          title: "Invalid native time",
          activityAt: "invalid",
        },
      ],
    },
  );
  try {
    const initial = (await f.frame()).join("\n");
    expect(initial).toContain("[t] now");
    expect(initial).toContain("[t] 2h");
    expect(initial).toContain("[t] 4d");
    expect(initial).toContain("[t] -");
    time += 180_000;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= time) {
        timers.delete(id);
        timer.callback();
      }
    }
    expect((await f.frame()).join("\n")).toContain("[t] 3m");
  } finally {
    await f.close();
  }
  expect(timers.size).toBe(0);
});

it("uses a 51-column default, persists keyboard resizing up to 72, and preserves saved custom widths", async () => {
  let saved = '{"version":1,"global":{},"targets":{}}';
  const fs = {
    readFile: async () => saved,
    writeAtomic: async (_path: string, value: string) => {
      saved = value;
    },
    remove: async () => {},
  };
  const preferences = await PreferenceSession.open({ type: "default" }, { fs });
  expect(preferences.treeWidth()).toBe(51);
  const f = await fixture({
    treeWidth: preferences.treeWidth(),
    onPreferencesChanged: (value) => preferences.present(value),
  });
  try {
    const lines = await f.frame();
    expect(lines.find((line) => line.includes("[t] 3m"))?.indexOf("[t]")).toBe(44);
    await f.input("\u0013");
    for (let index = 0; index < 12; index++) await f.input("]");
    expect((await f.frame()).find((line) => line.includes("[t] 3m"))?.indexOf("[t]")).toBe(65);
    await preferences.flush();
  } finally {
    await f.close();
  }
  const restored = await PreferenceSession.open({ type: "default" }, { fs });
  expect(restored.treeWidth()).toBe(72);
  saved = JSON.stringify({
    version: 1,
    global: {},
    targets: { [targetScope({ type: "default" })]: { treeWidth: 33 } },
  });
  const custom = await PreferenceSession.open({ type: "default" }, { fs });
  expect(custom.treeWidth()).toBe(33);
  const restarted = await fixture({ treeWidth: custom.treeWidth() });
  try {
    expect((await restarted.frame()).find((line) => line.includes("[t] 3m"))?.indexOf("[t]")).toBe(
      26,
    );
  } finally {
    await restarted.close();
  }
});

it("switches to a drawer when the selected Sidebar width would leave fewer than 40 Main columns, preserving narrow behavior", async () => {
  const f = await fixture({}, {}, directory, 93, 30);
  try {
    expect((await f.frame()).join("\n")).toContain("Projects / workspaces");
    f.terminal.setSize(92, 30);
    expect((await f.frame()).join("\n")).not.toContain("Projects / workspaces");
    await f.input("\u0013");
    expect((await f.frame()).join("\n")).toContain("Projects / workspaces");
    await f.input("\u001b");
    expect((await f.frame()).join("\n")).not.toContain("Projects / workspaces");
    f.terminal.setSize(93, 30);
    expect((await f.frame()).join("\n")).toContain("Projects / workspaces");
    await f.input("\u0013");
    await f.input("]");
    await f.input("\u001b");
    expect((await f.frame()).join("\n")).not.toContain("Projects / workspaces");
    await f.input("\u0013");
    await f.input("[");
    await f.input("\u001b");
    expect((await f.frame()).join("\n")).toContain("Projects / workspaces");
  } finally {
    await f.close();
  }
  const narrow = await fixture({ treeWidth: 18 }, {}, directory, 69, 30);
  try {
    expect((await narrow.frame()).join("\n")).not.toContain("Projects / works");
    narrow.terminal.setSize(70, 30);
    expect((await narrow.frame()).join("\n")).toContain("Projects / works");
  } finally {
    await narrow.close();
  }
});

it.each(["unicode", "ascii"] as const)(
  "reserves a complete right-aligned age before clipping wide Project text in %s appearances",
  async (symbols) => {
    const f = await fixture(
      {
        treeWidth: 24,
        appearance: { color: "none", unicode: symbols === "unicode", theme: "plain", symbols },
      },
      {},
      {
        ...directory,
        projects: [{ id: "p", name: "界界界界界界界界 project metadata" }],
      },
    );
    try {
      const lines = await f.frame();
      const title = lines.findIndex((line) => line.includes("Review workspace"));
      const metadata = lines[title + 1] ?? "";
      const clock = symbols === "unicode" ? "◷ 3m" : "[t] 3m";
      expect(metadata).toContain(clock);
      expect(terminalDisplayWidth(metadata.slice(0, metadata.indexOf(clock)))).toBe(
        symbols === "unicode" ? 19 : 17,
      );
      expect(metadata).toContain(symbols === "unicode" ? "▱ [ 界界界界… ]" : "[/] [ 界... ]");
      expect(metadata).not.toContain("project metadata");
    } finally {
      await f.close();
    }
  },
);
