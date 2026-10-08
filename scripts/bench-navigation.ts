import assert from "node:assert/strict";
import os from "node:os";
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
const symbols = process.argv[4] ?? "unicode";
const focus = process.argv[5] ?? "tree";
const color = process.argv[6] ?? "none";
const warmupCount = 10;
if (!Number.isSafeInteger(itemCount) || itemCount < 0) throw new Error("Invalid item count");
if (!Number.isSafeInteger(keyCount) || keyCount < 1) throw new Error("Invalid key count");
if (symbols !== "unicode" && symbols !== "ascii") throw new Error("Invalid symbol set");
if (focus !== "tree" && focus !== "timeline" && focus !== "composer")
  throw new Error("Invalid focus");
if (!["none", "ansi16", "ansi256", "truecolor"].includes(color))
  throw new Error("Invalid color tier");

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
  focus,
  composerMode: focus === "composer" ? "insert" : "normal",
  sidebarSelection: { kind: "workspace", id: "workspace-0" },
  sidebarOrder: ["project", ...workspaces.map((workspace) => workspace.id)],
  timeline: { agentId: "session-0", items, loading: false, recoveryRevision: 0 },
};
const terminal = new RecordingTerminal(120, 35);
const gateway = new FakePaseoGateway(directory);
const app = new ApplicationController(gateway, { initialState: state });
const deck = new DeckTui(
  terminal,
  app.state,
  (intent) => {
    void app.handleIntent(intent);
  },
  {
    appearance: {
      color: color as "none" | "ansi16" | "ansi256" | "truecolor",
      unicode: true,
      theme: "ember",
      symbols,
    },
  },
);
const unsubscribe = app.subscribe((next) => deck.update(next));
function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

// Timestamp inside write, before xterm parsing or outcome assertions. Never time
// an unrelated flush or include the assertions in key-to-first-write latency.
const write = terminal.write.bind(terminal);
let onWrite: ((time: number) => void) | undefined;
let acceptWrite = (_value: string) => true;
terminal.write = (value) => {
  const now = performance.now();
  write(value);
  if (acceptWrite(value)) {
    const listener = onWrite;
    onWrite = undefined;
    listener?.(now);
  }
};
async function measured(
  action: () => void,
  accepts = (_value: string) => true,
): Promise<{ latency: number; dispatch: number }> {
  acceptWrite = accepts;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const nextWrite = new Promise<number>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Render timed out")), 5_000);
    onWrite = resolve;
  });
  const start = performance.now();
  action();
  const dispatch = performance.now() - start;
  try {
    return { latency: (await nextWrite) - start, dispatch };
  } finally {
    clearTimeout(timeout);
    onWrite = undefined;
  }
}

try {
  const cold = await measured(
    () => deck.start(),
    (value) => value.includes("completed response"),
  );
  await terminal.waitForRender();
  assert(terminal.viewport().join("\n").includes("completed response"), "Cold content missing");
  // Establish the real gateway subscription before measuring replacement.
  await app.start();
  gateway.emitTimeline("session-0", { type: "hydrated", agentId: "session-0", items });
  await terminal.waitForRender();
  const replacementItems = items.map((event) => ({
    ...event,
    item: {
      ...event.item,
      text: "Replacement response with enough predictable content to wrap across several terminal lines.",
    },
  })) as TimelineEvent[];
  const replacement = await measured(() =>
    gateway.emitTimeline("session-0", {
      type: "replaced",
      agentId: "session-0",
      epoch: "history",
      items: replacementItems,
    }),
  );
  await terminal.waitForRender();
  assert(
    terminal.viewport().join("\n").includes("Replacement response"),
    "Replacement content missing",
  );
  // Restore identical idle fixtures in all contexts and allow pending renders to drain.
  gateway.emitTimeline("session-0", {
    type: "replaced",
    agentId: "session-0",
    epoch: "history",
    items,
  });
  await terminal.waitForRender();
  await app.handleIntent({ type: "set-focus", focus });
  await app.handleIntent({ type: "set-composer-mode", mode: "normal" });
  await terminal.waitForRender();
  if (focus === "timeline") {
    // A known visible interior row gives observable one-row movement without scrolling.
    for (const key of ["g", "g", "j", "j", "j", "j"]) terminal.sendInput(key);
    await terminal.waitForRender();
  }
  if (focus === "composer") {
    terminal.sendInput("i");
    await terminal.waitForRender();
  }
  const initialCursor = terminal.viewportCursor();
  const initialViewport = terminal.viewport();
  const keyToWrite: number[] = [];
  const dispatch: number[] = [];
  for (let index = 0; index < warmupCount + keyCount; index++) {
    const odd = index % 2 === 0;
    const key = focus === "composer" ? (odd ? "x" : "\x7f") : odd ? "j" : "k";
    const sample = await measured(() => terminal.sendInput(key));
    await terminal.flush();
    if (focus === "timeline") {
      assert.deepEqual(
        terminal.viewportCursor(),
        {
          row: initialCursor.row + (odd ? 1 : 0),
          column: initialCursor.column,
        },
        "Timeline must move one visible row and return",
      );
      assert.deepEqual(
        terminal.viewport().map((line) => line.trimEnd()),
        initialViewport.map((line) => line.trimEnd()),
        "Cursor movement must preserve visible content",
      );
    } else if (focus === "composer") {
      assert.equal(app.state.composer.drafts["session-0"] ?? "", odd ? "x" : "");
      assert.equal(
        terminal.viewport().some((line) => line.slice(36).trim() === "x"),
        odd,
        "Composer editing must be visible",
      );
    } else {
      assert.equal(app.state.sidebarSelection?.id, odd ? "workspace-1" : "workspace-0");
      assert.equal(
        app.state.selectedWorkspaceId,
        "workspace-0",
        "Sidebar movement must preserve active Workspace",
      );
      assert(terminal.viewport().join("\n").includes("completed response"));
    }
    if (index >= warmupCount) {
      keyToWrite.push(sample.latency);
      dispatch.push(sample.dispatch);
    }
  }
  const p95 = percentile(keyToWrite, 0.95);
  console.log(
    JSON.stringify({
      environment: {
        node: process.version,
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        cpu: os.cpus()[0]?.model,
      },
      fixture: {
        itemCount,
        workspaces: workspaces.length,
        sessions: agents.length,
        columns: 120,
        rows: 35,
      },
      keyCount,
      warmupCount,
      symbols,
      color,
      focus,
      keyToWriteMs: { median: percentile(keyToWrite, 0.5), p95, max: Math.max(...keyToWrite) },
      dispatchMs: { median: percentile(dispatch, 0.5), p95: percentile(dispatch, 0.95) },
      coldStartToWriteMs: cold.latency,
      replacementToWriteMs: replacement.latency,
      idleTargetPassed: p95 < 50,
    }),
  );
  assert(p95 < 50, `Idle p95 ${p95} ms must be below 50 ms`);
} finally {
  unsubscribe();
  await deck.stop();
  await gateway.close();
}
