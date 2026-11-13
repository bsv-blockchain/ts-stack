import { EntityCommission, planCommissionMerge, type CommissionMergeRow } from './EntityCommission'
import { createSyncMap, type EntityStorage } from './EntityBase'

type Field = Readonly<{ bytes: number; sha256: string }>
const original: Field = Object.freeze({ bytes: 100000000, sha256: 'a'.repeat(64) })
function row(): CommissionMergeRow<Field> {
  return {
    ...new EntityCommission().toApi(),
    commissionId: 7,
    userId: 1,
    transactionId: 5,
    updated_at: new Date(2000),
    keyOffset: 'original-offset',
    satoshis: 9,
    lockingScript: original
  }
}
test('newer commission redemption keeps the original transaction, value and large script', () => {
  const current = row(),
    before = { ...current },
    incoming = {
      ...row(),
      commissionId: 99,
      userId: 99,
      transactionId: 99,
      keyOffset: 'foreign-offset',
      satoshis: 99,
      updated_at: new Date(3000),
      isRedeemed: true,
      lockingScript: { bytes: 200000000, sha256: 'b'.repeat(64) }
    },
    planned = planCommissionMerge(current, incoming)
  expect(planned).toMatchObject({
    commissionId: 7,
    userId: 1,
    transactionId: 5,
    keyOffset: 'original-offset',
    satoshis: 9,
    isRedeemed: true,
    updated_at: new Date(3000)
  })
  expect(planned?.lockingScript).toBe(original)
  expect(current).toEqual(before)
})
test('equal and older commission changes remain quiescent', () => {
  expect(planCommissionMerge(row(), { ...row(), isRedeemed: true })).toBeUndefined()
  expect(planCommissionMerge(row(), { ...row(), updated_at: new Date(1000), isRedeemed: true })).toBeUndefined()
})
test('legacy redemption updates the existing public API object with its original script', async () => {
  const current = { ...new EntityCommission().toApi(), commissionId: 7, updated_at: new Date(2000) },
    entity = new EntityCommission(current),
    updateCommission = jest.fn(async () => 1),
    incoming = { ...current, updated_at: new Date(3000), isRedeemed: true, lockingScript: [1, 2] }
  expect(
    await entity.mergeExisting({ updateCommission } as unknown as EntityStorage, undefined, incoming, createSyncMap())
  ).toBe(true)
  expect(entity.toApi()).toBe(current)
  expect(current.lockingScript).toEqual([])
  expect(current.isRedeemed).toBe(true)
  expect(updateCommission).toHaveBeenCalledWith(7, current, undefined)
})
test('redemption preserves an arbitrarily large original TEXT keyOffset descriptor', () => {
  const current: CommissionMergeRow<Field, string | Field> = { ...row(), keyOffset: original },
    incoming: CommissionMergeRow<Field, string | Field> = {
      ...row(),
      updated_at: new Date(3000),
      isRedeemed: true,
      keyOffset: Object.freeze({ bytes: 200000000, sha256: 'b'.repeat(64) })
    },
    planned = planCommissionMerge(current, incoming)
  expect(planned?.keyOffset).toBe(original)
  expect(planned?.lockingScript).toBe(original)
  expect(planned?.isRedeemed).toBe(true)
  expect(current.keyOffset).toBe(original)
})
