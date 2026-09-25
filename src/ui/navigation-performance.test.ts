import { afterEach, expect, it, vi } from "vitest";
import { ApplicationController } from "../app/controller.js";
import type { AppState } from "../contracts/app-state.js";
import type { TimelineEvent } from "../contracts/domain.js";
import { FakePaseoGateway } from "../paseo/fake-gateway.js";
import { createInitialState } from "../state/store.js";
import { RecordingTerminal } from "./terminal.js";
import { DeckTui } from "./views.js";

afterEach(() => vi.restoreAllMocks());

it("moves the sidebar without reprocessing a long unchanged timeline", async () => {
  const workspaces = [
    { id: "first", title: "First", directory: "/first", archived: false },
    { id: "second", title: "Second", directory: "/second", archived: false },
  ];
  const agents = [
    {
      id: "session",
      workspaceId: "first",
      title: "Long session",
      status: "idle" as const,
      availableModeIds: [],
      availableThinkingLevels: [],
      pendingPermissions: [],
      needsAttention: false,
      archived: false,
    },
  ];
  const directory = { projects: [], workspaces, agents, providers: [] };
  const items: TimelineEvent[] = Array.from({ length: 300 }, (_, sequence) => ({
    epoch: "history",
    sequence,
    item: {
      id: `message-${sequence}`,
      type: "assistant-message",
      messageId: `message-${sequence}`,
      text: "A completed response with enough content to wrap across terminal lines.",
    },
  }));
  const state: AppState = {
    ...createInitialState(),
    connection: "connected",
    directory,
    selectedWorkspaceId: "first",
    selectedAgentId: "session",
    activeSessionId: "session",
    tabOrder: { first: ["session:session"] },
    activeTabIds: { first: "session:session" },
    focus: "tree",
    sidebarSelection: { kind: "workspace", id: "first" },
    sidebarOrder: ["first", "second"],
    timeline: { agentId: "session", items, loading: false, recoveryRevision: 0 },
  };
  const terminal = new RecordingTerminal(120, 35);
  const app = new ApplicationController(new FakePaseoGateway(directory), { initialState: state });
  const deck = new DeckTui(terminal, app.state, (intent) => {
    void app.handleIntent(intent);
  });
  const unsubscribe = app.subscribe((next) => deck.update(next));
  deck.start();
  try {
    await terminal.waitForRender();
    const segment = Intl.Segmenter.prototype.segment;
    const segmentation = vi.spyOn(Intl.Segmenter.prototype, "segment").mockImplementation(function (
      this: Intl.Segmenter,
      value: string,
    ) {
      return segment.call(this, value);
    });

    terminal.sendInput("j");
    await terminal.waitForRender();

    expect(app.state.sidebarSelection).toEqual({ kind: "workspace", id: "second" });
    // The layout library still measures visible panes. The original full
    // timeline redraw made more than 10,000 calls for this one sidebar key.
    expect(segmentation.mock.calls.length).toBeLessThan(2_500);

    deck.update({
      ...app.state,
      timeline: {
        ...app.state.timeline,
        items: [
          ...items,
          {
            epoch: "history",
            sequence: items.length,
            item: {
              id: "live-update",
              type: "assistant-message",
              messageId: "live-update",
              text: "Live update after sidebar browsing",
            },
          },
        ],
      },
    });
    await terminal.waitForRender();
    expect(terminal.viewport().join("\n")).toContain("Live update after sidebar browsing");
  } finally {
    unsubscribe();
    await deck.stop();
  }
});
