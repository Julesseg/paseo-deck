export type TargetArgument =
  | { type: "default" }
  | { type: "home"; path: string }
  | { type: "host"; value: string };

export interface CliArguments {
  command: "run" | "help" | "version";
  target: TargetArgument;
}

export class CliArgumentError extends Error {
  override readonly name = "CliArgumentError";
}

export function parseArguments(argv: readonly string[]): CliArguments {
  let target: TargetArgument = { type: "default" };
  let selectorSeen = false;
  let command: CliArguments["command"] = "run";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      command = "help";
      continue;
    }
    if (argument === "--version" || argument === "-v") {
      command = "version";
      continue;
    }
    if (argument === "--home" || argument === "--host") {
      if (selectorSeen) {
        throw new CliArgumentError("Use either --home or --host, not both");
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new CliArgumentError(`${argument} requires a value`);
      }
      selectorSeen = true;
      target = argument === "--home" ? { type: "home", path: value } : { type: "host", value };
      index += 1;
      continue;
    }
    throw new CliArgumentError(`Unknown option: ${argument}`);
  }

  return { command, target };
}
