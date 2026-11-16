import fc from 'fast-check'
import createKnex from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { prepareBrc38ImportExistingTargets } from './Brc38ImportExistingRows'
import type { Brc38ImportEntityTarget } from './Brc38ImportEntityTargets'
import { brc38ImportTargetIndexes, installBrc38ImportTargetIndexes } from './Brc38ImportTargetIndexes'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026)
})
const controls = {
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
}
type SqlValue = string | number | Buffer | null
type ColumnKind = 'integer' | 'text' | 'binary'
type NativeRow = Record<string, SqlValue>

async function fixture() {
  const db = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: db })
  const definitions = new Map<string, Map<string, ColumnKind>>()
  for (const [table, keys] of Object.values(brc38ImportTargetIndexes)) {
    const columns = definitions.get(table) ?? new Map<string, ColumnKind>()
    for (const key of keys) columns.set(key, key.endsWith('Id') || key === 'vout' ? 'integer' : 'text')
    definitions.set(table, columns)
  }
  const additional: Record<string, Record<string, ColumnKind>> = {
    output_baskets: {
      basketId: 'integer',
      created_at: 'integer',
      updated_at: 'integer',
      isDeleted: 'integer',
      numberOfDesiredUTXOs: 'integer',
      minimumDesiredUTXOValue: 'integer',
      managedChange: 'text'
    },
    proven_txs: {
      provenTxId: 'integer',
      created_at: 'integer',
      updated_at: 'integer',
      rawTx: 'binary'
    },
    proven_tx_reqs: {
      provenTxReqId: 'integer',
      created_at: 'integer',
      updated_at: 'integer',
      rawTx: 'binary',
      status: 'text'
    },
    outputs: {
      outputId: 'integer',
      created_at: 'integer',
      updated_at: 'integer',
      lockingScript: 'binary',
      scriptOffset: 'integer',
      scriptLength: 'integer',
      spendable: 'integer',
      change: 'integer'
    }
  }
  try {
    for (const [table, columns] of Object.entries(additional))
      for (const [name, kind] of Object.entries(columns)) definitions.get(table)!.set(name, kind)
    for (const [table, columns] of definitions) {
      await db.schema.createTable(table, builder => {
        for (const [name, kind] of columns) builder[kind](name)
      })
    }
    await db.transaction(async trx => await installBrc38ImportTargetIndexes(trx))
    function row(table: string, values: NativeRow): NativeRow {
      return {
        ...Object.fromEntries([...definitions.get(table)!.keys()].map(key => [key, null])),
        ...values
      }
    }
    return { db, storage, row, close: async () => await storage.destroy() }
  } catch (cause) {
    await storage.destroy()
    throw cause
  }
}

// Model the documented allocation policy from the native values, without
// evaluating the production SQL expression or loading payloads through it.
function allocation(row: NativeRow): number {
  return Object.values(row).reduce<number>(
    (sum, value) =>
      sum + 256 + 16 * (value === null ? 0 : Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value))),
    0
  )
}
const text = fc.array(fc.constantFrom('a', 'é', '漢', '😀'), { maxLength: 24 }).map(values => values.join(''))

