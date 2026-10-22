'use strict'

// Jest test sequencer that shards by measured test-file duration.
//
// Jest's default sharding hashes file paths, so one shard can collect most of
// the slow files. This sequencer assigns files longest first to the
// least-loaded shard (longest-processing-time-first scheduling) using the
// governed per-file seconds in JEST_SHARD_DURATIONS for JEST_SHARD_LANE, and
// runs each shard's files longest first so workers stay busy. Every test file
// still lands in exactly one shard; unmeasured files use a default estimate.

const { readFileSync } = require('node:fs')
const path = require('node:path')

const DEFAULT_SECONDS = 2

function laneSeconds() {
  const file = process.env.JEST_SHARD_DURATIONS
  const lane = process.env.JEST_SHARD_LANE
  if (!file || !lane) throw new Error('JEST_SHARD_DURATIONS and JEST_SHARD_LANE are required')
  const seconds = JSON.parse(readFileSync(file, 'utf8')).lanes?.[lane]?.seconds
  if (seconds === null || typeof seconds !== 'object')
    throw new Error(`No measured durations for lane ${lane}`)
  return seconds
}

function relativePath(test) {
  return path.relative(test.context.config.rootDir, test.path).split(path.sep).join('/')
}

function costs(tests, seconds) {
  return new Map(
    tests.map(test => {
      const measured = seconds[relativePath(test)]
      return [test, Number.isFinite(measured) && measured > 0 ? measured : DEFAULT_SECONDS]
    })
  )
}

function byCost(cost) {
  return (left, right) =>
    cost.get(right) - cost.get(left) || relativePath(left).localeCompare(relativePath(right))
}

function planShard(tests, seconds, shardIndex, shardCount) {
  const cost = costs(tests, seconds)
  const loads = Array.from({ length: shardCount }, () => 0)
  const selected = []
  for (const test of [...tests].sort(byCost(cost))) {
    let target = 0
    for (let index = 1; index < shardCount; index += 1)
      if (loads[index] < loads[target]) target = index
    loads[target] += cost.get(test)
    if (target === shardIndex - 1) selected.push(test)
  }
  return selected
}

class DurationSequencer {
  shard(tests, { shardIndex, shardCount }) {
    return planShard(tests, laneSeconds(), shardIndex, shardCount)
  }

  sort(tests) {
    return [...tests].sort(byCost(costs(tests, laneSeconds())))
  }

  allFailedTests(tests) {
    return tests
  }

  // Jest calls this after a run to persist timings in its cache; this
  // sequencer reads governed durations instead, so there is nothing to store.
  cacheResults() {
    return undefined
  }
}

module.exports = DurationSequencer
module.exports.planShard = planShard
