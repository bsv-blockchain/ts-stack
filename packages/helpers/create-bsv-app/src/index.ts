#!/usr/bin/env node
import { run, parseArgs } from './cli.js'
import { interactivePrompt } from './prompts.js'
import { uiPrompt } from './ui.js'

const args = parseArgs(process.argv.slice(2))
const provider = args.ui ? uiPrompt : interactivePrompt

run(process.argv.slice(2), provider)
  .then((res) => {
    console.log(`\nInstalled into ${res.targetDir}: ${res.written.length} file(s), ${res.skipped.length} skipped.`)
    const deps = Object.keys(res.dependencies)
    if (deps.length > 0) {
      console.log('\nAdd these dependencies:')
      console.log('  npm install ' + deps.join(' '))
    }
    console.log('\nSee AGENTS.md for wiring + how to extend.')
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
