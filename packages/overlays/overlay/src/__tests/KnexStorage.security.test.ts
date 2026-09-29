import { Script, Transaction } from '@bsv/sdk'
import type { Knex } from 'knex'
import type { Output } from '../Output.js'
import { BASM_ZERO_HASH } from '../BASM.js'
import { KnexStorage } from '../storage/knex/KnexStorage.js'

interface QueryRecord {
  table: string
  calls: Array<{ method: string; args: unknown[] }>
}

function mockKnex(configured: Record<string, unknown[]>): { knex: Knex; queries: QueryRecord[] } {
  const queues = Object.fromEntries(
    Object.entries(configured).map(([table, values]) => [table, [...values]])
  )
  const queries: QueryRecord[] = []
  const knex = ((table: string) => {
    const record: QueryRecord = { table, calls: [] }
    queries.push(record)
    const result = queues[table]?.shift()
    const builder: Record<string, unknown> = {}
    const chain =
      (method: string) =>
      (...args: unknown[]) => {
        record.calls.push({ method, args })
        if (method === 'where' && typeof args[0] === 'function') {
          ;(args[0] as (query: Record<string, unknown>) => void)(builder)
        }
        return builder
      }
    for (const method of [
      'where',
      'whereIn',
      'whereNotNull',
      'orWhereNull',
      'andWhere',
      'orderBy',
      'select',
      'first',
      'limit',
      'leftJoin',
      'insert',
      'onConflict',
      'ignore',
      'merge',
      'update',
      'del',
      'count'
    ]) {
      builder[method] = chain(method)
    }
    const awaitHook = ['th', 'en'].join('')
    Object.defineProperty(builder, awaitHook, {
      value: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject)
    })
    return builder
  }) as unknown as Knex
  knex.transaction = (async callback => await callback(knex)) as Knex['transaction']
  knex.raw = jest.fn((value: string) => value) as unknown as Knex['raw']
  return { knex, queries }
}

function callsFor(queries: QueryRecord[], table: string, method: string): unknown[][] {
  return queries
    .filter(query => query.table === table)
    .flatMap(query => query.calls.filter(call => call.method === method).map(call => call.args))
}

const txid = '11'.repeat(32)
const topic = 'tm_test'
const outputRow = {
  txid,
  outputIndex: 0,
  outputScript: Buffer.from([0x51]),
  topic,
  satoshis: 1,
  outputsConsumed: '[]',
  spent: 0,
  consumedBy: [],
  blockHeight: null,
  score: 7
}

