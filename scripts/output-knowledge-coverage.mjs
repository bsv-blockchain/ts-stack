#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import coverageLibrary from 'istanbul-lib-coverage'
import reportLibrary from 'istanbul-lib-report'
import reports from 'istanbul-reports'
import config from '../packages/application/output-knowledge/jest.coverage.config.js'
import {
  APPLICATION_COVERAGE_SHARDS,
  compareCoveragePaths,
  relativeTests,
  validateShardUnion,
  enforceGlobalCoverage,
  applicationCoverageBatches,
  mergeCoverageBatchResults
} from './output-knowledge-coverage-validation.mjs'
export {
  assertCompleteResults,
  validateShardUnion,
  enforceGlobalCoverage
} from './output-knowledge-coverage-validation.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageDirectory = path.join(root, 'packages/application/output-knowledge')
const { createCoverageMap } = coverageLibrary
const { createContext } = reportLibrary

export function mergeCoverage(shards) {
  const expected = Object.keys(shards[0].coverage).toSorted(compareCoveragePaths)
  assert.ok(expected.length > 0, 'empty coverage artifact')
  const map = createCoverageMap({})
  for (const shard of shards) {
    assert.deepEqual(
      Object.keys(shard.coverage).toSorted(compareCoveragePaths),
      expected,
      'different instrumented source inventory'
    )
    map.merge(shard.coverage)
  }
  return map
}

function identity() {
  const { GITHUB_SHA: sha, GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt } = process.env
  assert.match(sha ?? '', /^[0-9a-f]{40}$/)
  assert.match(run ?? '', /^[1-9]\d*$/)
  assert.match(attempt ?? '', /^[1-9]\d*$/)
  const hash = createHash('sha256')
  for (const file of [
    'packages/application/output-knowledge/jest.config.js',
    'packages/application/output-knowledge/jest.coverage.config.js',
    'scripts/output-knowledge-coverage.mjs',
    'scripts/output-knowledge-coverage-validation.mjs',
    'package.json',
    'pnpm-lock.yaml'
  ]) {
    hash.update(file).update(readFileSync(path.join(root, file)))
  }
  return { sha, run, attempt, configuration: hash.digest('hex') }
}

function jest(arguments_, capture = false) {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      'node_modules/jest/bin/jest.js',
      '--config',
      'jest.coverage.config.js',
      '--watchman=false',
      ...arguments_
    ],
    {
      cwd: packageDirectory,
      env: process.env,
      stdio: capture ? 'pipe' : 'inherit',
      encoding: 'utf8'
    }
  )
  if (result.error) throw result.error
  assert.equal(result.signal, null, 'Jest terminated by signal')
  assert.equal(result.status, 0, `Jest exited ${result.status}: ${result.stderr ?? ''}`)
  return capture ? JSON.parse(result.stdout) : undefined
}

function inventory(shard) {
  return relativeTests(
    jest(
      [
        '--listTests',
        '--json',
        ...(shard ? [`--shard=${shard}/${APPLICATION_COVERAGE_SHARDS}`] : [])
      ],
      true
    )
  )
}

function collect(shard, output) {
  assert.ok(Number.isSafeInteger(shard) && shard >= 1 && shard <= APPLICATION_COVERAGE_SHARDS)
  mkdirSync(output, { recursive: true })
  const manifest = {
    identity: identity(),
    shard,
    total: APPLICATION_COVERAGE_SHARDS,
    allTests: inventory(),
    selectedTests: inventory(shard)
  }
  manifest.batches = applicationCoverageBatches(manifest.selectedTests)
  writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest))
  const batches = []
  for (const batch of manifest.batches) {
    const directory = path.join(output, 'batches', batch.id)
    mkdirSync(directory, { recursive: true })
    const batchManifest = { identity: manifest.identity, ...batch }
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(batchManifest))
    // Preserve full source instrumentation and defer ONLY the existing global
    // threshold to the complete aggregate. Each fresh process remains serial.
    jest([
      '--coverage',
      '--coverageThreshold={}',
      '--coverageReporters=json',
      `--coverageDirectory=${directory}`,
      ...(batch.runInBand ? ['--runInBand'] : []),
      '--json',
      `--outputFile=${path.join(directory, 'results.json')}`,
      '--runTestsByPath',
      ...batch.selectedTests
    ])
    batches.push({
      manifest: batchManifest,
      results: JSON.parse(readFileSync(path.join(directory, 'results.json'))),
      coverage: JSON.parse(readFileSync(path.join(directory, 'coverage-final.json')))
    })
  }
  const results = mergeCoverageBatchResults(batches, manifest.identity, manifest.selectedTests)
  const coverage = mergeCoverage(batches).toJSON()
  writeFileSync(path.join(output, 'results.json'), JSON.stringify(results))
  writeFileSync(path.join(output, 'coverage-final.json'), JSON.stringify(coverage))
  console.log(
    `Complete application coverage shard ${shard}/${APPLICATION_COVERAGE_SHARDS}: ${manifest.selectedTests.length} suites`
  )
}

function aggregate(input, output) {
  const shards = Array.from({ length: APPLICATION_COVERAGE_SHARDS }, (_, index) => index + 1).map(
    shard => {
      const directory = path.join(input, `shard-${shard}`)
      const read = file => JSON.parse(readFileSync(path.join(directory, file)))
      const manifest = read('manifest.json')
      const plan = applicationCoverageBatches(manifest.selectedTests)
      assert.deepEqual(manifest.batches, plan, 'changed execution plan')
      const batches = plan.map(batch => {
        const base = path.join('batches', batch.id)
        return {
          manifest: read(path.join(base, 'manifest.json')),
          results: read(path.join(base, 'results.json')),
          coverage: read(path.join(base, 'coverage-final.json'))
        }
      })
      const results = mergeCoverageBatchResults(batches, manifest.identity, manifest.selectedTests)
      const coverage = mergeCoverage(batches).toJSON()
      assert.deepEqual(read('results.json'), results, 'merged test results differ from raw batches')
      assert.deepEqual(
        read('coverage-final.json'),
        coverage,
        'merged coverage differs from raw batches'
      )
      return { manifest, results, coverage }
    }
  )
  const expected = inventory()
  validateShardUnion(shards, identity(), expected)
  const map = mergeCoverage(shards)
  const summary = enforceGlobalCoverage(map, config.coverageThreshold)
  const context = createContext({ dir: output, coverageMap: map })
  for (const reporter of ['json', 'lcovonly', 'text-summary'])
    reports.create(reporter).execute(context)
  console.log(
    JSON.stringify({
      identity: identity(),
      suites: expected.length,
      tests: shards.reduce((total, shard) => total + shard.results.numTotalTests, 0),
      summary
    })
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [command, argument, destination] = process.argv.slice(2)
    if (command === 'collect' && argument && destination)
      collect(Number(argument), path.resolve(destination))
    else if (command === 'aggregate' && argument && destination)
      aggregate(path.resolve(argument), path.resolve(destination))
    else
      throw new Error(
        `Use collect <1..${APPLICATION_COVERAGE_SHARDS}> <output> or aggregate <input> <output>`
      )
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
