import { EntityTransaction, planTransactionMerge, type TransactionMergeRow } from './EntityTransaction'
import { createSyncMap, type EntityStorage } from './EntityBase'

type Field = Readonly<{ bytes: number; sha256: string }>
const oldField: Field = Object.freeze({ bytes: 100000000, sha256: 'a'.repeat(64) }),
  newField: Field = Object.freeze({ bytes: 200000000, sha256: 'b'.repeat(64) })
function row(): TransactionMergeRow<Field> {
  return {
    ...new EntityTransaction().toApi(),
    transactionId: 7,
    userId: 1,
    reference: 'local-reference',
    created_at: new Date(1000),
    updated_at: new Date(2000),
    rawTx: oldField,
    inputBEEF: undefined,
    noSendExpiryReclaimRawTx: oldField
  }
}
test('large-field metadata follows lifecycle precedence without reading or mutating payload descriptors', () => {
  const current = { ...row(), noSendExpiryState: 'reclaimed' as const, noSendExpiryReclaimTxid: 'c'.repeat(64) },
    incoming = {
      ...row(),
      userId: 99,
      reference: 'remote-reference',
      updated_at: new Date(1000),
      noSendExpiryState: 'target-won' as const,
      rawTx: newField
    },
    before = { ...current },
    prepared = planTransactionMerge(current, incoming, createSyncMap())
  expect(prepared?.row.noSendExpiryState).toBe('target-won')
  expect(prepared?.row.rawTx).toBe(oldField)
  expect(prepared?.row.noSendExpiryReclaimRawTx).toBe(oldField)
  expect(prepared?.row.reference).toBe('local-reference')
  expect(prepared?.row.userId).toBe(1)
  expect(prepared?.row.updated_at).toEqual(new Date(2000))
  expect(prepared?.quarantineReclaimTxid).toBe('c'.repeat(64))
  expect(current).toEqual(before)
  expect(incoming.rawTx).toBe(newField)
})
test('older independently proven metadata fills absent payloads while preserving newer present fields', () => {
  const map = createSyncMap()
  map.provenTx.idMap[12] = 44
  const current = { ...row(), noSendExpiryState: 'reclaimed' as const },
    incoming = { ...row(), updated_at: new Date(1000), provenTxId: 12, rawTx: newField, inputBEEF: newField },
    prepared = planTransactionMerge(current, incoming, map)
  expect(prepared?.row.provenTxId).toBe(44)
  expect(prepared?.row.noSendExpiryState).toBe('target-won')
  expect(prepared?.row.rawTx).toBe(oldField)
  expect(prepared?.row.inputBEEF).toBe(newField)
})
test('newer ordinary metadata retains the same absent-field replacement and older data remains quiescent', () => {
  const current = row(),
    incoming = { ...row(), updated_at: new Date(3000), rawTx: undefined, inputBEEF: newField },
    prepared = planTransactionMerge(current, incoming, createSyncMap())
  expect(prepared?.row.rawTx).toBeUndefined()
  expect(prepared?.row.inputBEEF).toBe(newField)
  expect(planTransactionMerge(current, { ...incoming, updated_at: new Date(1000) }, createSyncMap())).toBeUndefined()
})
test('legacy transaction retains its public API object while the storage update receives a serialization copy', async () => {
  const current = { ...new EntityTransaction().toApi(), transactionId: 7, updated_at: new Date(2000) },
    entity = new EntityTransaction(current),
    updateTransaction = jest.fn(async (_id: number, _row: typeof current, _trx?: unknown) => 1),
    incoming = { ...current, updated_at: new Date(3000), description: 'new description', rawTx: [1, 2] }
  expect(
    await entity.mergeExisting({ updateTransaction } as unknown as EntityStorage, undefined, incoming, createSyncMap())
  ).toBe(true)
  expect(entity.toApi()).toBe(current)
  expect(current.description).toBe('new description')
  expect(current.rawTx).toBe(incoming.rawTx)
  expect(updateTransaction.mock.calls[0][1]).not.toBe(current)
  expect(updateTransaction.mock.calls[0][1]).toEqual(current)
})
test('large TEXT metadata obeys the same ordinary, lifecycle and immutable expiry selections', () => {
  const current: TransactionMergeRow<Field, string | Field> = {
      ...row(),
      description: oldField,
      noSendExpiryReclaimDerivationPrefix: oldField,
      noSendExpiryReclaimDerivationSuffix: undefined
    },
    incoming: TransactionMergeRow<Field, string | Field> = {
      ...row(),
      description: newField,
      noSendExpiryReclaimDerivationPrefix: newField,
      noSendExpiryReclaimDerivationSuffix: newField,
      updated_at: new Date(3000)
    },
    map = createSyncMap(),
    ordinary = planTransactionMerge(current, incoming, map)
  expect(ordinary?.row.description).toBe(newField)
  expect(ordinary?.row.noSendExpiryReclaimDerivationPrefix).toBe(oldField)
  expect(ordinary?.row.noSendExpiryReclaimDerivationSuffix).toBe(newField)
  const lifecycle = planTransactionMerge(
    { ...current, noSendExpiryState: 'reclaimed' },
    { ...incoming, updated_at: new Date(1000), noSendExpiryState: 'target-won' },
    map
  )
  expect(lifecycle?.row.description).toBe(oldField)
  expect(lifecycle?.row.noSendExpiryReclaimDerivationPrefix).toBe(oldField)
  expect(current.description).toBe(oldField)
  expect(incoming.description).toBe(newField)
})
