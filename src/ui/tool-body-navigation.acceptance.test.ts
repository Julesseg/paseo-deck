import { expect, it } from "vitest";
import { ApplicationController } from "../app/controller.js";
import type { TimelineEvent } from "../contracts/domain.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

async function fixture(text = "", events?: TimelineEvent[], columns = 90) {
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
  const terminal = new RecordingTerminal(columns, 40);
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

it.each([100, 110, 120, 140])(
  "j/k leave the wrapped tool body after $ at %s columns",
  async (columns) => {
    const command =
      "(root/'tmux.conf.index-before').write_bytes(subprocess.check_output(git+['show',':.config/tmux/tmux.conf']))\nPY";
    const event: TimelineEvent = {
      epoch: "e",
      sequence: 1,
      item: {
        id: "command",
        type: "tool",
        callId: "c",
        name: "exec_command",
        status: "completed",
        detail: { kind: "command", command },
        output: "",
      },
    };
    const f = await fixture("", [event], columns);
    try {
      await f.keys("\u000b", "g", "g");
      for (
        let i = 0;
        i < 8 && !f.terminal.viewport()[f.terminal.viewportCursor().row]?.includes("(root/");
        i++
      )
        await f.keys("j");
      const row = f.terminal.viewportCursor().row;
      expect(f.terminal.viewport()[row]).toContain("(root/");
      await f.keys("$");
      const edge = f.terminal.viewportCursor();
      expect(edge.row).toBe(row);
      expect(f.terminal.viewport()[row + 1]?.trim()).not.toBe("");

      await f.keys("j");
      expect(
        f.terminal.viewportCursor().row,
        `from ${JSON.stringify(edge)} to ${JSON.stringify(f.terminal.viewportCursor())}; line ${f.terminal.viewport()[row]}; next ${f.terminal.viewport()[row + 1]}`,
      ).toBe(row + 1);
      const visible = f.terminal.viewport()[row + 1]?.trim();
      await f.keys("y", "y");
      expect(f.clipboard()).toBe(visible);
      f.gateway.emitTimeline("a", {
        type: "hydrated",
        agentId: "a",
        items: [structuredClone(event)],
      });
      await f.terminal.waitForRender();
      expect(f.terminal.viewportCursor().row).toBe(row + 1);
      await f.keys("k");
      expect(f.terminal.viewportCursor()).toEqual(edge);
    } finally {
      await f.close();
    }
  },
);

it.each(["completed", "failed"] as const)(
  "character Visual copies %s command exactly with its real newline",
  async (status) => {
    const command =
      "(root/'tmux.conf.index-before').write_bytes(subprocess.check_output(git+['show',':.config/tmux/tmux.conf']))\nPY";
    const event: TimelineEvent = {
      epoch: "e",
      sequence: 1,
      item: {
        id: "command",
        type: "tool",
        callId: "c",
        name: "exec_command",
        status,
        detail: { kind: "command", command },
        output: "",
      },
    };
    const f = await fixture("", [event], 100);
    try {
      await f.keys("\u000b", "g", "g");
      await f.keys("j");
      await f.keys("j", "^");
      await f.keys("v", "G", "$", "y");
      expect(f.clipboard()).toBe(command);
    } finally {
      await f.close();
    }
  },
);

it("preserves source character through tool append and narrow-wide-narrow reflow", async () => {
  const command =
    "(root/'tmux.conf.index-before').write_bytes(subprocess.check_output(git+['show',':.config/tmux/tmux.conf']))\nPY";
  const event = {
    epoch: "e",
    sequence: 1,
    item: {
      id: "tool",
      type: "tool",
      callId: "c",
      name: "exec_command",
      status: "running",
      detail: { kind: "command", command },
      output: "",
    },
  } satisfies TimelineEvent;
  const f = await fixture("", [event], 100);
  try {
    await f.keys("\u000b", "g", "g");
    await f.keys("j");
    await f.keys("j", "$", "j", "v", "y");
    expect(f.clipboard()).toBe(")");
    const before = f.terminal.viewportCursor();
    f.gateway.emitTimeline("a", {
      type: "hydrated",
      agentId: "a",
      items: [
        {
          ...event,
          item: {
            ...event.item,
            status: "completed",
            durationMs: 123,
            detail: { kind: "command", command: `${command}\nprint('more')` },
          },
        },
      ],
    });
    await f.terminal.waitForRender();
    expect(f.terminal.viewportCursor()).toEqual(before);
    for (const columns of [200, 100]) {
      f.terminal.setSize(columns, 40);
      await f.terminal.waitForRender();
      await f.keys("v", "y");
      expect(f.clipboard()).toBe(")");
    }
    await f.keys("j");
    expect(f.terminal.viewport()[f.terminal.viewportCursor().row]).toContain("PY");
  } finally {
    await f.close();
  }
});

it.each(["tool", "reasoning", "permission"] as const)(
  "copies %s wrapped Unicode with real indentation and stripped ANSI",
  async (type) => {
    const text = `    ${"x".repeat(85)}界é\n    print('next')`;
    const styled = `\u001b[31m${text}\u001b[0m`;
    const item =
      type === "tool"
        ? {
            id: "item",
            type,
            callId: "c",
            name: "exec_command",
            status: "completed" as const,
            detail: {
              kind: "command" as const,
              command: styled,
              content: "unrendered".repeat(1000),
            },
            output: "",
          }
        : type === "reasoning"
          ? { id: "item", type, text: styled, collapsed: false }
          : {
              id: "item",
              type,
              resolved: true,
              request: { id: "p", agentId: "a", title: "Read", description: styled },
            };
    const f = await fixture("", [{ epoch: "e", sequence: 1, item }], 100);
    try {
      await f.keys("\u000b", "g", "g");
      await f.keys("j");
      await f.keys("j", "0");
      if (type === "permission") {
        const row = f.terminal.viewportCursor().row;
        const displayed = f.terminal
          .viewport()
          [row]?.slice(f.terminal.viewportCursor().column + 4)
          .trimEnd();
        await f.keys("y", "y");
        expect(f.clipboard()).toBe(displayed);
        expect(f.clipboard()).not.toContain("…");
        await f.keys("j");
        expect(f.terminal.viewportCursor().row).toBe(row + 1);
      } else {
        await f.keys("v", "G", "$", "y");
        expect(f.clipboard()).toBe(text);
      }
      expect(f.terminal.viewport().every((line) => line.length < 110)).toBe(true);
    } finally {
      await f.close();
    }
  },
);
