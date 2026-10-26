import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const DurationSequencer = require('./jest-duration-sequencer.cjs')
const { planShard } = DurationSequencer

const rootDir = '/repo/packages/example'
const tests = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(name => ({
  path: `${rootDir}/test/${name}.test.ts`,
  context: { config: { rootDir } }
}))
const seconds = { 'test/a.test.ts': 90, 'test/b.test.ts': 60, 'test/c.test.ts': 30 }
const names = shard => shard.map(entry => entry.path.split('/').at(-1))

test('every test file lands in exactly one duration-balanced shard', () => {
  for (const shardCount of [1, 2, 3, 6, 9]) {
    const shards = Array.from({ length: shardCount }, (_, index) =>
      planShard(tests, seconds, index + 1, shardCount)
    )
    const assigned = shards.flat().map(entry => entry.path)
    assert.equal(assigned.length, tests.length, `count for ${shardCount}`)
    assert.deepEqual(new Set(assigned), new Set(tests.map(entry => entry.path)))
  }
  // Longest first to the least-loaded shard: 90 | 60 | 30 + four 2-second files.
  assert.deepEqual(names(planShard(tests, seconds, 1, 3)), ['a.test.ts'])
  assert.deepEqual(names(planShard(tests, seconds, 2, 3)), ['b.test.ts'])
  assert.equal(planShard(tests, seconds, 3, 3).length, 5)
})

test('shard plans do not depend on the order Jest discovers files', () => {
  const reversed = [...tests].reverse()
  for (let index = 1; index <= 3; index += 1)
    assert.deepEqual(planShard(reversed, seconds, index, 3), planShard(tests, seconds, index, 3))
})

test('the sequencer requires governed durations and keeps the lane sane', () => {
  const previous = { ...process.env }
  try {
    delete process.env.JEST_SHARD_DURATIONS
    assert.throws(() => new DurationSequencer().sort(tests), /JEST_SHARD_DURATIONS/)
    process.env.JEST_SHARD_DURATIONS = new URL(
      '../governance/ci-lane-durations.json',
      import.meta.url
    ).pathname
    process.env.JEST_SHARD_LANE = 'wallet-toolbox-coverage'
    assert.equal(new DurationSequencer().sort(tests).length, tests.length)
  } finally {
    process.env = previous
  }
  const lane = JSON.parse(
    readFileSync(new URL('../governance/ci-lane-durations.json', import.meta.url), 'utf8')
  ).lanes['wallet-toolbox-coverage']
  for (const [file, value] of Object.entries(lane.seconds)) {
    assert.match(file, /\.test\.ts$/)
    assert.ok(Number.isInteger(value) && value > 0 && value < 600, file)
  }
})
