import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

async function fixture(text = "", twoSessions = false) {
  const gateway = new FakePaseoGateway({
    projects: [],
    providers: [],
    workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
    agents: [
      ...(twoSessions
        ? [
            {
              id: "b",
              workspaceId: "w",
              title: "Other",
              status: "idle" as const,
              archived: false,
              availableModeIds: [],
              availableThinkingLevels: [],
              pendingPermissions: [],
              needsAttention: false,
            },
          ]
        : []),
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
      for (const key of keys) {
        terminal.sendInput(key);
        await terminal.waitForRender();
      }
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
it("Timeline query owns text, confirms once, and repeats counted matches", async () => {
  const f = await fixture("alpha target beta target gamma target");
  try {
    await f.keys("\u000b", "g", "g", "j", "^", "/", "target", "\r", "2", "n", "y", "w");
    expect(f.clipboard()).toBe("target");
    await f.keys("?", "nNg?", "\u001b", "y", "w");
    expect(f.clipboard()).toBe("target");
  } finally {
    await f.close();
  }
});
it("Composer query editing has field undo and preserves Visual selection on cancel", async () => {
  const f = await fixture();
  try {
    await f.keys(
      "\u000b",
      "\u001b",
      "i",
      "alpha target beta target",
      "\u001b",
      "0",
      "v",
      "l",
      "/",
      "nNg?",
      "\u001a",
      "\u001b",
      "y",
    );
    expect(f.clipboard()).toBe("al");
    expect(f.app.state.composer.drafts.a).toBe("alpha target beta target");
  } finally {
    await f.close();
  }
});

it("Composer forward and backward confirmed queries repeat without sending", async () => {
  const f = await fixture();
  try {
    await f.keys(
      "\u000b",
      "\u001b",
      "i",
      "alpha target beta target gamma",
      "\u001b",
      "0",
      "/",
      "target",
      "\r",
      "y",
      "w",
    );
    expect(f.clipboard()).toBe("target ");
    await f.keys("n", "y", "w");
    expect(f.clipboard()).toBe("target ");
    await f.keys("?", "alpha", "\r", "y", "w");
    expect(f.clipboard()).toBe("alpha ");
    expect(f.app.state.composer.drafts.a).toBe("alpha target beta target gamma");
  } finally {
    await f.close();
  }
});
it("whole-word star skips larger words and confirmed query keeps its direction after cancellation", async () => {
  const f = await fixture("cat scatter cat end");
  try {
    await f.keys("\u000b", "g", "g", "j", "^", "*", "y", "w");
    expect(f.clipboard()).toBe("cat ");
    await f.keys("?", "scatter", "\u001b", "n", "y", "w");
    expect(f.clipboard()).toBe("cat ");
  } finally {
    await f.close();
  }
});
it("Visual Timeline search extends the selection only on confirmation", async () => {
  const f = await fixture("alpha target omega");
  try {
    await f.keys("\u000b", "g", "g", "j", "^", "v", "/", "target", "\r", "y");
    expect(f.clipboard()).toBe("alpha t");
    expect(f.app.state.timelineMode).toBe("normal");
  } finally {
    await f.close();
  }
});
it("query paste and undo remain local and Ctrl-K changes focus without changing prompt", async () => {
  const f = await fixture("Timeline text");
  try {
    await f.keys("\u000b", "\u001b", "i", "draft", "\u001b", "/", "\u001b[200~nN\ng?\u001b[201~");
    expect(f.terminal.viewport().join("\n")).toContain("/ nN g?");
    await f.keys("\u001a");
    expect(f.app.state.composer.drafts.a).toBe("draft");
    await f.keys("\u000b");
    expect(f.app.state.focus).toBe("timeline");
    expect(f.terminal.viewport().join("\n")).not.toContain("/ nN");
  } finally {
    await f.close();
  }
});
it("query sits below visible settings and remains clipped in narrow Main pane", async () => {
  const f = await fixture("alpha target");
  try {
    await f.keys("\u000b", "/", "target");
    const rows = f.terminal.viewport();
    const query = rows.findIndex((row) => row.includes("/ target"));
    const settings = rows.findIndex((row) => row.includes("Think"));
    expect(query).toBeGreaterThan(settings);
    expect(rows[query]?.indexOf("/ target")).toBeGreaterThan(30);
    f.terminal.setSize(64, 20);
    await f.keys("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(f.terminal.viewport().every((row) => [...row].length <= 64)).toBe(true);
    expect(f.terminal.viewport().join("\n")).toContain("Think");
  } finally {
    await f.close();
  }
});

it("confirmed queries remain Session-local through resource round-trips and live changes", async () => {
  const f = await fixture("alpha target beta target", true);
  try {
    await f.app.selectAgent("a");
    await f.keys("\u000b", "g", "g", "j", "^", "/", "target", "\r");
    await f.app.selectAgent("b");
    f.gateway.emitTimeline("b", {
      type: "hydrated",
      agentId: "b",
      items: [
        {
          epoch: "b",
          sequence: 1,
          item: { id: "b-text", type: "user-message", text: "other target" },
        },
      ],
    });
    await f.keys("\u000b", "g", "g", "j", "^", "n", "y", "w");
    expect(f.clipboard()).toBe("other ");
    await f.app.selectAgent("a");
    f.gateway.emitTimeline("a", {
      type: "hydrated",
      agentId: "a",
      items: [
        {
          epoch: "e",
          sequence: 1,
          item: { id: "text", type: "user-message", text: "alpha target beta target" },
        },
      ],
    });
    await f.keys("\u000b", "g", "g", "j", "^", "n", "y", "w");
    expect(f.clipboard()).toBe("target ");
  } finally {
    await f.close();
  }
});
it("Composer star and its repeat search use whole words", async () => {
  const f = await fixture();
  try {
    await f.keys("\u000b", "\u001b", "i", "cat scatter cat end", "\u001b", "0", "*", "y", "w");
    expect(f.clipboard()).toBe("cat ");
    await f.keys("n", "y", "w");
    expect(f.clipboard()).toBe("cat ");
  } finally {
    await f.close();
  }
});

it("streaming during unconfirmed Visual search and Sidebar focus preserve the selection", async () => {
  const f = await fixture("alpha target omega");
  try {
    await f.keys("\u000b", "g", "g", "j", "^", "v", "l", "/", "omega");
    f.gateway.emitTimeline("a", {
      type: "hydrated",
      agentId: "a",
      items: [
        {
          epoch: "e",
          sequence: 1,
          item: { id: "text", type: "user-message", text: "alpha target omega plus streamed" },
        },
      ],
    });
    await f.keys("\u0013", "\u000b", "y");
    expect(f.clipboard()).toBe("al");
    expect(f.terminal.viewport().join("\n")).not.toContain("/ omega");
  } finally {
    await f.close();
  }
});