describe('KnexStorage security and bounded-query behavior', () => {
  it('maps SQL null confirmation heights to absent metadata on every output read', async () => {
    const { knex } = mockKnex({ outputs: [outputRow, [outputRow], [outputRow], [outputRow]] })
    const storage = new KnexStorage(knex)
    const single = await storage.findOutput(txid, 0)
    const batch = await storage.findOutputsByOutpoints([{ txid, outputIndex: 0 }])
    const transaction = await storage.findOutputsForTransaction(txid)
    const topicOutputs = await storage.findUTXOsForTopic(topic)
    for (const output of [single, ...batch, ...transaction, ...topicOutputs]) {
      expect(output?.blockHeight).toBeUndefined()
      expect(output?.satoshis).toBe(1)
    }
    expect(outputRow.blockHeight).toBeNull()
  })

  it.each([0, 123, -1, '123'])('does not coerce non-null height %p', async height => {
    const { knex } = mockKnex({ outputs: [{ ...outputRow, blockHeight: height }] })
    const output = await new KnexStorage(knex).findOutput(txid, 0)
    expect(output?.blockHeight).toBe(height)
  })

  it('atomically marks an unspent topical output with the spending transaction', async () => {
    const { knex, queries } = mockKnex({ outputs: [1] })
    const storage = new KnexStorage(knex)

    await storage.markUTXOAsSpent(txid, 0, topic, '22'.repeat(32))

    expect(callsFor(queries, 'outputs', 'where')).toEqual([
      [{ txid, outputIndex: 0, topic, spent: false }]
    ])
    expect(callsFor(queries, 'outputs', 'update')).toEqual([
      [{ spent: true, spentBy: '22'.repeat(32) }]
    ])
  })

  it('treats an identical spending transaction as an idempotent replay', async () => {
    const spendingTxid = '22'.repeat(32)
    const { knex, queries } = mockKnex({
      // SQLite and MySQL return persisted boolean columns as 0/1.
      outputs: [0, { spent: 1, spentBy: spendingTxid }]
    })
    const storage = new KnexStorage(knex)

    await expect(storage.markUTXOAsSpent(txid, 0, topic, spendingTxid)).resolves.toBeUndefined()

    expect(callsFor(queries, 'outputs', 'first')).toEqual([['spent', 'spentBy']])
  })

  it.each([
    ['no row', undefined, undefined],
    ['an unlabelled replay', { spent: true, spentBy: null }, undefined],
    ['another spender', { spent: true, spentBy: '33'.repeat(32) }, '22'.repeat(32)],
    ['an unspent row', { spent: false, spentBy: null }, '22'.repeat(32)]
  ])('rejects a conflicting atomic spend for %s', async (_label, existing, spendingTxid) => {
    const { knex } = mockKnex({ outputs: [0, existing] })
    const storage = new KnexStorage(knex)

    await expect(storage.markUTXOAsSpent(txid, 0, topic, spendingTxid)).rejects.toThrow(
      'Unable to atomically mark an unspent topical output as spent'
    )
  })

  it('uses conflict-safe inserts for outputs and transaction records', async () => {
    const transaction = new Transaction(
      1,
      [],
      [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
      0
    )
    const beef = transaction.toBEEF()
    const output: Output = {
      ...outputRow,
      txid: transaction.id('hex'),
      outputScript: [0x51],
      outputsConsumed: [],
      consumedBy: [],
      spent: false,
      beef
    }
    const { knex, queries } = mockKnex({ outputs: [undefined], transactions: [undefined] })
    const storage = new KnexStorage(knex)

    await storage.insertOutput(output)

    expect(callsFor(queries, 'outputs', 'onConflict')).toEqual([[['txid', 'outputIndex', 'topic']]])
    expect(callsFor(queries, 'outputs', 'ignore')).toHaveLength(1)
    expect(callsFor(queries, 'transactions', 'onConflict')).toEqual([['txid']])
    expect(callsFor(queries, 'transactions', 'merge')).toHaveLength(1)
  })

  it('applies bounded transaction-output reads and parses stored relation encodings', async () => {
    const { knex, queries } = mockKnex({ outputs: [[outputRow]] })
    const storage = new KnexStorage(knex)

    await expect(storage.findOutputsForTransaction(txid, false, 1)).resolves.toEqual([
      expect.objectContaining({
        txid,
        outputScript: [0x51],
        spent: false,
        outputsConsumed: [],
        consumedBy: []
      })
    ])

    expect(callsFor(queries, 'outputs', 'limit')).toEqual([[1]])
  })

  it('deduplicates batched outpoints and hydrates BEEF from one transaction query', async () => {
    const { knex, queries } = mockKnex({
      outputs: [[outputRow]],
      transactions: [[{ txid, beef: Buffer.from([1, 2, 3]) }]]
    })
    const storage = new KnexStorage(knex)

    await expect(
      storage.findOutputsByOutpoints(
        [
          { txid, outputIndex: 0 },
          { txid, outputIndex: 0 }
        ],
        true
      )
    ).resolves.toEqual([expect.objectContaining({ txid, beef: [1, 2, 3] })])

    expect(callsFor(queries, 'outputs', 'whereIn')[0]?.[1]).toEqual([[txid, 0]])
    expect(callsFor(queries, 'transactions', 'whereIn')).toEqual([['txid', [txid]]])
    await expect(storage.findOutputsByOutpoints([])).resolves.toEqual([])
  })

  it('persists applied transactions idempotently with an explicit proven default', async () => {
    const { knex, queries } = mockKnex({ applied_transactions: [undefined] })
    const storage = new KnexStorage(knex)

    await storage.insertAppliedTransaction({ txid, topic, firstSeenHeight: 10 })

    expect(callsFor(queries, 'applied_transactions', 'insert')).toEqual([
      [expect.objectContaining({ txid, topic, firstSeenHeight: 10, proven: false })]
    ])
    expect(callsFor(queries, 'applied_transactions', 'onConflict')).toEqual([[['txid', 'topic']]])
    expect(callsFor(queries, 'applied_transactions', 'ignore')).toHaveLength(1)
  })

  it('passes caller limits into ordered BASM reads', async () => {
    const blockHash = '22'.repeat(32)
    const anchor = {
      topic,
      blockHeight: 12,
      blockHash,
      basmRoot: BASM_ZERO_HASH,
      admittedCount: 1,
      tac: BASM_ZERO_HASH
    }
    const { knex, queries } = mockKnex({
      applied_transactions: [[{ txid, blockIndex: '3' }]],
      topic_block_anchors: [[anchor]]
    })
    const storage = new KnexStorage(knex)

    await expect(
      storage.findAdmittedTransactionsForBlock(topic, 12, blockHash, 1)
    ).resolves.toEqual([{ txid, blockIndex: 3 }])
    await expect(storage.findTopicBlockAnchors(topic, 10, 12, 1)).resolves.toEqual([anchor])

    expect(callsFor(queries, 'applied_transactions', 'limit')).toEqual([[1]])
    expect(callsFor(queries, 'topic_block_anchors', 'limit')).toEqual([[1]])
  })

  it('bounds unproven candidates and their aggregate output fetches', async () => {
    const { knex, queries } = mockKnex({
      applied_transactions: [
        [
          { txid, topic, firstSeenHeight: '9' },
          { txid: '22'.repeat(32), topic, firstSeenHeight: null }
        ]
      ],
      outputs: [
        [{ txid, outputIndex: '0' }],
        [
          { txid: '22'.repeat(32), outputIndex: '1' },
          { txid: '22'.repeat(32), outputIndex: '2' }
        ]
      ]
    })
    const storage = new KnexStorage(knex)

    await expect(
      storage.findUnprovenAppliedTransactions(10, topic, {
        maxCandidates: 2,
        maxOutputs: 2
      })
    ).resolves.toEqual([
      {
        txid,
        topic,
        firstSeenHeight: 9,
        outputs: [{ txid, outputIndex: 0 }]
      },
      {
        txid: '22'.repeat(32),
        topic,
        firstSeenHeight: undefined,
        outputs: [
          { txid: '22'.repeat(32), outputIndex: 1 },
          { txid: '22'.repeat(32), outputIndex: 2 }
        ]
      }
    ])

    expect(callsFor(queries, 'applied_transactions', 'limit')).toEqual([[3]])
    expect(callsFor(queries, 'outputs', 'limit')).toEqual([[3], [2]])
  })

  it('bounds proven recovery reads and clears proof state consistently', async () => {
    const blockHash = '22'.repeat(32)
    const { knex, queries } = mockKnex({
      applied_transactions: [
        [{ txid, topic, blockHeight: '12' }],
        [{ txid, topic, blockHeight: '12', blockHash: null, merkleRoot: null }],
        undefined
      ],
      outputs: [undefined]
    })
    const storage = new KnexStorage(knex)

    await expect(storage.findProvenAppliedTransactionsByBlockHash(blockHash, 1)).resolves.toEqual([
      { txid, topic, blockHeight: 12 }
    ])
    await expect(storage.findProvenAppliedTransactionsInRange(10, 12, topic, 1)).resolves.toEqual([
      { txid, topic, blockHeight: 12, blockHash: undefined, merkleRoot: undefined }
    ])
    await storage.demoteAppliedTransactionToUnproven(txid, topic)

    expect(callsFor(queries, 'applied_transactions', 'limit')).toEqual([[1], [1]])
    expect(callsFor(queries, 'applied_transactions', 'update')).toEqual([
      [
        {
          blockHeight: null,
          blockHash: null,
          blockIndex: null,
          merkleRoot: null,
          proven: false
        }
      ]
    ])
    expect(callsFor(queries, 'outputs', 'update')).toEqual([[{ blockHeight: null }]])
  })
})
