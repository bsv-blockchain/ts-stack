#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
let scopeFilter = ''
let dryRun = false

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--scope-filter') {
    scopeFilter = args[index + 1] ?? ''
    index += 1
  } else if (arg === '--dry-run') {
    dryRun = true
  } else {
    throw new Error(`Unknown argument: ${arg}`)
  }
}

const listArgs = ['-r']
if (scopeFilter !== '') {
  listArgs.push('--filter', scopeFilter)
}
listArgs.push('list', '--depth', '-1', '--json')

const listed = spawnSync('pnpm', listArgs, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit']
})

if (listed.status !== 0) {
  process.exit(listed.status ?? 1)
}

const dedicatedSuites = new Set([
  '@bsv/conformance-runner',
  '@bsv/conformance-runner-ts'
])

const projects = JSON.parse(listed.stdout)
const selected = projects
  .map(project => {
    const manifest = JSON.parse(
      readFileSync(resolve(project.path, 'package.json'), 'utf8')
    )
    return {
      name: manifest.name,
      path: project.path,
      scripts: manifest.scripts ?? {}
    }
  })
  .filter(project =>
    project.name !== '@bsv/ts-stack' &&
    project.name !== 'example-paymail' &&
    !dedicatedSuites.has(project.name) &&
    typeof project.scripts.test === 'string' &&
    typeof project.scripts['test:coverage'] !== 'string'
  )
  .sort((left, right) => left.name.localeCompare(right.name))

if (selected.length === 0) {
  console.log('No affected packages require the non-coverage test lane.')
  process.exit(0)
}

console.log('Non-coverage test lane:')
for (const project of selected) {
  console.log(`  - ${project.name}`)
}

if (dryRun) {
  process.exit(0)
}

const testArgs = ['-r']
for (const project of selected) {
  testArgs.push('--filter', project.name)
}
testArgs.push('run', 'test')

const tested = spawnSync('pnpm', testArgs, {
  stdio: 'inherit'
})

process.exit(tested.status ?? 1)
