import type { Knex } from 'knex'
import { hasBrc38NativePackedTextSchema, installBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import {
  readBrc38NativePackedTextDescriptor,
  readBrc38NativePackedTextExtent,
  writeBrc38PrivatePackedTextField,
  retireBrc38NativePackedTextVersion,
  collectBrc38NativePackedTextGarbage,
  collectBrc38NativePackedContent
} from './Brc38NativePackedTextFieldsNode'
import {
  prepareBrc38NativePackedTextWalletWrite,
  prechargeBrc38NativePackedTextWalletWrite,
  hydrateBrc38NativePackedTextWalletRows
} from './Brc38NativePackedTextWalletNode'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { inspectBrc38NativePackedTextInventory } from './Brc38NativePackedTextInventoryNode'

test('ordinary TEXT preparation preserves exact raw spelling and absent/null/empty values', () => {
  const history = '{ "what":1,"what":"last 😀é" }',
    input = { provenTxReqId: 12, history, notify: '' },
    prepared = prepareBrc38NativePackedTextWalletWrite('proven_tx_reqs', input)
  input.history = '{}'
  expect(prepared.row).toEqual({ provenTxReqId: 12, history: '', notify: '' })
  expect(prepared.fields.map(value => [value.field, Buffer.from(value.bytes).toString('utf8')])).toEqual([
    ['history', history],
    ['notify', '']
  ])
  expect(
    prepareBrc38NativePackedTextWalletWrite('sync_states', { errorLocal: null, syncMap: '{}' }).row.errorLocal
  ).toBeNull()
  expect(prepareBrc38NativePackedTextWalletWrite('sync_states', { status: 'historical' }).fields).toHaveLength(0)
})
test('binary plus TEXT allocation is checked jointly before either family is copied', () => {
  const rawTx = new Uint8Array(520000),
    history = 'x'.repeat(520000)
  expect(() => prechargeBrc38NativePackedTextWalletWrite('proven_tx_reqs', { rawTx })).not.toThrow()
  expect(() => prechargeBrc38NativePackedTextWalletWrite('proven_tx_reqs', { history })).not.toThrow()
  expect(() => prechargeBrc38NativePackedTextWalletWrite('proven_tx_reqs', { rawTx, history })).toThrow(
    SnapshotResourceLimitError
  )
})

test('copied native/profile labels cannot read, create, install or retire packed text before actual producer admission', async () => {
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
  await expect(installBrc38NativePackedTextSchema(transaction)).rejects.toThrow('actual fresh private')
  await expect(hasBrc38NativePackedTextSchema(transaction)).rejects.toThrow('authenticated published-profile')
  await expect(
    hydrateBrc38NativePackedTextWalletRows(transaction, 'sync_states', [{ syncStateId: 1, syncMap: '' }])
  ).rejects.toThrow('authenticated published-profile')
  await expect(
    readBrc38NativePackedTextDescriptor(transaction, { table: 'provenTxReqs', field: 'history', rowId: 1 })
  ).rejects.toThrow('authenticated published-profile')
  await expect(
    readBrc38NativePackedTextExtent(transaction, {
      table: 'syncStates',
      field: 'syncMap',
      rowId: 1,
      offset: 0,
      totalBytes: 2,
      length: 2
    })
  ).rejects.toThrow('authenticated published-profile')
  await expect(
    writeBrc38PrivatePackedTextField(transaction, {
      table: 'provenTxReqs',
      sourceIndex: 0,
      destinationRowId: 1,
      field: { field: 'history', encoding: 'utf8-json', bytes: 2, sha256: 'a'.repeat(64) },
      expiresAt: Date.now() + 60000
    })
  ).rejects.toThrow('current owned content')
  await expect(retireBrc38NativePackedTextVersion(transaction, 'a'.repeat(64), 1)).rejects.toThrow(
    'authenticated published-profile'
  )
  await expect(collectBrc38NativePackedTextGarbage(transaction, 16)).rejects.toThrow('authenticated published-profile')
  await expect(collectBrc38NativePackedContent(transaction, 16)).rejects.toThrow('authenticated published-profile')
  await expect(inspectBrc38NativePackedTextInventory(transaction, 3)).rejects.toThrow('authenticated published-profile')
  expect(sql).not.toHaveBeenCalled()
})
test('cancelled packed TEXT extent preserves the original reason before SQL or allocation', async () => {
  const sql = jest.fn(),
    transaction = { isTransaction: true, raw: sql } as unknown as Knex.Transaction,
    controller = new AbortController(),
    reason = new Error('original TEXT cancellation')
  controller.abort(reason)
  await expect(
    readBrc38NativePackedTextExtent(
      transaction,
      { table: 'provenTxReqs', field: 'notify', rowId: 1, offset: 0, totalBytes: 2, length: 2 },
      controller.signal
    )
  ).rejects.toBe(reason)
  await expect(inspectBrc38NativePackedTextInventory(transaction, 3, controller.signal)).rejects.toBe(reason)
  expect(sql).not.toHaveBeenCalled()
})
