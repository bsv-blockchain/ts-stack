#!/usr/bin/env node
import { run } from './cli.js'
import { interactiveConfigPrompt } from './prompts.js'

run(process.argv.slice(2), interactiveConfigPrompt)
  .then((res) => {
    const verb = res.skipped.length === 0 && res.written.length > 0 ? 'Scaffolded' : 'Updated'
    console.log(`\n${verb} ${res.targetDir} (${res.written.length} file(s) written).`)
    for (const [target, d] of Object.entries(res.deps)) {
      const names = Object.keys(d)
      if (names.length > 0) console.log(`\nAdd deps${target === 'root' ? '' : ` (${target}/)`}:\n  npm install ${names.join(' ')}`)
    }
    console.log('\nSee AGENTS.md for wiring + how to extend.')
  })
  .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
