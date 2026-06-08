// Note: references Engine from dist due to compiled code references in Engine.ts
// (matching Engine.test.ts).
import { Engine } from '../../dist/cjs/src/Engine.js'
import { computeBasmRoot, computeTac } from '../BASM'
import type { AdmittedTxRef, TopicBlockAnchor } from '../BASM'

const ZERO = '0000000000000000000000000000000000000000000000000000000000000000'
const TXID_1 = '0101010101010101010101010101010101010101010101010101010101010101'
const TXID_2 = '0202020202020202020202020202020202020202020202020202020202020202'

/** Deterministic non-zero 32-byte hex block hash for a height. */
const blockHashFor = (height: number): string => (height + 1).toString(16).padStart(64, '0')

interface FakeStore {
  anchors: Map<string, TopicBlockAnchor>
  admitted: Map<number, AdmittedTxRef[]>
}

function makeStorage (store: FakeStore): any {
  const key = (topic: string, height: number): string => `${topic}:${height}`
  return {
    async findTopicAnchorTip (topic: string) {
      let tip: TopicBlockAnchor | undefined
      for (const anchor of store.anchors.values()) {
        if (anchor.topic === topic && (tip === undefined || anchor.blockHeight > tip.blockHeight)) {
          tip = anchor
        }
      }
      return tip ?? { topic, blockHeight: -1, tac: ZERO }
    },
    async upsertTopicBlockAnchor (anchor: TopicBlockAnchor) {
      store.anchors.set(key(anchor.topic, anchor.blockHeight), { ...anchor })
    },
    async findTopicBlockAnchor (topic: string, height: number) {
      return store.anchors.get(key(topic, height))
    },
    async findAdmittedTransactionsForBlock (_topic: string, height: number) {
      return store.admitted.get(height) ?? []
    }
  }
}

function makeEngine (store: FakeStore): Engine {
  const managers = { tm_test: { identifyAdmissibleOutputs: jest.fn(), getDocumentation: async () => '', getMetaData: async () => ({ name: 'm', shortDescription: 's' }) } } as any
  const resolver = async (blockHeight: number) => ({ blockHeight, blockHash: blockHashFor(blockHeight) })
  return new Engine(
    managers,
    {},
    makeStorage(store),
    { isValidRootForHeight: async () => true, currentHeight: async () => 105 } as any,
    'https://example.com',
    undefined, undefined, undefined, undefined, undefined,
    false, '[T] ', false, undefined as any, console, true,
    resolver, false, 144
  )
}

describe('BRC-136 BASM anchor chain continuity', () => {
  it('extends the chain with empty anchors so the TAC never resets across blocks with no admitted txs', async () => {
    const store: FakeStore = { anchors: new Map(), admitted: new Map() }

    // Genesis: topic admits two txs at height 100.
    store.admitted.set(100, [
      { txid: TXID_1, blockIndex: 0 },
      { txid: TXID_2, blockIndex: 1 }
    ])
    const genesisRoot = computeBasmRoot(store.admitted.get(100)!)
    const genesisTac = computeTac(ZERO, blockHashFor(100), genesisRoot)
    store.anchors.set('tm_test:100', {
      topic: 'tm_test',
      blockHeight: 100,
      blockHash: blockHashFor(100),
      basmRoot: genesisRoot,
      admittedCount: 2,
      tac: genesisTac
    })

    const engine = makeEngine(store)
    await engine.advanceTopicAnchorChains(105)

    // Every height 100..105 must have an anchor — no gaps.
    for (let h = 100; h <= 105; h++) {
      expect(store.anchors.get(`tm_test:${h}`)).toBeDefined()
    }

    // 101..105 are empty anchors (zero root, zero count) chained off genesis.
    let expectedTac = genesisTac
    for (let h = 101; h <= 105; h++) {
      const anchor = store.anchors.get(`tm_test:${h}`)!
      expect(anchor.basmRoot).toBe(ZERO)
      expect(anchor.admittedCount).toBe(0)
      expectedTac = computeTac(expectedTac, blockHashFor(h), ZERO)
      expect(anchor.tac).toBe(expectedTac)
    }

    // The tip TAC is a cumulative hash that still depends on the genesis block —
    // i.e. it was NOT reset to a per-block value.
    const tipTac = store.anchors.get('tm_test:105')!.tac
    const resetTac = computeTac(ZERO, blockHashFor(105), ZERO)
    expect(tipTac).not.toBe(resetTac)
  })
})
