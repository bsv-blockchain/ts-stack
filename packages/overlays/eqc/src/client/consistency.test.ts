import { describe, expect, it } from 'vitest'

import type { Attestation, TopicAnchor } from '../protocol/attestation.js'
import { assessConsistency, classifyMinority } from './consistency.js'
import type { Arrival } from './race.js'

const TAC_1 = '11'.repeat(32)
const TAC_2 = '22'.repeat(32)
const TAC_EVIL = 'ee'.repeat(32)

function host(name: string, anchors?: TopicAnchor[]): Arrival {
  return {
    url: `https://${name}.example`,
    host: name,
    arrivedAt: 0,
    attestation: { anchors } as Attestation
  }
}

const tip = (blockHeight: number, tac: string): TopicAnchor[] => [
  { topic: 'tm_example', blockHeight, tac }
]

describe('assessConsistency', () => {
  it('reports agreement when every winner shares height and TAC', () => {
    expect(assessConsistency([host('a', tip(900, TAC_1)), host('b', tip(900, TAC_1))])).toEqual([
      {
        topic: 'tm_example',
        status: 'agreed',
        blockHeight: 900,
        tac: TAC_1,
        hosts: [
          { host: 'a', status: 'agreed', blockHeight: 900, tac: TAC_1 },
          { host: 'b', status: 'agreed', blockHeight: 900, tac: TAC_1 }
        ]
      }
    ])
  })

  it('marks a lower tip as lagging and a host without anchors as unknown, once the tip is corroborated by two winners', () => {
    // Rewritten for R11: the old version had 'a' alone at 900 and 'b' alone at 899, which under
    // the corroborated-reference rule yields no reference at all (no height has two distinct
    // winners), not a 'lagging' topic. A second winner at 900 supplies the corroboration.
    const [topic] = assessConsistency([
      host('a1', tip(900, TAC_1)),
      host('a2', tip(900, TAC_1)),
      host('b', tip(899, TAC_2)),
      host('c')
    ])
    expect(topic.status).toBe('lagging')
    expect(topic.blockHeight).toBe(900)
    expect(topic.tac).toBe(TAC_1)
    expect(topic.hosts.map(entry => entry.status)).toEqual([
      'agreed',
      'agreed',
      'lagging',
      'unknown'
    ])
  })

  it('requires corroboration from at least two distinct winners: a single fabricated tip cannot become the reference', () => {
    // R11 fix for the poisoning finding: A and B honestly agree at 900; C claims a wild,
    // uncorroborated 10_000_000. Before the fix, referenceFor took Math.max over every winner's
    // claim with no corroboration, so C alone would set the reference to its fabricated tip,
    // reporting both honest hosts 'lagging' and publishing C's tip and TAC as authoritative.
    const [topic] = assessConsistency([
      host('a', tip(900, TAC_1)),
      host('b', tip(900, TAC_1)),
      host('c', tip(10_000_000, TAC_EVIL))
    ])
    expect(topic).toEqual({
      topic: 'tm_example',
      status: 'agreed',
      blockHeight: 900,
      tac: TAC_1,
      hosts: [
        { host: 'a', status: 'agreed', blockHeight: 900, tac: TAC_1 },
        { host: 'b', status: 'agreed', blockHeight: 900, tac: TAC_1 },
        { host: 'c', status: 'unknown', blockHeight: 10_000_000, tac: TAC_EVIL }
      ]
    })
  })

  it('reports no reference when only one winner reports the topic', () => {
    const [topic] = assessConsistency([host('a', tip(900, TAC_1))])
    expect(topic.status).toBe('unknown')
    expect(topic.blockHeight).toBeUndefined()
    expect(topic.tac).toBeUndefined()
    expect(topic.hosts).toEqual([{ host: 'a', status: 'unknown', blockHeight: 900, tac: TAC_1 }])
  })

  it('marks different TACs at the same height as diverged', () => {
    const [topic] = assessConsistency([host('a', tip(900, TAC_1)), host('b', tip(900, TAC_2))])
    expect(topic.status).toBe('diverged')
    expect(topic.tac).toBeUndefined()
  })

  it('returns nothing when no winner sent anchors', () => {
    expect(assessConsistency([host('a'), host('b')])).toEqual([])
  })
})

describe('classifyMinority', () => {
  const winners = [host('a', tip(900, TAC_1)), host('b', tip(900, TAC_1))]

  it('excuses a host that is behind', () => {
    expect(classifyMinority(host('m', tip(899, TAC_2)), winners)).toBe('lagging')
  })

  it('flags a host with matching admission state but a different answer', () => {
    expect(classifyMinority(host('m', tip(900, TAC_1)), winners)).toBe('diverged-answer')
  })

  it('stays neutral without comparable anchors', () => {
    expect(classifyMinority(host('m'), winners)).toBe('minority-hash')
    expect(classifyMinority(host('m', tip(900, TAC_2)), winners)).toBe('minority-hash')
  })

  it('does not excuse a genuinely diverged host as lagging when one winner claims a fabricated height', () => {
    // R11 fix: with the old uncorroborated reference, C's fabricated 10_000_000 would become the
    // reference, so a minority host at the true tip 900 with a different TAC would read as
    // `900 < 10_000_000` and be excused as 'lagging' instead of flagged as diverged.
    const poisonedWinners = [
      host('a', tip(900, TAC_1)),
      host('b', tip(900, TAC_1)),
      host('c', tip(10_000_000, TAC_EVIL))
    ]
    expect(classifyMinority(host('m', tip(900, TAC_2)), poisonedWinners)).toBe('minority-hash')
  })
})
