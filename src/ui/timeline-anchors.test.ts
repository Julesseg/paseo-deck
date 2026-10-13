import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { type AppState, emptyDirectory } from "../contracts/app-state.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

function state(text: string): AppState {
  return {
    connection: "connected",
    tabOrder: {},
    activeTabIds: {},
    sessionDrafts: {},
    recovery: { attempt: 0, directoryStale: false, timelineStale: false },
    notifications: [],
    directory: emptyDirectory(),
    expandedIds: new Set(),
    filter: "",
    treeOrder: "attention",
    showArchived: false,
    attentionOnly: false,
    focus: "timeline",
    modal: { type: "none" },
    selectedAgentId: "session",
    timeline: {
      recoveryRevision: 0,
      loading: false,
      agentId: "session",
      items: [{ epoch: "e", sequence: 1, item: { id: "text", type: "user-message", text } }],
    },
    timelineNavigation: { session: { following: false, unread: 0 } },
    creationDefaults: {},
    composer: {
      drafts: {},
      histories: {},
      historyIndexes: {},
      historyDrafts: {},
      sendingAgentIds: new Set(),
      detachedAgentIds: new Set(),
    },
  };
}

it("keeps the character under the Timeline cursor through narrow reflow", async () => {
  const terminal = new RecordingTerminal(100, 30);
  const deck = new DeckTui(
    terminal,
    state(
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango",
    ),
    () => undefined,
  );
  deck.start();
  try {
    await terminal.waitForRender();
    for (const key of ["g", "g", "j", "8", "w"]) terminal.sendInput(key);
    await terminal.waitForRender();
    const before = terminal.viewportCursor();
    const character = terminal.viewport()[before.row]?.[before.column];
    expect(character).toBe("h");
    terminal.setSize(48, 30);
    await terminal.waitForRender();
    const after = terminal.viewportCursor();
    expect(terminal.viewport()[after.row]?.[after.column]).toBe(character);
  } finally {
    await deck.stop();
  }
});

it("restores a Session's exact cursor after visiting another Session", async () => {
  const terminal = new RecordingTerminal(100, 30);
  const initial = state("alpha bravo charlie delta echo foxtrot golf hotel india");
  const deck = new DeckTui(terminal, initial, () => undefined);
  deck.start();
  try {
    await terminal.waitForRender();
    for (const key of ["g", "g", "j", "8", "w"]) terminal.sendInput(key);
    await terminal.waitForRender();
    const before = terminal.viewportCursor();
    expect(terminal.viewport()[before.row]?.[before.column]).toBe("h");
    deck.update({
      ...state("different content"),
      selectedAgentId: "other",
      timeline: { ...state("different content").timeline, agentId: "other" },
    });
    await terminal.waitForRender();
    deck.update(initial);
    await terminal.waitForRender();
    const after = terminal.viewportCursor();
    expect(terminal.viewport()[after.row]?.[after.column]).toBe("h");
  } finally {
    await deck.stop();
  }
});

it("keeps the reading viewport on surviving content when older history is prepended", async () => {
  const terminal = new RecordingTerminal(100, 18);
  const initial = state(
    Array.from({ length: 40 }, (_, index) => `reading line ${index}`).join("\n\n"),
  );
  const deck = new DeckTui(terminal, initial, () => undefined);
  deck.start();
  try {
    await terminal.waitForRender();
    for (const key of ["g", "g", "2", "0", "j"]) terminal.sendInput(key);
    await terminal.waitForRender();
    const before = terminal.viewport().flatMap((line, row) => {
      const match = line.match(/reading line \d+/);
      return match ? [[row, match[0]]] : [];
    });
    expect(before.length).toBeGreaterThan(1);
    deck.update({
      ...initial,
      timeline: {
        ...initial.timeline,
        items: [
          {
            epoch: "e",
            sequence: 0,
            item: { id: "older", type: "user-message", text: "old history\n\n".repeat(20) },
          },
          ...initial.timeline.items,
        ],
      },
    });
    await terminal.waitForRender();
    expect(
      terminal.viewport().flatMap((line, row) => {
        const match = line.match(/reading line \d+/);
        return match ? [[row, match[0]]] : [];
      }),
    ).toEqual(before);
  } finally {
    await deck.stop();
  }
});

