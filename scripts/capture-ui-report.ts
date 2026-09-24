import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppState } from "../src/contracts/app-state.js";
import type { TerminalAppearance } from "../src/ui/capabilities.js";
import { NARROW_SIDEBAR_BREAKPOINT } from "../src/ui/layout.js";
import { RecordingTerminal } from "../src/ui/terminal.js";
import { terminalDisplayWidth } from "../src/ui/text-safety.js";
import { DeckTui } from "../src/ui/views.js";

const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error("Usage: tsx scripts/capture-ui-report.ts <output-directory>");

const baseState = syntheticState();
const { selectedAgentId: _selectedAgentId, ...terminalBaseState } = baseState;
const emptyState = withoutSelection(baseState);
const overflowTemplate = baseState.directory.agents[0];
if (!overflowTemplate) throw new Error("UI report needs a session fixture");
const overflowAgents = Array.from({ length: 8 }, (_, index) => ({
  ...overflowTemplate,
  id: `agent-overflow-${index}`,
  title: `Session ${index + 1} review`,
  status: "idle" as const,
}));
const sampledTerminalAppearance: TerminalAppearance = {
  color: "truecolor",
  unicode: true,
  theme: "ember",
  palette: "terminal",
  background: [28, 25, 23],
  symbols: "unicode",
};
const shots: Array<{
  name: string;
  columns: number;
  rows: number;
  state: AppState;
  appearance?: TerminalAppearance;
}> = [
  { name: "project-ownership", columns: 160, rows: 42, state: baseState },
  {
    name: "project-collapsed",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      expandedIds: new Set(),
      sidebarSelection: { kind: "project", id: "live-project" },
    },
  },
  {
    name: "sidebar-selection",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      activeSessionId: "agent-atlas-1234",
      sidebarSelection: { kind: "workspace", id: "workspace-theme" },
    },
  },
  {
    name: "workspace-empty",
    columns: 100,
    rows: 28,
    state: {
      ...emptyState,
      directory: {
        ...baseState.directory,
        workspaces: [
          ...baseState.directory.workspaces,
          {
            id: "workspace-empty",
            projectId: "live-project",
            title: "Empty",
            directory: "/demo/empty",
            archived: false,
          },
        ],
      },
      selectedWorkspaceId: "workspace-empty",
      sidebarSelection: { kind: "workspace", id: "workspace-empty" },
      timeline: { recoveryRevision: 0, items: [], loading: false },
    },
  },
  {
    name: "workspace-filter",
    columns: 100,
    rows: 28,
    state: { ...baseState, filter: "Theme" },
  },
  {
    name: "workspace-monochrome",
    columns: 100,
    rows: 28,
    state: baseState,
    appearance: { color: "none", unicode: false, theme: "plain", symbols: "ascii" },
  },
  {
    name: "workspace-activity",
    columns: 100,
    rows: 28,
    state: {
      ...emptyState,
      directory: {
        ...baseState.directory,
        projects: [{ id: "activity", name: "Activity" }],
        workspaces: ["attention", "working", "idle", "done"].map((id) => ({
          id,
          projectId: "activity",
          title: id.slice(0, 1).toUpperCase() + id.slice(1),
          directory: `/demo/${id}`,
          archived: false,
        })),
        agents: baseState.directory.agents
          .filter((agent) => agent.id === "agent-harbor-5678")
          .map((agent) => ({ ...agent, workspaceId: "attention" }))
          .concat(
            baseState.directory.agents
              .filter((agent) => agent.id === "agent-atlas-1234")
              .map((agent) => ({ ...agent, workspaceId: "done", status: "stopped" as const })),
          ),
      },
      selectedWorkspaceId: "working",
      sidebarSelection: { kind: "workspace", id: "working" },
      workspaceTerminals: {
        working: [
          {
            id: "terminal-build",
            workspaceId: "working",
            name: "build",
            cwd: "/demo/working",
            activity: "working",
          },
        ],
      },
      expandedIds: new Set(["activity"]),
      timeline: { recoveryRevision: 0, items: [], loading: false },
    },
  },
  {
    name: "sidebar-active-session",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      focus: "composer",
      composerMode: "normal",
      activeSessionId: "agent-atlas-1234",
      sidebarSelection: { kind: "workspace", id: "workspace-main" },
    },
  },
  {
    name: "active-session-tab",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      activeSessionId: "agent-atlas-1234",
      tabOrder: {
        ...baseState.tabOrder,
        "workspace-main": ["session:agent-atlas-1234", "session:agent-harbor-5678"],
      },
    },
  },
  {
    name: "unified-overflow",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      directory: {
        ...baseState.directory,
        agents: [...baseState.directory.agents, ...overflowAgents],
      },
      tabOrder: {
        ...baseState.tabOrder,
        "workspace-main": [
          "session:agent-atlas-1234",
          "terminal:terminal-1",
          ...overflowAgents.map((agent) => `session:${agent.id}` as const),
          "session:agent-harbor-5678",
        ],
      },
      workspaceTerminals: {
        "workspace-main": [
          { id: "terminal-1", workspaceId: "workspace-main", cwd: "/demo/deck", name: "build" },
        ],
      },
      activeTabIds: { ...baseState.activeTabIds, "workspace-main": "session:agent-overflow-3" },
      activeSessionId: "agent-overflow-3",
      selectedAgentId: "agent-overflow-3",
      timeline: { recoveryRevision: 0, agentId: "agent-overflow-3", items: [], loading: false },
    },
  },
  {
    name: "workspace-restored",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      selectedWorkspaceId: "workspace-theme",
      selectedAgentId: "agent-lumen-9012",
      activeSessionId: "agent-lumen-9012",
      sidebarSelection: { kind: "workspace", id: "workspace-main" },
      timeline: { recoveryRevision: 0, agentId: "agent-lumen-9012", items: [], loading: false },
    },
  },
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
      tabOrder: {
        ...baseState.tabOrder,
        "workspace-main": [
          "session:agent-atlas-1234",
          "session:agent-harbor-5678",
          "terminal:terminal-1",
        ],
      },
    },
  },
  {
    name: "terminal-normal",
    columns: 100,
    rows: 28,
    state: {
      ...terminalBaseState,
      focus: "timeline",
      activeTerminalId: "terminal-1",
      activeTabIds: { ...baseState.activeTabIds, "workspace-main": "terminal:terminal-1" },
      tabOrder: {
        ...baseState.tabOrder,
        "workspace-main": [
          "session:agent-atlas-1234",
          "session:agent-harbor-5678",
          "terminal:terminal-1",
        ],
      },
      workspaceTerminals: {
        "workspace-main": [
          { id: "terminal-1", workspaceId: "workspace-main", cwd: "/demo/deck", name: "build" },
        ],
      },
      terminalMode: "normal",
      terminalLines: { "terminal-1": ["$ npm test", "All tests passed"] },
    },
  },
  {
    name: "terminal-insert",
    columns: 100,
    rows: 28,
    state: {
      ...terminalBaseState,
      focus: "timeline",
      activeTerminalId: "terminal-1",
      activeTabIds: { ...baseState.activeTabIds, "workspace-main": "terminal:terminal-1" },
      tabOrder: {
        ...baseState.tabOrder,
        "workspace-main": [
          "session:agent-atlas-1234",
          "session:agent-harbor-5678",
          "terminal:terminal-1",
        ],
      },
      workspaceTerminals: {
        "workspace-main": [
          { id: "terminal-1", workspaceId: "workspace-main", cwd: "/demo/deck", name: "build" },
        ],
      },
      terminalMode: "insert",
      terminalLines: { "terminal-1": ["$ "] },
    },
  },
  {
    name: "terminal-confirm",
    columns: 100,
    rows: 28,
    state: {
      ...terminalBaseState,
      activeTerminalId: "terminal-1",
      activeTabIds: { ...baseState.activeTabIds, "workspace-main": "terminal:terminal-1" },
      tabOrder: {
        ...baseState.tabOrder,
        "workspace-main": ["session:agent-atlas-1234", "terminal:terminal-1"],
      },
      workspaceTerminals: {
        "workspace-main": [
          { id: "terminal-1", workspaceId: "workspace-main", cwd: "/demo/deck", name: "build" },
        ],
      },
      modal: { type: "confirm", action: "kill-terminal", terminalId: "terminal-1" },
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
    name: "creation-picker-dark",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      modal: { type: "create-agent", workspaceId: "workspace-main", step: "provider" },
    },
  },
  {
    name: "creation-picker-light",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      modal: { type: "create-agent", workspaceId: "workspace-main", step: "provider" },
    },
    appearance: { ...sampledTerminalAppearance, background: [240, 230, 220] },
  },
  {
    name: "creation-model-picker",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      modal: {
        type: "create-agent",
        workspaceId: "workspace-main",
        step: "model",
        providerId: "codex",
      },
    },
  },
  {
    name: "creation-mode-picker",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      modal: {
        type: "create-agent",
        workspaceId: "workspace-main",
        step: "mode",
        providerId: "codex",
        modelId: "gpt-5.6-terra",
      },
    },
  },
  {
    name: "creation-thinking-picker",
    columns: 100,
    rows: 28,
    state: {
      ...baseState,
      modal: {
        type: "create-agent",
        workspaceId: "workspace-main",
        step: "thinking",
        providerId: "codex",
        modelId: "gpt-5.6-terra",
      },
    },
  },
  {
    name: "session-mode-picker",
    columns: 100,
    rows: 28,
    state: { ...baseState, modal: { type: "mode", agentId: "agent-atlas-1234" } },
  },
  {
    name: "session-thinking-picker",
    columns: 100,
    rows: 28,
    state: { ...baseState, modal: { type: "thinking", agentId: "agent-atlas-1234" } },
  },
  {
    name: "creation-picker-narrow",
    columns: 52,
    rows: 12,
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
  { name: "short-layout", columns: 100, rows: 14, state: baseState },
  { name: "narrow-layout", columns: 52, rows: 18, state: baseState },
  {
    name: "narrow-main-pane",
    columns: 52,
    rows: 18,
    state: { ...baseState, focus: "composer", composerMode: "normal" },
  },
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
    appearance: shot.appearance ?? sampledTerminalAppearance,
    renderClock: {
      now: () => 12_000,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    },
  });
  deck.update(shot.state);
  deck.start();
  await terminal.waitForRender();
  await terminal.waitForRender();
  const viewport = terminal.viewport();
  const backgrounds = terminal.viewportBackgrounds();
  await deck.stop();
  await writeFile(
    join(outputDirectory, `${shot.name}.svg`),
    terminalSvg(
      viewport,
      backgrounds,
      shot.columns,
      shot.rows,
      `Paseo Deck ${shot.name.replaceAll("-", " ")}`,
      shot.columns >= NARROW_SIDEBAR_BREAKPOINT && (shot.appearance?.theme ?? "ember") === "ember"
        ? { columns: 34, color: "#1f1d1b" }
        : undefined,
    ),
    "utf8",
  );
}

