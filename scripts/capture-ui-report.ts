import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppState } from "../src/contracts/app-state.js";
import type { TerminalAppearance } from "../src/ui/capabilities.js";
import { RecordingTerminal } from "../src/ui/terminal.js";
import { DeckTui } from "../src/ui/views.js";

const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error("Usage: tsx scripts/capture-ui-report.ts <output-directory>");

const baseState = syntheticState();
const emptyState = withoutSelection(baseState);
const shots: Array<{
  name: string;
  columns: number;
  rows: number;
  state: AppState;
  appearance?: TerminalAppearance;
}> = [
  { name: "session-tree", columns: 100, rows: 28, state: baseState },
  {
    name: "terminal-discovery",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      workspaceTerminals: {
        "workspace-main": [
          { id: "terminal-1", workspaceId: "workspace-main", cwd: "/repo", name: "build" },
        ],
      },
    },
  },
  {
    name: "terminal-normal",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      focus: "timeline",
      activeTerminalId: "terminal-1",
      openTerminalIds: ["terminal-1"],
      terminalMode: "normal",
      terminalLines: { "terminal-1": ["$ npm test", "All tests passed"] },
    },
  },
  {
    name: "terminal-insert",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      focus: "timeline",
      activeTerminalId: "terminal-1",
      openTerminalIds: ["terminal-1"],
      terminalMode: "insert",
      terminalLines: { "terminal-1": ["$ "] },
    },
  },
  {
    name: "composer-normal",
    columns: 100,
    rows: 28,
    state: { ...baseState, focus: "composer", composerMode: "normal" },
  },
  {
    name: "composer-insert",
    columns: 100,
    rows: 28,
    state: { ...baseState, focus: "composer", composerMode: "insert" },
  },
  {
    name: "composer-visual",
    columns: 100,
    rows: 28,
    state: { ...baseState, focus: "composer", composerMode: "visual" },
  },
  {
    name: "composer-sending",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      focus: "composer",
      composerMode: "normal",
      composer: { ...baseState.composer, sendingAgentIds: new Set(["agent-atlas-1234"]) },
    },
  },
  {
    name: "composer-unavailable",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      focus: "composer",
      composerMode: "normal",
      connection: "disconnected",
    },
  },
  {
    name: "active-timeline",
    columns: 100,
    rows: 28,
    state: { ...baseState, focus: "timeline" },
  },
  {
    name: "active-turn",
    columns: 100,
    rows: 28,
    state: withTimeline(baseState, "timeline-active", [
      { id: "turn-active", type: "turn", status: "started", detail: "Working" },
      {
        id: "assistant-streaming",
        type: "assistant-message",
        messageId: "stream",
        text: "I am checking the release artifacts…",
        streaming: true,
      },
    ]),
  },
  {
    name: "completed-turn",
    columns: 100,
    rows: 28,
    state: withTimeline(baseState, "timeline-completed", [
      {
        id: "turn-completed",
        type: "turn",
        status: "completed",
        detail: "Release verified",
        durationMs: 3200,
      },
      {
        id: "assistant-completed",
        type: "assistant-message",
        messageId: "completed",
        turnId: "turn-completed",
        text: "The release build is ready.",
      },
    ]),
  },
  {
    name: "permission",
    columns: 100,
    rows: 28,
    state: withTimeline(baseState, "timeline-permission", [
      {
        id: "permission-report",
        type: "permission",
        request: {
          id: "report-permission",
          agentId: "agent-atlas-1234",
          title: "Run release checks",
          description: "The session needs approval before running the command.",
        },
      },
    ]),
  },
  {
    name: "failure",
    columns: 100,
    rows: 28,
    state: withTimeline(baseState, "timeline-failure", [
      {
        id: "tool-failure",
        type: "tool",
        callId: "failure",
        name: "npm test",
        status: "failed",
        failureSummary: "exit 1",
        output: "Assertion failed in release smoke test.",
      },
      {
        id: "error-failure",
        type: "error",
        message: "Release verification failed",
        detail: "The package smoke test returned exit code 1.",
      },
    ]),
  },
  {
    name: "structured-tool",
    columns: 100,
    rows: 28,
    state: withTimeline(baseState, "timeline-tool", [
      {
        id: "tool-command",
        type: "tool",
        callId: "command",
        name: "shell",
        status: "completed",
        summary: "npm run check",
        detail: { kind: "command", command: "npm run check" },
        output: "71 tests passed",
      },
      {
        id: "tool-search",
        type: "tool",
        callId: "search",
        name: "search",
        status: "completed",
        summary: "TimelineItem",
        detail: { kind: "search", query: "TimelineItem" },
        output: "src/contracts/domain.ts",
      },
    ]),
  },
  {
    name: "diff",
    columns: 100,
    rows: 28,
    state: withTimeline(baseState, "timeline-diff", [
      {
        id: "tool-diff",
        type: "tool",
        callId: "diff",
        name: "edit",
        status: "completed",
        summary: "src/ui/views.ts",
        detail: {
          kind: "file-write",
          path: "src/ui/views.ts",
          diff: "@@ -1,2 +1,3 @@\n-const old = true;\n+const old = false;\n+const newValue = true;",
        },
        output: "@@ -1,2 +1,3 @@\n-const old = true;\n+const old = false;\n+const newValue = true;",
      },
    ]),
  },
  {
    name: "unknown-event",
    columns: 100,
    rows: 28,
    state: withTimeline(baseState, "timeline-unknown", [
      {
        id: "unknown-report",
        type: "unknown",
        sourceType: "future_event",
        summary: "Retained safely for inspection",
      },
    ]),
  },
  {
    name: "creation-picker",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      modal: { type: "create-agent", workspaceId: "workspace-main", step: "provider" },
    },
  },
  {
    name: "permission-modal",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      modal: {
        type: "permission",
        agentId: "agent-harbor-5678",
        requestId: "permission-demo",
        queueIndex: 0,
        submitting: false,
      },
    },
  },
  {
    name: "reconnecting",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      connection: "reconnecting",
      recovery: { attempt: 2, since: 0, directoryStale: true, timelineStale: true },
      composer: {
        ...baseState.composer,
        drafts: { "agent-atlas-1234": "This draft remains while the daemon reconnects." },
      },
      notifications: [{ id: 1, kind: "info", message: "Reconnecting to Paseo…" }],
      activeNotificationId: 1,
    },
  },
  { name: "narrow-layout", columns: 52, rows: 18, state: baseState },
  {
    name: "no-color",
    columns: 100,
    rows: 28,
    state: { ...baseState, focus: "timeline" },
    appearance: { color: "none", unicode: true, theme: "plain", symbols: "unicode" },
  },
  {
    name: "ascii",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      focus: "tree",
      modal: { type: "create-agent", workspaceId: "workspace-main", step: "provider" },
    },
    appearance: { color: "ansi16", unicode: false, theme: "ember", symbols: "ascii" },
  },
  {
    name: "error",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      notifications: [
        {
          id: 1,
          kind: "error",
          failureKind: "command",
          message: "Could not refresh the selected agent.",
          detail: "Synthetic command failure for visual review.",
        },
      ],
      activeNotificationId: 1,
    },
  },
  {
    name: "empty-directory",
    columns: 100,
    rows: 28,
    state: {
      ...emptyState,
      directory: { projects: [], workspaces: [], agents: [], providers: [] },
      expandedIds: new Set(),
      timeline: { recoveryRevision: 0, items: [], loading: false },
    },
  },
];

