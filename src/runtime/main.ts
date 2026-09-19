import { ProcessTerminal, type Terminal } from "@earendil-works/pi-tui";
import { ApplicationController } from "../app/controller.js";
import type { PaseoGateway } from "../contracts/gateway.js";
import { createPaseoGateway, type PaseoGatewayOptions } from "../paseo/gateway.js";
import { detectTerminalAppearance, type TerminalEnvironment } from "../ui/capabilities.js";
import { DeckTui } from "../ui/views.js";
import {
  CliArgumentError,
  type CliArguments,
  parseArguments,
  type TargetArgument,
} from "./arguments.js";
import { ShutdownCoordinator } from "./lifecycle.js";
import { type PreferenceFileSystem, PreferenceSession } from "./preferences.js";

const VERSION = "0.1.0";

export const HELP = `Paseo Deck ${VERSION}

Usage: paseo-deck [options]

Options:
  --home <path>    Connect through a local Paseo home
  --host <target>  Connect to a TCP Paseo daemon (host:port or tcp://host:port)
  -h, --help       Show this help
  -v, --version    Show the version

Authentication:
  Set PASEO_PASSWORD in the environment. Passwords are never accepted as arguments.
`;

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface RunCliOptions {
  io?: CliIo;
}

export interface RuntimeExitHandlers {
  signal(signal: "SIGINT" | "SIGTERM"): void;
  fatal(error: unknown): void;
}

export interface InteractiveDependencies {
  gateway?: PaseoGateway;
  terminal?: Terminal;
  bindExitHandlers?: (handlers: RuntimeExitHandlers) => () => void;
  environment?: TerminalEnvironment;
  preferences?: PreferenceFileSystem;
  preferencesPath?: string;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const io = options.io ?? {
    stdout: (value: string) => process.stdout.write(value),
    stderr: (value: string) => process.stderr.write(value),
  };
  let parsed: CliArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    const message = error instanceof CliArgumentError ? error.message : String(error);
    io.stderr(`paseo-deck: ${message}\nRun paseo-deck --help for usage.\n`);
    return 2;
  }

  if (parsed.command === "help") {
    io.stdout(HELP);
    return 0;
  }
  if (parsed.command === "version") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    io.stderr("paseo-deck: an interactive terminal is required.\n");
    return 1;
  }

  return runInteractive(parsed.target, io);
}

export async function runInteractive(
  target: TargetArgument,
  io: CliIo,
  dependencies: InteractiveDependencies = {},
): Promise<number> {
  const gateway = dependencies.gateway ?? createPaseoGateway(gatewayOptions(target));
  const terminal = dependencies.terminal ?? new ProcessTerminal();
  const preferenceSession = await PreferenceSession.open(target, {
    ...(dependencies.preferences ? { fs: dependencies.preferences } : {}),
    ...(dependencies.preferencesPath ? { path: dependencies.preferencesPath } : {}),
    ...(dependencies.setTimeout ? { setTimeout: dependencies.setTimeout } : {}),
    ...(dependencies.clearTimeout ? { clearTimeout: dependencies.clearTimeout } : {}),
    onWarning: (message) => io.stderr(`paseo-deck: ${message}\n`),
  });
  if (preferenceSession.warning) io.stderr(`paseo-deck: ${preferenceSession.warning}\n`);
  const detected = detectTerminalAppearance(dependencies.environment ?? process.env);
  const requested = preferenceSession.requestedGlobal();
  const appearance = {
    ...detected,
    theme: detected.color === "none" ? "plain" : (requested.theme ?? detected.theme),
    symbols: detected.unicode ? (requested.symbolSet ?? detected.symbols) : "ascii",
  } as const;
  let requestShutdown: (code?: number, error?: unknown) => Promise<void> = async () => undefined;
  const app = new ApplicationController(gateway, {
    onQuit: () => requestShutdown(0),
    initialState: preferenceSession.initialState(),
  });
  // Capability detection is deliberately a runtime concern: views are pure of
  // environment reads and receive a stable appearance for their whole run.
  const deck = new DeckTui(
    terminal,
    app.state,
    (intent) => {
      void app.handleIntent(intent).catch((error: unknown) => requestShutdown(1, error));
    },
    {
      appearance,
      treeWidth: preferenceSession.treeWidth(),
      ...(requested.theme ? { requestedTheme: requested.theme } : {}),
      ...(requested.symbolSet ? { requestedSymbolSet: requested.symbolSet } : {}),
      onPreferencesChanged: (value) => {
        preferenceSession.present(value);
      },
    },
  );
  const unsubscribeState = app.subscribe((state) => {
    deck.update(state);
    preferenceSession.observe(state);
  });
  const shutdown = new ShutdownCoordinator({
    releaseObservations: async () => {
      unsubscribeState();
      await app.releaseObservations();
    },
    closeGateway: async () => {
      await preferenceSession.flush();
      await gateway.close();
    },
    drainInput: async () => undefined,
    restoreTerminal: () => deck.stop(),
  });

  let finish: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });
  let shutdownPromise: Promise<void> | undefined;
  let removeHandlers = (): void => undefined;
  requestShutdown = (code = 0, error?: unknown): Promise<void> => {
    shutdownPromise ??= (async () => {
      let finalCode = code;
      let finalError = error;
      try {
        await shutdown.shutdown();
      } catch (cleanupError) {
        finalCode = 1;
        finalError ??= cleanupError;
      } finally {
        removeHandlers();
        if (finalError !== undefined) io.stderr(`paseo-deck: ${errorText(finalError)}\n`);
        finish(finalCode);
      }
    })();
    return shutdownPromise;
  };

  removeHandlers = (dependencies.bindExitHandlers ?? bindProcessExitHandlers)({
    signal: (signal) => void requestShutdown(signal === "SIGINT" ? 130 : 143),
    fatal: (error) => void requestShutdown(1, error),
  });

  try {
    deck.start();
    await app.start();
  } catch (error) {
    await requestShutdown(1, error);
  }
  return done;
}

function bindProcessExitHandlers(handlers: RuntimeExitHandlers): () => void {
  const onSigint = (): void => handlers.signal("SIGINT");
  const onSigterm = (): void => handlers.signal("SIGTERM");
  const onUncaught = (error: Error): void => handlers.fatal(error);
  const onUnhandled = (reason: unknown): void => handlers.fatal(reason);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  process.once("uncaughtException", onUncaught);
  process.once("unhandledRejection", onUnhandled);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
  };
}

function gatewayOptions(target: TargetArgument): PaseoGatewayOptions {
  switch (target.type) {
    case "default":
      return {};
    case "home":
      return { home: target.path };
    case "host":
      return { host: target.value };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
