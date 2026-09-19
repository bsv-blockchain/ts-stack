import { MerklePath } from '@bsv/sdk'
import { BASM_ZERO_HASH, computeTac } from '../BASM'
import type { TopicBlockAnchor } from '../BASM'
import { blockHash, blockHeight, fixture, hashPair, topic } from './BASMReconciliationFixture'
import type { BASMFixture } from './BASMReconciliationFixture'

afterEach(() => jest.restoreAllMocks())

/**
 * Re-points the fake peer at a single-block anchor whose admitted list is
 * proven by `path`, and tells the chain tracker which root is canonical.
 */
function serveBlock(
  f: BASMFixture,
  options: {
    admitted: Array<{ txid: string; blockIndex: number }>
    basmRoot: string
    path: MerklePath
    merkleRoot: string
    rawTxIndexes: number[]
    blockTransactionCount?: number
  }
): TopicBlockAnchor {
  const anchor: TopicBlockAnchor = {
    topic,
    blockHeight,
    blockHash,
    basmRoot: options.basmRoot,
    admittedCount: options.admitted.length,
    tac: computeTac(BASM_ZERO_HASH, blockHash, options.basmRoot)
  }
  f.responses['/requestTopicAnchorTip'] = anchor
  f.responses['/requestTopicAnchorRange'] = { topic, anchors: [anchor] }
  f.responses['/requestAdmittedList'] = {
    topic,
    blockHeight,
    blockHash,
    admitted: options.admitted
  }
  f.responses['/requestCompoundMerklePath'] = {
    topic,
    blockHeight,
    txids: options.admitted.map(item => item.txid),
    merklePath: options.path.toHex()
  }
  f.responses['/requestRawTransactions'] = {
    transactions: options.rawTxIndexes.map(index => ({
      txid: f.ids[index],
      rawTx: f.transactions[index].toHex()
    })),
    missing: []
  }
  f.tracker.isValidRootForHeight.mockImplementation(
    async (candidate: string, height: number) =>
      candidate === options.merkleRoot && height === blockHeight
  )
  f.engine.topicAnchorHeaderResolver = async height => ({
    blockHeight: height,
    blockHash,
    merkleRoot: options.merkleRoot,
    blockTransactionCount: options.blockTransactionCount
  })
  return anchor
}

/** A three-transaction block: offset 3 is the phantom duplicate of offset 2. */
function oddWidthBlock(f: BASMFixture): { path: MerklePath; merkleRoot: string } {
  return {
    path: new MerklePath(blockHeight, [
      [
        { offset: 2, hash: f.ids[2], txid: true },
        { offset: 3, duplicate: true }
      ],
      [{ offset: 0, hash: hashPair(f.ids[0], f.ids[1]) }]
    ]),
    merkleRoot: hashPair(hashPair(f.ids[0], f.ids[1]), hashPair(f.ids[2], f.ids[2]))
  }
}

describe('BASM canonical proof position validation', () => {
  it('accepts a duplicate node at the right edge of an odd-width block', async () => {
    const f = fixture()
    const block = oddWidthBlock(f)
    serveBlock(f, {
      admitted: [{ txid: f.ids[2], blockIndex: 2 }],
      basmRoot: f.ids[2],
      path: block.path,
      merkleRoot: block.merkleRoot,
      rawTxIndexes: [2],
      blockTransactionCount: 3
    })
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('advanced')
    expect(report.fetchedTxCount).toBe(1)
    expect(report.positionValidation).toBe('canonical-count')
    expect(f.submit).toHaveBeenCalledTimes(1)
    expect(f.tracker.isValidRootForHeight).toHaveBeenCalledWith(block.merkleRoot, blockHeight)
  })

  it('rejects the same duplicate node when the canonical block width is even', async () => {
    const f = fixture()
    const block = oddWidthBlock(f)
    serveBlock(f, {
      admitted: [{ txid: f.ids[2], blockIndex: 2 }],
      basmRoot: f.ids[2],
      path: block.path,
      merkleRoot: block.merkleRoot,
      rawTxIndexes: [2],
      // Four transactions leaves no odd right edge, so offset 3 is a real
      // position the peer would have to prove rather than duplicate.
      blockTransactionCount: 4
    })
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.errorCode).toBe('BASM_INVALID_RESPONSE')
    expect(report.message).toBe('BASM proof node is outside canonical block positions')
    expect(f.requests.some(request => request.path === '/requestRawTransactions')).toBe(false)
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('rejects a compound path that silently omits one admitted transaction', async () => {
    const f = fixture()
    // Claims both txids in its response envelope, but the BUMP only carries a
    // leaf for the first one.
    f.responses['/requestCompoundMerklePath'] = {
      topic,
      blockHeight,
      txids: f.admitted.map(item => item.txid),
      merklePath: new MerklePath(blockHeight, [
        [
          { offset: 0, hash: f.ids[0] },
          { offset: 1, hash: f.ids[1], txid: true }
        ],
        [{ offset: 1, hash: hashPair(f.ids[2], f.ids[3]) }]
      ]).toHex()
    }
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.errorCode).toBe('BASM_INVALID_RESPONSE')
    expect(report.message).toBe('BASM proof does not bind the admitted block index')
    expect(f.requests.some(request => request.path === '/requestRawTransactions')).toBe(false)
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('rejects a well-formed proof whose root is not canonical for the height', async () => {
    const f = fixture()
    f.tracker.isValidRootForHeight.mockResolvedValue(false)
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.errorCode).toBeUndefined()
    expect(report.message).toBe(
      `Peer supplied invalid compound Merkle path at height ${blockHeight}`
    )
    expect(f.tracker.isValidRootForHeight).toHaveBeenCalledWith(f.root, blockHeight)
    expect(f.requests.some(request => request.path === '/requestRawTransactions')).toBe(false)
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('records canonical-count assurance even when nothing needs fetching', async () => {
    const f = fixture()
    f.storage.findAdmittedTransactionsForBlock.mockResolvedValue([...f.admitted])
    f.engine.topicAnchorHeaderResolver = async height => ({
      blockHeight: height,
      blockHash,
      merkleRoot: f.root,
      blockTransactionCount: 4
    })
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('diverged')
    expect(report.positionValidation).toBe('canonical-count')
    expect(report.missingTxids).toEqual([])
    expect(f.requests.some(request => request.path === '/requestCompoundMerklePath')).toBe(true)
    expect(f.requests.some(request => request.path === '/requestRawTransactions')).toBe(false)
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('refuses to admit when the anchor disappears from the peer before admission', async () => {
    const f = fixture()
    const originalFetch = f.fetchMock.getMockImplementation()!
    f.fetchMock.mockImplementation(async (url, init) => {
      const response = await originalFetch(url, init)
      if (new URL(String(url)).pathname === '/requestRawTransactions') {
        f.responses['/requestTopicAnchorRange'] = { topic, anchors: [] }
      }
      return response
    })
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.errorCode).toBe('BASM_INVALID_RESPONSE')
    expect(report.message).toBe('BASM peer anchor changed before admission')
    expect(f.submit).not.toHaveBeenCalled()
  })
})