function syntheticState(): AppState {
  return {
    connection: "connected",
    tabOrder: {
      "workspace-main": ["session:agent-atlas-1234", "session:agent-harbor-5678"],
      "workspace-theme": ["session:agent-lumen-9012"],
      "workspace-orphan": ["session:agent-orphan-3456"],
    },
    activeTabIds: {
      "workspace-main": "session:agent-atlas-1234",
      "workspace-theme": "session:agent-lumen-9012",
      "workspace-orphan": "session:agent-orphan-3456",
    },
    recovery: { attempt: 0, directoryStale: false, timelineStale: false },
    notifications: [],
    directory: {
      projects: [{ id: "live-project", name: "Deck Labs" }],
      workspaces: [
        {
          id: "workspace-main",
          projectId: "live-project",
          title: "Main",
          directory: "/demo/deck",
          archived: false,
        },
        {
          id: "workspace-theme",
          projectId: "live-project",
          title: "Theme polish",
          directory: "/demo/deck-theme",
          archived: false,
        },
        {
          id: "workspace-orphan",
          projectId: "missing-project",
          title: "Standalone",
          directory: "/demo/standalone",
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
        {
          id: "agent-orphan-3456",
          workspaceId: "workspace-orphan",
          title: "Orion",
          status: "idle",
          providerId: "codex",
          modelId: "gpt-5.6-terra",
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
    selectedProjectId: "live-project",
    selectedWorkspaceId: "workspace-main",
    selectedAgentId: "agent-atlas-1234",
    expandedIds: new Set(["live-project", "workspace-main", "workspace-theme", "workspace-orphan"]),
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
  backgrounds: ReadonlyArray<ReadonlyArray<string | undefined>>,
  columns: number,
  rows: number,
  title: string,
  sidebar?: { columns: number; color: string },
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
      (line, row) =>
        `<text x="${padding}" y="${chromeHeight + padding + (row + 1) * lineHeight - 4}" xml:space="preserve">${escapeXml(line.replaceAll("", " ").replaceAll("", " "))}</text>`,
    )
    .join("\n");
  const pillCaps = lines
    .slice(0, rows)
    .flatMap((line, row) =>
      [...line.matchAll(/[]/gu)].map((match) => {
        const column = terminalDisplayWidth(line.slice(0, match.index));
        const neighbor = match[0] === "" ? column + 1 : column - 1;
        const color = backgrounds[row]?.[neighbor] ?? "#f5f5f4";
        return `<text x="${padding + column * cellWidth}" y="${chromeHeight + padding + (row + 1) * lineHeight - 4}" fill="${color}" font-family="JetBrainsMono Nerd Font Mono, Menlo, Consolas, monospace" font-size="15">${match[0]}</text>`;
      }),
    )
    .join("\n");
  const backgroundsSvg = backgrounds
    .flatMap((row, rowIndex) => {
      const rectangles: string[] = [];
      let start = 0;
      while (start < row.length) {
        const color = row[start] ?? (start < (sidebar?.columns ?? 0) ? sidebar?.color : undefined);
        let end = start + 1;
        while (
          end < row.length &&
          (row[end] ?? (end < (sidebar?.columns ?? 0) ? sidebar?.color : undefined)) === color
        )
          end++;
        if (color)
          rectangles.push(
            `<rect x="${padding + start * cellWidth}" y="${chromeHeight + padding + rowIndex * lineHeight}" width="${(end - start) * cellWidth}" height="${lineHeight}" fill="${color}"/>`,
          );
        start = end;
      }
      return rectangles;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title>${escapeXml(title)}</title>
  <rect width="${width}" height="${height}" rx="12" fill="#1c1917"/>
  <rect width="${width}" height="${chromeHeight}" rx="12" fill="#292524"/>
  <rect y="20" width="${width}" height="12" fill="#292524"/>
  <circle cx="18" cy="16" r="5" fill="#ef4444"/>
  <circle cx="36" cy="16" r="5" fill="#f59e0b"/>
  <circle cx="54" cy="16" r="5" fill="#22c55e"/>
  <g>${backgroundsSvg}</g>
  <g fill="#f5f5f4" font-family="JetBrainsMono Nerd Font Mono, Menlo, Consolas, monospace" font-size="15">
${text}
  </g>
  <g>${pillCaps}</g>
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
