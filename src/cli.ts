#!/usr/bin/env node

import { runCli } from "./runtime/main.js";

process.exitCode = await runCli(process.argv.slice(2));
