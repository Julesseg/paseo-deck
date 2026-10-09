import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import type { TimelineEvent } from "../contracts/domain.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

async function fixture(text = "", events?: TimelineEvent[]) {
  const gateway = new FakePaseoGateway({
    projects: [],
    providers: [],
    workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
    agents: [
      {
        id: "a",
        workspaceId: "w",
        title: "Session",
        status: "idle",
        archived: false,
        availableModeIds: [],
        availableThinkingLevels: [],
        pendingPermissions: [],
        needsAttention: false,
      },
    ],
  });
  const app = new ApplicationController(gateway);
  await app.start();
  gateway.emitTimeline("a", {
    type: "hydrated",
    agentId: "a",
    items:
      events ??
      (text ? [{ epoch: "e", sequence: 1, item: { id: "text", type: "user-message", text } }] : []),
  });
  const terminal = new RecordingTerminal(90, 26);
  let clipboard = "outside";
  const opened: string[] = [];
  const deck = new DeckTui(
    terminal,
    app.state,
    (intent) => {
      void app.handleIntent(intent);
    },
    {
      openLink: (url) => {
        opened.push(url);
      },
      clipboard: {
        read: () => clipboard,
        write: (value) => {
          clipboard = value;
        },
      },
    },
  );
  const stop = app.subscribe((state) => deck.update(state));
  await deck.start();
  await terminal.waitForRender();
  return {
    app,
    gateway,
    opened,
    terminal,
    deck,
    keys: async (...keys: string[]) => {
      for (const key of keys) terminal.sendInput(key);
      await terminal.waitForRender();
    },
    clipboard: () => clipboard,
    close: async () => {
      stop();
      await deck.stop();
      await app.releaseObservations();
    },
  };
}

it("first Timeline focus starts at the beginning of its final displayed row", async () => {
  const f = await fixture("alpha first row\nsecond row\nlast row with a long ending");
  try {
    await f.keys("\u000b");
    const initial = f.terminal.viewportCursor();
    const initialRow = f.terminal.viewport()[initial.row];
    await f.keys("0");
    const beginning = f.terminal.viewportCursor();
    expect(initialRow).toContain("last row with a long ending");
    expect(
      initial.column,
      `firstfocus ${JSON.stringify(initial)} vs rowbeginning ${JSON.stringify(beginning)}`,
    ).toBe(beginning.column);
  } finally {
    await f.close();
  }
});

it("keeps a vertical screen-column goal across separately rendered ordinary rows", async () => {
  const f = await fixture("alpha enough width\nsecond row long\nthird anotherline");
  try {
    await f.keys("\u000b", "g", "g", "j", "0", "l", "l", "l", "l", "l", "l");
    const goal = f.terminal.viewportCursor().column;
    const row = f.terminal.viewportCursor().row;
    await f.keys("j");
    expect(f.terminal.viewportCursor()).toEqual({ row: row + 1, column: goal });
    await f.keys("j");
    expect(f.terminal.viewportCursor()).toEqual({ row: row + 2, column: goal });
    await f.keys("k");
    expect(f.terminal.viewportCursor()).toEqual({ row: row + 1, column: goal });
  } finally {
    await f.close();
  }
});

it("reaches every collapsed tool row through cloned hydration and separately rendered j/k", async () => {
  const items: TimelineEvent[] = [
    { epoch: "e", sequence: 1, item: { id: "before", type: "user-message", text: "before tools" } },
    ...(["running", "completed", "failed"] as const).map((status, i) => ({
      epoch: "e",
      sequence: i + 2,
      item: {
        id: `tool${i}`,
        type: "tool" as const,
        callId: `c${i}`,
        name: "read_file",
        status,
        summary: "duplicate summary",
        output: "same line\nsame line",
      },
    })),
    { epoch: "e", sequence: 5, item: { id: "after", type: "user-message", text: "after tools" } },
  ];
  const f = await fixture("", items);
  try {
    await f.keys("\u000b", "G", "0");
    const last = f.terminal.viewportCursor().row;
    await f.keys("g", "g", "0");
    const first = f.terminal.viewportCursor().row;
    for (let row = first; row < last; row++) {
      f.gateway.emitTimeline("a", {
        type: "hydrated",
        agentId: "a",
        items: structuredClone(items),
      });
      await f.terminal.waitForRender();
      await f.keys("j");
      expect(
        f.terminal.viewportCursor().row,
        `down from ${row}: ${f.terminal.viewport()[row]}`,
      ).toBe(row + 1);
    }
    for (let row = last; row > first; row--) {
      f.gateway.emitTimeline("a", {
        type: "hydrated",
        agentId: "a",
        items: structuredClone(items),
      });
      await f.terminal.waitForRender();
      await f.keys("k");
      expect(f.terminal.viewportCursor().row, `up from ${row}`).toBe(row - 1);
    }
  } finally {
    await f.close();
  }
});

