import type { Arrival } from './race.js'

export type ConsistencyStatus = 'agreed' | 'lagging' | 'diverged' | 'unknown'

export interface TopicConsistency {
  topic: string
  status: ConsistencyStatus
  /** Highest tip corroborated by at least two distinct winners; omitted when no height qualifies. */
  blockHeight?: number
  /** The TAC at that height, when every host at that height agrees. */
  tac?: string
  hosts: Array<{ host: string; status: ConsistencyStatus; blockHeight?: number; tac?: string }>
}

interface Reference {
  blockHeight: number
  tac?: string
}

/**
 * The reference tip for a topic is the highest `blockHeight` reported by at least two distinct
 * winners — a single winner's claim, however high, never becomes the reference. `blockHeight` is
 * untrusted host input, so without corroboration one dishonest winner could otherwise mark every
 * honest host `lagging` and publish a fabricated tip. When no height clears that bar there is no
 * reference at all.
 */
function referenceFor(topic: string, winners: Arrival[]): Reference | undefined {
  const hostsByHeight = new Map<number, Set<string>>()
  for (const winner of winners) {
    for (const anchor of winner.attestation.anchors ?? []) {
      if (anchor.topic !== topic) continue
      const hosts = hostsByHeight.get(anchor.blockHeight) ?? new Set<string>()
      hosts.add(winner.host)
      hostsByHeight.set(anchor.blockHeight, hosts)
    }
  }
  let blockHeight: number | undefined
  for (const [height, hosts] of hostsByHeight) {
    if (hosts.size < 2) continue
    if (blockHeight === undefined || height > blockHeight) blockHeight = height
  }
  if (blockHeight === undefined) return undefined
  const tacs = new Set<string>()
  for (const winner of winners) {
    for (const anchor of winner.attestation.anchors ?? []) {
      if (anchor.topic === topic && anchor.blockHeight === blockHeight) tacs.add(anchor.tac)
    }
  }
  return tacs.size === 1 ? { blockHeight, tac: [...tacs][0] } : { blockHeight }
}

/**
 * Compares BRC-136 topic anchors across the winning hosts. Agreement means `t` independent hosts
 * share the answer and the topic's whole confirmed history through that height. A matching TAC
 * proves agreement on admission only; bans and janitor removals are node-local. The reference tip
 * is corroborated (see `referenceFor`); when no height is corroborated for a topic there is no
 * reference, every winner that reported the topic is `unknown`, and the topic itself is `unknown`.
 */
export function assessConsistency(winners: Arrival[]): TopicConsistency[] {
  const topics = new Set<string>()
  for (const winner of winners) {
    for (const anchor of winner.attestation.anchors ?? []) topics.add(anchor.topic)
  }
  return [...topics].sort().map(topic => {
    const reference = referenceFor(topic, winners)
    const hosts = winners.map(winner => {
      const anchor = winner.attestation.anchors?.find(entry => entry.topic === topic)
      if (anchor === undefined) return { host: winner.host, status: 'unknown' as const }
      if (reference === undefined) {
        return {
          host: winner.host,
          status: 'unknown' as const,
          blockHeight: anchor.blockHeight,
          tac: anchor.tac
        }
      }
      let status: ConsistencyStatus
      if (anchor.blockHeight < reference.blockHeight) status = 'lagging'
      else if (anchor.blockHeight > reference.blockHeight) status = 'unknown'
      else status = reference.tac !== undefined ? 'agreed' : 'diverged'
      return { host: winner.host, status, blockHeight: anchor.blockHeight, tac: anchor.tac }
    })
    let status: ConsistencyStatus
    if (reference === undefined) status = 'unknown'
    else if (hosts.some(entry => entry.status === 'diverged')) status = 'diverged'
    else if (hosts.some(entry => entry.status === 'lagging')) status = 'lagging'
    else status = 'agreed'
    const result: TopicConsistency = { topic, status, hosts }
    if (reference !== undefined) {
      result.blockHeight = reference.blockHeight
      if (reference.tac !== undefined) result.tac = reference.tac
    }
    return result
  })
}

/**
 * Explains a minority answer for reputation, against the same corroborated reference as
 * `assessConsistency`. A host that is behind the reference is excused; a host whose admission
 * state matches the winners at the reference height yet answered differently is not. Any anchor
 * that is not behind and does not match the reference — including one with no corroborated
 * reference at all, a TAC-less (diverged) reference, or a claim above the reference height — is
 * treated as non-matching rather than excused, so a fabricated high tip from one winner can never
 * launder a genuinely diverged minority host into `lagging`.
 */
export function classifyMinority(
  minority: Arrival,
  winners: Arrival[]
): 'lagging' | 'diverged-answer' | 'minority-hash' {
  const anchors = minority.attestation.anchors ?? []
  if (anchors.length === 0) return 'minority-hash'
  let matched = 0
  for (const anchor of anchors) {
    const reference = referenceFor(anchor.topic, winners)
    if (reference !== undefined && anchor.blockHeight < reference.blockHeight) return 'lagging'
    if (
      reference !== undefined &&
      reference.tac !== undefined &&
      anchor.blockHeight === reference.blockHeight &&
      anchor.tac === reference.tac
    ) {
      matched++
      continue
    }
    return 'minority-hash'
  }
  return matched > 0 ? 'diverged-answer' : 'minority-hash'
}
