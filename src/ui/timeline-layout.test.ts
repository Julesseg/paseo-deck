import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import type { TerminalAppearance } from "./capabilities.js";
import { RecordingTerminal } from "./terminal.js";
import { terminalDisplayWidth } from "./text-safety.js";
import { DeckTui } from "./views.js";

async function fixture(
  columns: number,
  treeWidth: number,
  options: { rows?: number; appearance?: TerminalAppearance; text?: string; user?: boolean } = {},
) {
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
    items: [
      {
        epoch: "e",
        sequence: 1,
        item: {
          id: "message",
          type: options.user ? "user-message" : "assistant-message",
          messageId: "message",
          text: options.text ?? `READING ${"word ".repeat(60)}`,
        },
      },
    ],
  });
  const terminal = new RecordingTerminal(columns, options.rows ?? 30);
  let clipboard = "outside";
  const deck = new DeckTui(
    terminal,
    app.state,
    (intent) => {
      void app.handleIntent(intent);
    },
    {
      treeWidth,
      clipboard: {
        read: () => clipboard,
        write: (text) => {
          clipboard = text;
        },
      },
      appearance: options.appearance ?? {
        color: "truecolor",
        unicode: true,
        theme: "ember",
        symbols: "unicode",
        background: [28, 25, 23],
      },
    },
  );
  const unsubscribe = app.subscribe((state) => deck.update(state));
  await deck.start();
  await terminal.waitForRender();
  return {
    app,
    gateway,
    terminal,
    deck,
    clipboard: () => clipboard,
    close: async () => {
      unsubscribe();
      await deck.stop();
      await app.releaseObservations();
      await gateway.close();
    },
  };
}

it.each([
  [487, 34],
  [320, 48],
  [200, 34],
  [160, 18],
  [200, 48],
  [100, 34],
  [70, 48],
  [64, 34],
  [52, 34],
])(
  "reading column uses Main pane width and symmetric gutters at %s / Sidebar %s",
  async (columns, treeWidth) => {
    const f = await fixture(
      columns,
      treeWidth,
      columns === 70 ? { text: `READING ${"word ".repeat(10)}` } : {},
    );
    try {
      const lines = f.terminal.viewport();
      const mainStart = columns < 70 || columns - treeWidth - 2 < 40 ? 0 : treeWidth + 2;
      const row = lines.findIndex((line) => line.includes("Prompt"));
      const backgrounds = f.terminal.viewportBackgrounds()[row] ?? [];
      const painted = backgrounds.flatMap((color, column) =>
        color && column >= mainStart ? [column] : [],
      );
      const left = painted[0] ?? -1;
      const right = painted.at(-1) ?? -1;
      const width = right - left + 1;
      const leftGutter = left - mainStart;
      const rightGutter = columns - 1 - right;
      expect(
        width,
        JSON.stringify({ mainStart, left, right, width, leftGutter, rightGutter }),
      ).toBe(Math.min(144, columns - mainStart - 2));
      expect(Math.abs(leftGutter - rightGutter)).toBeLessThanOrEqual(1);
      const text = lines.find((line) => line.includes("READING")) ?? "";
      expect(text.indexOf("READING") - left).toBe(2);
      const tab = lines[0] ?? "";
      expect(tab.indexOf("Session") - left).toBeLessThanOrEqual(5);
      expect(tab.indexOf("Session")).toBeGreaterThanOrEqual(left);
      if (width > 100)
        expect(terminalDisplayWidth(text.trimEnd()) - text.indexOf("READING")).toBeGreaterThan(100);
    } finally {
      await f.close();
    }
  },
);

it("resizes the same assembled Main pane with symmetric reading bounds and stable draft", async () => {
  const f = await fixture(487, 48, { rows: 75 });
  try {
    f.app.setComposerText("retained Composer text");
    for (const [columns, rows] of [
      [320, 45],
      [100, 28],
      [64, 24],
      [52, 24],
      [487, 75],
    ] as const) {
      f.terminal.setSize(columns, rows);
      await f.terminal.waitForRender();
      const lines = f.terminal.viewport();
      const mainStart = columns < 70 ? 0 : 50;
      const row = lines.findIndex((line) => line.includes("Prompt"));
      const painted = (f.terminal.viewportBackgrounds()[row] ?? []).flatMap((color, column) =>
        color && column >= mainStart ? [column] : [],
      );
      const left = painted[0] ?? -1,
        right = painted.at(-1) ?? -1;
      expect(right - left + 1).toBe(Math.min(144, columns - mainStart - 2));
      expect(Math.abs(left - mainStart - (columns - right - 1))).toBeLessThanOrEqual(1);
      expect(f.app.state.composer.drafts.a).toBe("retained Composer text");
      expect(lines.join("\n")).toContain("READING");
    }
  } finally {
    await f.close();
  }
});