it("keeps a character selection through reflow and a streaming replacement", async () => {
  const terminal = new RecordingTerminal(100, 30);
  const initial = state("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima");
  const copied: string[] = [];
  const application = new ApplicationController(new FakePaseoGateway(initial.directory), {
    initialState: initial,
  });
  const deck = new DeckTui(
    terminal,
    application.state,
    (intent) => {
      void application.handleIntent(intent);
    },
    {
      copyText: (text) => {
        copied.push(text);
      },
    },
  );
  const unsubscribe = application.subscribe((next) => deck.update(next));
  deck.start();
  try {
    await terminal.waitForRender();
    for (const key of ["g", "g", "j", "8", "w", "v", "e"]) terminal.sendInput(key);
    await terminal.waitForRender();
    terminal.setSize(48, 30);
    await terminal.waitForRender();
    deck.update({
      ...application.state,
      timeline: state(
        "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima streamed tail",
      ).timeline,
    });
    await terminal.waitForRender();
    terminal.sendInput("y");
    await terminal.waitForRender();
    expect(copied).toEqual(["hotel"]);
  } finally {
    unsubscribe();
    await deck.stop();
  }
});

it("moves a removed cursor entry to the nearest surviving entry and invalidates its selection", async () => {
  const terminal = new RecordingTerminal(100, 30);
  const initial = state("first");
  initial.timeline = {
    ...initial.timeline,
    items: [
      ...initial.timeline.items,
      { epoch: "e", sequence: 2, item: { id: "second", type: "user-message", text: "second" } },
      { epoch: "e", sequence: 3, item: { id: "third", type: "user-message", text: "third" } },
    ],
  };
  const copied: string[] = [];
  const application = new ApplicationController(new FakePaseoGateway(initial.directory), {
    initialState: initial,
  });
  const deck = new DeckTui(
    terminal,
    application.state,
    (intent) => {
      void application.handleIntent(intent);
    },
    {
      copyText: (text) => {
        copied.push(text);
      },
    },
  );
  const unsubscribe = application.subscribe((next) => deck.update(next));
  deck.start();
  try {
    await terminal.waitForRender();
    for (const key of ["g", "g", "3", "j", "v", "e"]) terminal.sendInput(key);
    await terminal.waitForRender();
    deck.update({
      ...initial,
      timeline: {
        ...initial.timeline,
        items: initial.timeline.items.filter((event) => event.item.id !== "second"),
      },
    });
    await terminal.waitForRender();
    const cursor = terminal.viewportCursor();
    expect(terminal.viewport()[cursor.row]?.trim()).toBe("You");
    expect(terminal.viewport().join("\n")).toContain("Selection cleared:");
    terminal.sendInput("y");
    await terminal.waitForRender();
    expect(copied).toEqual([]);
  } finally {
    unsubscribe();
    await deck.stop();
  }
});

it("invalidates a selection when its text is lost inside a surviving entry", async () => {
  const terminal = new RecordingTerminal(100, 30);
  const initial = state("alpha bravo charlie delta echo foxtrot golf hotel india");
  const copied: string[] = [];
  const application = new ApplicationController(new FakePaseoGateway(initial.directory), {
    initialState: initial,
  });
  const deck = new DeckTui(
    terminal,
    initial,
    (intent) => {
      void application.handleIntent(intent);
    },
    {
      copyText: (text) => {
        copied.push(text);
      },
    },
  );
  const unsubscribe = application.subscribe((next) => deck.update(next));
  deck.start();
  try {
    await terminal.waitForRender();
    for (const key of ["g", "g", "j", "8", "w", "v", "e"]) terminal.sendInput(key);
    await terminal.waitForRender();
    deck.update({ ...application.state, timeline: state("alpha").timeline });
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Selection cleared:");
    terminal.sendInput("y");
    await terminal.waitForRender();
    expect(copied).toEqual([]);
  } finally {
    unsubscribe();
    await deck.stop();
  }
});