describe('existing import rows respect fixed pre-materialization allocation and ownership', () => {
  test('generated row pairs preserve native identities, dates, tombstones and exact aggregate charges', async () => {
    const target = await fixture()
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 8 }),
          fc.integer({ min: -16, max: 16 }),
          fc.integer({ min: 0, max: 1000000000 }),
          fc.boolean(),
          text,
          async (userId, localId, time, deleted, suffix) => {
            const first = target.row('output_baskets', {
              userId,
              basketId: localId,
              name: 'first-' + suffix,
              created_at: time,
              updated_at: time + 1,
              isDeleted: Number(deleted),
              numberOfDesiredUTXOs: 4,
              minimumDesiredUTXOValue: 32,
              managedChange: null
            })
            const second = { ...first, basketId: localId + 100, name: 'second-' + suffix }
            await target.db('output_baskets').del()
            await target
              .db('output_baskets')
              .insert([first, second, { ...first, userId: userId + 1, basketId: localId + 200 }])
            const targets: Brc38ImportEntityTarget[] = [first, second].map(row => ({
              table: 'outputBaskets',
              index: 'outputBaskets',
              found: true,
              localId: row.basketId as number,
              key: { userId, name: row.name as string }
            }))
            const absent: Brc38ImportEntityTarget = {
              table: 'outputBaskets',
              index: 'outputBaskets',
              found: false,
              key: { userId, name: 'absent-' + suffix }
            }
            const before = JSON.stringify(targets),
              firstBytes = allocation(first),
              total = firstBytes + allocation(second)
            await target.db.transaction(async trx => {
              await trx.raw('PRAGMA query_only=ON')
              const queries: string[] = [],
                original = jest.spyOn(target.storage, 'validateEntity')
              trx.on('query', (value: { sql: string }) => queries.push(value.sql))
              const payloadReads = () => queries.filter(sql => /INDEXED BY/.test(sql) && !/allocationBytes/.test(sql))
              try {
                await expect(
                  prepareBrc38ImportExistingTargets(
                    trx,
                    target.storage,
                    userId,
                    'outputBaskets',
                    targets,
                    firstBytes - 1
                  )
                ).rejects.toThrow('allocation budget')
                expect(original).not.toHaveBeenCalled()
                expect(payloadReads()).toHaveLength(0)
                queries.length = 0
                await expect(
                  prepareBrc38ImportExistingTargets(trx, target.storage, userId, 'outputBaskets', targets, total - 1)
                ).rejects.toThrow('allocation budget')
                expect(original).toHaveBeenCalledTimes(1)
                expect(payloadReads()).toHaveLength(1)
                original.mockClear()
                const prepared = await prepareBrc38ImportExistingTargets(
                  trx,
                  target.storage,
                  userId,
                  'outputBaskets',
                  [...targets, absent],
                  total
                )
                expect(prepared.map(value => value.allocationBytes)).toEqual([firstBytes, allocation(second), 0])
                expect(prepared[2].row).toBeUndefined()
                for (const [index, row] of [first, second].entries()) {
                  expect(prepared[index].row).toEqual({
                    ...row,
                    created_at: new Date(time),
                    updated_at: new Date(time + 1),
                    isDeleted: deleted,
                    managedChange: undefined
                  })
                  expect(Object.isFrozen(prepared[index])).toBe(true)
                  expect(Object.isFrozen(prepared[index].row)).toBe(true)
                }
                expect(Object.isFrozen(prepared)).toBe(true)
                original.mockClear()
                await expect(
                  prepareBrc38ImportExistingTargets(
                    trx,
                    target.storage,
                    userId,
                    'outputBaskets',
                    [{ ...targets[0], key: { ...targets[0].key, userId: userId + 1 } }],
                    total
                  )
                ).rejects.toThrow('prepared indexed identity')
                expect(original).not.toHaveBeenCalled()
                queries.length = 0
                const abort = new AbortController(),
                  reason = new Error('owned preparation cancelled')
                abort.abort(reason)
                await expect(
                  prepareBrc38ImportExistingTargets(
                    trx,
                    target.storage,
                    userId,
                    'outputBaskets',
                    targets,
                    total,
                    abort.signal
                  )
                ).rejects.toBe(reason)
                expect(queries).toHaveLength(0)
                expect(JSON.stringify(targets)).toBe(before)
              } finally {
                original.mockRestore()
                await trx.raw('PRAGMA query_only=OFF')
              }
            })
          }
        ),
        controls
      )
    } finally {
      await target.close()
    }
  }, 30000)

  test('generated proof/request precedence reconstructs only admitted bounded slices and freezes binary values', async () => {
    const target = await fixture()
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 64, maxLength: 96 }),
          fc.integer({ min: 1, max: 16 }),
          fc.integer({ min: 1, max: 16 }),
          fc.constantFrom('absent', 'null', 'bytes'),
          fc.constantFrom('unconfirmed', 'unfail', 'completed', 'failed'),
          async (bytes, offset, length, proven, status) => {
            const txid = 'a'.repeat(64),
              raw = Buffer.from(bytes),
              request = Buffer.from([...bytes].reverse())
            for (const table of ['outputs', 'proven_txs', 'proven_tx_reqs']) await target.db(table).del()
            if (proven !== 'absent')
              await target.db('proven_txs').insert(
                target.row('proven_txs', {
                  provenTxId: 0,
                  txid,
                  created_at: 1,
                  updated_at: 2,
                  rawTx: proven === 'bytes' ? raw : null
                })
              )
            await target.db('proven_tx_reqs').insert(
              target.row('proven_tx_reqs', {
                provenTxReqId: 0,
                txid,
                created_at: 1,
                updated_at: 2,
                rawTx: request,
                status
              })
            )
            const row = target.row('outputs', {
              outputId: 0,
              userId: 7,
              transactionId: 9,
              vout: 1,
              txid,
              created_at: 1,
              updated_at: 2,
              scriptOffset: offset,
              scriptLength: length,
              lockingScript: null,
              spendable: 1,
              change: 0
            })
            await target.db('outputs').insert(row)
            const selected = proven === 'bytes' ? raw : ['unfail', 'completed'].includes(status) ? request : undefined
            const slice = selected?.subarray(offset, offset + length),
              base = allocation(row),
              total = base + (slice === undefined ? 0 : 256 + 16 * slice.length),
              selection: Brc38ImportEntityTarget = {
                table: 'outputs',
                index: 'outputs',
                found: true,
                localId: 0,
                key: { userId: 7, transactionId: 9, vout: 1 }
              }
            await target.db.transaction(async trx => {
              await trx.raw('PRAGMA query_only=ON')
              try {
                if (slice !== undefined)
                  await expect(
                    prepareBrc38ImportExistingTargets(trx, target.storage, 7, 'outputs', [selection], total - 1)
                  ).rejects.toThrow('allocation budget')
                const [existing] = await prepareBrc38ImportExistingTargets(
                  trx,
                  target.storage,
                  7,
                  'outputs',
                  [selection],
                  total
                )
                if (existing.table !== 'outputs') throw new Error('Owned output fixture differs')
                expect(existing.allocationBytes).toBe(total)
                expect(existing.row?.lockingScript).toEqual(slice === undefined ? undefined : Array.from(slice))
                expect(existing.row?.spendable).toBe(true)
                expect(existing.row?.change).toBe(false)
                expect(existing.row?.created_at).toEqual(new Date(1))
                expect(Object.isFrozen(existing.row)).toBe(true)
                if (slice !== undefined) expect(Object.isFrozen(existing.row?.lockingScript)).toBe(true)
                expect((await trx('proven_tx_reqs').first()).rawTx).toEqual(request)
                expect((await trx('outputs').first()).lockingScript).toBeNull()
              } finally {
                await trx.raw('PRAGMA query_only=OFF')
              }
            })
          }
        ),
        controls
      )
    } finally {
      await target.close()
    }
  }, 30000)
})
