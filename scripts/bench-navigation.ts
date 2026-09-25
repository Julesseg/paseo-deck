import { performance } from "node:perf_hooks";
import { ApplicationController } from "../src/app/controller.js";
import type { AppState } from "../src/contracts/app-state.js";
import type { DirectorySnapshot, TimelineEvent } from "../src/contracts/domain.js";
import { FakePaseoGateway } from "../src/paseo/fake-gateway.js";
import { createInitialState } from "../src/state/store.js";
import { RecordingTerminal } from "../src/ui/terminal.js";
import { DeckTui } from "../src/ui/views.js";

const itemCount = Number(process.argv[2] ?? 1_000);
const keyCount = Number(process.argv[3] ?? 20);
if (!Number.isSafeInteger(itemCount) || itemCount < 0) throw new Error("Invalid item count");
if (!Number.isSafeInteger(keyCount) || keyCount < 1) throw new Error("Invalid key count");

const projects = [{ id: "project", name: "Deck" }];
const workspaces = Array.from({ length: 30 }, (_, index) => ({
  id: `workspace-${index}`,
  projectId: "project",
  title: `Workspace ${String(index).padStart(2, "0")}`,
  directory: `/tmp/workspace-${index}`,
  archived: false,
}));
const agents = Array.from({ length: 90 }, (_, index) => ({
  id: `session-${index}`,
  workspaceId: workspaces[index % workspaces.length]?.id ?? "workspace-0",
  title: `Session ${index}`,
  status: "idle" as const,
  availableModeIds: [],
  availableThinkingLevels: [],
  pendingPermissions: [],
  needsAttention: false,
  archived: false,
}));
const directory: DirectorySnapshot = { projects, workspaces, agents, providers: [] };
const items: TimelineEvent[] = Array.from({ length: itemCount }, (_, sequence) => ({
  epoch: "history",
  sequence,
  item: {
    id: `message-${sequence}`,
    type: "assistant-message",
    messageId: `message-${sequence}`,
    text: "A completed response with enough predictable content to wrap across several terminal lines.",
    turnId: `turn-${Math.floor(sequence / 5)}`,
  },
}));
const state: AppState = {
  ...createInitialState(),
  connection: "connected",
  directory,
  expandedIds: new Set(["project"]),
  selectedWorkspaceId: "workspace-0",
  selectedProjectId: "project",
  selectedAgentId: "session-0",
  activeSessionId: "session-0",
  tabOrder: { "workspace-0": ["session:session-0"] },
  activeTabIds: { "workspace-0": "session:session-0" },
  focus: "tree",
  sidebarSelection: { kind: "workspace", id: "workspace-0" },
  sidebarOrder: ["project", ...workspaces.map((workspace) => workspace.id)],
  timeline: { agentId: "session-0", items, loading: false, recoveryRevision: 0 },
};
const terminal = new RecordingTerminal(120, 35);
const app = new ApplicationController(new FakePaseoGateway(directory), { initialState: state });
const deck = new DeckTui(
  terminal,
  app.state,
  (intent) => {
    void app.handleIntent(intent);
  },
  { appearance: { color: "none", unicode: false, theme: "plain", symbols: "ascii" } },
);
const unsubscribe = app.subscribe((next) => deck.update(next));
deck.start();

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

try {
  await terminal.waitForRender();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const write = terminal.write.bind(terminal);
  let onWrite: (() => void) | undefined;
  terminal.write = (value) => {
    write(value);
    onWrite?.();
  };
  const keyToWrite: number[] = [];
  const dispatch: number[] = [];
  for (let index = 0; index < keyCount; index++) {
    const nextWrite = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Render timed out")), 5_000);
      onWrite = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    const start = performance.now();
    terminal.sendInput(index % 2 === 0 ? "j" : "k");
    dispatch.push(performance.now() - start);
    await nextWrite;
    const expected = index % 2 === 0 ? "workspace-1" : "workspace-0";
    if (app.state.sidebarSelection?.id !== expected)
      throw new Error(`Sidebar selection did not move to ${expected}`);
    keyToWrite.push(performance.now() - start);
    await terminal.flush();
  }
  console.log(
    JSON.stringify({
      itemCount,
      keyCount,
      keyToWriteMs: { median: percentile(keyToWrite, 0.5), p95: percentile(keyToWrite, 0.95) },
      dispatchMs: { median: percentile(dispatch, 0.5), p95: percentile(dispatch, 0.95) },
    }),
  );
} finally {
  unsubscribe();
  await deck.stop();
}
