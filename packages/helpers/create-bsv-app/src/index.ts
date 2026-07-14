#!/usr/bin/env node
import { run } from './cli.js'
import { interactiveConfigPrompt } from './prompts.js'
import { formatConfigError } from './config/validate.js'

try {
  const res = await run(process.argv.slice(2), interactiveConfigPrompt)
  const verb = res.skipped.length === 0 && res.written.length > 0 ? 'Scaffolded' : 'Updated'
  console.log(`\n${verb} ${res.targetDir} (${res.written.length} file(s) written).`)
  for (const [target, d] of Object.entries(res.deps)) {
    const names = Object.keys(d)
    if (names.length > 0) {
      const cmd = target === 'root' ? 'npm i' : `cd ${target} && npm i`
      const suffix = target === 'root' ? '' : ` (${target}/)`
      console.log(`\nInstall deps${suffix}:\n  ${cmd}`)
    }
  }
  console.log('\nSee AGENTS.md for wiring + how to extend.')
} catch (err) {
  console.error(formatConfigError(err))
  process.exit(1)
}
