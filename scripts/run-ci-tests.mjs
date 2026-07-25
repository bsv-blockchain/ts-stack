#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
let projectsJson = ''

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--projects-json') {
    projectsJson = args[index + 1] ?? ''
    index += 1
  } else {
    throw new Error(`Unknown argument: ${arg}`)
  }
}

if (projectsJson === '') {
  throw new Error('--projects-json is required')
}

const dedicatedSuites = new Set([
  '@bsv/conformance-runner',
  '@bsv/conformance-runner-ts'
])

const projects = JSON.parse(readFileSync(resolve(projectsJson), 'utf8'))
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

process.stdout.write(JSON.stringify(selected.map(project => project.name)))
