#!/usr/bin/env node

const HELP = `Paseo Deck 0.1.0

Usage: paseo-deck [options]

Options:
  --home <path>    Connect through a local Paseo home
  --host <target>  Connect to a TCP Paseo daemon
  -h, --help       Show this help
  -v, --version    Show the version
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(HELP);
} else if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("0.1.0\n");
} else {
  process.stderr.write("Paseo Deck is not wired yet.\n");
  process.exitCode = 1;
}
