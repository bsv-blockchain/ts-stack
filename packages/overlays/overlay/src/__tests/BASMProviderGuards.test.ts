import { MerklePath, Transaction } from '@bsv/sdk'
import { Engine } from '../Engine'
import type { Storage } from '../storage/Storage'

const topic = 'tm_basm_guards'
const txid = 'ab'.repeat(32)
const blockHash = '11'.repeat(32)
const zeroHash = '00'.repeat(32)

/** A storage backend that implements none of the optional BASM read methods. */
const engineWithout = (methods: Record<string, unknown> = {}): Engine =>
  new Engine({ [topic]: {} as never }, {}, methods as unknown as Storage, 'scripts only')

const expectUnsupported = async (operation: Promise<unknown>, message: string): Promise<void> => {
  await expect(operation).rejects.toThrow(TypeError)
  await expect(operation).rejects.toThrow(message)
  await expect(operation).rejects.toMatchObject({ code: 'BASM_UNSUPPORTED' })
}

describe('BASM provider capability guards', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('refuses to serve a topic anchor tip without findTopicAnchorTip', async () => {
    await expectUnsupported(
      engineWithout().provideTopicAnchorTip(topic),
      'Storage does not support BASM topic anchor tips'
    )
  })

  it('refuses to serve a topic anchor range without findTopicBlockAnchors', async () => {
    await expectUnsupported(
      engineWithout().provideTopicAnchorRange(topic, 0, 0),
      'Storage does not support BASM topic anchor ranges'
    )
  })

  it('refuses to serve an admitted list without findAdmittedTransactionsForBlock', async () => {
    await expectUnsupported(
      engineWithout().provideAdmittedList(topic, 100),
      'Storage does not support BASM admitted lists'
    )
  })

  it('refuses to serve a compound Merkle path without findTransactionMerklePaths', async () => {
    await expectUnsupported(
      engineWithout().provideCompoundMerklePath(topic, 100, [txid]),
      'Storage does not support direct Merkle path lookup'
    )
  })

  it('refuses to serve raw transactions without findRawTransactions', async () => {
    await expectUnsupported(
      engineWithout().provideRawTransactions([txid]),
      'Storage does not support raw transaction lookup'
    )
  })

  it('checks capability before the empty-txid guard on compound Merkle paths', async () => {
    // Order matters: an unsupported backend must report BASM_UNSUPPORTED rather
    // than the argument-shape error a caller could mistake for a bad request.
    await expectUnsupported(
      engineWithout().provideCompoundMerklePath(topic, 100, []),
      'Storage does not support direct Merkle path lookup'
    )
  })

  it('still serves a tip and a range once the backend supports them', async () => {
    const engine = engineWithout({
      findTopicAnchorTip: jest.fn(async () => undefined),
      findTopicBlockAnchors: jest.fn(async () => [])
    })
    await expect(engine.provideTopicAnchorTip(topic)).resolves.toEqual({
      topic,
      blockHeight: -1,
      tac: '00'.repeat(32)
    })
    await expect(engine.provideTopicAnchorRange(topic, 5, 7)).resolves.toEqual({
      topic,
      anchors: []
    })
  })

  it.each([
    ['a non-object tip', null, 'invalid'],
    [
      'a cross-topic tip',
      {
        topic: 'tm_other',
        blockHeight: 1,
        blockHash,
        basmRoot: zeroHash,
        admittedCount: 0,
        tac: zeroHash
      },
      'requested topic'
    ],
    [
      'a height below the empty sentinel',
      { topic, blockHeight: -2, blockHash, basmRoot: zeroHash, admittedCount: 0, tac: zeroHash },
      'height is invalid'
    ],
    [
      'an excessive admitted count',
      {
        topic,
        blockHeight: 1,
        blockHash,
        basmRoot: zeroHash,
        admittedCount: 100_001,
        tac: zeroHash
      },
      'admitted count is too large'
    ]
  ])('rejects storage returning %s', async (_label, tip, message) => {
    const engine = engineWithout({ findTopicAnchorTip: jest.fn(async () => tip) })
    await expect(engine.provideTopicAnchorTip(topic)).rejects.toThrow(message as string)
  })

  it.each([
    [-1, 0, 'Invalid topic anchor range'],
    [2, 1, 'Invalid topic anchor range'],
    [0, 1024, 'capped at 1024 heights']
  ])('rejects unsafe anchor range %s..%s before storage', async (from, to, message) => {
    const findTopicBlockAnchors = jest.fn()
    const engine = engineWithout({ findTopicBlockAnchors })

    await expect(engine.provideTopicAnchorRange(topic, from, to)).rejects.toThrow(message)
    expect(findTopicBlockAnchors).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-array result', null, 'invalid or oversized'],
    [
      'a cross-topic anchor',
      [
        {
          topic: 'tm_other',
          blockHeight: 5,
          blockHash,
          basmRoot: zeroHash,
          admittedCount: 0,
          tac: zeroHash
        }
      ],
      'requested topic'
    ],
    [
      'an out-of-range anchor',
      [{ topic, blockHeight: 4, blockHash, basmRoot: zeroHash, admittedCount: 0, tac: zeroHash }],
      'unbound or unordered'
    ],
    [
      'duplicate heights',
      [
        { topic, blockHeight: 5, blockHash, basmRoot: zeroHash, admittedCount: 0, tac: zeroHash },
        { topic, blockHeight: 5, blockHash, basmRoot: zeroHash, admittedCount: 0, tac: zeroHash }
      ],
      'unbound or unordered'
    ]
  ])('rejects an anchor range with %s', async (_label, anchors, message) => {
    const engine = engineWithout({ findTopicBlockAnchors: jest.fn(async () => anchors) })
    await expect(engine.provideTopicAnchorRange(topic, 5, 6)).rejects.toThrow(message as string)
  })

  it.each([
    ['a non-array list', null, 'invalid or oversized'],
    ['a non-object admission', [null], 'Invalid BASM admission'],
    ['an invalid txid', [{ txid: 'bad', blockIndex: 0 }], '32 bytes of hex'],
    [
      'duplicate txids',
      [
        { txid, blockIndex: 0 },
        { txid: txid.toUpperCase(), blockIndex: 1 }
      ],
      'duplicate BASM admissions'
    ],
    [
      'duplicate block indexes',
      [
        { txid, blockIndex: 0 },
        { txid: 'cd'.repeat(32), blockIndex: 0 }
      ],
      'duplicate BASM block indexes'
    ]
  ])('rejects an admitted list with %s', async (_label, admitted, message) => {
    const engine = engineWithout({
      findAdmittedTransactionsForBlock: jest.fn(async () => admitted)
    })
    await expect(engine.provideAdmittedList(topic, 12, blockHash)).rejects.toThrow(
      message as string
    )
  })

  it('serves a request-bound ordered admitted list with the storage safety limit', async () => {
    const findAdmittedTransactionsForBlock = jest.fn(async () => [
      { txid, blockIndex: 0 },
      { txid: 'cd'.repeat(32), blockIndex: 1 }
    ])
    const engine = engineWithout({ findAdmittedTransactionsForBlock })

    await expect(engine.provideAdmittedList(topic, 12, blockHash)).resolves.toEqual({
      topic,
      blockHeight: 12,
      blockHash,
      admitted: [
        { txid, blockIndex: 0 },
        { txid: 'cd'.repeat(32), blockIndex: 1 }
      ]
    })
    expect(findAdmittedTransactionsForBlock).toHaveBeenCalledWith(topic, 12, blockHash, 100_001)
  })

  it('binds compound proof requests to the admitted transaction set', async () => {
    const engine = engineWithout({
      findAdmittedTransactionsForBlock: jest.fn(async () => [
        { txid: 'cd'.repeat(32), blockIndex: 0 }
      ]),
      findTransactionMerklePaths: jest.fn()
    })

    await expect(engine.provideCompoundMerklePath(topic, 12, [txid])).rejects.toThrow(
      'not admitted to topic'
    )
  })

  it.each([
    ['a non-array proof set', null, 'invalid BASM proof set'],
    [
      'an unexpected proof',
      [{ txid: 'cd'.repeat(32), merklePath: '00' }],
      'unexpected or duplicate BASM proof'
    ],
    ['a missing proof', [], 'No direct Merkle path found']
  ])('rejects %s', async (_label, proofs, message) => {
    const engine = engineWithout({ findTransactionMerklePaths: jest.fn(async () => proofs) })
    await expect(engine.provideCompoundMerklePath(topic, 12, [txid])).rejects.toThrow(
      message as string
    )
  })

  it('combines exact proof records and rejects proof-height substitution', async () => {
    const firstTxid = txid
    const secondTxid = 'cd'.repeat(32)
    const combine = jest.fn()
    const toHex = jest.fn(() => 'combined-proof')
    jest
      .spyOn(MerklePath, 'fromHex')
      .mockReturnValueOnce({ blockHeight: 12, combine, toHex } as unknown as MerklePath)
      .mockReturnValueOnce({ blockHeight: 12 } as unknown as MerklePath)
    const engine = engineWithout({
      findTransactionMerklePaths: jest.fn(async () => [
        { txid: firstTxid, merklePath: '00' },
        { txid: secondTxid, merklePath: '11' }
      ])
    })

    await expect(
      engine.provideCompoundMerklePath(topic, 12, [firstTxid, secondTxid])
    ).resolves.toEqual({
      topic,
      blockHeight: 12,
      txids: [firstTxid, secondTxid],
      merklePath: 'combined-proof'
    })
    expect(combine).toHaveBeenCalledTimes(1)

    jest.spyOn(MerklePath, 'fromHex').mockReturnValue({ blockHeight: 13 } as MerklePath)
    const wrongHeight = engineWithout({
      findTransactionMerklePaths: jest.fn(async () => [{ txid, merklePath: '00' }])
    })
    await expect(wrongHeight.provideCompoundMerklePath(topic, 12, [txid])).rejects.toThrow(
      'expected 12'
    )
  })

  it('requires an authorized topic and validates storage authorization verdicts', async () => {
    const findRawTransactions = jest.fn()
    const engine = engineWithout({ findRawTransactions, doesAppliedTransactionExist: jest.fn() })
    await expect(engine.provideRawTransactions([txid])).rejects.toThrow('topic is required')
    expect(findRawTransactions).not.toHaveBeenCalled()

    const invalidVerdict = engineWithout({
      findRawTransactions,
      doesAppliedTransactionExist: jest.fn(async () => ({ authorized: true }))
    })
    await expect(invalidVerdict.provideRawTransactions([txid], topic)).rejects.toThrow(
      'invalid BASM authorization verdict'
    )
  })

  it('returns only authorized, transaction-bound raw records and accounts for missing txids', async () => {
    const rawTx = '01000000000000000000'
    const actualTxid = Transaction.fromHex(rawTx).id('hex')
    const unauthorized = 'cd'.repeat(32)
    const doesAppliedTransactionExist = jest.fn(
      async ({ txid: candidate }: { txid: string }) => candidate === actualTxid
    )
    const findRawTransactions = jest.fn(async () => [{ txid: actualTxid, rawTx }])
    const engine = engineWithout({ doesAppliedTransactionExist, findRawTransactions })

    await expect(engine.provideRawTransactions([actualTxid, unauthorized], topic)).resolves.toEqual(
      {
        transactions: [{ txid: actualTxid, rawTx }],
        missing: [unauthorized]
      }
    )
    expect(findRawTransactions).toHaveBeenCalledWith([actualTxid])
  })

  it.each([
    ['a non-array raw set', null, 'invalid BASM raw-transaction set'],
    [
      'an unexpected raw transaction',
      [{ txid: 'cd'.repeat(32), rawTx: '01000000000000000000' }],
      'does not match its txid'
    ]
  ])('rejects storage returning %s', async (_label, transactions, message) => {
    const engine = engineWithout({
      doesAppliedTransactionExist: jest.fn(async () => true),
      findRawTransactions: jest.fn(async () => transactions)
    })
    await expect(engine.provideRawTransactions([txid], topic)).rejects.toThrow(message as string)
  })
})
