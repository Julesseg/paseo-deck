import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppState } from "../src/contracts/app-state.js";
import { RecordingTerminal } from "../src/ui/terminal.js";
import { DeckTui } from "../src/ui/views.js";

const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error("Usage: tsx scripts/capture-ui-report.ts <output-directory>");

const baseState = syntheticState();
const shots: Array<{
  name: string;
  columns: number;
  rows: number;
  state: AppState;
}> = [
  { name: "session-tree", columns: 100, rows: 28, state: baseState },
  {
    name: "active-timeline",
    columns: 100,
    rows: 28,
    state: { ...baseState, focus: "timeline" },
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
        request: {
          id: "permission-demo",
          agentId: "agent-harbor",
          title: "Run the verification command",
          description: "Allow this disposable session to run npm test?",
        },
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
      composer: {
        ...baseState.composer,
        drafts: { "agent-atlas-1234": "This draft remains while the daemon reconnects." },
      },
      notification: { kind: "info", message: "Reconnecting to Paseo…" },
    },
  },
  { name: "narrow-layout", columns: 52, rows: 18, state: baseState },
];

await mkdir(outputDirectory, { recursive: true });
for (const shot of shots) {
  const terminal = new RecordingTerminal(shot.columns, shot.rows);
  const deck = new DeckTui(terminal, shot.state, () => undefined);
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
