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

interface AppliedRow {
  txid: string
  topic: string
  blockHeight?: number
  blockHash?: string
  blockIndex?: number
  merkleRoot?: string
  firstSeenHeight?: number
  proven: boolean
}

interface FakeStore {
  anchors: Map<string, TopicBlockAnchor>
  admitted?: Map<number, AdmittedTxRef[]>
  applied?: AppliedRow[]
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
    async findTopicBlockAnchors (topic: string, fromHeight: number, toHeight: number) {
      const result: TopicBlockAnchor[] = []
      for (const anchor of store.anchors.values()) {
        if (anchor.topic === topic && anchor.blockHeight >= fromHeight && anchor.blockHeight <= toHeight) {
          result.push(anchor)
        }
      }
      return result.sort((a, b) => a.blockHeight - b.blockHeight)
    },
    async findAdmittedTransactionsForBlock (topic: string, height: number) {
      // Prefer deriving from proven applied rows so demotion is reflected.
      if (store.applied !== undefined) {
        return store.applied
          .filter(r => r.proven && r.topic === topic && r.blockHeight === height && r.blockIndex !== undefined)
          .sort((a, b) => (a.blockIndex ?? 0) - (b.blockIndex ?? 0))
          .map(r => ({ txid: r.txid, blockIndex: r.blockIndex as number }))
      }
      return store.admitted?.get(height) ?? []
    },
    async findProvenAppliedTransactionsByBlockHash (blockHash: string) {
      return (store.applied ?? [])
        .filter(r => r.proven && r.blockHash?.toLowerCase() === blockHash.toLowerCase())
        .map(r => ({ txid: r.txid, topic: r.topic, blockHeight: r.blockHeight as number }))
    },
    async findProvenAppliedTransactionsInRange (fromHeight: number, toHeight: number, topic?: string) {
      return (store.applied ?? [])
        .filter(r => r.proven && r.blockHeight !== undefined && r.blockHeight >= fromHeight && r.blockHeight <= toHeight && (topic === undefined || r.topic === topic))
        .map(r => ({ txid: r.txid, topic: r.topic, blockHeight: r.blockHeight as number, blockHash: r.blockHash, merkleRoot: r.merkleRoot }))
    },
    async demoteAppliedTransactionToUnproven (txid: string, topic: string) {
      const row = (store.applied ?? []).find(r => r.txid === txid && r.topic === topic)
      if (row !== undefined) {
        row.proven = false
        row.blockHeight = undefined
        row.blockHash = undefined
        row.blockIndex = undefined
        row.merkleRoot = undefined
      }
    }
  }
}

