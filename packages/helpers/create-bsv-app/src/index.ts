#!/usr/bin/env node
import { main } from './cli.js'
import { interactiveConfigPrompt } from './prompts.js'

// Everything else lives in main() so it can be tested; this only wires in the process.
void main(process.argv.slice(2), interactiveConfigPrompt).then(code => {
  process.exitCode = code
})
