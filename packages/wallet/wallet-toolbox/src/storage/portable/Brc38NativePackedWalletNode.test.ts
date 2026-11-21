import type { Knex } from 'knex'
import {
  prepareBrc38NativePackedWalletWrite,
  hydrateBrc38NativePackedWalletRows,
  matchesBrc38NativePackedWalletBytes
} from './Brc38NativePackedWalletNode'
import { installBrc38NativePackedSchema, hasBrc38NativePackedSchema } from './Brc38NativePackedSchemaNode'
import {
  readBrc38NativePackedExtent,
  writeBrc38NativePackedBytes,
  retireBrc38NativePackedVersion,
  collectBrc38NativePackedGarbage
} from './Brc38NativePackedFieldsNode'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

test('ordinary write preparation detaches bytes, retains metadata and distinguishes absent/null/empty', () => {
  const rawTx = [1, 2, 3],
    reclaim = new Uint8Array([9, 0]),
    input = {
      transactionId: 12,
      reference: 'original',
      rawTx,
      inputBEEF: null,
      noSendExpiryReclaimRawTx: reclaim
    },
    result = prepareBrc38NativePackedWalletWrite('transactions', input)
  rawTx[0] = 8
  reclaim[0] = 8
  expect(result.fields.map(value => [value.field, Array.from(value.bytes)])).toEqual([
    ['rawTx', [1, 2, 3]],
    ['noSendExpiryReclaimRawTx', [9, 0]]
  ])
  expect(result.row.reference).toBe('original')
  expect(result.row.rawTx).toEqual(Buffer.alloc(0))
  expect(result.row.inputBEEF).toBeNull()
  expect(input.rawTx).toEqual([8, 2, 3])
  expect(prepareBrc38NativePackedWalletWrite('outputs', { lockingScript: [] }).fields[0].bytes.byteLength).toBe(0)
  expect(prepareBrc38NativePackedWalletWrite('outputs', { satoshis: 1 }).fields).toHaveLength(0)
})
test.each([[[-1]], [[256]], [[0.5]], [[NaN]], [['1']]])(
  'ordinary binary bytes reject malformed values %j before storage',
  bytes => {
    expect(() => prepareBrc38NativePackedWalletWrite('proven_txs', { rawTx: bytes })).toThrow()
  }
)
test('full-row write allocation is reserved across every binary field before copies', () => {
  const value = new Uint8Array(600000)
  expect(() => prepareBrc38NativePackedWalletWrite('transactions', { rawTx: value, inputBEEF: value })).toThrow(
    SnapshotResourceLimitError
  )
})
test('packed operations reject copied root/transaction flags before any SQL or complete DTO marker', async () => {
  const sql = jest.fn(),
    transaction = Object.assign(
      () => {
        sql()
        throw new Error('Counterfeit SQL ran')
      },
      {
        isTransaction: true,
        raw: sql,
        client: { config: { client: class OwnedNativeSqliteClient {} }, dialect: 'sqlite3' }
      }
    ) as unknown as Knex.Transaction
  await expect(installBrc38NativePackedSchema(transaction)).rejects.toThrow('actual fresh private')
  await expect(hasBrc38NativePackedSchema(transaction)).rejects.toThrow('authenticated published-profile')
  await expect(
    hydrateBrc38NativePackedWalletRows(transaction, 'outputs', [{ outputId: 1, lockingScript: Buffer.alloc(0) }])
  ).rejects.toThrow('current metadata row')
  await expect(matchesBrc38NativePackedWalletBytes(transaction, 'proven_txs', 1, { rawTx: [1] })).rejects.toThrow(
    'authenticated published-profile'
  )
  await expect(
    writeBrc38NativePackedBytes(
      transaction,
      { table: 'outputs', field: 'lockingScript', rowId: 1 },
      new Uint8Array([1])
    )
  ).rejects.toThrow('authenticated published-profile')
  await expect(retireBrc38NativePackedVersion(transaction, '0'.repeat(64), 1)).rejects.toThrow(
    'authenticated published-profile'
  )
  await expect(collectBrc38NativePackedGarbage(transaction, 16)).rejects.toThrow('authenticated published-profile')
  expect(sql).not.toHaveBeenCalled()
})
test('cancelled logical extent never asks a counterfeit connection for SQL', async () => {
  const sql = jest.fn(),
    controller = new AbortController(),
    reason = new Error('original cancellation')
  controller.abort(reason)
  const transaction = {
    isTransaction: true,
    raw: sql,
    client: { config: { client: 'better-sqlite3' } }
  } as unknown as Knex.Transaction
  await expect(
    readBrc38NativePackedExtent(
      transaction,
      { table: 'outputs', field: 'lockingScript', rowId: 1, offset: 0, totalBytes: 1, length: 1 },
      controller.signal
    )
  ).rejects.toBe(reason)
  expect(sql).not.toHaveBeenCalled()
})
