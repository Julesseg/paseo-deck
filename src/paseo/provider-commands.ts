import { randomUUID } from "node:crypto";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PaseoTarget } from "./target.js";

export interface ProviderCommandsClient extends Pick<DaemonClient, "listCommands"> {
  connect(): Promise<void>;
  close(): Promise<void>;
}

export function createProviderCommandsClient(target: PaseoTarget): ProviderCommandsClient {
  return new DaemonClient({
    url: target.websocketUrl,
    clientId: `deck-commands-${randomUUID()}`,
    clientType: "cli",
    ...(target.password === undefined ? {} : { password: target.password }),
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}
