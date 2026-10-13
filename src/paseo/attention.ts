import { randomUUID } from "node:crypto";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PaseoTarget } from "./target.js";

export interface AttentionClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  clearAgentAttention(agentId: string): Promise<void>;
}

export function createAttentionClient(target: PaseoTarget): AttentionClient {
  return new DaemonClient({
    url: target.websocketUrl,
    clientId: `deck-attention-${randomUUID()}`,
    clientType: "cli",
    ...(target.password === undefined ? {} : { password: target.password }),
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}
