#!/usr/bin/env node
import { start } from './cli.js'
import { interactiveConfigPrompt } from './prompts.js'

// Everything else lives in cli.ts so it can be tested; this only wires in the process.
start(process.argv.slice(2), interactiveConfigPrompt)
