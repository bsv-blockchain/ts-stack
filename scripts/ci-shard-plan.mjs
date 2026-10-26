#!/usr/bin/env node

// Plan a serial test lane's matrix shards from measured package durations.
//
// Each shard runs its packages one after another (their test runners already
// use worker pools), so a shard lasts as long as the sum of its packages. The
// lane finishes with its slowest shard. Splitting by package count can put most
// of the work in one shard; instead choose the shard count from the estimated
// total and assign packages longest first to the least-loaded shard
// (longest-processing-time-first scheduling). Planning only decides which shard
// runs a package: every selected package still runs exactly once.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_PLAN = Object.freeze({
  targetSeconds: 300,
  maxPackagesPerShard: 6,
  maxShards: 6,
  defaultSeconds: 120
})

export function planShards(packages, seconds, options = {}) {
  const { targetSeconds, maxPackagesPerShard, maxShards, defaultSeconds } = {
    ...DEFAULT_PLAN,
    ...options
  }
  if (!Array.isArray(packages) || packages.some(name => typeof name !== 'string' || !name))
    throw new Error('Shard planning requires package names')
  if (new Set(packages).size !== packages.length)
    throw new Error('Shard planning received a duplicate package')
  if (
    ![targetSeconds, maxPackagesPerShard, maxShards, defaultSeconds].every(
      value => Number.isInteger(value) && value > 0
    )
  )
    throw new Error('Shard planning limits must be positive integers')
  if (packages.length === 0) return { include: [{ shard: 1, total: 1, packages: [] }] }

  const cost = name => {
    const measured = seconds[name]
    return Number.isFinite(measured) && measured > 0 ? measured : defaultSeconds
  }
  const total = packages.reduce((sum, name) => sum + cost(name), 0)
  // Measured time sets the floor; the package bound keeps a slow package that
  // the measurements cannot know about (for example a new test in this pull
  // request) from holding many others behind it in one serial shard.
  const wanted = Math.max(
    Math.ceil(total / targetSeconds),
    Math.ceil(packages.length / maxPackagesPerShard)
  )
  const count = Math.max(1, Math.min(maxShards, packages.length, wanted))
  const shards = Array.from({ length: count }, () => ({ load: 0, packages: [] }))
  // No shard takes more than its even share of packages, so the count bound
  // holds even when a few long packages leave other shards lightly loaded.
  const capacity = Math.ceil(packages.length / count)
  const ordered = [...packages].sort(
    (left, right) => cost(right) - cost(left) || left.localeCompare(right)
  )
  for (const name of ordered) {
    let target
    for (const shard of shards)
      if (shard.packages.length < capacity && (!target || shard.load < target.load)) target = shard
    target.packages.push(name)
    target.load += cost(name)
  }
  return {
    include: shards.map((shard, index) => ({
      shard: index + 1,
      total: count,
      packages: shard.packages.toSorted((left, right) => left.localeCompare(right))
    }))
  }
}

export function parseArguments(arguments_) {
  const options = {}
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (!['--packages-json', '--durations', '--lane'].includes(key) || value === undefined)
      throw new Error(`Unknown or incomplete argument: ${key}`)
    options[key.slice(2)] = value
  }
  for (const key of ['packages-json', 'durations', 'lane'])
    if (!options[key]) throw new Error(`--${key} is required`)
  return options
}

function main(arguments_) {
  const options = parseArguments(arguments_)
  const durations = JSON.parse(readFileSync(resolve(options.durations), 'utf8'))
  const lane = durations.lanes?.[options.lane]
  if (!lane || typeof lane.seconds !== 'object')
    throw new Error(`No measured durations for lane ${options.lane}`)
  const packages = JSON.parse(options['packages-json'])
  process.stdout.write(JSON.stringify(planShards(packages, lane.seconds, lane.plan)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
