#!/usr/bin/env node
import { CLI_HELP, run } from './cli.js'
import { interactiveConfigPrompt } from './prompts.js'
import { formatConfigError } from './config/validate.js'
import { getStarter } from './starters.js'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(CLI_HELP)
  process.exit(0)
}

try {
  const res = await run(argv, interactiveConfigPrompt)
  const verb = res.skipped.length === 0 && res.written.length > 0 ? 'Scaffolded' : 'Updated'
  console.log(`\n${verb} ${res.targetDir} (${res.written.length} file(s) written).`)
  if (res.installed === false) {
    console.log(
      '\nDependencies were not installed. Run your package manager install command before starting.'
    )
  } else if (res.installed === true) {
    console.log('\nDependencies installed.')
  }
  if (getStarter(res.starter ?? '')?.kind === 'repository') {
    console.log(
      `\nNext:\n  cd ${res.targetDir}\n  Follow the starter README for its development commands.`
    )
  } else {
    console.log(`\nNext:\n  cd ${res.targetDir}\n  ${res.packageManager ?? 'npm'} run dev`)
  }
  console.log(
    '\nSee the generated README/AGENTS.md when present and bsv-scaffold.json for exact provenance.'
  )
} catch (err) {
  console.error(formatConfigError(err))
  process.exit(1)
}
