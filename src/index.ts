export type { AppState } from "./contracts/app-state.js";
export type { AgentCommand, CommandResult } from "./contracts/commands.js";
export type * from "./contracts/domain.js";
export type { Observation, PaseoGateway } from "./contracts/gateway.js";
export type {
  TerminalCapture,
  TerminalCreateOptions,
  TerminalGateway,
  TerminalObservation,
  TerminalRecord,
  TerminalStreamUpdate,
} from "./contracts/terminal.js";
export { TerminalTabs } from "./ui/terminal-tabs.js";
