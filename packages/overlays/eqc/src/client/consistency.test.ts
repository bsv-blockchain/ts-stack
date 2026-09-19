import { describe, expect, it } from 'vitest'

import type { Attestation, TopicAnchor } from '../protocol/attestation.js'
import { assessConsistency, classifyMinority } from './consistency.js'
import type { Arrival } from './race.js'

const TAC_1 = '11'.repeat(32)
const TAC_2 = '22'.repeat(32)

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

  it('marks a lower tip as lagging and a host without anchors as unknown', () => {
    const [topic] = assessConsistency([
      host('a', tip(900, TAC_1)),
      host('b', tip(899, TAC_2)),
      host('c')
    ])
    expect(topic.status).toBe('lagging')
    expect(topic.hosts.map(entry => entry.status)).toEqual(['agreed', 'lagging', 'unknown'])
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
})
