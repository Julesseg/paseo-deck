import { randomUUID } from "node:crypto";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PaseoTarget } from "./target.js";

export interface WorkspaceLabelsClient
  extends Pick<DaemonClient, "listWorkspaceLabels" | "observeWorkspaceLabels"> {
  connect(): Promise<void>;
  close(): Promise<void>;
}

export function createWorkspaceLabelsClient(target: PaseoTarget): WorkspaceLabelsClient {
  return new DaemonClient({
    url: target.websocketUrl,
    clientId: `deck-labels-${randomUUID()}`,
    clientType: "cli",
    ...(target.password === undefined ? {} : { password: target.password }),
    reconnect: { enabled: true },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}
