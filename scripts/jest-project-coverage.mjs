#!/usr/bin/env node

// Runs a package's Jest coverage once per Jest project and merges the results
// in source coordinates.
//
// One Jest run over several projects merges each file's raw coverage before
// applying source maps, and then maps the merged data with a single project's
// map. When the projects compile the same file differently (for example
// CommonJS and ES modules), the other project's counts land on the wrong
// source lines. Running each project on its own maps every result with its own
// source map; istanbul then merges the source-coordinate maps by location.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const PROJECT_NAME = /^[A-Za-z0-9][\w.-]*$/

/**
 * Every project in the package's Jest config, so a project added later is
 * covered without editing the package script.
 */
export function projectNames(config) {
  const projects = config?.projects
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error('Jest config must define projects')
  }
  const names = projects.map(project => {
    const name =
      typeof project?.displayName === 'string' ? project.displayName : project?.displayName?.name
    if (!PROJECT_NAME.test(name ?? '')) throw new Error(`Jest project needs a displayName: ${name}`)
    return name
  })
  if (new Set(names).size !== names.length)
    throw new Error('Jest project displayNames must be unique')
  return names
}

export function jestArguments(project, coverageDirectory) {
  return [
    '--experimental-vm-modules',
    'node_modules/jest/bin/jest.js',
    '--coverage',
    '--runInBand',
    '--watchman=false',
    `--selectProjects=${project}`,
    '--coverageReporters=json',
    `--coverageDirectory=${coverageDirectory}`
  ]
}

// The istanbul copies Jest itself uses for this package, resolved at run time
// so the dependency-free script tests can import this module.
function istanbul(packageDirectory) {
  const requireFromPackage = createRequire(path.join(packageDirectory, 'package.json'))
  const requireFromReporters = createRequire(
    requireFromPackage.resolve('@jest/reporters', {
      paths: [path.dirname(requireFromPackage.resolve('jest/package.json'))]
    })
  )
  return {
    coverage: requireFromReporters('istanbul-lib-coverage'),
    report: requireFromReporters('istanbul-lib-report'),
    reports: requireFromReporters('istanbul-reports')
  }
}

/** Merges per-project istanbul JSON maps that are already in source coordinates. */
function mergeCoverage(coverageLibrary, projectMaps) {
  const merged = coverageLibrary.createCoverageMap({})
  for (const map of projectMaps) merged.merge(map)
  return merged
}

function writeReports({ report: reportLibrary, reports }, coverageMap, directory) {
  const context = reportLibrary.createContext({ dir: directory, coverageMap })
  for (const [name, options] of [
    ['json', { file: 'coverage-final.json' }],
    ['lcov', {}],
    ['text-summary', {}]
  ]) {
    reports.create(name, options).execute(context)
  }
}

async function main(arguments_) {
  if (arguments_.length > 0) throw new Error(`Unknown argument: ${arguments_[0]}`)
  const config = await import(pathToFileURL(path.resolve('jest.config.js')).href)
  const projects = projectNames(config.default)
  const coverageDirectory = path.resolve('coverage')
  rmSync(coverageDirectory, { recursive: true, force: true })
  const maps = []
  for (const project of projects) {
    const projectDirectory = path.join(coverageDirectory, 'projects', project)
    mkdirSync(projectDirectory, { recursive: true })
    console.log(`Jest coverage for project ${project}`)
    const run = spawnSync(process.execPath, jestArguments(project, projectDirectory), {
      stdio: 'inherit',
      env: process.env
    })
    if (run.error) throw run.error
    if (run.status !== 0)
      throw new Error(`Jest project ${project} exited with ${run.status ?? run.signal}`)
    maps.push(JSON.parse(readFileSync(path.join(projectDirectory, 'coverage-final.json'), 'utf8')))
  }
  const libraries = istanbul(process.cwd())
  writeReports(libraries, mergeCoverage(libraries.coverage, maps), coverageDirectory)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
