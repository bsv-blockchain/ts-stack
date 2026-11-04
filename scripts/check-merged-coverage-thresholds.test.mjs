import assert from 'node:assert/strict'
import test from 'node:test'

import {
  globalThresholds,
  parseArguments,
  thresholdFailures
} from './check-merged-coverage-thresholds.mjs'

const summary = {
  branches: { pct: 79.99 },
  functions: { pct: 85 },
  lines: { pct: 90 },
  statements: { pct: 84.5 }
}

test('merged coverage fails exactly the metrics below their thresholds', () => {
  assert.deepEqual(
    thresholdFailures(summary, { branches: 80, functions: 85, lines: 85, statements: 85 }),
    [
      'branches coverage 79.99% is below the 80% threshold',
      'statements coverage 84.5% is below the 85% threshold'
    ]
  )
  assert.deepEqual(thresholdFailures(summary, { functions: 85, lines: 85 }), [])
  assert.deepEqual(thresholdFailures(summary, {}), [])
})

test('only global percentage thresholds can be enforced across shards', () => {
  assert.deepEqual(globalThresholds({}), {})
  assert.deepEqual(globalThresholds({ coverageThreshold: { global: { lines: 85 } } }), {
    lines: 85
  })
  assert.throws(
    () => globalThresholds({ coverageThreshold: { global: { lines: 85 }, './src/': {} } }),
    /Only global/
  )
  assert.throws(
    () => globalThresholds({ coverageThreshold: { global: { lines: -10 } } }),
    /percentage/
  )
  assert.throws(() => globalThresholds({ coverageThreshold: { global: { paths: 1 } } }), /Unknown/)
})

test('the threshold checker requires its package and shard directory', () => {
  assert.deepEqual(parseArguments(['--package', 'packages/sdk', '--coverage-directory', 'c']), {
    package: 'packages/sdk',
    'coverage-directory': 'c'
  })
  assert.throws(() => parseArguments(['--package', 'packages/sdk']), /--coverage-directory/)
  assert.throws(() => parseArguments(['--shards', '2']), /Unknown/)
})
