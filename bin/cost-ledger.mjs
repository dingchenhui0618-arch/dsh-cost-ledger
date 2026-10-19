#!/usr/bin/env node
// Thin bin wrapper. All logic lives in lib/cli.js so it is unit-testable
// without spawning a process.
import { runCli } from '../lib/cli.js'

const result = runCli(process.argv.slice(2))
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
process.exitCode = result.code
