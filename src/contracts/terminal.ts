import type { TerminalProfile } from "@getpaseo/protocol/messages";

/** A daemon-owned terminal, deliberately separate from an agent/session. */
export interface TerminalRecord {
  id: string;
  workspaceId: string;
  cwd: string;
  name: string;
  title?: string;
  activity?: "idle" | "working" | "attention";
}

export interface TerminalCapture {
  terminalId: string;
  lines: readonly string[];
  totalLines: number;
}

export type TerminalStreamUpdate =
  | { type: "output"; terminalId: string; data: Uint8Array }
  | { type: "snapshot"; terminalId: string; lines: readonly string[] }
  | { type: "restore"; terminalId: string; data: Uint8Array }
  | { type: "exited"; terminalId: string };

export type TerminalObservation = { release(): Promise<void> };

export interface TerminalCreateOptions {
  name?: string;
  cwd?: string;
  command?: string;
  args?: readonly string[];
  size?: { rows: number; cols: number };
}

export interface TerminalGateway {
  listTerminalProfiles(): Promise<readonly TerminalProfile[]>;
  listTerminals(workspaceId: string): Promise<readonly TerminalRecord[]>;
  createTerminal(workspaceId: string, options?: TerminalCreateOptions): Promise<TerminalRecord>;
  createProfileTerminal(workspaceId: string, profile: TerminalProfile): Promise<TerminalRecord>;
  captureTerminal(
    terminalId: string,
    options?: { start?: number; end?: number },
  ): Promise<TerminalCapture>;
  sendTerminalInput(terminalId: string, data: string): void;
  observeTerminal(
    terminalId: string,
    listener: (update: TerminalStreamUpdate) => void,
  ): Promise<TerminalObservation>;
  killTerminal(terminalId: string): Promise<void>;
}

export type { TerminalProfile };
