import { LockingScript, MerklePath, Transaction } from '@bsv/sdk'
import { Engine } from '../Engine'
import { BASM_ZERO_HASH, computeBasmRoot, computeTac } from '../BASM'
import type {
  AdmittedTxRef,
  TopicAnchorHeader,
  TopicAnchorTip,
  TopicBlockAnchor
} from '../BASM'
import type { Storage } from '../storage/Storage'

const topic = 'tm_basm_range'
const endpoint = 'https://peer.example'

/** A distinct, well-formed 32-byte block hash per height. */
const hashAt = (height: number): string =>
  `${height.toString(16).padStart(8, '0')}${'bb'.repeat(28)}`

interface RangeBody {
  fromHeight: number
  toHeight: number
}

/**
 * A fake BASM peer plus a local overlay whose stored anchors, canonical
 * headers and chain tracker are supplied per test.
 */
function harness(options: {
  localTip?: TopicAnchorTip
  localAnchors?: TopicBlockAnchor[]
  header?: (height: number) => TopicAnchorHeader
  isCanonicalRoot?: (root: string, height: number) => boolean
  handle: (path: string, body: Record<string, unknown>) => unknown
}) {
  const localAnchors = new Map(
    (options.localAnchors ?? []).map(anchor => [anchor.blockHeight, anchor])
  )
  const storage = {
    findTopicAnchorTip: jest.fn(
      async (topicName: string): Promise<TopicAnchorTip | undefined> =>
        topicName === topic ? options.localTip : undefined
    ),
    findTopicBlockAnchor: jest.fn(
      async (topicName: string, height: number): Promise<TopicBlockAnchor | undefined> =>
        topicName === topic ? localAnchors.get(height) : undefined
    ),
    findAdmittedTransactionsForBlock: jest.fn(async (): Promise<AdmittedTxRef[]> => [])
  }
  const tracker = {
    currentHeight: jest.fn(async () => 5000),
    isValidRootForHeight: jest.fn(
      async (root: string, height: number) => options.isCanonicalRoot?.(root, height) ?? false
    )
  }
  const engine = new Engine({}, {}, storage as unknown as Storage, tracker)
  engine.syncConfiguration = { [topic]: [endpoint] }
  engine.topicAnchorHeaderResolver = jest.fn(
    async (height: number) =>
      options.header?.(height) ?? { blockHeight: height, blockHash: hashAt(height) }
  )
  engine.logger = { ...console, error: jest.fn() }
  const submit = jest.spyOn(engine, 'submit').mockResolvedValue({})
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ path, body })
    return Response.json(options.handle(path, body))
  })
  return { engine, storage, tracker, submit, requests }
}

/** A contiguous run of zero-admission anchors chained onto `startTac`. */
function chain(fromHeight: number, count: number, startTac: string): TopicBlockAnchor[] {
  const anchors: TopicBlockAnchor[] = []
  let tac = startTac
  for (let index = 0; index < count; index++) {
    const blockHeight = fromHeight + index
    tac = computeTac(tac, hashAt(blockHeight), BASM_ZERO_HASH)
    anchors.push({
      topic,
      blockHeight,
      blockHash: hashAt(blockHeight),
      basmRoot: BASM_ZERO_HASH,
      admittedCount: 0,
      tac
    })
  }
  return anchors
}

const inRange = (anchors: TopicBlockAnchor[], body: Record<string, unknown>): TopicBlockAnchor[] => {
  const { fromHeight, toHeight } = body as unknown as RangeBody
  return anchors.filter(
    anchor => anchor.blockHeight >= fromHeight && anchor.blockHeight <= toHeight
  )
}

afterEach(() => jest.restoreAllMocks())