await mkdir(outputDirectory, { recursive: true });
for (const shot of shots) {
  const terminal = new RecordingTerminal(shot.columns, shot.rows);
  const deck = new DeckTui(terminal, shot.state, () => undefined, {
    ...(shot.appearance === undefined ? {} : { appearance: shot.appearance }),
    renderClock: {
      now: () => 12_000,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    },
  });
  deck.update(shot.state);
  deck.start();
  await terminal.waitForRender();
  const viewport = terminal.viewport();
  await deck.stop();
  await writeFile(
    join(outputDirectory, `${shot.name}.svg`),
    terminalSvg(viewport, shot.columns, shot.rows, `Paseo Deck ${shot.name.replaceAll("-", " ")}`),
    "utf8",
  );
}

function syntheticState(): AppState {
  return {
    connection: "connected",
    recovery: { attempt: 0, directoryStale: false, timelineStale: false },
    notifications: [],
    directory: {
      projects: [{ id: "project-deck", name: "Deck Labs" }],
      workspaces: [
        {
          id: "workspace-main",
          projectId: "project-deck",
          title: "Main",
          directory: "/demo/deck",
          archived: false,
        },
        {
          id: "workspace-theme",
          projectId: "project-deck",
          title: "Theme polish",
          directory: "/demo/deck-theme",
          archived: false,
        },
      ],
      agents: [
        {
          id: "agent-atlas-1234",
          workspaceId: "workspace-main",
          title: "Atlas",
          status: "running",
          providerId: "codex",
          modelId: "gpt-5.6-terra",
          thinkingLevel: "medium",
          modeId: "auto",
          availableModeIds: ["auto", "full-access"],
          availableThinkingLevels: ["low", "medium", "high"],
          pendingPermissions: [],
          needsAttention: false,
          archived: false,
          lastUsage: { inputTokens: 1450, outputTokens: 320, contextTokens: 1770 },
        },
        {
          id: "agent-harbor-5678",
          workspaceId: "workspace-main",
          title: "Harbor",
          status: "idle",
          providerId: "codex",
          modelId: "gpt-5.6-terra",
          thinkingLevel: "high",
          availableModeIds: ["auto", "full-access"],
          availableThinkingLevels: ["medium", "high"],
          pendingPermissions: [
            {
              id: "permission-demo",
              agentId: "agent-harbor-5678",
              title: "Run tests",
            },
          ],
          needsAttention: true,
          archived: false,
        },
        {
          id: "agent-lumen-9012",
          workspaceId: "workspace-theme",
          title: "Lumen",
          status: "idle",
          providerId: "pi",
          modelId: "claude-sonnet",
          availableModeIds: [],
          availableThinkingLevels: [],
          pendingPermissions: [],
          needsAttention: false,
          archived: false,
        },
      ],
      providers: [
        {
          id: "codex",
          name: "Codex",
          ready: true,
          models: [
            {
              id: "gpt-5.6-terra",
              name: "GPT-5.6 Terra",
              selectable: true,
              thinkingLevels: ["low", "medium", "high"],
            },
            {
              id: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              selectable: true,
              thinkingLevels: ["medium", "high"],
            },
          ],
          modeIds: ["auto", "full-access"],
          defaultModelId: "gpt-5.6-terra",
          defaultModeId: "auto",
        },
      ],
    },
    selectedProjectId: "project-deck",
    selectedWorkspaceId: "workspace-main",
    selectedAgentId: "agent-atlas-1234",
    expandedIds: new Set(["project-deck", "workspace-main", "workspace-theme"]),
    filter: "",
    treeOrder: "attention",
    showArchived: false,
    attentionOnly: false,
    focus: "tree",
    modal: { type: "none" },
    timeline: {
      recoveryRevision: 0,
      agentId: "agent-atlas-1234",
      epoch: "demo",
      cursor: { epoch: "demo", sequence: 5 },
      loading: false,
      usage: { inputTokens: 1450, outputTokens: 320, contextTokens: 1770 },
      items: [
        {
          epoch: "demo",
          sequence: 1,
          item: { id: "user-1", type: "user-message", text: "Check the release build." },
        },
        {
          epoch: "demo",
          sequence: 2,
          item: {
            id: "reasoning-1",
            type: "reasoning",
            text: "I will run the focused checks, then verify the packaged executable aliases.",
          },
        },
        {
          epoch: "demo",
          sequence: 3,
          item: {
            id: "tool-1",
            type: "tool",
            callId: "call-1",
            name: "npm run check",
            status: "completed",
            summary: "71 tests passed; typecheck and build succeeded.",
          },
        },
        {
          epoch: "demo",
          sequence: 4,
          item: {
            id: "assistant-1",
            type: "assistant-message",
            messageId: "message-1",
            text: "The release build is clean. Both executable aliases are ready.",
          },
        },
        {
          epoch: "demo",
          sequence: 5,
          item: { id: "turn-1", type: "turn", status: "completed" },
        },
      ],
    },
    timelineNavigation: {},
    creationDefaults: {},
    composer: {
      drafts: {},
      histories: {},
      historyIndexes: {},
      historyDrafts: {},
      sendingAgentIds: new Set(),
      detachedAgentIds: new Set(),
    },
  };
}

