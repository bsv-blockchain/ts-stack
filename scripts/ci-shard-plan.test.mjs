import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { DEFAULT_PLAN, parseArguments, planShards } from './ci-shard-plan.mjs'

const names = matrix => matrix.include.flatMap(shard => shard.packages)
const load = (shard, seconds) => shard.packages.reduce((sum, name) => sum + seconds[name], 0)

test('every selected package runs exactly once and no shard is empty', () => {
  const seconds = { a: 600, b: 380, c: 140, d: 110, e: 60, f: 45, g: 20, h: 12 }
  const packages = Object.keys(seconds)
  const matrix = planShards(packages, seconds)
  assert.deepEqual(names(matrix).sort(), [...packages].sort())
  assert.ok(matrix.include.every(shard => shard.packages.length > 0))
  const total = matrix.include.length
  assert.ok(
    matrix.include.every((shard, index) => shard.shard === index + 1 && shard.total === total)
  )
})

test('measured durations balance the slowest shard instead of package count', () => {
  // The 2026-10-20 shape: one shard of sixteen packages ran 24 minutes while
  // its sibling finished in 3; count splitting cannot see that imbalance.
  const seconds = {
    heavy: 598,
    slow: 377,
    mid: 140,
    ten: 106,
    a: 62,
    b: 58,
    c: 47,
    d: 17,
    e: 12,
    f: 11,
    g: 8,
    h: 6,
    i: 5,
    j: 5
  }
  const matrix = planShards(Object.keys(seconds), seconds, { targetSeconds: 300, maxShards: 6 })
  const loads = matrix.include.map(shard => load(shard, seconds))
  // The heavy shard only takes the smallest packages once the others are full.
  assert.ok(Math.max(...loads) <= 598 + 10)
  const names = Object.keys(seconds).sort()
  const roundRobin = [0, 1].map(shard =>
    names.filter((_, index) => index % 2 === shard).reduce((sum, name) => sum + seconds[name], 0)
  )
  assert.ok(Math.max(...loads) < Math.max(...roundRobin))
})

test('shard count follows estimated total time, capped by packages and the limit', () => {
  assert.equal(planShards(['a'], { a: 2000 }).include.length, 1)
  assert.equal(planShards(['a', 'b'], { a: 10, b: 10 }).include.length, 1)
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`p${index}`, 400]))
  assert.equal(planShards(Object.keys(many), many).include.length, DEFAULT_PLAN.maxShards)
  assert.equal(planShards(Object.keys(many), many, { maxShards: 3 }).include.length, 3)
})

test('unmeasured packages use the default estimate and planning is deterministic', () => {
  const packages = ['new-one', 'known', 'new-two']
  const seconds = { known: 500 }
  const first = planShards(packages, seconds)
  assert.deepEqual(planShards([...packages].reverse(), seconds), first)
  assert.deepEqual(names(first).sort(), [...packages].sort())
  assert.equal(first.include.length, Math.ceil((500 + 2 * DEFAULT_PLAN.defaultSeconds) / 300))
})

test('empty, duplicate and malformed selections fail closed', () => {
  assert.deepEqual(planShards([], {}), { include: [{ shard: 1, total: 1, packages: [] }] })
  assert.throws(() => planShards(['a', 'a'], {}), /duplicate/)
  assert.throws(() => planShards([''], {}), /package names/)
  assert.throws(() => planShards('a', {}), /package names/)
  assert.throws(() => planShards(['a'], {}, { maxShards: 0 }), /positive integers/)
  assert.throws(() => parseArguments(['--lane']), /incomplete/)
  assert.throws(() => parseArguments(['--lane', 'x']), /required/)
})

test('the governed durations cover the coverage-other lane with sane values', () => {
  const durations = JSON.parse(
    readFileSync(new URL('../governance/ci-lane-durations.json', import.meta.url), 'utf8')
  )
  const lane = durations.lanes['coverage-other']
  assert.ok(Object.keys(lane.seconds).length > 0)
  for (const [name, value] of Object.entries(lane.seconds)) {
    assert.ok(name.length > 0)
    assert.ok(Number.isInteger(value) && value > 0, name)
  }
})

test('package count also bounds a shard so an unmeasured slow package cannot hold many others', () => {
  const seconds = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`p${index}`, 5]))
  const matrix = planShards(Object.keys(seconds), seconds)
  assert.equal(matrix.include.length, 5)
  assert.ok(
    matrix.include.every(shard => shard.packages.length <= DEFAULT_PLAN.maxPackagesPerShard)
  )
  // Long packages must not push every short package into the remaining shards.
  const skewed = { ...seconds, p0: 400, p1: 300 }
  const plan = planShards(Object.keys(skewed), skewed)
  assert.ok(plan.include.every(shard => shard.packages.length <= DEFAULT_PLAN.maxPackagesPerShard))
  assert.deepEqual(plan.include.flatMap(shard => shard.packages).sort(), Object.keys(skewed).sort())
})