it("restores its preferred screen column after short blank indented and Unicode rows", async () => {
  const f = await fixture(
    "alpha enough width\nx\n\n   indented long row\n界界界界abcdefghijk\néééabcdefghijk\nfinal enough width",
  );
  try {
    await f.keys("\u000b", "g", "g", "j", "0", "8", "l");
    const goal = f.terminal.viewportCursor().column;
    for (const label of ["short", "blank", "indented", "wide", "combining", "final"]) {
      await f.keys("j");
      const cursor = f.terminal.viewportCursor();
      if (!["short", "blank"].includes(label))
        expect(
          cursor.column,
          `${label} ${JSON.stringify(cursor)}: ${f.terminal.viewport()[cursor.row]}`,
        ).toBe(goal);
    }
    for (const label of ["combining", "wide", "indented"]) {
      await f.keys("k");
      expect(f.terminal.viewportCursor().column, label).toBe(goal);
    }
  } finally {
    await f.close();
  }
});

it("traverses every expanded wrapped diff tool row and synthetic Turn row", async () => {
  const items: TimelineEvent[] = [
    { epoch: "e", sequence: 1, item: { id: "turn", type: "turn", turnId: "t", status: "started" } },
    {
      epoch: "e",
      sequence: 2,
      item: {
        id: "diff",
        type: "tool",
        callId: "d",
        name: `apply_patch_${"x".repeat(120)}`,
        status: "completed",
        summary: "x".repeat(150),
        output: "x".repeat(300),
        detail: {
          kind: "file-write",
          path: "sample.ts",
          diff: "@@ aaaaa @@\n-aaaaa\n+aaaaa\n\n@@ aaaaa @@\n-aaaaa\n+aaaaa",
        },
      },
    },
    { epoch: "e", sequence: 3, item: { id: "after", type: "user-message", text: "after" } },
  ];
  const f = await fixture("", items);
  try {
    await f.keys("\u000b", "g", "g");
    await f.keys("j");
    await f.keys("z", "a");
    await f.keys("G", "0");
    expect(f.terminal.viewport().join("\n")).toContain("-aaaaa");
    const last = f.terminal.viewportCursor().row;
    await f.keys("g", "g", "0");
    const first = f.terminal.viewportCursor().row;
    for (let row = first; row < last; row++) {
      f.gateway.emitTimeline("a", {
        type: "hydrated",
        agentId: "a",
        items: structuredClone(items),
      });
      await f.terminal.waitForRender();
      await f.keys("j");
      expect(
        f.terminal.viewportCursor().row,
        `down from ${row}: ${f.terminal.viewport()[row]}`,
      ).toBe(row + 1);
    }
  } finally {
    await f.close();
  }
});

it("keeps a clipped tool body cursor while status duration and appended output change", async () => {
  const tool = {
    epoch: "e",
    sequence: 1,
    item: {
      id: "tool",
      type: "tool",
      callId: "c",
      name: `long_${"x".repeat(120)}`,
      status: "running",
      durationMs: 10,
      output: "first output\nsame output\nsame output\nlast output",
    },
  } satisfies TimelineEvent;
  const f = await fixture("", [tool]);
  try {
    await f.keys("\u000b", "g", "g", "j", "j", "j", "0", "4", "l");
    const before = f.terminal.viewportCursor();
    const line = f.terminal.viewport()[before.row];
    expect(line).toContain("same output");
    f.gateway.emitTimeline("a", {
      type: "hydrated",
      agentId: "a",
      items: [
        {
          ...tool,
          item: {
            ...tool.item,
            type: "tool",
            callId: "c",
            name: `long_${"x".repeat(120)}`,
            status: "completed",
            durationMs: 1234,
            output: "first output\nsame output\nsame output\nlast output\nappended output",
          },
        },
      ],
    });
    await f.terminal.waitForRender();
    expect(f.terminal.viewportCursor()).toEqual(before);
    expect(f.terminal.viewport()[before.row]).toBe(line);
    await f.keys("j");
    expect(f.terminal.viewportCursor().row).toBe(before.row + 1);
    f.terminal.setSize(110, 30);
    await f.terminal.waitForRender();
    expect(f.terminal.viewport()[f.terminal.viewportCursor().row]).toContain("same output");
    await f.keys("\u0013", "\u0004", "\u000b");
    expect(f.terminal.viewport()[f.terminal.viewportCursor().row]).toContain("same output");
  } finally {
    await f.close();
  }
});

it("copies tool headings without decorative hierarchy padding", async () => {
  const f = await fixture("", [
    {
      epoch: "e",
      sequence: 1,
      item: {
        id: "tool",
        type: "tool",
        callId: "c",
        name: "git",
        status: "completed",
        output: "actual output",
      },
    },
  ]);
  try {
    await f.keys("\u000b", "g", "g");
    await f.keys("j", "0", "y", "y");
    expect(f.clipboard()).toBe("Tool completed: git");
    await f.keys("v", "0", "$", "y");
    expect(f.clipboard()).toBe("Tool completed: git");
  } finally {
    await f.close();
  }
});
