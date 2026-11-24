#!/usr/bin/env node

// Enforce a package's Jest coverageThreshold on coverage merged from shards.
//
// Each shard runs with Jest's own threshold check disabled because it sees
// only part of the coverage. This merges every shard's Istanbul JSON with the
// same library Jest uses and applies the package's configured global
// thresholds, so a sharded run passes or fails exactly as one run would.

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const METRICS = ['branches', 'functions', 'lines', 'statements']

export function parseArguments(arguments_) {
  const options = {}
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (!['--package', '--coverage-directory'].includes(key) || value === undefined)
      throw new Error(`Unknown or incomplete argument: ${key}`)
    options[key.slice(2)] = value
  }
  for (const key of ['package', 'coverage-directory'])
    if (!options[key]) throw new Error(`--${key} is required`)
  return options
}

export function globalThresholds(config) {
  const thresholds = config.coverageThreshold
  if (thresholds === undefined) return {}
  const keys = Object.keys(thresholds)
  if (keys.length !== 1 || keys[0] !== 'global')
    throw new Error('Only global coverage thresholds can be enforced on merged shards')
  for (const [metric, value] of Object.entries(thresholds.global)) {
    if (!METRICS.includes(metric)) throw new Error(`Unknown coverage threshold ${metric}`)
    if (!Number.isFinite(value) || value < 0 || value > 100)
      throw new Error(`Coverage threshold ${metric} must be a percentage`)
  }
  return thresholds.global
}

export function thresholdFailures(summary, thresholds) {
  return Object.entries(thresholds)
    .filter(([metric, minimum]) => summary[metric].pct < minimum)
    .map(
      ([metric, minimum]) =>
        `${metric} coverage ${summary[metric].pct}% is below the ${minimum}% threshold`
    )
}

function istanbulCoverage(packageDirectory) {
  // Resolve the copy Jest itself uses for this package.
  const requireFromPackage = createRequire(path.join(packageDirectory, 'package.json'))
  const reporters = requireFromPackage.resolve('@jest/reporters', {
    paths: [path.dirname(requireFromPackage.resolve('jest/package.json'))]
  })
  return createRequire(reporters)('istanbul-lib-coverage')
}

async function main(arguments_) {
  const options = parseArguments(arguments_)
  const packageDirectory = path.resolve(options.package)
  const { default: config } = await import(
    pathToFileURL(path.join(packageDirectory, 'jest.config.js')).href
  )
  const thresholds = globalThresholds(config)
  const files = readdirSync(options['coverage-directory'])
    .filter(file => file.endsWith('.json'))
    .sort()
  if (files.length === 0) throw new Error('No shard coverage JSON was found')

  const { createCoverageMap } = istanbulCoverage(packageDirectory)
  const map = createCoverageMap({})
  for (const file of files)
    map.merge(JSON.parse(readFileSync(path.join(options['coverage-directory'], file), 'utf8')))
  const summary = map.getCoverageSummary().data
  console.log(
    `Merged ${files.length} shards: ` +
      METRICS.map(metric => `${metric} ${summary[metric].pct}%`).join(', ')
  )
  const failures = thresholdFailures(summary, thresholds)
  if (failures.length > 0) throw new Error(failures.join('\n'))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