function withoutSelection(
  state: AppState,
): Omit<AppState, "selectedProjectId" | "selectedWorkspaceId" | "selectedAgentId"> {
  const {
    selectedProjectId: _project,
    selectedWorkspaceId: _workspace,
    selectedAgentId: _agent,
    ...rest
  } = state;
  return rest;
}

function withTimeline(
  state: AppState,
  epoch: string,
  items: readonly AppState["timeline"]["items"][number]["item"][],
): AppState {
  return {
    ...state,
    focus: "timeline",
    timeline: {
      ...state.timeline,
      epoch,
      cursor: { epoch, sequence: items.length },
      items: items.map((item, index) => ({ epoch, sequence: index + 1, item })),
    },
  };
}

function terminalSvg(
  lines: readonly string[],
  columns: number,
  rows: number,
  title: string,
): string {
  const cellWidth = 9;
  const lineHeight = 18;
  const padding = 16;
  const chromeHeight = 32;
  const width = columns * cellWidth + padding * 2;
  const height = rows * lineHeight + padding * 2 + chromeHeight;
  const text = lines
    .slice(0, rows)
    .map(
      (line, index) =>
        `<text x="${padding}" y="${chromeHeight + padding + (index + 1) * lineHeight - 4}">${escapeXml(line)}</text>`,
    )
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title>${escapeXml(title)}</title>
  <rect width="${width}" height="${height}" rx="12" fill="#1c1917"/>
  <rect width="${width}" height="${chromeHeight}" rx="12" fill="#292524"/>
  <rect y="20" width="${width}" height="12" fill="#292524"/>
  <circle cx="18" cy="16" r="5" fill="#ef4444"/>
  <circle cx="36" cy="16" r="5" fill="#f59e0b"/>
  <circle cx="54" cy="16" r="5" fill="#22c55e"/>
  <g fill="#f5f5f4" font-family="SFMono-Regular, Menlo, Consolas, monospace" font-size="14" xml:space="preserve">
${text}
  </g>
</svg>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
