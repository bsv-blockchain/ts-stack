import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Attestation } from '../protocol/attestation.js'
import { decideRace, runRace, type Arrival, type RaceTask, type Rejection } from './race.js'

const HASH_A = 'aa'.repeat(32)
const HASH_B = 'bb'.repeat(32)

function arrival(name: string, contentHash: string, arrivedAt: number, attestedAt = ''): Arrival {
  return {
    url: `https://${name}.example`,
    host: name,
    arrivedAt,
    attestation: { contentHash, attestedAt } as Attestation
  }
}

function after<T>(milliseconds: number, value: T): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(value), milliseconds))
}

function task(value: Arrival | Rejection, milliseconds: number): RaceTask {
  return { url: value.url, promise: after(milliseconds, value) }
}

describe('decideRace', () => {
  it('ranks the winning hash by local arrival and ignores host-claimed time', () => {
    const outcome = decideRace(
      [
        arrival('slow', HASH_A, 30, '1999-01-01T00:00:00.000Z'),
        arrival('fast', HASH_A, 10, '2099-01-01T00:00:00.000Z'),
        arrival('mid', HASH_A, 20),
        arrival('stale', HASH_B, 5)
      ],
      { threshold: 3, topK: 5 }
    )
    expect(outcome.thresholdMet).toBe(true)
    expect(outcome.winningHash).toBe(HASH_A)
    expect(outcome.ranked.map(entry => entry.host)).toEqual(['fast', 'mid', 'slow'])
    expect(outcome.minority.map(entry => entry.host)).toEqual(['stale'])
  })

  it('keeps only the fastest topK hosts', () => {
    const arrivals = [1, 2, 3, 4].map(n => arrival(`h${n}`, HASH_A, n))
    const outcome = decideRace(arrivals, { threshold: 1, topK: 2 })
    expect(outcome.ranked.map(entry => entry.host)).toEqual(['h1', 'h2'])
  })

  it('breaks a tie toward the hash seen first', () => {
    const outcome = decideRace(
      [
        arrival('a1', HASH_A, 20),
        arrival('b1', HASH_B, 10),
        arrival('a2', HASH_A, 30),
        arrival('b2', HASH_B, 40)
      ],
      { threshold: 2, topK: 5 }
    )
    expect(outcome.winningHash).toBe(HASH_B)
  })

  it('reports an unmet threshold with every group', () => {
    const outcome = decideRace([arrival('only', HASH_A, 1), arrival('other', HASH_B, 2)], {
      threshold: 3,
      topK: 5
    })
    expect(outcome.thresholdMet).toBe(false)
    expect(outcome.ranked).toEqual([])
    expect(outcome.groups).toEqual([
      { contentHash: HASH_A, hosts: ['only'], firstArrival: 1 },
      { contentHash: HASH_B, hosts: ['other'], firstArrival: 2 }
    ])
  })

  it('handles no arrivals', () => {
    expect(decideRace([], { threshold: 1, topK: 1 })).toEqual({
      thresholdMet: false,
      ranked: [],
      minority: [],
      groups: []
    })
  })
})

describe('runRace', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const options = { raceMs: 400, hostTimeoutMs: 5000, topK: 5 }

  it('closes the window raceMs after the first valid attestation', async () => {
    const race = runRace(
      [
        task(arrival('first', HASH_A, 10), 10),
        task(arrival('second', HASH_A, 100), 100),
        task(arrival('late', HASH_A, 1000), 1000)
      ],
      options
    )
    await vi.advanceTimersByTimeAsync(410)
    const result = await race
    expect(result.arrivals.map(entry => entry.host)).toEqual(['first', 'second'])
    expect(result.unfinished).toEqual(['https://late.example'])
  })

  it('ends as soon as every host has answered or failed', async () => {
    const failed: Rejection = { url: 'https://down.example', reason: 'http' }
    const race = runRace([task(arrival('first', HASH_A, 10), 10), task(failed, 20)], options)
    await vi.advanceTimersByTimeAsync(20)
    const result = await race
    expect(result.arrivals).toHaveLength(1)
    expect(result.rejections).toEqual([failed])
    expect(result.unfinished).toEqual([])
  })

  it('ends early once topK hosts share one hash', async () => {
    const race = runRace(
      [
        task(arrival('h1', HASH_A, 10), 10),
        task(arrival('h2', HASH_A, 20), 20),
        task(arrival('h3', HASH_A, 300), 300)
      ],
      { ...options, topK: 2 }
    )
    await vi.advanceTimersByTimeAsync(20)
    expect((await race).unfinished).toEqual(['https://h3.example'])
  })

  it('gives up at hostTimeoutMs when nothing valid arrives', async () => {
    const race = runRace([task(arrival('never', HASH_A, 9000), 9000)], options)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await race).toEqual({
      arrivals: [],
      rejections: [],
      unfinished: ['https://never.example']
    })
  })

  it('counts one identity once, however many domains it answers from', async () => {
    const twin: Arrival = { ...arrival('first', HASH_A, 20), url: 'https://twin.example' }
    const race = runRace([task(arrival('first', HASH_A, 10), 10), task(twin, 20)], options)
    await vi.advanceTimersByTimeAsync(20)
    const result = await race
    expect(result.arrivals).toHaveLength(1)
    expect(result.rejections).toEqual([
      {
        url: 'https://twin.example',
        host: 'first',
        reason: 'malformed',
        detail: 'duplicate host identity'
      }
    ])
  })

  it('returns immediately for an empty host list', async () => {
    expect(await runRace([], options)).toEqual({ arrivals: [], rejections: [], unfinished: [] })
  })
})
