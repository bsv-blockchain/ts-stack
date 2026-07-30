#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MODES = ['standard', 'coverage-other', 'browser']

const dedicatedSuites = new Set([
  '@bsv/conformance-runner',
  '@bsv/conformance-runner-ts',
  '@bsv/did',
  '@bsv/sdk',
  '@bsv/verifast',
  '@bsv/wallet-toolbox',
  'docs-site'
])

const dedicatedBrowserSuites = new Set(['@bsv/sdk', '@bsv/verifast', '@bsv/wallet-toolbox-client'])

export function parseArguments(arguments_) {
  let projectsJson = ''
  let mode = 'standard'
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--projects-json') {
      projectsJson = arguments_[index + 1] ?? ''
      index += 1
    } else if (argument === '--mode') {
      mode = arguments_[index + 1] ?? ''
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (projectsJson === '') throw new Error('--projects-json is required')
  if (!MODES.includes(mode)) {
    throw new Error(`--mode must be ${MODES.slice(0, -1).join(', ')} or ${MODES.at(-1)}`)
  }
  return { mode, projectsJson }
}

export function selectCiPackageNames(projects, mode) {
  if (!MODES.includes(mode)) throw new Error(`Unsupported CI test mode: ${mode}`)
  return projects
    .filter(project => {
      if (project.name === '@bsv/ts-stack' || project.name === 'example-paymail') {
        return false
      }
      if (mode === 'browser') {
        return (
          !dedicatedBrowserSuites.has(project.name) &&
          typeof project.scripts['test:browser'] === 'string'
        )
      }
      if (dedicatedSuites.has(project.name)) return false
      if (mode === 'coverage-other') {
        return typeof project.scripts['test:coverage'] === 'string'
      }
      return (
        typeof project.scripts.test === 'string' &&
        typeof project.scripts['test:coverage'] !== 'string'
      )
    })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(project => project.name)
}

function main(arguments_) {
  const { mode, projectsJson } = parseArguments(arguments_)
  const projects = JSON.parse(readFileSync(resolve(projectsJson), 'utf8')).map(project => {
    const manifest = JSON.parse(readFileSync(resolve(project.path, 'package.json'), 'utf8'))
    return {
      name: manifest.name,
      scripts: manifest.scripts ?? {}
    }
  })
  process.stdout.write(JSON.stringify(selectCiPackageNames(projects, mode)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
