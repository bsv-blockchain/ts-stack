import { createHash } from 'node:crypto'
import { LockingScript, MerklePath, Transaction } from '@bsv/sdk'
import { Engine } from '../Engine'
import { BASM_ZERO_HASH, computeBasmRoot, computeTac } from '../BASM'
import type { TopicBlockAnchor } from '../BASM'
import type { Storage } from '../storage/Storage'

const topic = 'tm_basm_test'
const blockHeight = 100
const blockHash = 'ab'.repeat(32)
const hashPair = (left: string, right: string): string => {
  const bytes = Buffer.concat([
    Buffer.from(left, 'hex').reverse(),
    Buffer.from(right, 'hex').reverse()
  ])
  const first = createHash('sha256').update(bytes).digest()
  return createHash('sha256').update(first).digest().reverse().toString('hex')
}

function fixture() {
  const transactions = [1, 2, 3, 4].map(
    satoshis =>
      new Transaction(1, [], [{ satoshis, lockingScript: LockingScript.fromASM('OP_TRUE') }], 0)
  )
  const ids = transactions.map(tx => tx.id('hex'))
  const root = hashPair(hashPair(ids[0], ids[1]), hashPair(ids[2], ids[3]))
  const path = new MerklePath(blockHeight, [
    ids.map((hash, offset) => ({ offset, hash, txid: true })),
    []
  ])
  const admitted = [
    { txid: ids[1], blockIndex: 1 },
    { txid: ids[3], blockIndex: 3 }
  ]
  const anchor: TopicBlockAnchor = {
    topic,
    blockHeight,
    blockHash,
    basmRoot: computeBasmRoot(admitted),
    admittedCount: 2,
    tac: ''
  }
  anchor.tac = computeTac(BASM_ZERO_HASH, blockHash, anchor.basmRoot)
  const responses: Record<string, unknown> = {
    '/requestTopicAnchorTip': anchor,
    '/requestTopicAnchorRange': { topic, anchors: [anchor] },
    '/requestAdmittedList': { topic, blockHeight, blockHash, admitted },
    '/requestCompoundMerklePath': {
      topic,
      blockHeight,
      txids: admitted.map(item => item.txid),
      merklePath: path.toHex()
    },
    '/requestRawTransactions': {
      // Deliberately reversed: admission must still follow original block order.
      transactions: [3, 1].map(index => ({ txid: ids[index], rawTx: transactions[index].toHex() })),
      missing: []
    }
  }
  const storage = {
    findTopicAnchorTip: jest.fn(async () => undefined),
    findTopicBlockAnchor: jest.fn(async () => undefined),
    findAdmittedTransactionsForBlock: jest.fn(async () => [])
  }
  const tracker = {
    currentHeight: jest.fn(async () => 250),
    isValidRootForHeight: jest.fn(
      async (candidate: string, height: number) => candidate === root && height === blockHeight
    )
  }
  const engine = new Engine({}, {}, storage as unknown as Storage, tracker)
  engine.syncConfiguration = { [topic]: ['https://peer.example'] }
  engine.topicAnchorHeaderResolver = jest.fn(async height => ({
    blockHeight: height,
    blockHash,
    merkleRoot: root
  }))
  engine.logger = { ...console, error: jest.fn() }
  const submit = jest.spyOn(engine, 'submit').mockResolvedValue({})
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const endpoint = new URL(String(url)).pathname
    requests.push({
      path: endpoint,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>
    })
    return new Response(JSON.stringify(responses[endpoint]), { status: 200 })
  })
  return {
    engine,
    responses,
    anchor,
    admitted,
    transactions,
    ids,
    path,
    root,
    submit,
    storage,
    tracker,
    requests,
    fetchMock
  }
}

afterEach(() => jest.restoreAllMocks())

