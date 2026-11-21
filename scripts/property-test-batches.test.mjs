import assert from 'node:assert/strict'
import { test } from 'node:test'

import { propertyTestBatches } from '../config/testing/property-test-batches.cjs'
import { syncPropertyTestBatches } from './sync-property-test-batches.mjs'

test('PR, scheduled and manual case counts register every generated offset once', () => {
  for (const numRuns of [300, 313, 5000, 100000]) {
    const batches = propertyTestBatches({ numRuns, seed: -3242026, endOnFailure: true })
    let nextOffset = 0
    for (const batch of batches) {
      assert.equal(batch.path, String(nextOffset))
      assert.ok(batch.numRuns > 0 && batch.numRuns <= 50)
      assert.equal(batch.seed, -3242026)
      assert.equal(batch.endOnFailure, true)
      nextOffset += batch.numRuns
    }
    assert.equal(nextOffset, numRuns)
  }
})

test('stateful histories retain their complete 300-case sequence in each fixture', () => {
  const batches = propertyTestBatches({ numRuns: 5000, seed: 18 }, 300)
  assert.deepEqual(batches.slice(0, 2), [
    { numRuns: 300, path: '0', seed: 18 },
    { numRuns: 300, path: '300', seed: 18 }
  ])
  assert.deepEqual(batches.at(-1), { numRuns: 200, path: '4800', seed: 18 })
  assert.equal(
    batches.reduce((total, batch) => total + batch.numRuns, 0),
    5000
  )
  assert.throws(() => propertyTestBatches({ numRuns: 300 }, 301), /batch size/)
})

test('replay paths keep their original seed and absolute generator offsets', () => {
  assert.deepEqual(propertyTestBatches({ numRuns: 53, path: '252', seed: 4 }), [
    { numRuns: 50, path: '252', seed: 4 },
    { numRuns: 3, path: '302', seed: 4 }
  ])
  const shrink = { numRuns: 300, path: '252:11:2', seed: 4 }
  assert.deepEqual(propertyTestBatches(shrink), [shrink])
})

test('batches share one default seed and reject invalid counts and offsets', () => {
  const batches = propertyTestBatches({})
  assert.equal(batches.length, 2)
  assert.ok(Number.isInteger(batches[0].seed))
  assert.equal(batches[0].seed, batches[1].seed)
  assert.throws(() => propertyTestBatches({ numRuns: 0 }), /positive, safe case count/)
  assert.throws(() => propertyTestBatches({ numRuns: 2.5 }), /positive, safe case count/)
  assert.throws(
    () => propertyTestBatches({ path: String(Number.MAX_SAFE_INTEGER), numRuns: 2 }),
    /replay offset exceeds the safe range/
  )
})

test('isolated package test stands match the canonical implementation and declaration', () => {
  assert.doesNotThrow(() => syncPropertyTestBatches({ check: true }))
})
