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

const root = fileURLToPath(new URL('..', import.meta.url))
const packageDirectory = path.join(root, 'packages/application/output-knowledge')
const shardCount = 2
const { createCoverageMap } = coverageLibrary
const { createContext } = reportLibrary

function relativeTests(tests, directory = packageDirectory) {
  assert.ok(Array.isArray(tests) && tests.length > 0, 'empty test inventory')
  return tests
    .map(test => {
      const relative = path.relative(directory, test).split(path.sep).join('/')
      assert.ok(relative.startsWith('test/') && relative.endsWith('.test.ts'))
      assert.ok(!relative.split('/').includes('..'))
      return relative
    })
    .sort()
}

export function assertCompleteResults(results, selected, directory = packageDirectory) {
  assert.equal(results.success, true, 'Jest did not succeed')
  assert.equal(results.numFailedTests, 0)
  assert.equal(results.numFailedTestSuites, 0)
  assert.equal(results.numPendingTests, 0, 'pending tests are not qualification')
  assert.equal(results.numTodoTests, 0)
  assert.equal(results.numPendingTestSuites, 0)
  assert.ok(results.numTotalTests > 0)
  assert.equal(results.numPassedTests, results.numTotalTests)
  assert.equal(results.numTotalTestSuites, selected.length)
  assert.equal(results.numPassedTestSuites, selected.length)
  assert.deepEqual(
    relativeTests(
      results.testResults.map(test => test.name),
      directory
    ),
    selected
  )
  assert.equal(
    results.testResults.reduce((total, suite) => total + suite.assertionResults.length, 0),
    results.numTotalTests
  )
  for (const suite of results.testResults) {
    assert.equal(suite.status, 'passed')
    assert.ok(suite.assertionResults.length > 0)
    assert.ok(suite.assertionResults.every(result => result.status === 'passed'))
  }
}

export function validateShardUnion(shards, identity, expected) {
  assert.equal(shards.length, shardCount, 'both same-run shards are required')
  const selected = []
  const ids = new Set()
  for (const { manifest, results } of shards) {
    assert.deepEqual(manifest.identity, identity, 'different run, attempt, source or configuration')
    assert.equal(manifest.total, shardCount)
    assert.ok([1, 2].includes(manifest.shard) && !ids.has(manifest.shard))
    ids.add(manifest.shard)
    assert.deepEqual(manifest.allTests, expected)
    assertCompleteResults(results, manifest.selectedTests)
    selected.push(...manifest.selectedTests)
  }
  assert.equal(new Set(selected).size, selected.length, 'duplicate test execution')
  assert.deepEqual(selected.sort(), expected, 'missing or extra test execution')
}

export function enforceGlobalCoverage(map, thresholds) {
  assert.deepEqual(Object.keys(thresholds), ['global'], 'unsupported coverage threshold scope')
  assert.deepEqual(Object.keys(thresholds.global).sort(), [
    'branches',
    'functions',
    'lines',
    'statements'
  ])
  const summary = map.getCoverageSummary().toJSON()
  for (const [metric, minimum] of Object.entries(thresholds.global)) {
    assert.ok(['branches', 'functions', 'lines', 'statements'].includes(metric))
    assert.ok(Number.isFinite(minimum))
    const { total, covered, pct } = summary[metric]
    assert.ok(total > 0 && typeof pct === 'number', `missing ${metric} coverage`)
    assert.ok(
      minimum < 0 ? total - covered <= -minimum : pct >= minimum,
      `${metric} coverage ${pct}% fails original threshold ${minimum}`
    )
  }
  return summary
}

export function mergeCoverage(shards) {
  const expected = Object.keys(shards[0].coverage).sort()
  assert.ok(expected.length > 0, 'empty coverage artifact')
  const map = createCoverageMap({})
  for (const shard of shards) {
    assert.deepEqual(
      Object.keys(shard.coverage).sort(),
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
    jest(['--listTests', '--json', ...(shard ? [`--shard=${shard}/2`] : [])], true)
  )
}

function collect(shard, output) {
  assert.ok([1, 2].includes(shard))
  mkdirSync(output, { recursive: true })
  const manifest = {
    identity: identity(),
    shard,
    total: shardCount,
    allTests: inventory(),
    selectedTests: inventory(shard)
  }
  writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest))
  // A shard cannot meet the package-wide threshold independently. The required
  // aggregate below applies the original config to the complete merged map.
  jest([
    '--coverage',
    '--coverageThreshold={}',
    '--coverageReporters=json',
    `--coverageDirectory=${output}`,
    `--shard=${shard}/2`,
    '--json',
    `--outputFile=${path.join(output, 'results.json')}`
  ])
  assertCompleteResults(
    JSON.parse(readFileSync(path.join(output, 'results.json'))),
    manifest.selectedTests
  )
  console.log(
    `Complete application coverage shard ${shard}/2: ${manifest.selectedTests.length} suites`
  )
}

function aggregate(input, output) {
  const shards = [1, 2].map(shard => {
    const directory = path.join(input, `shard-${shard}`)
    const read = file => JSON.parse(readFileSync(path.join(directory, file)))
    return {
      manifest: read('manifest.json'),
      results: read('results.json'),
      coverage: read('coverage-final.json')
    }
  })
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
    else throw new Error('Use collect <1|2> <output> or aggregate <input> <output>')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
