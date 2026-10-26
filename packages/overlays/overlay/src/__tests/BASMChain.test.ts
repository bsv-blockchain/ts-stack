import { Engine } from '../Engine.js'
import { computeBasmRoot, computeTac } from '../BASM'
import type { AdmittedTxRef, TopicBlockAnchor } from '../BASM'

const ZERO = '0000000000000000000000000000000000000000000000000000000000000000'
const TXID_1 = '0101010101010101010101010101010101010101010101010101010101010101'
const TXID_2 = '0202020202020202020202020202020202020202020202020202020202020202'
const TXID_3 = '0303030303030303030303030303030303030303030303030303030303030303'
const ROOT_100 = 'a0'.repeat(32)
const ROOT_101 = 'a1'.repeat(32)
const ROOT_101_NEW = 'a2'.repeat(32)

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

function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message)
  return value
}

function makeStorage(store: FakeStore): any {
  const key = (topic: string, height: number): string => `${topic}:${height}`
  return {
    async findTopicAnchorTip(topic: string) {
      let tip: TopicBlockAnchor | undefined
      for (const anchor of store.anchors.values()) {
        if (anchor.topic === topic && (tip === undefined || anchor.blockHeight > tip.blockHeight)) {
          tip = anchor
        }
      }
      return tip ?? { topic, blockHeight: -1, tac: ZERO }
    },
    async upsertTopicBlockAnchor(anchor: TopicBlockAnchor) {
      store.anchors.set(key(anchor.topic, anchor.blockHeight), { ...anchor })
    },
    async findTopicBlockAnchor(topic: string, height: number) {
      return store.anchors.get(key(topic, height))
    },
    async findTopicBlockAnchors(topic: string, fromHeight: number, toHeight: number) {
      const result: TopicBlockAnchor[] = []
      for (const anchor of store.anchors.values()) {
        if (
          anchor.topic === topic &&
          anchor.blockHeight >= fromHeight &&
          anchor.blockHeight <= toHeight
        ) {
          result.push(anchor)
        }
      }
      return result.sort((a, b) => a.blockHeight - b.blockHeight)
    },
    async findAdmittedTransactionsForBlock(topic: string, height: number) {
      // Prefer deriving from proven applied rows so demotion is reflected.
      if (store.applied !== undefined) {
        return store.applied
          .filter(
            r =>
              r.proven &&
              r.topic === topic &&
              r.blockHeight === height &&
              r.blockIndex !== undefined
          )
          .sort((a, b) => (a.blockIndex ?? 0) - (b.blockIndex ?? 0))
          .map(r => ({ txid: r.txid, blockIndex: r.blockIndex as number }))
      }
      return store.admitted?.get(height) ?? []
    },
    async findProvenAppliedTransactionsByBlockHash(blockHash: string) {
      return (store.applied ?? [])
        .filter(r => r.proven && r.blockHash?.toLowerCase() === blockHash.toLowerCase())
        .map(r => ({ txid: r.txid, topic: r.topic, blockHeight: r.blockHeight as number }))
    },
    async findProvenAppliedTransactionsInRange(
      fromHeight: number,
      toHeight: number,
      topic?: string
    ) {
      return (store.applied ?? [])
        .filter(
          r =>
            r.proven &&
            r.blockHeight !== undefined &&
            r.blockHeight >= fromHeight &&
            r.blockHeight <= toHeight &&
            (topic === undefined || r.topic === topic)
        )
        .map(r => ({
          txid: r.txid,
          topic: r.topic,
          blockHeight: r.blockHeight as number,
          blockHash: r.blockHash,
          merkleRoot: r.merkleRoot
        }))
    },
    async demoteAppliedTransactionToUnproven(txid: string, topic: string) {
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

function makeEngine(
  store: FakeStore,
  opts: {
    resolver?: (h: number) => Promise<{ blockHeight: number; blockHash: string }>
    currentHeight?: number
    isValidRootForHeight?: (root: string, height: number) => Promise<boolean>
  } = {}
): Engine {
  const managers = {
    tm_test: {
      identifyAdmissibleOutputs: jest.fn(),
      getDocumentation: async () => '',
      getMetaData: async () => ({ name: 'm', shortDescription: 's' })
    }
  } as any
  const resolver =
    opts.resolver ??
    (async (blockHeight: number) => ({ blockHeight, blockHash: blockHashFor(blockHeight) }))
  return new Engine(
    managers,
    {},
    makeStorage(store),
    {
      isValidRootForHeight: opts.isValidRootForHeight ?? (async () => true),
      currentHeight: async () => opts.currentHeight ?? 105
    } as any,
    'https://example.com',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    '[T] ',
    false,
    undefined as any,
    console,
    true,
    resolver,
    false,
    144
  )
}

describe('BRC-136 BASM anchor chain continuity', () => {
  it('serializes resolver failures as single-line log fields', async () => {
    const store: FakeStore = { anchors: new Map(), admitted: new Map() }
    const engine = makeEngine(store, {
      resolver: async () => {
        throw new Error('resolver failed\r\nFORGED')
      }
    })
    const logger = {
      ...console,
      warn: jest.fn()
    }
    engine.logger = logger

    await (engine as any).rebuildTopicAnchorChain('tm_test', 0, 1024)

    const messages = logger.warn.mock.calls.map(call => call[0] as string)
    expect(messages).toHaveLength(3)
    expect(messages.join(' ')).toContain('resolver failed\\r\\nFORGED')
    expect(messages.every(message => !/[\r\n\u2028\u2029]/.test(message))).toBe(true)
  })

  it('rejects invalid target heights and unbound stored anchor tips', async () => {
    const store: FakeStore = { anchors: new Map(), admitted: new Map() }
    const engine = makeEngine(store)
    const upsert = jest.spyOn(engine.storage as any, 'upsertTopicBlockAnchor')

    await expect(engine.advanceTopicAnchorChains(-1)).rejects.toThrow(
      'BASM target height must be a non-negative safe integer'
    )
    ;(engine.storage as any).findTopicAnchorTip = jest.fn(async () => ({
      topic: 'tm_other',
      blockHeight: 100,
      tac: ZERO
    }))
    await expect(engine.advanceTopicAnchorChains(105)).rejects.toThrow(
      'does not match the requested topic'
    )
    expect(upsert).not.toHaveBeenCalled()
  })

  it('rejects unordered or unbound stored anchor ranges', async () => {
    const store: FakeStore = { anchors: new Map(), admitted: new Map() }
    const engine = makeEngine(store)
    ;(engine.storage as any).findTopicBlockAnchors = jest.fn(async () => [
      {
        topic: 'tm_test',
        blockHeight: 101,
        blockHash: blockHashFor(101),
        basmRoot: ROOT_101,
        admittedCount: 0,
        tac: ZERO
      },
      {
        topic: 'tm_test',
        blockHeight: 100,
        blockHash: blockHashFor(100),
        basmRoot: ROOT_100,
        admittedCount: 0,
        tac: ZERO
      }
    ])

    await expect(engine.provideTopicAnchorRange('tm_test', 100, 101)).rejects.toThrow(
      'unbound or unordered BASM anchor range'
    )
  })

  it('extends the chain with empty anchors so the TAC never resets across blocks with no admitted txs', async () => {
    const store: FakeStore = { anchors: new Map(), admitted: new Map() }

    // Genesis: topic admits two txs at height 100.
    must(store.admitted, 'admitted transaction map').set(100, [
      { txid: TXID_1, blockIndex: 0 },
      { txid: TXID_2, blockIndex: 1 }
    ])
    const genesisRoot = computeBasmRoot(
      must(must(store.admitted, 'admitted transaction map').get(100), 'genesis admissions')
    )
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
      const anchor = must(store.anchors.get(`tm_test:${h}`), `anchor ${h}`)
      expect(anchor.basmRoot).toBe(ZERO)
      expect(anchor.admittedCount).toBe(0)
      expectedTac = computeTac(expectedTac, blockHashFor(h), ZERO)
      expect(anchor.tac).toBe(expectedTac)
    }

    // The tip TAC is a cumulative hash that still depends on the genesis block —
    // i.e. it was NOT reset to a per-block value.
    const tipTac = must(store.anchors.get('tm_test:105'), 'tip anchor').tac
    const resetTac = computeTac(ZERO, blockHashFor(105), ZERO)
    expect(tipTac).not.toBe(resetTac)
  })
})

/** Replacement canonical block hash for height 101 after a reorg. */
const H101_NEW = 'aaaa000000000000000000000000000000000000000000000000000000000000'

/** Header resolver where height 101's canonical block hash is H101_NEW (post-reorg). */
const reorgResolver = async (h: number): Promise<{ blockHeight: number; blockHash: string }> => ({
  blockHeight: h,
  blockHash: h === 101 ? H101_NEW : blockHashFor(h)
})

/**
 * Builds a topic with a proven admission at height 100 (TXID_1, stays canonical)
 * and a proven admission at height 101 (TXID_2) in a block that will be orphaned.
 */
function seedTwoBlockChain(): FakeStore {
  const applied: AppliedRow[] = [
    {
      txid: TXID_1,
      topic: 'tm_test',
      blockHeight: 100,
      blockHash: blockHashFor(100),
      blockIndex: 0,
      merkleRoot: ROOT_100,
      firstSeenHeight: 100,
      proven: true
    },
    {
      txid: TXID_2,
      topic: 'tm_test',
      blockHeight: 101,
      blockHash: blockHashFor(101),
      blockIndex: 0,
      merkleRoot: ROOT_101,
      firstSeenHeight: 101,
      proven: true
    }
  ]
  const root100 = computeBasmRoot([{ txid: TXID_1, blockIndex: 0 }])
  const tac100 = computeTac(ZERO, blockHashFor(100), root100)
  const root101 = computeBasmRoot([{ txid: TXID_2, blockIndex: 0 }])
  const tac101 = computeTac(tac100, blockHashFor(101), root101)
  const anchors = new Map<string, TopicBlockAnchor>()
  anchors.set('tm_test:100', {
    topic: 'tm_test',
    blockHeight: 100,
    blockHash: blockHashFor(100),
    basmRoot: root100,
    admittedCount: 1,
    tac: tac100
  })
  anchors.set('tm_test:101', {
    topic: 'tm_test',
    blockHeight: 101,
    blockHash: blockHashFor(101),
    basmRoot: root101,
    admittedCount: 1,
    tac: tac101
  })
  return { anchors, applied }
}

describe('BRC-136 BASM reorg handling', () => {
  it('does not demote a block that the canonical resolver still recognizes', async () => {
    const store = seedTwoBlockChain()
    const engine = makeEngine(store, { currentHeight: 101 })

    await expect(
      engine.handleReorg({
        orphanedBlockHashes: [blockHashFor(101)],
        rebuildFromHeight: 101,
        newTipHeight: 101
      })
    ).rejects.toThrow('still canonical')

    expect(
      must(
        store.applied?.find(row => row.txid === TXID_2),
        'canonical row'
      ).proven
    ).toBe(true)
  })

  it('demotes an orphaned-block tx to unproven and rebuilds the anchor over the canonical hash', async () => {
    const store = seedTwoBlockChain()
    // Reorg: height 101's block (blockHashFor(101)) is orphaned; the replacement
    // canonical block at 101 (H101_NEW) does not re-include TXID_2.
    const engine = makeEngine(store, { resolver: reorgResolver, currentHeight: 101 })

    await (engine as any).handleReorg({
      orphanedBlockHashes: [blockHashFor(101)],
      rebuildFromHeight: 101,
      newTipHeight: 101
    })

    // TXID_2 is demoted: no longer proven, block metadata cleared.
    const row = must(
      store.applied?.find(r => r.txid === TXID_2),
      'orphaned applied row'
    )
    expect(row.proven).toBe(false)
    expect(row.blockHeight).toBeUndefined()
    // It survives as a receipt record (firstSeenHeight retained).
    expect(row.firstSeenHeight).toBe(101)

    // Anchor at 101 rebuilt: empty admitted set, canonical hash, recomputed TAC.
    const anchor101 = must(store.anchors.get('tm_test:101'), 'anchor 101')
    expect(anchor101.admittedCount).toBe(0)
    expect(anchor101.basmRoot).toBe(ZERO)
    expect(anchor101.blockHash).toBe(H101_NEW)
    const tac100 = must(store.anchors.get('tm_test:100'), 'anchor 100').tac
    expect(anchor101.tac).toBe(computeTac(tac100, H101_NEW, ZERO))

    // Height 100 is untouched.
    const root100 = computeBasmRoot([{ txid: TXID_1, blockIndex: 0 }])
    expect(must(store.anchors.get('tm_test:100'), 'anchor 100').basmRoot).toBe(root100)
  })

  it('is idempotent: orphaned hashes matching no proven rows leave the chain unchanged', async () => {
    const store = seedTwoBlockChain()
    const engine = makeEngine(store, { currentHeight: 101 })
    const before = must(store.anchors.get('tm_test:101'), 'anchor 101').tac

    await (engine as any).handleReorg({
      orphanedBlockHashes: ['ffff000000000000000000000000000000000000000000000000000000000000'],
      rebuildFromHeight: 101,
      newTipHeight: 101
    })

    expect(
      must(
        store.applied?.find(r => r.txid === TXID_2),
        'applied row 2'
      ).proven
    ).toBe(true)
    expect(must(store.anchors.get('tm_test:101'), 'anchor 101').tac).toBe(before)
  })

  it('re-proving a demoted tx at a new height restores it to the admitted set', async () => {
    const store = seedTwoBlockChain()
    const engine = makeEngine(store, { resolver: reorgResolver, currentHeight: 101 })

    await (engine as any).handleReorg({
      orphanedBlockHashes: [blockHashFor(101)],
      rebuildFromHeight: 101,
      newTipHeight: 101
    })
    expect(must(store.anchors.get('tm_test:101'), 'anchor 101').basmRoot).toBe(ZERO)

    // TXID_2 re-mined into the new canonical block at 101.
    const row = must(
      store.applied?.find(r => r.txid === TXID_2),
      'applied row 2'
    )
    row.proven = true
    row.blockHeight = 101
    row.blockHash = H101_NEW
    row.blockIndex = 0
    row.merkleRoot = ROOT_101_NEW

    await (engine as any).handleReorg({
      orphanedBlockHashes: [],
      rebuildFromHeight: 101,
      newTipHeight: 101
    })

    const anchor101 = must(store.anchors.get('tm_test:101'), 'anchor 101')
    expect(anchor101.admittedCount).toBe(1)
    expect(anchor101.basmRoot).toBe(computeBasmRoot([{ txid: TXID_2, blockIndex: 0 }]))
    expect(anchor101.blockHash).toBe(H101_NEW)
  })
})

describe('BRC-136 BASM reorg revalidation sweep', () => {
  it('detects a stale proof root within the window and reorgs the affected height', async () => {
    const store = seedTwoBlockChain()
    // Height 101's proof root no longer validates (block orphaned); canonical
    // header at 101 is now H101_NEW.
    const isValidRootForHeight = async (root: string, height: number): Promise<boolean> =>
      !(height === 101 && root === ROOT_101)
    const engine = makeEngine(store, {
      resolver: reorgResolver,
      currentHeight: 101,
      isValidRootForHeight
    })

    await (engine as any).revalidateRecentAnchors(3)

    expect(
      must(
        store.applied?.find(r => r.txid === TXID_2),
        'applied row 2'
      ).proven
    ).toBe(false)
    const anchor101 = must(store.anchors.get('tm_test:101'), 'anchor 101')
    expect(anchor101.basmRoot).toBe(ZERO)
    expect(anchor101.blockHash).toBe(H101_NEW)
    // Height 100 still valid and untouched.
    expect(
      must(
        store.applied?.find(r => r.txid === TXID_1),
        'applied row 1'
      ).proven
    ).toBe(true)
    expect(must(store.anchors.get('tm_test:100'), 'anchor 100').basmRoot).toBe(
      computeBasmRoot([{ txid: TXID_1, blockIndex: 0 }])
    )
  })

  it('leaves the chain unchanged when every proof in the window still validates', async () => {
    const store = seedTwoBlockChain()
    const engine = makeEngine(store, { currentHeight: 101, isValidRootForHeight: async () => true })
    const before = must(store.anchors.get('tm_test:101'), 'anchor 101').tac

    await (engine as any).revalidateRecentAnchors(3)

    expect(
      must(
        store.applied?.find(r => r.txid === TXID_2),
        'applied row 2'
      ).proven
    ).toBe(true)
    expect(must(store.anchors.get('tm_test:101'), 'anchor 101').tac).toBe(before)
  })

  it('does not treat a truthy non-boolean chain verdict as valid proof evidence', async () => {
    const store = seedTwoBlockChain()
    const engine = makeEngine(store, {
      resolver: reorgResolver,
      currentHeight: 101,
      isValidRootForHeight: async () => 'true' as unknown as boolean
    })

    await (engine as any).revalidateRecentAnchors(3)

    expect(
      must(
        store.applied?.find(row => row.txid === TXID_2),
        'applied row 2'
      ).proven
    ).toBe(false)
  })

  it('demotes only the exact invalid-proof row when its block remains canonical', async () => {
    const store = seedTwoBlockChain()
    must(store.applied, 'applied rows').push({
      txid: TXID_3,
      topic: 'tm_test',
      blockHeight: 101,
      blockHash: blockHashFor(101),
      blockIndex: 1,
      merkleRoot: ROOT_101_NEW,
      firstSeenHeight: 101,
      proven: true
    })
    const engine = makeEngine(store, {
      currentHeight: 101,
      isValidRootForHeight: async root => root !== ROOT_101
    })

    await engine.revalidateRecentAnchors(3)

    expect(
      must(
        store.applied?.find(row => row.txid === TXID_2),
        'invalid row'
      ).proven
    ).toBe(false)
    expect(
      must(
        store.applied?.find(row => row.txid === TXID_3),
        'valid peer row'
      ).proven
    ).toBe(true)
  })
})

describe('BRC-136 BASM hostile storage and range boundaries', () => {
  it('rejects malformed anchor rebuild controls before storage access', async () => {
    const engine = makeEngine({ anchors: new Map(), admitted: new Map() })
    const rebuild = (engine as any).rebuildTopicAnchorChain.bind(engine)

    await expect(rebuild('tm_test', 0, 1, {})).rejects.toThrow(
      'BASM block hash hints must be a Map'
    )
    await expect(rebuild('tm_test', 0, 1, new Map(), 'yes')).rejects.toThrow(
      'BASM forceResolve must be a boolean'
    )
    await expect(rebuild('tm_test', 0, 1, new Map([[2, blockHashFor(2)]]))).rejects.toThrow(
      'BASM block hash hint is outside the rebuild range'
    )
  })

  it.each([
    null,
    { orphanedBlockHashes: 'not-an-array', rebuildFromHeight: 0, newTipHeight: 0 },
    {
      orphanedBlockHashes: Array.from({ length: 10_001 }, () => ZERO),
      rebuildFromHeight: 0,
      newTipHeight: 0
    }
  ])('rejects an invalid or oversized reorg envelope %#', async input => {
    const engine = makeEngine({ anchors: new Map(), admitted: new Map() })
    await expect(engine.handleReorg(input as any)).rejects.toThrow(
      'Invalid or oversized reorg input'
    )
  })

  it('rejects reversed, oversized, and duplicate reorg claims', async () => {
    const engine = makeEngine({ anchors: new Map(), admitted: new Map() })

    await expect(
      engine.handleReorg({ orphanedBlockHashes: [], rebuildFromHeight: 2, newTipHeight: 1 })
    ).rejects.toThrow('Reorg rebuild ranges are capped')
    await expect(
      engine.handleReorg({ orphanedBlockHashes: [], rebuildFromHeight: 0, newTipHeight: 100_000 })
    ).rejects.toThrow('Reorg rebuild ranges are capped')
    await expect(
      engine.handleReorg({
        orphanedBlockHashes: [blockHashFor(1), blockHashFor(1).toUpperCase()],
        rebuildFromHeight: 0,
        newTipHeight: 1
      })
    ).rejects.toThrow('Reorg block hashes must be unique')
  })

  it.each([
    ['non-array', 'bad'],
    ['null row', [null]],
    ['out-of-range row', [{ txid: TXID_1, topic: 'tm_test', blockHeight: 2 }]],
    [
      'duplicate row',
      [
        { txid: TXID_1, topic: 'tm_test', blockHeight: 1 },
        { txid: TXID_1.toUpperCase(), topic: 'tm_test', blockHeight: 1 }
      ]
    ]
  ])('rejects hostile reorg transaction results: %s', async (_label, rows) => {
    const engine = makeEngine({ anchors: new Map(), admitted: new Map() })
    ;(engine.storage as any).findProvenAppliedTransactionsByBlockHash = jest.fn(async () => rows)

    await expect(
      engine.handleReorg({
        orphanedBlockHashes: [blockHashFor(1)],
        rebuildFromHeight: 0,
        newTipHeight: 1
      })
    ).rejects.toThrow()
  })

  it('fails closed when an orphan claim cannot be corroborated', async () => {
    const store: FakeStore = {
      anchors: new Map(),
      applied: [
        {
          txid: TXID_1,
          topic: 'tm_test',
          blockHeight: 1,
          blockHash: blockHashFor(1),
          proven: true
        }
      ]
    }
    const engine = makeEngine(store, { resolver: async () => undefined as any })

    await expect(
      engine.handleReorg({
        orphanedBlockHashes: [blockHashFor(1)],
        rebuildFromHeight: 0,
        newTipHeight: 1
      })
    ).rejects.toThrow('Unable to corroborate a reported reorg')
    expect(must(store.applied, 'applied rows')[0].proven).toBe(true)
  })

  it.each([
    ['non-array', 'bad'],
    ['null anchor', [null]],
    [
      'wrong topic',
      [
        {
          topic: 'tm_other',
          blockHeight: 1,
          blockHash: blockHashFor(1),
          basmRoot: ZERO,
          admittedCount: 0,
          tac: ZERO
        }
      ]
    ],
    [
      'duplicate height',
      [0, 1].map(() => ({
        topic: 'tm_test',
        blockHeight: 1,
        blockHash: blockHashFor(1),
        basmRoot: ZERO,
        admittedCount: 0,
        tac: ZERO
      }))
    ]
  ])('rejects hostile reorg anchor results: %s', async (_label, anchors) => {
    const engine = makeEngine({ anchors: new Map(), admitted: new Map() })
    ;(engine.storage as any).findTopicBlockAnchors = jest.fn(async () => anchors)

    await expect(
      engine.handleReorg({ orphanedBlockHashes: [], rebuildFromHeight: 0, newTipHeight: 1 })
    ).rejects.toThrow()
  })

  it.each([
    ['non-array', 'bad'],
    ['null row', [null]],
    [
      'out-of-range row',
      [{ txid: TXID_1, topic: 'tm_test', blockHeight: 90, blockHash: blockHashFor(90) }]
    ],
    [
      'duplicate row',
      [
        { txid: TXID_1, topic: 'tm_test', blockHeight: 105, blockHash: blockHashFor(105) },
        {
          txid: TXID_1.toUpperCase(),
          topic: 'tm_test',
          blockHeight: 105,
          blockHash: blockHashFor(105)
        }
      ]
    ]
  ])('rejects hostile revalidation results: %s', async (_label, rows) => {
    const engine = makeEngine({ anchors: new Map(), admitted: new Map() }, { currentHeight: 105 })
    ;(engine.storage as any).findProvenAppliedTransactionsInRange = jest.fn(async () => rows)

    await expect(engine.revalidateRecentAnchors(3)).rejects.toThrow()
  })

  it('skips rows without block identities and contains proof-validator failures', async () => {
    const engine = makeEngine(
      { anchors: new Map(), admitted: new Map() },
      {
        currentHeight: 105,
        isValidRootForHeight: async () => {
          throw new Error('hostile\r\nvalidator')
        }
      }
    )
    const logger = { ...console, warn: jest.fn() }
    engine.logger = logger
    ;(engine.storage as any).findProvenAppliedTransactionsInRange = jest.fn(async () => [
      { txid: TXID_1, topic: 'tm_test', blockHeight: 105 },
      {
        txid: TXID_2,
        topic: 'tm_test',
        blockHeight: 105,
        blockHash: blockHashFor(105),
        merkleRoot: ROOT_101
      }
    ])

    await expect(engine.revalidateRecentAnchors(3)).resolves.toEqual({ perTopic: [] })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('hostile'))
  })
})