it.each(["truecolor", "none"] as const)(
  "populated Unicode lines use the widened column in %s without clipping graphemes",
  async (color) => {
    const f = await fixture(320, 34, {
      text: `READING ${"界e\u0301 ".repeat(100)}`,
      appearance: { color, unicode: true, theme: "ember", symbols: "unicode" },
    });
    try {
      const lines = f.terminal.viewport();
      const reading = lines.find((line) => line.includes("READING")) ?? "";
      // Main starts36; width144 has70cells left gutter. Body indent2 is preserved.
      expect(reading.indexOf("READING")).toBe(108);
      const body = reading.slice(reading.indexOf("READING")).trimEnd();
      expect(terminalDisplayWidth(body)).toBeGreaterThan(120);
      expect(terminalDisplayWidth(body)).toBeLessThanOrEqual(142);
      expect(body).toContain("界e\u0301");
      expect(f.gateway.commands).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it("search query remains inside the reading column while Composer and Tabs stay visible", async () => {
  const f = await fixture(200, 34);
  try {
    for (const key of ["\u000b", "/", "READING"]) {
      f.terminal.sendInput(key);
      await f.terminal.waitForRender();
    }
    const lines = f.terminal.viewport();
    const query = lines.find((line) => line.includes("/ READING")) ?? "";
    expect(query.indexOf("/ READING")).toBe(46);
    expect(lines.join("\n")).toContain("Prompt → Session");
    expect(lines[0]).toContain("Session");
    expect(f.app.state.composer.drafts.a ?? "").toBe("");
  } finally {
    await f.close();
  }
});

it.each([200, 64])(
  "direct Terminal content stays inside the Main pane at %s columns",
  async (columns) => {
    const f = await fixture(columns, 34);
    try {
      f.gateway.terminals = [{ id: "t", workspaceId: "w", name: "Shell", cwd: "/tmp" }];
      await f.app.handleIntent({ type: "refresh" });
      await f.app.handleIntent({ type: "open-terminal", terminalId: "t" });
      f.gateway.emitTerminal({
        type: "output",
        terminalId: "t",
        data: new TextEncoder().encode(`TERMINAL ${"x".repeat(180)}\r\n`),
      });
      await f.terminal.waitForRender();
      const line = f.terminal.viewport().find((line) => line.includes("TERMINAL")) ?? "";
      const start = columns === 200 ? 46 : 1;
      expect(line.indexOf("TERMINAL")).toBe(start);
      expect(terminalDisplayWidth(line.trimEnd()) - start).toBe(
        Math.min(144, columns - (columns < 70 ? 0 : 36) - 2),
      );
      f.terminal.sendInput("x");
      expect(f.gateway.terminalInput).toEqual([{ terminalId: "t", data: "x" }]);
    } finally {
      await f.close();
    }
  },
);

it("Sidebar width changes recenter the shared column without changing Active session", async () => {
  const f = await fixture(200, 34);
  try {
    f.terminal.sendInput("\u0013");
    for (const key of ["]", "]", "]", "["]) {
      f.terminal.sendInput(key);
      await f.terminal.waitForRender();
    }
    // Sidebar38 + gap2 leaves Main160; column144 has8-cell gutters.
    const lines = f.terminal.viewport();
    const row = lines.findIndex((line) => line.includes("Prompt"));
    const painted = (f.terminal.viewportBackgrounds()[row] ?? []).flatMap((color, column) =>
      color && column >= 40 ? [column] : [],
    );
    expect(painted[0]).toBe(48);
    expect(painted.at(-1)).toBe(191);
    expect(f.app.state.selectedAgentId).toBe("a");
  } finally {
    await f.close();
  }
});

it("Workspace controls share the centered Composer column", async () => {
  const f = await fixture(200, 34);
  try {
    await f.app.handleIntent({ type: "open-new-workspace" });
    await f.terminal.waitForRender();
    const lines = f.terminal.viewport();
    const controls = lines.filter((line) => line.includes("Project") || line.includes("Placement"));
    expect(controls.length).toBeGreaterThan(0);
    for (const line of controls.filter((line) => !line.includes("workspaces"))) {
      expect(line.trim().length).toBeGreaterThan(0);
      expect(line.search(/\S/u)).toBeGreaterThanOrEqual(46);
      expect(terminalDisplayWidth(line.trimEnd())).toBeLessThanOrEqual(190);
    }
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.close();
  }
});

it("Visual content selection survives width reflow of the same centered column", async () => {
  const f = await fixture(100, 34, { text: `alpha target omega ${"word ".repeat(30)}` });
  try {
    for (const key of ["\u000b", "g", "g", "j", "^", "v", "l", "l"]) {
      f.terminal.sendInput(key);
      await f.terminal.waitForRender();
    }
    f.terminal.setSize(200, 30);
    await f.terminal.waitForRender();
    expect(f.app.state.timelineMode).toBe("visual");
    f.terminal.sendInput("y");
    await f.terminal.waitForRender();
    expect(f.clipboard()).toBe("alp");
    expect(f.app.state.composer.drafts.a ?? "").toBe("");
  } finally {
    await f.close();
  }
});

it("right-aligns a bounded user block while assistant text stays at the reading edge", async () => {
  const f = await fixture(140, 34, { rows: 40, text: "User body", user: true });
  try {
    f.gateway.emitTimeline("a", {
      type: "event",
      agentId: "a",
      event: {
        epoch: "e",
        sequence: 2,
        item: {
          id: "assistant",
          type: "assistant-message",
          messageId: "assistant",
          text: "Assistant body",
        },
      },
    });
    await f.terminal.waitForRender();
    const lines = f.terminal.viewport();
    const userRow = lines.findIndex((line) => line.includes("User body"));
    const assistantRow = lines.findIndex((line) => line.includes("Assistant body"));
    const backgrounds = f.terminal.viewportBackgrounds()[userRow] ?? [];
    const painted = backgrounds.flatMap((color, column) => (color && column > 34 ? [column] : []));
    expect(painted).toHaveLength(76);
    expect(painted[0]).toBe(63);
    expect(painted.at(-1)).toBe(138);
    expect(lines[userRow]?.indexOf("User body")).toBe(65);
    expect(lines[assistantRow]?.indexOf("Assistant body")).toBe(39);
    expect(f.terminal.viewportBackgrounds()[assistantRow]?.slice(37)).not.toContain(
      backgrounds[65],
    );
  } finally {
    await f.close();
  }
});

it("copies a right-aligned user row without its alignment gutter", async () => {
  const f = await fixture(140, 34, { rows: 40, text: "User body", user: true });
  try {
    for (const key of ["\u000b", "g", "g", "j", "y", "y"]) f.terminal.sendInput(key);
    await f.terminal.waitForRender();
    expect(f.clipboard()).toBe("User body");
  } finally {
    await f.close();
  }
});

it("paints consecutive tools across the reading column and leaves assistant output unpainted", async () => {
  const f = await fixture(140, 34, { rows: 40, text: "User body", user: true });
  try {
    f.gateway.emitTimeline("a", {
      type: "hydrated",
      agentId: "a",
      items: [
        {
          epoch: "tools",
          sequence: 1,
          item: {
            id: "tool1",
            type: "tool",
            callId: "c1",
            name: "shell",
            status: "completed",
            output: "first output",
          },
        },
        {
          epoch: "tools",
          sequence: 2,
          item: {
            id: "tool2",
            type: "tool",
            callId: "c2",
            name: "shell",
            status: "failed",
            failureSummary: "exit 1",
            output: "failed output",
          },
        },
        {
          epoch: "tools",
          sequence: 3,
          item: { id: "assistant", type: "assistant-message", messageId: "m", text: "After tools" },
        },
      ],
    });
    await f.terminal.waitForRender();
    const lines = f.terminal.viewport();
    for (const text of ["Tool completed", "first output", "Tool failed", "failed output"]) {
      const row = lines.findIndex((line) => line.includes(text));
      const cells = f.terminal.viewportBackgrounds()[row]?.slice(37, 139);
      expect(cells?.every((cell) => cell && cell === cells[0])).toBe(true);
    }
    expect(lines.some((line) => line.slice(37, 139) === "─".repeat(102))).toBe(true);
    const assistant = lines.findIndex((line) => line.includes("After tools"));
    expect(
      f.terminal
        .viewportBackgrounds()
        [assistant]?.slice(37, 139)
        .every((cell) => !cell),
    ).toBe(true);
    for (const key of ["\u000b", "g", "g", "V", "G", "y"]) f.terminal.sendInput(key);
    await f.terminal.waitForRender();
    expect(f.clipboard()).not.toContain("─".repeat(3));
    expect(f.clipboard()).toContain("failed output");
  } finally {
    await f.close();
  }
});

it("leaves a blank reading row between messages and consecutive tool blocks", async () => {
  const f = await fixture(140, 34, { rows: 40, text: "seed" });
  try {
    f.gateway.emitTimeline("a", {
      type: "replaced",
      epoch: "spacing",
      agentId: "a",
      items: [
        {
          epoch: "spacing",
          sequence: 1,
          item: { id: "user", type: "user-message", text: "User spacing body" },
        },
        {
          epoch: "spacing",
          sequence: 2,
          item: {
            id: "assistant",
            type: "assistant-message",
            messageId: "a",
            text: "Assistant spacing body",
          },
        },
        {
          epoch: "spacing",
          sequence: 3,
          item: {
            id: "tool-one",
            type: "tool",
            callId: "c1",
            name: "first-tool",
            status: "completed",
          },
        },
        {
          epoch: "spacing",
          sequence: 4,
          item: {
            id: "tool-two",
            type: "tool",
            callId: "c2",
            name: "second-tool",
            status: "completed",
          },
        },
      ],
    });
    await f.terminal.waitForRender();
    const lines = f.terminal.viewport().map((line) => line.slice(37, 139).trim());
    for (const label of [
      "Assistant",
      "Tool completed: first-tool",
      "Tool completed: second-tool",
    ]) {
      const index = lines.findIndex((line) => line === label || line.startsWith(label));
      expect(index).toBeGreaterThan(0);
      expect(lines[index - 1]).toBe("");
    }
  } finally {
    await f.close();
  }
});

it("copies wrapped user content through Visual reflow without adding padding or soft-wrap newlines", async () => {
  const text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima 世界 end";
  const f = await fixture(100, 34, { rows: 40, text, user: true });
  try {
    for (const key of ["\u000b", "g", "g", "j", "^", "v", "G", "$"]) f.terminal.sendInput(key);
    await f.terminal.waitForRender();
    f.terminal.setSize(52, 40);
    await f.terminal.waitForRender();
    f.terminal.sendInput("y");
    await f.terminal.waitForRender();
    expect(f.clipboard()).toBe(text);
  } finally {
    await f.close();
  }
});

it("keeps expanded tool output on its surface when folded and updated", async () => {
  const f = await fixture(140, 34, { rows: 40, text: "User body", user: true });
  const item = {
    id: "longtool",
    type: "tool" as const,
    callId: "longtool",
    name: "read_file",
    status: "running" as const,
    summary: "Reading source",
    output: `first line\n${"Expanded tool output.\n".repeat(12)}`,
  };
  try {
    f.gateway.emitTimeline("a", {
      type: "event",
      agentId: "a",
      event: { epoch: "e", sequence: 2, item },
    });
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).not.toContain("Expanded tool output.");
    for (const key of ["\u000b", "G", "z", "a"]) f.terminal.sendInput(key);
    await f.terminal.waitForRender();
    const row = f.terminal.viewport().findIndex((line) => line.includes("Expanded tool output."));
    expect(row).toBeGreaterThan(0);
    const cells = f.terminal.viewportBackgrounds()[row]?.slice(37, 139);
    expect(cells?.every((cell) => cell && cell === cells[0])).toBe(true);
    for (const key of ["g", "g", "G", "z", "a"]) f.terminal.sendInput(key);
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).not.toContain("Expanded tool output.");
  } finally {
    await f.close();
  }
});
