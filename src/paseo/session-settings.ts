import { randomUUID } from "node:crypto";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PaseoTarget } from "./target.js";

/** SDK 0.8 public API/CLI omit model changes and Terminal rename. Own one isolated client. */
export interface SessionSettingsClient {
  renameTerminal(input: {
    terminalId: string;
    title: string;
  }): Promise<{ success: boolean; error: string | null }>;
  connect(): Promise<void>;
  close(): Promise<void>;
  setAgentModel(agentId: string, modelId: string | null): Promise<void>;
  setAgentThinkingOption(
    agentId: string,
    thinkingOptionId: string | null,
  ): Promise<{ type: "info" | "warning" | "error"; message: string } | null>;
}

export function createSessionSettingsClient(target: PaseoTarget): SessionSettingsClient {
  return new DaemonClient({
    url: target.websocketUrl,
    clientId: `deck-settings-${randomUUID()}`,
    clientType: "cli",
    ...(target.password === undefined ? {} : { password: target.password }),
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}