function makeEngine (
  store: FakeStore,
  opts: { resolver?: (h: number) => Promise<{ blockHeight: number, blockHash: string }>, currentHeight?: number, isValidRootForHeight?: (root: string, height: number) => Promise<boolean> } = {}
): Engine {
  const managers = { tm_test: { identifyAdmissibleOutputs: jest.fn(), getDocumentation: async () => '', getMetaData: async () => ({ name: 'm', shortDescription: 's' }) } } as any
  const resolver = opts.resolver ?? (async (blockHeight: number) => ({ blockHeight, blockHash: blockHashFor(blockHeight) }))
  return new Engine(
    managers,
    {},
    makeStorage(store),
    { isValidRootForHeight: opts.isValidRootForHeight ?? (async () => true), currentHeight: async () => opts.currentHeight ?? 105 } as any,
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
    store.admitted!.set(100, [
      { txid: TXID_1, blockIndex: 0 },
      { txid: TXID_2, blockIndex: 1 }
    ])
    const genesisRoot = computeBasmRoot(store.admitted!.get(100)!)
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

describe('BRC-136 BASM reorg handling', () => {
  const TXID_3 = '0303030303030303030303030303030303030303030303030303030303030303'
  const H101_NEW = 'aaaa000000000000000000000000000000000000000000000000000000000000'

  /**
   * Builds a topic with a proven admission at height 100 (TXID_1, stays canonical)
   * and a proven admission at height 101 (TXID_2) in a block that will be orphaned.
   */
  function seedTwoBlockChain (): FakeStore {
    const applied: AppliedRow[] = [
      { txid: TXID_1, topic: 'tm_test', blockHeight: 100, blockHash: blockHashFor(100), blockIndex: 0, merkleRoot: 'm100', firstSeenHeight: 100, proven: true },
      { txid: TXID_2, topic: 'tm_test', blockHeight: 101, blockHash: blockHashFor(101), blockIndex: 0, merkleRoot: 'm101', firstSeenHeight: 101, proven: true }
    ]
    const root100 = computeBasmRoot([{ txid: TXID_1, blockIndex: 0 }])
    const tac100 = computeTac(ZERO, blockHashFor(100), root100)
    const root101 = computeBasmRoot([{ txid: TXID_2, blockIndex: 0 }])
    const tac101 = computeTac(tac100, blockHashFor(101), root101)
    const anchors = new Map<string, TopicBlockAnchor>()
    anchors.set('tm_test:100', { topic: 'tm_test', blockHeight: 100, blockHash: blockHashFor(100), basmRoot: root100, admittedCount: 1, tac: tac100 })
    anchors.set('tm_test:101', { topic: 'tm_test', blockHeight: 101, blockHash: blockHashFor(101), basmRoot: root101, admittedCount: 1, tac: tac101 })
    return { anchors, applied }
  }

  it('demotes an orphaned-block tx to unproven and rebuilds the anchor over the canonical hash', async () => {
    const store = seedTwoBlockChain()
    // Reorg: height 101's block (blockHashFor(101)) is orphaned; the replacement
    // canonical block at 101 (H101_NEW) does not re-include TXID_2.
    const resolver = async (h: number) => ({ blockHeight: h, blockHash: h === 101 ? H101_NEW : blockHashFor(h) })
    const engine = makeEngine(store, { resolver, currentHeight: 101 })

    await (engine as any).handleReorg({
      orphanedBlockHashes: [blockHashFor(101)],
      rebuildFromHeight: 101,
      newTipHeight: 101
    })

    // TXID_2 is demoted: no longer proven, block metadata cleared.
    const row = store.applied!.find(r => r.txid === TXID_2)!
    expect(row.proven).toBe(false)
    expect(row.blockHeight).toBeUndefined()
    // It survives as a receipt record (firstSeenHeight retained).
    expect(row.firstSeenHeight).toBe(101)

    // Anchor at 101 rebuilt: empty admitted set, canonical hash, recomputed TAC.
    const anchor101 = store.anchors.get('tm_test:101')!
    expect(anchor101.admittedCount).toBe(0)
    expect(anchor101.basmRoot).toBe(ZERO)
    expect(anchor101.blockHash).toBe(H101_NEW)
    const tac100 = store.anchors.get('tm_test:100')!.tac
    expect(anchor101.tac).toBe(computeTac(tac100, H101_NEW, ZERO))

    // Height 100 is untouched.
    const root100 = computeBasmRoot([{ txid: TXID_1, blockIndex: 0 }])
    expect(store.anchors.get('tm_test:100')!.basmRoot).toBe(root100)
  })

  it('is idempotent: orphaned hashes matching no proven rows leave the chain unchanged', async () => {
    const store = seedTwoBlockChain()
    const engine = makeEngine(store, { currentHeight: 101 })
    const before = store.anchors.get('tm_test:101')!.tac

    await (engine as any).handleReorg({
      orphanedBlockHashes: ['ffff000000000000000000000000000000000000000000000000000000000000'],
      rebuildFromHeight: 101,
      newTipHeight: 101
    })

    expect(store.applied!.find(r => r.txid === TXID_2)!.proven).toBe(true)
    expect(store.anchors.get('tm_test:101')!.tac).toBe(before)
  })

  it('re-proving a demoted tx at a new height restores it to the admitted set', async () => {
    const store = seedTwoBlockChain()
    const resolver = async (h: number) => ({ blockHeight: h, blockHash: h === 101 ? H101_NEW : blockHashFor(h) })
    const engine = makeEngine(store, { resolver, currentHeight: 101 })

    await (engine as any).handleReorg({
      orphanedBlockHashes: [blockHashFor(101)],
      rebuildFromHeight: 101,
      newTipHeight: 101
    })
    expect(store.anchors.get('tm_test:101')!.basmRoot).toBe(ZERO)

    // TXID_2 re-mined into the new canonical block at 101.
    const row = store.applied!.find(r => r.txid === TXID_2)!
    row.proven = true
    row.blockHeight = 101
    row.blockHash = H101_NEW
    row.blockIndex = 0
    row.merkleRoot = 'm101new'

    await (engine as any).handleReorg({
      orphanedBlockHashes: [],
      rebuildFromHeight: 101,
      newTipHeight: 101
    })

    const anchor101 = store.anchors.get('tm_test:101')!
    expect(anchor101.admittedCount).toBe(1)
    expect(anchor101.basmRoot).toBe(computeBasmRoot([{ txid: TXID_2, blockIndex: 0 }]))
    expect(anchor101.blockHash).toBe(H101_NEW)
  })
})

describe('BRC-136 BASM reorg revalidation sweep', () => {
  const H101_NEW = 'aaaa000000000000000000000000000000000000000000000000000000000000'

  function seedTwoBlockChain (): FakeStore {
    const applied: AppliedRow[] = [
      { txid: TXID_1, topic: 'tm_test', blockHeight: 100, blockHash: blockHashFor(100), blockIndex: 0, merkleRoot: 'm100', firstSeenHeight: 100, proven: true },
      { txid: TXID_2, topic: 'tm_test', blockHeight: 101, blockHash: blockHashFor(101), blockIndex: 0, merkleRoot: 'm101', firstSeenHeight: 101, proven: true }
    ]
    const root100 = computeBasmRoot([{ txid: TXID_1, blockIndex: 0 }])
    const tac100 = computeTac(ZERO, blockHashFor(100), root100)
    const root101 = computeBasmRoot([{ txid: TXID_2, blockIndex: 0 }])
    const tac101 = computeTac(tac100, blockHashFor(101), root101)
    const anchors = new Map<string, TopicBlockAnchor>()
    anchors.set('tm_test:100', { topic: 'tm_test', blockHeight: 100, blockHash: blockHashFor(100), basmRoot: root100, admittedCount: 1, tac: tac100 })
    anchors.set('tm_test:101', { topic: 'tm_test', blockHeight: 101, blockHash: blockHashFor(101), basmRoot: root101, admittedCount: 1, tac: tac101 })
    return { anchors, applied }
  }

  it('detects a stale proof root within the window and reorgs the affected height', async () => {
    const store = seedTwoBlockChain()
    // Height 101's proof root no longer validates (block orphaned); canonical
    // header at 101 is now H101_NEW.
    const isValidRootForHeight = async (root: string, height: number) => !(height === 101 && root === 'm101')
    const resolver = async (h: number) => ({ blockHeight: h, blockHash: h === 101 ? H101_NEW : blockHashFor(h) })
    const engine = makeEngine(store, { resolver, currentHeight: 101, isValidRootForHeight })

    await (engine as any).revalidateRecentAnchors(3)

    expect(store.applied!.find(r => r.txid === TXID_2)!.proven).toBe(false)
    const anchor101 = store.anchors.get('tm_test:101')!
    expect(anchor101.basmRoot).toBe(ZERO)
    expect(anchor101.blockHash).toBe(H101_NEW)
    // Height 100 still valid and untouched.
    expect(store.applied!.find(r => r.txid === TXID_1)!.proven).toBe(true)
    expect(store.anchors.get('tm_test:100')!.basmRoot).toBe(computeBasmRoot([{ txid: TXID_1, blockIndex: 0 }]))
  })

  it('leaves the chain unchanged when every proof in the window still validates', async () => {
    const store = seedTwoBlockChain()
    const engine = makeEngine(store, { currentHeight: 101, isValidRootForHeight: async () => true })
    const before = store.anchors.get('tm_test:101')!.tac

    await (engine as any).revalidateRecentAnchors(3)

    expect(store.applied!.find(r => r.txid === TXID_2)!.proven).toBe(true)
    expect(store.anchors.get('tm_test:101')!.tac).toBe(before)
  })
})
