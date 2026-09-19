import type { Arrival } from './race.js'

export type ConsistencyStatus = 'agreed' | 'lagging' | 'diverged' | 'unknown'

export interface TopicConsistency {
  topic: string
  status: ConsistencyStatus
  /** Highest tip any winner reported. */
  blockHeight?: number
  /** The TAC at that height, when every host at that height agrees. */
  tac?: string
  hosts: Array<{ host: string; status: ConsistencyStatus; blockHeight?: number; tac?: string }>
}

interface Reference {
  blockHeight: number
  tac?: string
}

function referenceFor(topic: string, winners: Arrival[]): Reference | undefined {
  let blockHeight = Number.NEGATIVE_INFINITY
  for (const winner of winners) {
    for (const anchor of winner.attestation.anchors ?? []) {
      if (anchor.topic === topic) blockHeight = Math.max(blockHeight, anchor.blockHeight)
    }
  }
  if (blockHeight === Number.NEGATIVE_INFINITY) return undefined
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
 * proves agreement on admission only; bans and janitor removals are node-local.
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
      if (anchor === undefined || reference === undefined) {
        return { host: winner.host, status: 'unknown' as const }
      }
      let status: ConsistencyStatus = 'agreed'
      if (anchor.blockHeight < reference.blockHeight) status = 'lagging'
      else if (reference.tac === undefined) status = 'diverged'
      return { host: winner.host, status, blockHeight: anchor.blockHeight, tac: anchor.tac }
    })
    let status: ConsistencyStatus = 'agreed'
    if (hosts.some(entry => entry.status === 'diverged')) status = 'diverged'
    else if (hosts.some(entry => entry.status === 'lagging')) status = 'lagging'
    const result: TopicConsistency = { topic, status, hosts }
    if (reference !== undefined) {
      result.blockHeight = reference.blockHeight
      if (reference.tac !== undefined) result.tac = reference.tac
    }
    return result
  })
}

/**
 * Explains a minority answer for reputation. A host that is behind is excused; a host whose
 * admission state matches the winners yet answered differently is not.
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
    if (reference === undefined) continue
    if (anchor.blockHeight < reference.blockHeight) return 'lagging'
    if (anchor.blockHeight === reference.blockHeight && anchor.tac === reference.tac) matched++
    else return 'minority-hash'
  }
  return matched > 0 ? 'diverged-answer' : 'minority-hash'
}
