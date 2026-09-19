import { Random } from '@bsv/sdk'

import type { RejectionReason } from './race.js'

/**
 * `unadvertised-identity` is a host whose session key no SLAP token names for its URL. It shares
 * the `identity-mismatch` rejection reason but not its penalty, because the advertisement is
 * third-party data.
 */
export type ReputationEvent =
  'success' | 'lagging' | 'diverged-answer' | 'unadvertised-identity' | RejectionReason

/** Local, per-client reputation keyed by host URL. Never fed by another party's claims. */
export interface ReputationStore {
  record: (url: string, event: ReputationEvent, now: number) => void
  isExcluded: (url: string, now: number) => boolean
  score: (url: string) => number
}

/**
 * Events only the host itself can cause, so they cost a cooldown. `collect-failed` is one: every
 * collect follows a dispatched payout, so a failed collect is a paid non-delivery. Events that
 * rest on what other parties say are soft: `diverged-answer` rests on anchors the winners report
 * about themselves, and `unadvertised-identity` on a permissionless advertisement.
 */
const HARD_EVENTS: ReadonlySet<ReputationEvent> = new Set([
  'hash-mismatch',
  'bad-signature',
  'identity-mismatch',
  'collect-failed'
])
const HARD_PENALTY = 10
const DEFAULT_COOLDOWN_MS = 600_000

export class InMemoryReputationStore implements ReputationStore {
  private readonly scores = new Map<string, number>()
  private readonly excludedUntil = new Map<string, number>()
  private readonly cooldownMs: number

  constructor(cooldownMs: number = DEFAULT_COOLDOWN_MS) {
    this.cooldownMs = cooldownMs
  }

  record(url: string, event: ReputationEvent, now: number): void {
    const current = this.scores.get(url) ?? 0
    if (event === 'success') {
      this.scores.set(url, current + 1)
    } else if (HARD_EVENTS.has(event)) {
      this.scores.set(url, current - HARD_PENALTY)
      this.excludedUntil.set(url, now + this.cooldownMs)
    } else {
      this.scores.set(url, current - 1)
    }
  }

  isExcluded(url: string, now: number): boolean {
    return now < (this.excludedUntil.get(url) ?? 0)
  }

  score(url: string): number {
    return this.scores.get(url) ?? 0
  }
}

/** A uniform integer in `[0, bound)` from the SDK random source, without modulo bias. */
function randomBelow(bound: number): number {
  const range = 0x1_0000_0000
  const limit = range - (range % bound)
  for (;;) {
    const [a, b, c, d] = Random(4)
    const value = a * 0x100_0000 + b * 0x1_0000 + c * 0x100 + d
    if (value < limit) return value % bound
  }
}

/**
 * Orders `items` best score first and shuffles every run of equal scores (Fisher-Yates). Without
 * the shuffle, ties keep discovery order, so whoever answers a tracker first decides which hosts a
 * `maxHosts` cut ever contacts. `random(bound)` returns an integer in `[0, bound)`.
 */
export function orderByScore<T>(
  items: readonly T[],
  score: (item: T) => number,
  random: (bound: number) => number = randomBelow
): T[] {
  const scored = items.map(item => ({ item, score: score(item) }))
  scored.sort((left, right) => right.score - left.score)
  let start = 0
  while (start < scored.length) {
    let end = start + 1
    while (end < scored.length && scored[end].score === scored[start].score) end++
    for (let index = end - 1; index > start; index--) {
      const other = start + random(index - start + 1)
      const held = scored[index]
      scored[index] = scored[other]
      scored[other] = held
    }
    start = end
  }
  return scored.map(entry => entry.item)
}
