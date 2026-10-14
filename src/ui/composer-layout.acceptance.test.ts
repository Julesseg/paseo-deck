import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import type { TerminalAppearance } from "./capabilities.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

async function fixture(columns = 100, rows = 28, appearance?: TerminalAppearance) {
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
        providerId: "provider",
        modelId: "model-with-a-long-configuration-name",
        thinkingLevel: "high",
        modeId: "plan",
        lastUsage: { contextTokens: 123456789 },
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
  const terminal = new RecordingTerminal(columns, rows);
  const deck = new DeckTui(terminal, app.state, (intent) => void app.handleIntent(intent), {
    ...(appearance ? { appearance } : {}),
    treeWidth: 34,
  });
  const stop = app.subscribe((state) => deck.update(state));
  await deck.start();
  await terminal.waitForRender();
  return {
    app,
    terminal,
    gateway,
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

it("shows a fitting token count fully at the padded Composer settings right edge", async () => {
  const f = await fixture();
  try {
    await f.keys("i", "prompt");
    const settings = f.terminal.viewport().find((line) => line.includes("[mm]"));
    expect(settings).toContain("context 123456789");
    expect(settings?.indexOf("context 123456789")).toBe(81);
    expect(settings?.trimEnd().endsWith("123456789")).toBe(true);
  } finally {
    await f.close();
  }
});

it("shows active context usage without an ellipsis when the details fit", async () => {
  const f = await fixture(200, 28, {
    color: "none",
    unicode: true,
    theme: "plain",
    symbols: "unicode",
  });
  try {
    const agent = f.app.state.directory.agents[0];
    if (!agent) throw new Error("Missing Session");
    f.gateway.emitDirectory({
      type: "agent-upserted",
      agent: {
        ...agent,
        status: "running",
        lastUsage: { contextTokens: 334037 },
      },
    });
    await f.terminal.waitForRender();
    const settings = f.terminal.viewport().find((line) => line.includes("context 334037"));
    expect(settings).toContain("active · context 334037");
    expect(settings).not.toContain("…");
  } finally {
    await f.close();
  }
});

it("keeps a complete fitting token count when long settings cannot share the content width", async () => {
  const f = await fixture(30, 12);
  try {
    await f.keys("i", "prompt");
    const settings = f.terminal.viewport().find((line) => line.includes("context"));
    expect(settings?.slice(11, 28)).toBe("context 123456789");
    expect(f.app.state.composer.drafts.a).toBe("prompt");
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.close();
  }
});

it("separates the editor from its heading and settings and removes the bottom status row", async () => {
  const f = await fixture();
  try {
    await f.keys("i", "\u001b[200~first line\nlast line\u001b[201~");
    const lines = f.terminal.viewport();
    const heading = lines.findIndex((line) => line.includes("INSERT Prompt"));
    const first = lines.findIndex((line) => line.includes("first line"));
    const last = lines.findIndex((line) => line.includes("last line"));
    const settings = lines.findIndex((line) => line.includes("context 123456789"));
    expect(first).toBe(heading + 2);
    expect(settings).toBe(last + 2);
    expect(lines[heading + 1]?.slice(37).trim()).toBe("");
    expect(lines[last + 1]?.slice(37).trim()).toBe("");
    expect(settings).toBe(27);
    expect(lines.join("\n")).not.toMatch(/provider\/|connected|permissions 0/u);
    expect(f.terminal.viewportCursor()).toEqual({ row: last, column: 47 });
  } finally {
    await f.close();
  }
});

it.each([
  [160, 36, { color: "truecolor", unicode: true, theme: "ember", symbols: "unicode" }],
  [52, 18, { color: "none", unicode: true, theme: "plain", symbols: "unicode" }],
  [30, 12, { color: "none", unicode: false, theme: "plain", symbols: "ascii" }],
] satisfies Array<[number, number, TerminalAppearance]>)(
  "retains the multiline editor cursor, spacing and full count at %ix%i",
  async (columns, rows, appearance) => {
    const f = await fixture(columns, rows, appearance);
    try {
      const prompt = Array.from({ length: 15 }, (_, index) => `line ${index}`).join("\n");
      await f.keys("i", `\u001b[200~${prompt}\u001b[201~`);
      const lines = f.terminal.viewport();
      const heading = lines.findIndex((line) => line.includes("INSERT Prompt"));
      const last = lines.findIndex((line) => line.includes("line 14"));
      const settings = lines.findIndex((line) => line.includes("context 123456789"));
      expect(heading).toBeGreaterThanOrEqual(0);
      expect(lines[heading + 1]?.trim()).toBe("");
      expect(settings).toBe(last + 2);
      expect(lines[last + 1]?.trim()).toBe("");
      expect(f.terminal.viewportCursor().row).toBe(last);
      expect(f.app.state.composer.drafts.a).toBe(prompt);
      await f.keys("\u001b", "g", "g");
      expect(f.terminal.viewport().join("\n")).toContain("line 0");
      expect(f.terminal.viewport().join("\n")).not.toContain("line 14");
      await f.keys("G");
      expect(f.terminal.viewport().join("\n")).toContain("line 14");
      expect(f.terminal.viewport().join("\n")).toContain("context 123456789");
      await f.keys("u");
      expect(f.app.state.composer.drafts.a).toBe("");
      expect(f.gateway.commands).toEqual([]);
    } finally {
      await f.close();
    }
  },
);
