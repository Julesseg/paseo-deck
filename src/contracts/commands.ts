export type AgentCommand =
  | { type: "send-prompt"; agentId: string; prompt: string }
  | {
      type: "create-agent";
      workspaceId: string;
      providerId: string;
      modelId: string;
      prompt: string;
      title?: string;
      modeId?: string;
      thinkingLevel?: string;
    }
  | { type: "respond-permission"; agentId: string; requestId: string; allow: boolean }
  | { type: "stop-agent"; agentId: string }
  | { type: "archive-agent"; agentId: string }
  | { type: "detach-agent"; agentId: string }
  | { type: "rename-agent"; agentId: string; name: string }
  | { type: "set-agent-mode"; agentId: string; modeId: string }
  | { type: "set-thinking-level"; agentId: string; thinkingLevel: string };

export type CommandResult =
  | { type: "ok" }
  | { type: "agent-created"; agentId: string }
  | { type: "permission-resolved"; requestId: string };
