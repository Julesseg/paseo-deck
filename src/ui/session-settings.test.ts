import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

async function fixture(providerId = "p") {
  const gateway = new FakePaseoGateway({
    projects: [],
    providers: [
      {
        id: providerId,
        name: "Provider",
        ready: true,
        modeIds: ["plan", "build"],
        defaultModeId: "plan",
        defaultModelId: "m",
        models: [
          {
            id: "m",
            name: "Model",
            selectable: true,
            thinkingLevels: ["low", "high"],
            defaultThinkingLevel: "low",
          },
          {
            id: "next",
            name: "Next Model",
            selectable: true,
            thinkingLevels: ["medium"],
            defaultThinkingLevel: "medium",
          },
        ],
      },
      {
        id: "off",
        name: "Unavailable",
        ready: false,
        unavailableReason: "offline",
        modeIds: [],
        models: [],
      },
    ],
    workspaces: [{ id: "w", title: "Workspace", directory: "/tmp", archived: false }],
    agents: [
      {
        id: "a",
        workspaceId: "w",
        title: "Original",
        modeId: "plan",
        providerId,
        modelId: "m",
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
  const terminal = new RecordingTerminal(100, 30);
  const deck = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const unsubscribe = app.subscribe((state) => deck.update(state));
  await deck.start();
  return {
    app,
    terminal,
    gateway,
    stop: async () => {
      unsubscribe();
      await deck.stop();
    },
  };
}

it("Normal mp opens draft provider without changing prompt or sending", async () => {
  const f = await fixture();
  try {
    await f.app.handleIntent({ type: "open-new-tab", workspaceId: "w" });
    f.terminal.sendInput("\r");
    f.app.setComposerText("retained draft");
    f.terminal.sendInput("m");
    f.terminal.sendInput("p");
    expect(f.app.state.modal.type).toBe("draft-setting");
    expect(f.gateway.commands).toEqual([]);
    expect(f.app.state.sessionDrafts.w?.prompt).toBe("retained draft");
  } finally {
    await f.stop();
  }
});

it("existing Session mm keeps unsupported models visible with their reason", async () => {
  const f = await fixture();
  try {
    await f.app.handleIntent({ type: "set-focus", focus: "composer" });
    f.terminal.sendInput("m");
    f.terminal.sendInput("m");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("Model");
    expect(f.terminal.viewport().join("\n")).toContain(
      "Model switching is unverified for this provider",
    );
    f.terminal.sendInput("\r");
    expect(f.gateway.commands).toEqual([]);
    expect(f.app.state.modal.type).toBe("session-setting");
  } finally {
    await f.stop();
  }
});

it("existing Session model switch resets thinking and preserves prompt, mode, identity and history", async () => {
  const f = await fixture("codex");
  try {
    await f.app.handleIntent({ type: "set-focus", focus: "composer" });
    f.app.setComposerText("keep this");
    f.terminal.sendInput("m");
    f.terminal.sendInput("m");
    f.terminal.sendInput("Next");
    f.terminal.sendInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.gateway.commands).toEqual([
      { type: "set-agent-model", agentId: "a", modelId: "next", thinkingLevel: "medium" },
    ]);
    expect(f.app.state.composer.drafts.a).toBe("keep this");
    expect(f.app.state.directory.agents[0]?.id).toBe("a");
    expect(f.app.state.directory.agents[0]?.modeId).toBe("plan");
    expect(f.app.state.modal.type).toBe("none");
  } finally {
    await f.stop();
  }
});

it("draft settings apply dependent defaults, retain undo, and never send", async () => {
  const f = await fixture();
  try {
    await f.app.handleIntent({ type: "open-new-tab", workspaceId: "w" });
    f.terminal.sendInput("\r");
    f.terminal.sendInput("i");
    f.terminal.sendInput("kept");
    f.terminal.sendInput("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const [key, query] of [
      ["o", "build"],
      ["t", "high"],
      ["m", "Next"],
    ] as const) {
      f.terminal.sendInput("m");
      f.terminal.sendInput(key);
      f.terminal.sendInput(query);
      f.terminal.sendInput("\r");
    }
    expect(f.app.state.sessionDrafts.w).toMatchObject({
      prompt: "kept",
      modelId: "next",
      thinkingLevel: "medium",
      modeId: "build",
    });
    f.terminal.sendInput("m");
    f.terminal.sendInput("m");
    f.terminal.sendInput("\r");
    expect(f.app.state.sessionDrafts.w?.modeId).toBe("build");
    f.terminal.sendInput("u");
    expect(f.app.state.sessionDrafts.w?.prompt).toBe("");
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("existing partial failure refreshes confirmed state, retains input, and offers no automatic retry", async () => {
  const f = await fixture("codex");
  try {
    await f.app.handleIntent({ type: "set-focus", focus: "composer" });
    f.app.setComposerText("useful input");
    const original = f.gateway.execute.bind(f.gateway);
    f.gateway.execute = async (command) => {
      await original(command);
      const snapshot = await f.gateway.getDirectorySnapshot();
      f.gateway.emitDirectory({
        type: "snapshot",
        snapshot: {
          ...snapshot,
          agents: snapshot.agents.map((a) => ({ ...a, modelId: "next", thinkingLevel: "low" })),
        },
      });
      throw new Error("thinking rejected after model applied");
    };
    f.terminal.sendInput("m");
    f.terminal.sendInput("m");
    f.terminal.sendInput("Next");
    f.terminal.sendInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.app.state.directory.agents[0]).toMatchObject({
      id: "a",
      modelId: "next",
      thinkingLevel: "low",
    });
    expect(f.app.state.composer.drafts.a).toBe("useful input");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("Filter: Next");
    expect(f.gateway.commands).toHaveLength(1);
    expect(f.app.state.notifications.at(-1)?.retry).toBeUndefined();
    expect(f.app.state.notifications.at(-1)?.message).toContain("some changes may have applied");
  } finally {
    await f.stop();
  }
});

it("provider change resets all dependent defaults while thinking/mode changes stay independent", async () => {
  const f = await fixture();
  try {
    const snapshot = await f.gateway.getDirectorySnapshot();
    f.gateway.emitDirectory({
      type: "snapshot",
      snapshot: {
        ...snapshot,
        providers: [
          ...snapshot.providers,
          {
            id: "other",
            name: "Other",
            ready: true,
            defaultModeId: "review",
            modeIds: ["review"],
            defaultModelId: "alternate",
            models: [
              {
                id: "alternate",
                name: "Alternate",
                selectable: true,
                defaultThinkingLevel: "deep",
                thinkingLevels: ["deep"],
              },
            ],
          },
        ],
      },
    });
    await f.app.handleIntent({ type: "open-new-tab", workspaceId: "w" });
    f.terminal.sendInput("\r");
    for (const [key, query] of [
      ["o", "build"],
      ["t", "high"],
      ["p", "Other"],
    ] as const) {
      f.terminal.sendInput("m");
      f.terminal.sendInput(key);
      f.terminal.sendInput(query);
      f.terminal.sendInput("\r");
    }
    expect(f.app.state.sessionDrafts.w).toMatchObject({
      providerId: "other",
      modelId: "alternate",
      modeId: "review",
      thinkingLevel: "deep",
    });
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("busy existing model choices remain visible and cannot apply", async () => {
  const f = await fixture("codex");
  try {
    const snapshot = await f.gateway.getDirectorySnapshot();
    f.gateway.emitDirectory({
      type: "snapshot",
      snapshot: { ...snapshot, agents: snapshot.agents.map((a) => ({ ...a, status: "running" })) },
    });
    await f.app.handleIntent({ type: "set-focus", focus: "composer" });
    f.terminal.sendInput("m");
    f.terminal.sendInput("m");
    f.terminal.sendInput("Next");
    await f.terminal.waitForRender();
    expect(f.terminal.viewport().join("\n")).toContain("Session is busy");
    f.terminal.sendInput("\r");
    expect(f.gateway.commands).toEqual([]);
    expect(f.app.state.modal.type).toBe("session-setting");
  } finally {
    await f.stop();
  }
});

it("Sidebar, Insert and Visual never gain direct Session setting commands", async () => {
  const f = await fixture("codex");
  try {
    for (const focus of ["tree", "composer", "timeline"] as const) {
      await f.app.handleIntent({ type: "set-focus", focus });
      if (focus === "composer")
        await f.app.handleIntent({ type: "set-composer-mode", mode: "visual" });
      if (focus === "timeline")
        await f.app.handleIntent({ type: "set-timeline-mode", mode: "visual" });
      f.terminal.sendInput("m");
      f.terminal.sendInput("m");
      expect(f.app.state.modal.type).toBe("none");
    }
    await f.app.handleIntent({ type: "set-focus", focus: "composer" });
    await f.app.handleIntent({ type: "set-composer-mode", mode: "insert" });
    f.terminal.sendInput("m");
    f.terminal.sendInput("m");
    expect(f.app.state.composer.drafts.a).toBe("mm");
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("existing mode/thinking changes are independent and same-value confirmation sends nothing", async () => {
  const f = await fixture("codex");
  try {
    const snapshot = await f.gateway.getDirectorySnapshot();
    f.gateway.emitDirectory({
      type: "snapshot",
      snapshot: {
        ...snapshot,
        agents: snapshot.agents.map((a) => ({
          ...a,
          availableModeIds: ["plan", "build"],
          availableThinkingLevels: ["low", "high"],
          thinkingLevel: "low",
        })),
      },
    });
    await f.app.handleIntent({ type: "set-focus", focus: "timeline" });
    for (const [key, query] of [
      ["o", "build"],
      ["t", "high"],
      ["t", "high"],
    ] as const) {
      f.terminal.sendInput("m");
      f.terminal.sendInput(key);
      f.terminal.sendInput(query);
      f.terminal.sendInput("\r");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(f.gateway.commands).toEqual([
      { type: "set-agent-mode", agentId: "a", modeId: "build" },
      { type: "set-thinking-level", agentId: "a", thinkingLevel: "high" },
    ]);
    expect(f.app.state.directory.agents[0]).toMatchObject({
      id: "a",
      providerId: "codex",
      modelId: "m",
      modeId: "build",
      thinkingLevel: "high",
    });
    f.terminal.sendInput("m");
    f.terminal.sendInput("p");
    expect(f.app.state.modal.type).toBe("none");
  } finally {
    await f.stop();
  }
});

it("an in-flight captured Session stays busy after dismissing and reopening its picker", async () => {
  const f = await fixture("codex");
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const original = f.gateway.execute.bind(f.gateway);
    f.gateway.execute = async (command) => {
      const result = await original(command);
      await pending;
      return result;
    };
    await f.app.handleIntent({ type: "set-focus", focus: "composer" });
    f.terminal.sendInput("m");
    f.terminal.sendInput("m");
    f.terminal.sendInput("Next");
    f.terminal.sendInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.terminal.sendInput("\u0013");
    f.terminal.sendInput("\u000b");
    f.terminal.sendInput("m");
    f.terminal.sendInput("m");
    expect(f.app.state.modal).toMatchObject({ type: "session-setting", busy: true });
    f.terminal.sendInput("\r");
    expect(f.gateway.commands).toHaveLength(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.app.state.modal).toMatchObject({ type: "session-setting", busy: false });
  } finally {
    release();
    await f.stop();
  }
});

it("Timeline character targets and pending yank/count sequences own m before Session settings", async () => {
  const f = await fixture("codex");
  try {
    f.gateway.emitTimeline("a", {
      type: "hydrated",
      agentId: "a",
      items: [
        {
          epoch: "e",
          sequence: 1,
          item: {
            type: "assistant-message",
            id: "message",
            messageId: "message",
            text: "some model text",
          },
        },
      ],
    });
    await f.app.handleIntent({ type: "set-focus", focus: "timeline" });
    for (const sequence of [
      ["f", "m", "m"],
      ["y", "m", "m"],
      ["2", "m", "m"],
    ]) {
      for (const key of sequence) f.terminal.sendInput(key);
      expect(f.app.state.modal.type).toBe("none");
      f.terminal.sendInput("\u0013");
      f.terminal.sendInput("\u000b");
    }
    expect(f.gateway.commands).toEqual([]);
  } finally {
    await f.stop();
  }
});

it("a model without an explicit thinking default resets the previous level through null", async () => {
  const f = await fixture("codex");
  try {
    const snapshot = await f.gateway.getDirectorySnapshot();
    f.gateway.emitDirectory({
      type: "snapshot",
      snapshot: {
        ...snapshot,
        providers: snapshot.providers.map((provider) =>
          provider.id === "codex"
            ? {
                ...provider,
                models: [
                  ...provider.models,
                  { id: "plain", name: "Plain Model", selectable: true, thinkingLevels: [] },
                ],
              }
            : provider,
        ),
        agents: snapshot.agents.map((agent) => ({ ...agent, thinkingLevel: "high" })),
      },
    });
    await f.app.handleIntent({ type: "set-focus", focus: "composer" });
    f.terminal.sendInput("m");
    f.terminal.sendInput("m");
    f.terminal.sendInput("Plain");
    f.terminal.sendInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.gateway.commands).toEqual([
      { type: "set-agent-model", agentId: "a", modelId: "plain", thinkingLevel: null },
    ]);
    expect(f.app.state.directory.agents[0]?.thinkingLevel).toBeUndefined();
    expect(f.app.state.directory.agents[0]?.modeId).toBe("plan");
  } finally {
    await f.stop();
  }
});
