import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

async function fixture(text = "") {
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
    items: text
      ? [{ epoch: "e", sequence: 1, item: { id: "text", type: "user-message", text } }]
      : [],
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
it("empty Timeline Escape restores the saved Composer and cancels a count first", async () => {
  const f = await fixture();
  try {
    await f.keys("i", "draft", "\u0013", "\u000b", "2", "\u001b");
    expect(f.app.state.focus).toBe("timeline");
    await f.keys("\u001b");
    expect(f.app.state.focus).toBe("composer");
    expect(f.app.state.composerMode).toBe("insert");
    await f.keys("X");
    expect(f.app.state.composer.drafts.a).toBe("draftX");
  } finally {
    await f.close();
  }
});
it("copies counted displayed rows and shared motion ranges directly without editing", async () => {
  const f = await fixture("alpha bravo\n\ncharlie delta\n\necho foxtrot");
  try {
    await f.keys("\u000b", "g", "g", "j", "^", "y", "w");
    expect(f.clipboard()).toBe("alpha ");
    await f.keys("2", "y", "y");
    expect(f.clipboard()).toBe("alpha bravo\n");
    await f.keys("y", "i", "v");
    expect(f.clipboard()).toBe("alpha bravo\n");
    await f.keys("i", "x", "p", "\r");
    expect(f.app.state.composer.drafts.a ?? "").toBe("");
  } finally {
    await f.close();
  }
});
it("Visual half-page scroll preserves endpoints and Visual G never resumes following", async () => {
  const f = await fixture(Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n\n"));
  try {
    await f.keys("\u000b", "g", "g", "j", "^", "v", "l", "\u0004");
    expect(f.app.state.timelineNavigation.a?.following).toBe(false);
    await f.keys("y");
    expect(f.clipboard()).toBe("li");
    expect(f.app.state.timelineMode).toBe("normal");
    await f.keys("g", "g", "j", "^", "v", "G");
    expect(f.app.state.timelineNavigation.a?.following).toBe(false);
    await f.keys("\u001b");
    await f.keys("G");
    expect(f.app.state.timelineNavigation.a?.following).toBe(true);
  } finally {
    await f.close();
  }
});
it("switches Visual type without losing the anchor, swaps endpoints and restores same-Session selection", async () => {
  const f = await fixture("alpha bravo charlie");
  try {
    await f.keys("\u000b", "g", "g", "j", "^", "v", "4", "l", "o", "l", "y");
    expect(f.clipboard()).toBe("lpha");
    await f.keys("g", "v", "y");
    expect(f.clipboard()).toBe("lpha");
    await f.keys("g", "v", "V", "v", "y");
    expect(f.clipboard()).toBe("lpha");
    await f.keys("g", "v", "v");
    expect(f.app.state.timelineMode).toBe("normal");
  } finally {
    await f.close();
  }
});
it("character copies rejoin wraps and retain real breaks while row copies keep displayed rows", async () => {
  const text =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar\n\nsecond paragraph";
  const f = await fixture(text);
  try {
    await f.keys("\u000b", "g", "g", "j", "^", "v", "G", "y");
    expect(f.clipboard()).toBe(text);
    await f.keys("g", "g", "j", "V", "G", "Y");
    expect(f.clipboard()).toContain("\n");
    expect(f.clipboard()).not.toBe(text);
    expect(f.clipboard()).toContain("second paragraph");
  } finally {
    await f.close();
  }
});
it("background scroll preserves input and refocus leaves the viewport until the next motion", async () => {
  const f = await fixture(Array.from({ length: 60 }, (_, i) => `row ${i}`).join("\n\n"));
  try {
    await f.keys("\u000b", "g", "g", "j", "^");
    await f.keys("\u001b");
    await f.keys("i", "draft", "\u0004", "\u0004");
    const before = f.terminal.viewport().join("\n");
    expect(before).not.toContain("row 0");
    await f.keys("\u000b");
    expect(f.terminal.viewport().join("\n")).not.toContain("row 0");
    await f.keys("l", "v", "y");
    expect(f.clipboard()).toBe("o");
    expect(f.app.state.composer.drafts.a).toBe("draft");
  } finally {
    await f.close();
  }
});
it("counts multiply, underscore equals caret, bare percent matches and unsupported forms preserve clipboard", async () => {
  const f = await fixture("  alpha bravo charlie delta echo foxtrot (pair)");
  try {
    await f.keys("\u000b", "g", "g", "j", "^", "2", "y", "2", "w");
    expect(f.clipboard()).toBe("alpha bravo charlie delta ");
    await f.keys("w", "y", "_");
    expect(f.clipboard()).toBe("alpha ");
    await f.keys("y", "i", "q", "2", "y", "i", "w", "2", "y", "%", "g", "m", "\u0016");
    expect(f.clipboard()).toBe("alpha ");
    await f.keys("G", "F", "(", "y", "%");
    expect(f.clipboard()).toBe("(pair)");
  } finally {
    await f.close();
  }
});
it("Normal half-page scroll keeps the screen row and desired column", async () => {
  const f = await fixture(
    Array.from({ length: 60 }, (_, i) => `long row ${i} content`).join("\n\n"),
  );
  try {
    await f.keys("\u000b", "g", "g", "j", "^", "5", "l");
    const before = f.terminal.viewportCursor();
    await f.keys("\u0004");
    expect(f.terminal.viewportCursor()).toEqual(before);
    await f.keys("v", "y");
    expect(f.clipboard()).toBe("r");
    expect(f.app.state.timelineNavigation.a?.following).toBe(false);
  } finally {
    await f.close();
  }
});
it("row yanks retain linewise clipboard ownership for Composer paste", async () => {
  const f = await fixture("alpha bravo");
  try {
    await f.keys("\u000b", "g", "g", "j", "y", "y");
    f.app.setComposerText("top\nbottom");
    await f.keys("\u001b");
    await f.keys("g", "g", "p");
    expect(f.app.state.composer.drafts.a).toBe("top\nalpha bravo\nbottom");
  } finally {
    await f.close();
  }
});
it("links and folds are Normal-only and a missing link preserves clipboard", async () => {
  const f = await fixture("[docs](https://example.test/path)");
  try {
    await f.keys("\u000b", "g", "g", "j", "^", "g", "x");
    expect(f.opened).toEqual(["https://example.test/path"]);
    await f.keys("v", "g", "x", "z", "a");
    expect(f.opened).toHaveLength(1);
    await f.keys("\u001b");
    f.gateway.emitTimeline("a", {
      type: "event",
      agentId: "a",
      event: {
        epoch: "e",
        sequence: 2,
        item: { id: "r", type: "reasoning", text: "hidden reasoning detail" },
      },
    });
    await f.terminal.waitForRender();
    await f.keys("G", "z", "a");
    expect(f.terminal.viewport().join("\n")).toContain("hidden reasoning detail");
    await f.keys("g", "x");
    expect(f.opened).toHaveLength(1);
    expect(f.clipboard()).toBe("outside");
  } finally {
    await f.close();
  }
});
it("page controls move the active Visual endpoint while half-pages can leave it offscreen", async () => {
  const f = await fixture(Array.from({ length: 70 }, (_, i) => `page ${i}`).join("\n\n"));
  try {
    await f.keys("\u000b", "g", "g", "j", "^", "v", "\u0004", "\u0004");
    expect(f.terminal.writes.at(-1)).toContain("\u001b[?25l");
    await f.keys("y");
    expect(f.clipboard()).toBe("p");
    await f.keys("g", "g", "j", "^", "v", "\u0006", "y");
    expect(f.clipboard()).toContain("page 1");
    await f.keys("g", "g", "j", "^", "\u001b[6~", "H", "j", "^", "v", "y");
    expect(f.clipboard()).toBe("p");
  } finally {
    await f.close();
  }
});
it("previous row selections retain their content extent after reflow and copies stay snapshots", async () => {
  const text =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar";
  const f = await fixture(text);
  try {
    f.terminal.setSize(120, 26);
    await f.terminal.waitForRender();
    await f.keys("\u000b", "g", "g", "j", "V", "y");
    const copied = f.clipboard();
    f.gateway.emitTimeline("a", {
      type: "event",
      agentId: "a",
      event: {
        epoch: "e",
        sequence: 2,
        item: { id: "append", type: "user-message", text: "later output" },
      },
    });
    await f.terminal.waitForRender();
    expect(f.clipboard()).toBe(copied);
    f.terminal.setSize(48, 26);
    await f.terminal.waitForRender();
    await f.keys("g", "v", "y");
    expect(f.clipboard().replaceAll("\n", " ")).toContain(copied);
  } finally {
    await f.close();
  }
});
