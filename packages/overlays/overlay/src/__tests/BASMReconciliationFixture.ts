import { createHash } from 'node:crypto'
import { LockingScript, MerklePath, Transaction } from '@bsv/sdk'
import { Engine } from '../Engine'
import { BASM_ZERO_HASH, computeBasmRoot, computeTac } from '../BASM'
import type { AdmittedTxRef, TopicAnchorTip, TopicBlockAnchor } from '../BASM'
import type { Storage } from '../storage/Storage'

export const topic = 'tm_basm_test'
export const blockHeight = 100
export const blockHash = 'ab'.repeat(32)

export const hashPair = (left: string, right: string): string => {
  const bytes = Buffer.concat([
    Buffer.from(left, 'hex').reverse(),
    Buffer.from(right, 'hex').reverse()
  ])
  const first = createHash('sha256').update(bytes).digest()
  return createHash('sha256').update(first).digest().reverse().toString('hex')
}

export function fixture() {
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
    findTopicAnchorTip: jest.fn(async (): Promise<TopicAnchorTip | undefined> => undefined),
    findTopicBlockAnchor: jest.fn(async (): Promise<TopicBlockAnchor | undefined> => undefined),
    findAdmittedTransactionsForBlock: jest.fn(async (): Promise<AdmittedTxRef[]> => [])
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
  const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = new URL(String(url)).pathname
    requests.push({
      path: endpoint,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>
    })
    return new Response(JSON.stringify(responses[endpoint]), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  })
  ;(engine as unknown as { basmFetchImpl: typeof fetch }).basmFetchImpl = fetchMock
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

export type BASMFixture = ReturnType<typeof fixture>
