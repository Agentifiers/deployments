#!/usr/bin/env bun

import { flushCliOutput, runCli } from "./cli.ts";

const exitCode = await runCli();
await flushCliOutput();
process.exitCode = exitCode;