it("preserves duplicate rows by item and text position across gateway append, prepend and reconnect", async () => {
  const terminal = new RecordingTerminal(100, 30);
  const initial = state("same\n\nsame\n\nlast");
  initial.selectedWorkspaceId = "workspace";
  initial.directory = {
    ...emptyDirectory(),
    workspaces: [{ id: "workspace", title: "Workspace", directory: "/workspace", archived: false }],
    agents: [
      {
        id: "session",
        workspaceId: "workspace",
        title: "Session",
        status: "idle",
        availableModeIds: [],
        availableThinkingLevels: [],
        pendingPermissions: [],
        needsAttention: false,
        archived: false,
      },
    ],
  };
  initial.activeTabIds = { workspace: "session:session" };
  initial.tabOrder = { workspace: ["session:session"] };
  const gateway = new FakePaseoGateway(initial.directory);
  const application = new ApplicationController(gateway, { initialState: initial });
  const deck = new DeckTui(terminal, initial, (intent) => {
    void application.handleIntent(intent);
  });
  const unsubscribe = application.subscribe((next) => deck.update(next));
  deck.start();
  try {
    await application.start();
    gateway.emitTimeline("session", {
      type: "hydrated",
      agentId: "session",
      items: initial.timeline.items,
    });
    await terminal.waitForRender();
    for (const key of ["g", "g", "3", "j", "l", "l"]) terminal.sendInput(key);
    await terminal.waitForRender();
    const cursor = terminal.viewportCursor();
    expect(terminal.viewport()[cursor.row]?.trim()).toBe("same");
    const firstSameRow = terminal.viewport().findIndex((line) => line.trim() === "same");
    expect(cursor.row).toBeGreaterThan(firstSameRow);
    const appended = {
      epoch: "e",
      sequence: 2,
      item: { id: "append", type: "user-message" as const, text: "same" },
    };
    gateway.emitTimeline("session", { type: "event", agentId: "session", event: appended });
    await terminal.waitForRender();
    expect(terminal.viewportCursor()).toEqual(cursor);
    gateway.emitTimeline("session", {
      type: "replaced",
      agentId: "session",
      epoch: "e",
      items: [
        { epoch: "e", sequence: 0, item: { id: "older", type: "user-message", text: "same" } },
        ...initial.timeline.items,
        appended,
      ],
    });
    await terminal.waitForRender();
    const after = terminal.viewportCursor();
    expect(terminal.viewport()[after.row]?.[after.column]).toBe("s");
    terminal.sendInput("G");
    await terminal.waitForRender();
    expect(application.state.timelineNavigation.session?.following).toBe(true);
  } finally {
    unsubscribe();
    await application.releaseObservations();
    await gateway.close();
    await deck.stop();
  }
});

it("moves folded cursor content to its visible summary", async () => {
  const terminal = new RecordingTerminal(100, 30);
  const initial = state("");
  initial.timeline = {
    ...initial.timeline,
    items: [
      {
        epoch: "e",
        sequence: 1,
        item: { id: "reason", type: "reasoning", collapsed: true, text: "first\nsecond\nthird" },
      },
    ],
  };
  const deck = new DeckTui(terminal, initial, () => undefined);
  deck.toggleTimelineItem("reason");
  deck.start();
  try {
    await terminal.waitForRender();
    for (const key of ["g", "g", "4", "j"]) terminal.sendInput(key);
    await terminal.waitForRender();
    expect(terminal.viewport()[terminal.viewportCursor().row]).toContain("third");
    deck.toggleTimelineItem("reason");
    await terminal.waitForRender();
    expect(terminal.viewport()[terminal.viewportCursor().row]).toContain("Reasoning (collapsed)");
  } finally {
    await deck.stop();
  }
});