describe('BASM reconciliation evidence binding', () => {
  it('verifies a multi-level subset with original index gaps and submits historically in block order', async () => {
    const f = fixture()
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('advanced')
    expect(report.fetchedTxCount).toBe(2)
    expect(report.positionValidation).toBe('encoded-offset-only')
    expect(f.submit).toHaveBeenCalledTimes(2)
    expect(
      f.submit.mock.calls.map(([tagged]) => Transaction.fromBEEF(tagged.beef).id('hex'))
    ).toEqual([f.ids[1], f.ids[3]])
    for (const [, callback, mode] of f.submit.mock.calls) {
      expect(callback).toBeUndefined()
      expect(mode).toBe('historical-tx')
    }
    expect(f.tracker.isValidRootForHeight).toHaveBeenCalledTimes(1)
    expect(f.tracker.isValidRootForHeight).toHaveBeenCalledWith(f.root, blockHeight)
  })

  it('reports stronger position validation only when a trusted count is bound to the canonical header', async () => {
    const f = fixture()
    f.engine.topicAnchorHeaderResolver = async height => ({
      blockHeight: height,
      blockHash,
      blockTransactionCount: 4
    })
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('advanced')
    expect(report.positionValidation).toBe('canonical-count')
    expect(f.submit).toHaveBeenCalledTimes(2)
  })

  it.each([0, -1, 1, 1.5, 3, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'rejects inconsistent canonical full-block count %s',
    async blockTransactionCount => {
      const f = fixture()
      f.engine.topicAnchorHeaderResolver = async height => ({
        blockHeight: height,
        blockHash,
        blockTransactionCount
      })
      const [report] = await f.engine.startBASMSync()
      expect(report.status).toBe('error')
      expect(f.submit).not.toHaveBeenCalled()
    }
  )

  it('rejects an admitted phantom duplicate at the right edge of an odd-width block', async () => {
    const f = fixture()
    const duplicated = [f.ids[0], f.ids[1], f.ids[2], f.ids[2]]
    const root = hashPair(
      hashPair(duplicated[0], duplicated[1]),
      hashPair(duplicated[2], duplicated[3])
    )
    const proof = new MerklePath(blockHeight, [
      duplicated.map((hash, offset) => ({ hash, offset, txid: true })),
      []
    ])
    const admitted = [{ txid: f.ids[2], blockIndex: 3 }]
    const anchor = {
      ...f.anchor,
      basmRoot: f.ids[2],
      admittedCount: 1,
      tac: computeTac(BASM_ZERO_HASH, blockHash, f.ids[2])
    }
    f.responses['/requestTopicAnchorTip'] = anchor
    f.responses['/requestTopicAnchorRange'] = { topic, anchors: [anchor] }
    f.responses['/requestAdmittedList'] = { topic, blockHeight, blockHash, admitted }
    f.responses['/requestCompoundMerklePath'] = {
      topic,
      blockHeight,
      txids: [f.ids[2]],
      merklePath: proof.toHex()
    }
    f.engine.topicAnchorHeaderResolver = async height => ({
      blockHeight: height,
      blockHash,
      merkleRoot: root,
      blockTransactionCount: 3
    })
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.message).toContain('canonical block transaction count')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it.each([
    'block hash',
    'header height',
    'header unavailable',
    'header root',
    'proof height',
    'proof index',
    'raw identity',
    'raw trailing bytes',
    'range TAC',
    'range gap'
  ])('rejects invalid %s before admission', async failure => {
    const f = fixture()
    switch (failure) {
      case 'block hash':
        f.engine.topicAnchorHeaderResolver = async height => ({
          blockHeight: height,
          blockHash: 'cd'.repeat(32)
        })
        break
      case 'header height':
        f.engine.topicAnchorHeaderResolver = async height => ({
          blockHeight: height + 1,
          blockHash
        })
        break
      case 'header unavailable':
        f.engine.topicAnchorHeaderResolver = async () => undefined
        break
      case 'header root':
        f.engine.topicAnchorHeaderResolver = async height => ({
          blockHeight: height,
          blockHash,
          merkleRoot: BASM_ZERO_HASH
        })
        break
      case 'proof height':
        f.path.blockHeight += 1
        f.responses['/requestCompoundMerklePath'] = {
          topic,
          blockHeight,
          txids: f.admitted.map(item => item.txid),
          merklePath: f.path.toHex()
        }
        break
      case 'proof index':
        f.admitted[0].blockIndex = 0
        break
      case 'raw identity':
      case 'raw trailing bytes':
        f.responses['/requestRawTransactions'] = {
          transactions: f.admitted.map((item, i) => ({
            txid: item.txid,
            rawTx:
              f.transactions[failure === 'raw identity' ? 0 : i * 2 + 1].toHex() +
              (failure === 'raw trailing bytes' ? '00' : '')
          })),
          missing: []
        }
        break
      case 'range TAC':
        f.anchor.tac = 'cd'.repeat(32)
        break
      case 'range gap':
        f.responses['/requestTopicAnchorRange'] = { topic, anchors: [] }
        break
    }
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('requires canonical header capability even for equal-height matching tips', async () => {
    const f = fixture()
    jest.spyOn(f.engine, 'provideTopicAnchorTip').mockResolvedValue(f.anchor)
    f.engine.topicAnchorHeaderResolver = undefined
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.message).toContain('canonical header resolver')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('detects a peer anchor changing while raw transactions are fetched', async () => {
    const f = fixture()
    const originalFetch = f.fetchMock.getMockImplementation()!
    f.fetchMock.mockImplementation(async (url, init) => {
      const response = await originalFetch(url, init)
      if (new URL(String(url)).pathname === '/requestRawTransactions') {
        f.responses['/requestTopicAnchorRange'] = {
          topic,
          anchors: [{ ...f.anchor, tac: 'ef'.repeat(32) }]
        }
      }
      return response
    })
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.message).toContain('changed before admission')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('starts the next forward page immediately after the local tip when remote is over a page ahead', async () => {
    const f = fixture()
    jest
      .spyOn(f.engine, 'provideTopicAnchorTip')
      .mockResolvedValue({ topic, blockHeight: 1, tac: BASM_ZERO_HASH })
    f.anchor.blockHeight = 3000
    await f.engine.startBASMSync()
    const ranges = f.requests.filter(request => request.path === '/requestTopicAnchorRange')
    expect(ranges.map(request => request.body)).toEqual([
      { fromHeight: 3000, toHeight: 3000 },
      { fromHeight: 2, toHeight: 1001 }
    ])
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('refuses an old-topic bootstrap tail without a trusted TAC prefix (B02 continuation required)', async () => {
    const f = fixture()
    const anchors: TopicBlockAnchor[] = []
    let tac = BASM_ZERO_HASH
    for (let height = 100; height <= 1100; height++) {
      const basmRoot = height === 100 ? f.anchor.basmRoot : BASM_ZERO_HASH
      tac = computeTac(tac, blockHash, basmRoot)
      anchors.push({
        topic,
        blockHeight: height,
        blockHash,
        basmRoot,
        admittedCount: height === 100 ? 2 : 0,
        tac
      })
    }
    f.fetchMock.mockImplementation(async (url, init) => {
      const endpoint = new URL(String(url)).pathname
      if (endpoint === '/requestTopicAnchorTip') return Response.json(anchors.at(-1))
      const body = JSON.parse(String(init?.body)) as { fromHeight: number; toHeight: number }
      return Response.json({
        topic,
        anchors: anchors.filter(
          anchor => anchor.blockHeight >= body.fromHeight && anchor.blockHeight <= body.toHeight
        )
      })
    })
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.message).toContain('TAC is inconsistent with its prefix')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('binds claimed indices to the compound path when every remote txid is already local', async () => {
    const f = fixture()
    f.storage.findAdmittedTransactionsForBlock.mockResolvedValue([...f.admitted])
    f.admitted[0].blockIndex = 0
    f.admitted[1].blockIndex = 2
    f.anchor.basmRoot = computeBasmRoot(f.admitted)
    f.anchor.tac = computeTac(BASM_ZERO_HASH, blockHash, f.anchor.basmRoot)
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.message).toContain('admitted block index')
    expect(f.requests.some(request => request.path === '/requestCompoundMerklePath')).toBe(true)
    expect(f.requests.some(request => request.path === '/requestRawTransactions')).toBe(false)
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('still requests a compound path before reporting local-superset divergence', async () => {
    const f = fixture()
    f.storage.findAdmittedTransactionsForBlock.mockResolvedValue([...f.admitted])
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('diverged')
    expect(report.positionValidation).toBe('encoded-offset-only')
    expect(f.requests.some(request => request.path === '/requestCompoundMerklePath')).toBe(true)
    expect(f.requests.some(request => request.path === '/requestRawTransactions')).toBe(false)
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('accepts an admitted coinbase in a block younger than 100 confirmations', async () => {
    const f = fixture()
    const coinbase = new Transaction(
      1,
      [],
      [{ satoshis: 50, lockingScript: LockingScript.fromASM('OP_TRUE') }],
      0
    )
    const txid = coinbase.id('hex')
    const path = new MerklePath(blockHeight, [[{ offset: 0, hash: txid, txid: true }]])
    const admitted = [{ txid, blockIndex: 0 }]
    const anchor: TopicBlockAnchor = {
      topic,
      blockHeight,
      blockHash,
      basmRoot: txid,
      admittedCount: 1,
      tac: computeTac(BASM_ZERO_HASH, blockHash, txid)
    }
    f.tracker.currentHeight.mockResolvedValue(blockHeight + 50)
    f.tracker.isValidRootForHeight.mockImplementation(
      async (candidate: string, height: number) => candidate === txid && height === blockHeight
    )
    f.engine.topicAnchorHeaderResolver = jest.fn(async height => ({
      blockHeight: height,
      blockHash,
      merkleRoot: txid
    }))
    f.responses['/requestTopicAnchorTip'] = anchor
    f.responses['/requestTopicAnchorRange'] = { topic, anchors: [anchor] }
    f.responses['/requestAdmittedList'] = { topic, blockHeight, blockHash, admitted }
    f.responses['/requestCompoundMerklePath'] = {
      topic,
      blockHeight,
      txids: [txid],
      merklePath: path.toHex()
    }
    f.responses['/requestRawTransactions'] = {
      transactions: [{ txid, rawTx: coinbase.toHex() }],
      missing: []
    }
    const verify = jest.spyOn(MerklePath.prototype, 'verify')
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('advanced')
    expect(report.fetchedTxCount).toBe(1)
    expect(verify).not.toHaveBeenCalled()
    expect(f.tracker.isValidRootForHeight).toHaveBeenCalledWith(txid, blockHeight)
    expect(f.submit).toHaveBeenCalledTimes(1)
    expect(f.tracker.currentHeight).not.toHaveBeenCalled()
  })

  it('reports a finite proof request limit for a block above 1000 admissions (B02 chunking required)', async () => {
    const f = fixture()
    const admitted = Array.from({ length: 1001 }, (_, blockIndex) => ({
      txid: blockIndex.toString(16).padStart(64, '0'),
      blockIndex
    }))
    f.anchor.admittedCount = admitted.length
    f.anchor.basmRoot = computeBasmRoot(admitted)
    f.anchor.tac = computeTac(BASM_ZERO_HASH, blockHash, f.anchor.basmRoot)
    f.responses['/requestAdmittedList'] = { topic, blockHeight, blockHash, admitted }
    const [report] = await f.engine.startBASMSync()
    expect(report.status).toBe('error')
    expect(report.errorCode).toBe('BASM_RESOURCE_LIMIT')
    expect(f.requests.some(request => request.path === '/requestCompoundMerklePath')).toBe(false)
    expect(f.submit).not.toHaveBeenCalled()
  })
})
