import type { Attestation } from '../protocol/attestation.js'

export type RejectionReason =
  | 'timeout'
  | 'http'
  | 'malformed'
  | 'bad-signature'
  | 'identity-mismatch'
  | 'wrong-query'
  | 'minority-hash'
  | 'late'
  | 'collect-failed'
  | 'hash-mismatch'

export interface Rejection {
  url: string
  host?: string
  reason: RejectionReason
  detail?: string
}

/** A verified attestation and the local time it arrived. `host` is the identity key. */
export interface Arrival {
  url: string
  host: string
  attestation: Attestation
  arrivedAt: number
}

/** `promise` must resolve to a `Rejection` instead of rejecting. */
export interface RaceTask {
  url: string
  promise: Promise<Arrival | Rejection>
}

export interface RaceResult {
  arrivals: Arrival[]
  rejections: Rejection[]
  unfinished: string[]
}

export interface HashGroup {
  contentHash: string
  hosts: string[]
  firstArrival: number
}

export interface RaceOutcome {
  thresholdMet: boolean
  winningHash?: string
  ranked: Arrival[]
  minority: Arrival[]
  groups: HashGroup[]
}

function isArrival(value: Arrival | Rejection): value is Arrival {
  return 'attestation' in value
}

function largestGroup(arrivals: Arrival[]): number {
  const counts = new Map<string, number>()
  let largest = 0
  for (const arrival of arrivals) {
    const count = (counts.get(arrival.attestation.contentHash) ?? 0) + 1
    counts.set(arrival.attestation.contentHash, count)
    largest = Math.max(largest, count)
  }
  return largest
}

/**
 * Collects attestations until the race window closes: `raceMs` after the first valid arrival,
 * or sooner when every host has settled or `topK` hosts already share one hash. With no valid
 * arrival the race ends at `hostTimeoutMs`.
 */
export async function runRace(
  tasks: RaceTask[],
  options: { raceMs: number; hostTimeoutMs: number; topK: number }
): Promise<RaceResult> {
  const arrivals: Arrival[] = []
  const rejections: Rejection[] = []
  const settled = new Set<string>()
  return await new Promise(resolve => {
    let finished = false
    let windowTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (finished) return
      finished = true
      clearTimeout(overallTimer)
      if (windowTimer !== undefined) clearTimeout(windowTimer)
      resolve({
        arrivals: [...arrivals],
        rejections: [...rejections],
        unfinished: tasks.map(entry => entry.url).filter(url => !settled.has(url))
      })
    }
    const overallTimer = setTimeout(finish, options.hostTimeoutMs)
    if (tasks.length === 0) {
      finish()
      return
    }
    for (const entry of tasks) {
      void entry.promise.then(result => {
        if (finished) return
        settled.add(entry.url)
        if (!isArrival(result)) {
          rejections.push(result)
        } else if (arrivals.some(existing => existing.host === result.host)) {
          rejections.push({
            url: result.url,
            host: result.host,
            reason: 'malformed',
            detail: 'duplicate host identity'
          })
        } else {
          arrivals.push(result)
          if (arrivals.length === 1) windowTimer = setTimeout(finish, options.raceMs)
          if (largestGroup(arrivals) >= options.topK) finish()
        }
        if (settled.size === tasks.length) finish()
      })
    }
  })
}

/**
 * Picks the hash attested by the most distinct hosts (ties go to the hash seen first) and ranks
 * its hosts by client-measured arrival. Host-claimed `attestedAt` is never read.
 */
export function decideRace(
  arrivals: Arrival[],
  params: { threshold: number; topK: number }
): RaceOutcome {
  const byHash = new Map<string, Arrival[]>()
  for (const arrival of arrivals) {
    const group = byHash.get(arrival.attestation.contentHash) ?? []
    group.push(arrival)
    byHash.set(arrival.attestation.contentHash, group)
  }
  const sortedGroups = [...byHash.entries()].map(([contentHash, members]) => {
    const ordered = [...members].sort((left, right) => left.arrivedAt - right.arrivedAt)
    return { contentHash, ordered, firstArrival: ordered[0].arrivedAt }
  })
  sortedGroups.sort(
    (left, right) =>
      right.ordered.length - left.ordered.length || left.firstArrival - right.firstArrival
  )
  const groups: HashGroup[] = sortedGroups.map(group => ({
    contentHash: group.contentHash,
    hosts: group.ordered.map(member => member.host),
    firstArrival: group.firstArrival
  }))
  const winner = sortedGroups[0]
  if (winner === undefined || winner.ordered.length < params.threshold) {
    return { thresholdMet: false, ranked: [], minority: [], groups }
  }
  return {
    thresholdMet: true,
    winningHash: winner.contentHash,
    ranked: winner.ordered.slice(0, params.topK),
    minority: sortedGroups.slice(1).flatMap(group => group.ordered),
    groups
  }
}