it("has no hardware cursor or yankable placeholder while the Timeline is empty or loading", async () => {
  const terminal = new RecordingTerminal(100, 30);
  const initial = state("");
  initial.timeline = { recoveryRevision: 0, loading: true, agentId: "session", items: [] };
  const copied: string[] = [];
  const deck = new DeckTui(terminal, initial, () => undefined, {
    copyText: (text) => {
      copied.push(text);
    },
  });
  deck.start();
  try {
    await terminal.waitForRender();
    for (const key of ["j", "k", "y", "y"]) terminal.sendInput(key);
    await terminal.waitForRender();
    expect(deck.tui.getShowHardwareCursor()).toBe(false);
    expect(terminal.viewport().join("\n")).toContain("Loading timeline history");
    expect(copied).toEqual([]);
  } finally {
    await deck.stop();
  }
});

it("emits a steady block cursor and highlights the full row without changing code geometry", async () => {
  const terminal = new RecordingTerminal(100, 30);
  const deck = new DeckTui(
    terminal,
    state('```ts\n  const value = "界";\n\n  return value;\n```'),
    () => undefined,
    {
      appearance: {
        color: "truecolor",
        unicode: true,
        theme: "ember",
        palette: "ember",
        symbols: "unicode",
      },
    },
  );
  deck.start();
  try {
    await terminal.waitForRender();
    const before = terminal.viewport().filter((line) => /const value|return value/u.test(line));
    for (const key of ["g", "g", "j", "j"]) terminal.sendInput(key);
    await terminal.waitForRender();
    expect(terminal.viewport().filter((line) => /const value|return value/u.test(line))).toEqual(
      before,
    );
    expect(terminal.writes.join("")).toContain("\u001b[2 q");
    const backgrounds = terminal.viewportBackgrounds()[terminal.viewportCursor().row] ?? [];
    expect(backgrounds.filter((background) => background === "#332e27").length).toBeGreaterThan(40);
    expect(terminal.viewport().join("\n")).not.toContain("▶");
  } finally {
    await deck.stop();
  }
});

it("keeps every reflowed row spanned by a line Visual selection", async () => {
  const terminal = new RecordingTerminal(100, 30);
  const initial = state("alpha bravo charlie delta echo foxtrot golf hotel india");
  const copied: string[] = [];
  const application = new ApplicationController(new FakePaseoGateway(initial.directory), {
    initialState: initial,
  });
  const deck = new DeckTui(
    terminal,
    initial,
    (intent) => {
      void application.handleIntent(intent);
    },
    {
      copyText: (text) => {
        copied.push(text);
      },
    },
  );
  const unsubscribe = application.subscribe((next) => deck.update(next));
  deck.start();
  try {
    await terminal.waitForRender();
    for (const key of ["g", "g", "j", "V"]) terminal.sendInput(key);
    await terminal.waitForRender();
    terminal.setSize(48, 30);
    await terminal.waitForRender();
    terminal.sendInput("y");
    await terminal.waitForRender();
    expect(copied[0]).toContain("alpha bravo");
    expect(copied[0]).toContain("hotel india");
  } finally {
    unsubscribe();
    await deck.stop();
  }
});

it("retains the saved Session selection while its history loads on return", async () => {
  const terminal = new RecordingTerminal(100, 30);
  const initial = state("alpha bravo charlie delta echo foxtrot golf hotel india");
  const copied: string[] = [];
  const application = new ApplicationController(new FakePaseoGateway(initial.directory), {
    initialState: initial,
  });
  const deck = new DeckTui(
    terminal,
    initial,
    (intent) => {
      void application.handleIntent(intent);
    },
    {
      copyText: (text) => {
        copied.push(text);
      },
    },
  );
  const unsubscribe = application.subscribe((next) => deck.update(next));
  deck.start();
  try {
    await terminal.waitForRender();
    for (const key of ["g", "g", "j", "8", "w", "v", "e"]) terminal.sendInput(key);
    await terminal.waitForRender();
    deck.update({ ...state("another Session"), selectedAgentId: "other" });
    await terminal.waitForRender();
    deck.update({
      ...application.state,
      timeline: { ...initial.timeline, loading: true, items: [] },
    });
    await terminal.waitForRender();
    deck.update({ ...application.state, timeline: initial.timeline });
    await terminal.waitForRender();
    terminal.sendInput("y");
    await terminal.waitForRender();
    expect(copied).toEqual(["hotel"]);
  } finally {
    unsubscribe();
    await deck.stop();
  }
});