describe('BASM forward-page prefix validation', () => {
  it('rejects a page that stops short of the height it was asked for', async () => {
    const [tip] = chain(1200, 1, BASM_ZERO_HASH)
    const served = [...chain(201, 5, BASM_ZERO_HASH), tip]
    const h = harness({
      handle: (path, body) => {
        if (path === '/requestTopicAnchorTip') return tip
        // A peer that silently caps every page at five anchors.
        return { topic, anchors: inRange(served, body).slice(0, 5) }
      }
    })
    const [report] = await h.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.errorCode).toBe('BASM_INVALID_RESPONSE')
    expect(report.message).toBe('BASM range omits its requested target')
    // The page starts one page below the remote tip, not at genesis.
    expect(h.requests.at(-1)).toEqual({
      path: '/requestTopicAnchorRange',
      body: { fromHeight: 201, toHeight: 1200 }
    })
    expect(h.submit).not.toHaveBeenCalled()
  })

  it('rejects a page that skips the height immediately after the local tip', async () => {
    const localTac = computeTac(BASM_ZERO_HASH, hashAt(100), BASM_ZERO_HASH)
    const [, tip] = chain(101, 2, localTac)
    const h = harness({
      localTip: { topic, blockHeight: 100, tac: localTac },
      handle: (path, body) => {
        if (path === '/requestTopicAnchorTip') return tip
        // Height 101 is withheld, so the prefix cannot be chained.
        return { topic, anchors: inRange([tip], body) }
      }
    })
    const [report] = await h.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.errorCode).toBe('BASM_INVALID_RESPONSE')
    expect(report.message).toBe('BASM range omits its next height')
    expect(h.submit).not.toHaveBeenCalled()
  })

  it('advances one capped page at a time when the peer is many pages ahead', async () => {
    const localTac = computeTac(BASM_ZERO_HASH, hashAt(0), BASM_ZERO_HASH)
    const page = chain(1, 1000, localTac)
    const [tip] = chain(2000, 1, BASM_ZERO_HASH)
    const h = harness({
      localTip: { topic, blockHeight: 0, tac: localTac },
      // Every anchor in the page is already stored locally with the same TAC.
      localAnchors: page,
      handle: (path, body) => {
        if (path === '/requestTopicAnchorTip') return tip
        return { topic, anchors: inRange([...page, tip], body) }
      }
    })
    const [report] = await h.engine.startBASMSync()
    expect(report.status).toBe('advanced')
    expect(report.checkedHeights).toHaveLength(1000)
    expect(report.checkedHeights[0]).toBe(1)
    expect(report.checkedHeights.at(-1)).toBe(1000)
    expect(report.fetchedTxCount).toBe(0)
    expect(report.missingTxids).toEqual([])
    // A page that ends below the remote tip is not required to reproduce it,
    // and anchors already held locally are never re-downloaded.
    expect(
      h.requests.filter(request => request.path === '/requestTopicAnchorRange').map(r => r.body)
    ).toEqual([
      { fromHeight: 2000, toHeight: 2000 },
      { fromHeight: 1, toHeight: 1000 }
    ])
    expect(h.requests.some(request => request.path === '/requestAdmittedList')).toBe(false)
    expect(h.submit).not.toHaveBeenCalled()
  })
})

describe('BASM position-assurance reporting across a page', () => {
  it('keeps the weakest assurance when only some blocks bind a canonical count', async () => {
    const transactions = [10, 20].map(
      satoshis =>
        new Transaction(1, [], [{ satoshis, lockingScript: LockingScript.fromASM('OP_TRUE') }], 0)
    )
    const ids = transactions.map(tx => tx.id('hex'))
    const localTac = computeTac(BASM_ZERO_HASH, hashAt(99), BASM_ZERO_HASH)
    const anchors: TopicBlockAnchor[] = []
    let tac = localTac
    ids.forEach((txid, index) => {
      const blockHeight = 100 + index
      const basmRoot = computeBasmRoot([{ txid, blockIndex: 0 }])
      tac = computeTac(tac, hashAt(blockHeight), basmRoot)
      anchors.push({
        topic,
        blockHeight,
        blockHash: hashAt(blockHeight),
        basmRoot,
        admittedCount: 1,
        tac
      })
    })
    const txidAt = (height: number): string => ids[height - 100]
    const rawByTxid = new Map(ids.map((txid, index) => [txid, transactions[index].toHex()]))
    const h = harness({
      localTip: { topic, blockHeight: 99, tac: localTac },
      header: height => ({
        blockHeight: height,
        blockHash: hashAt(height),
        merkleRoot: txidAt(height),
        // Only the second block's header carries a trusted transaction count.
        ...(height === 101 ? { blockTransactionCount: 1 } : {})
      }),
      isCanonicalRoot: (root, height) => root === txidAt(height),
      handle: (path, body) => {
        if (path === '/requestTopicAnchorTip') return anchors[1]
        if (path === '/requestTopicAnchorRange') return { topic, anchors: inRange(anchors, body) }
        const { blockHeight, txids } = body as unknown as {
          blockHeight: number
          txids: string[]
        }
        if (path === '/requestAdmittedList') {
          return {
            topic,
            blockHeight,
            blockHash: hashAt(blockHeight),
            admitted: [{ txid: txidAt(blockHeight), blockIndex: 0 }]
          }
        }
        if (path === '/requestCompoundMerklePath') {
          return {
            topic,
            blockHeight,
            txids,
            merklePath: new MerklePath(blockHeight, [
              [{ offset: 0, hash: txidAt(blockHeight), txid: true }]
            ]).toHex()
          }
        }
        return {
          transactions: txids.map(txid => ({ txid, rawTx: rawByTxid.get(txid) })),
          missing: []
        }
      }
    })
    const [report] = await h.engine.startBASMSync()
    expect(report.status).toBe('advanced')
    expect(report.checkedHeights).toEqual([100, 101])
    expect(report.fetchedTxCount).toBe(2)
    // Height 100 could only be checked against encoded offsets, so the report
    // must not claim the stronger canonical-count assurance of height 101.
    expect(report.positionValidation).toBe('encoded-offset-only')
    expect(
      h.submit.mock.calls.map(([tagged]) => Transaction.fromBEEF(tagged.beef).id('hex'))
    ).toEqual(ids)
  })
})
