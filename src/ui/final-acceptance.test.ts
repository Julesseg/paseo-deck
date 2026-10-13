import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

async function fixture() {
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
          type: "user-message",
          text:
            "alpha target omega\n\n" +
            Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n\n"),
        },
      },
    ],
  });
  const terminal = new RecordingTerminal(100, 28);
  let clipboard = "external";
  const deck = new DeckTui(
    terminal,
    app.state,
    (intent) => {
      void app.handleIntent(intent);
    },
    {
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
  return {
    app,
    gateway,
    terminal,
    clipboard: () => clipboard,
    keys: async (...keys: string[]) => {
      for (const key of keys) {
        terminal.sendInput(key);
        await terminal.waitForRender();
      }
    },
    close: async () => {
      stop();
      await deck.stop();
      await app.releaseObservations();
      await gateway.close();
    },
  };
}

it("preserves Timeline Visual selection through Help, nested quit and background scroll before copying", async () => {
  const f = await fixture();
  try {
    await f.keys("i", "unsent", "\u001b", "\u000b", "g", "g", "j", "^", "v", "l", "l");
    expect(f.app.state.timelineMode).toBe("visual");
    await f.keys("g", "?", "\u0003", "\u0003");
    expect(f.terminal.viewport().join("\n")).toContain("Quit and discard");
    await f.keys("\u001b");
    expect(f.terminal.viewport().join("\n")).toContain("Paseo Deck keys");
    await f.keys("\u001b", "\u0004", "y");
    expect(f.clipboard()).toBe("alp");
    expect(f.app.state.timelineMode).toBe("normal");
    expect(f.app.state.composer.drafts.a).toBe("unsent");
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.close();
  }
});

it("cancels an unconfirmed Visual search before palette replacement and restores atomic paste undo", async () => {
  const f = await fixture();
  try {
    await f.keys(
      "i",
      "alpha target omega",
      "\u001b",
      "0",
      "v",
      "l",
      "l",
      "/",
      "target",
      "\u0010",
      "theme",
    );
    expect(f.terminal.viewport().join("\n")).toContain("Command palette");
    await f.keys("\u001b");
    expect(f.app.state.composerMode).toBe("visual");
    expect(f.terminal.viewport().join("\n")).toContain("selected 3 chars");
    await f.keys("\u001b[200~g?\n\u0013\nquit\u001b[201~");
    expect(f.app.state.composerMode).toBe("insert");
    expect(f.app.state.composer.drafts.a).toBe("g?\n\u0013\nquitha target omega");
    await f.keys("\u001b", "u");
    expect(f.app.state.composer.drafts.a).toBe("alpha target omega");
    expect(f.app.state.focus).toBe("composer");
    expect(f.gateway.commands).toEqual([]);
    expect(f.clipboard()).toBe("external");
  } finally {
    await f.close();
  }
});

it("repaints Composer Visual motion after each separately rendered key", async () => {
  const f = await fixture();
  try {
    await f.keys("i", "abcdef", "\u001b", "0", "v");
    expect(f.terminal.viewport().join("\n")).toContain("selected 1 chars");
    await f.keys("l");
    expect(f.terminal.viewport().join("\n")).toContain("selected 2 chars");
    await f.keys("l");
    expect(f.terminal.viewport().join("\n")).toContain("selected 3 chars");
    expect(f.app.state.composer.drafts.a).toBe("abcdef");
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.close();
  }
});
