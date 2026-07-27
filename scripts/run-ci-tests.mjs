#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
let projectsJson = ''
let mode = 'standard'

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--projects-json') {
    projectsJson = args[index + 1] ?? ''
    index += 1
  } else if (arg === '--mode') {
    mode = args[index + 1] ?? ''
    index += 1
  } else {
    throw new Error(`Unknown argument: ${arg}`)
  }
}

if (projectsJson === '') {
  throw new Error('--projects-json is required')
}
if (!['standard', 'coverage-other'].includes(mode)) {
  throw new Error('--mode must be standard or coverage-other')
}

const dedicatedSuites = new Set([
  '@bsv/conformance-runner',
  '@bsv/conformance-runner-ts',
  '@bsv/did',
  '@bsv/sdk',
  '@bsv/verifast',
  '@bsv/wallet-toolbox'
])

const projects = JSON.parse(readFileSync(resolve(projectsJson), 'utf8'))
const selected = projects
  .map(project => {
    const manifest = JSON.parse(readFileSync(resolve(project.path, 'package.json'), 'utf8'))
    return {
      name: manifest.name,
      path: project.path,
      scripts: manifest.scripts ?? {}
    }
  })
  .filter(project => {
    if (
      project.name === '@bsv/ts-stack' ||
      project.name === 'example-paymail' ||
      dedicatedSuites.has(project.name)
    ) {
      return false
    }
    if (mode === 'coverage-other') {
      return typeof project.scripts['test:coverage'] === 'string'
    }
    return (
      typeof project.scripts.test === 'string' &&
      typeof project.scripts['test:coverage'] !== 'string'
    )
  })
  .sort((left, right) => left.name.localeCompare(right.name))

process.stdout.write(JSON.stringify(selected.map(project => project.name)))
