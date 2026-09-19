import type { RejectionReason } from './race.js'

export type ReputationEvent = 'success' | 'lagging' | 'diverged-answer' | RejectionReason

/** Local, per-client reputation keyed by host URL. Never fed by another party's claims. */
export interface ReputationStore {
  record: (url: string, event: ReputationEvent, now: number) => void
  isExcluded: (url: string, now: number) => boolean
  score: (url: string) => number
}

const HARD_EVENTS: ReadonlySet<ReputationEvent> = new Set([
  'hash-mismatch',
  'bad-signature',
  'identity-mismatch',
  'diverged-answer'
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
