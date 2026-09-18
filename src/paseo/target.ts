import { PaseoGatewayError } from "./errors.js";

export interface PaseoTargetInput {
  home?: string;
  host?: string;
  password?: string;
}

export interface PaseoTarget {
  websocketUrl: string;
  password?: string;
  cliArguments: readonly string[];
  /** The original user target, retained for error messages and CLI fallbacks. */
  originalTarget: string;
}

export type DaemonStatus = { listen?: unknown };

export function websocketUrlForTcpTarget(target: string): string {
  const trimmed = target.trim();
  if (trimmed.length === 0) {
    throw new PaseoGatewayError("A Paseo host cannot be empty.");
  }
  if (/^ssh:/i.test(trimmed)) {
    throw new PaseoGatewayError(
      "SSH targets are not supported by Paseo Deck v0.1. Use a direct TCP daemon target.",
    );
  }
  if (/^https?:/i.test(trimmed) || trimmed.includes("#offer=")) {
    throw new PaseoGatewayError(
      "Relay pairing offers are not supported by Paseo Deck v0.1. Use a direct TCP daemon target.",
    );
  }

  const withoutScheme = trimmed.replace(/^tcp:\/\//i, "");
  if (withoutScheme.includes("/") || !/^[^:]+:\d+$/.test(withoutScheme)) {
    throw new PaseoGatewayError("Use --host as host:port or tcp://host:port.");
  }
  return `ws://${withoutScheme}/ws`;
}

export function targetFromDaemonStatus(input: PaseoTargetInput, status: DaemonStatus): PaseoTarget {
  if (input.host !== undefined) {
    return {
      websocketUrl: websocketUrlForTcpTarget(input.host),
      ...(input.password === undefined ? {} : { password: input.password }),
      cliArguments: ["--host", input.host],
      originalTarget: input.host,
    };
  }

  if (typeof status.listen !== "string") {
    throw new PaseoGatewayError("Paseo daemon status did not include a TCP listen address.");
  }
  const home = input.home;
  return {
    websocketUrl: websocketUrlForTcpTarget(status.listen),
    ...(input.password === undefined ? {} : { password: input.password }),
    cliArguments: home === undefined ? [] : ["--home", home],
    originalTarget: home === undefined ? status.listen : home,
  };
}
