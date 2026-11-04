import { EntityOutput, planOutputMerge, type OutputMergeRow } from './EntityOutput'
import { createSyncMap } from './EntityBase'
import type { EntityStorage } from './EntityBase'

type Field = Readonly<{ bytes: number; sha256: string }>
const original: Field = Object.freeze({ bytes: 100000000, sha256: 'a'.repeat(64) }),
  incomingField: Field = Object.freeze({ bytes: 200000000, sha256: 'b'.repeat(64) })
function row(): OutputMergeRow<Field> {
  return {
    ...new EntityOutput().toApi(),
    outputId: 7,
    userId: 1,
    transactionId: 5,
    updated_at: new Date(2000),
    txid: 'c'.repeat(64),
    vout: 3,
    satoshis: 9,
    derivationPrefix: 'original-prefix',
    sequenceNumber: 4,
    lockingScript: original
  }
}
test('newer output metadata maps only mutable relationships and selects its actual incoming field', () => {
  const map = createSyncMap()
  map.outputBasket.idMap[10] = 20
  map.transaction.idMap[11] = 21
  const current = row(),
    before = { ...current },
    incoming = {
      ...row(),
      outputId: 99,
      userId: 99,
      transactionId: 99,
      vout: 99,
      satoshis: 99,
      txid: 'd'.repeat(64),
      sequenceNumber: 99,
      derivationPrefix: 'foreign-prefix',
      updated_at: new Date(3000),
      basketId: 10,
      spentBy: 11,
      lockingScript: incomingField,
      spendable: true
    },
    planned = planOutputMerge(current, incoming, map)
  expect(planned).toMatchObject({
    outputId: 7,
    userId: 1,
    transactionId: 5,
    vout: 3,
    satoshis: 9,
    txid: 'c'.repeat(64),
    derivationPrefix: 'original-prefix',
    sequenceNumber: 4,
    basketId: 20,
    spentBy: 21
  })
  expect(planned?.lockingScript).toBe(incomingField)
  // The caller still checks actual BRC177 quarantine before persistence.
  expect(planned?.spendable).toBe(true)
  expect(current).toEqual(before)
  expect(incoming.lockingScript).toBe(incomingField)
})
test('equal/older output timestamps are quiescent and newer absence clears the old payload', () => {
  const current = row(),
    map = createSyncMap()
  expect(planOutputMerge(current, { ...row(), lockingScript: incomingField }, map)).toBeUndefined()
  expect(planOutputMerge(current, { ...row(), updated_at: new Date(1000) }, map)).toBeUndefined()
  expect(
    planOutputMerge(current, { ...row(), updated_at: new Date(3000), lockingScript: undefined }, map)?.lockingScript
  ).toBeUndefined()
})
test('newer foreign basket without an actual ID mapping remains an incoherent merge', () => {
  expect(() =>
    planOutputMerge(row(), { ...row(), updated_at: new Date(3000), basketId: 10 }, createSyncMap())
  ).toThrow()
})
test('legacy output retains its public API object and old timestamp if reclaim quarantine fails', async () => {
  const current = {
      ...new EntityOutput().toApi(),
      outputId: 7,
      userId: 1,
      txid: 'c'.repeat(64),
      updated_at: new Date(2000)
    },
    entity = new EntityOutput(current),
    reason = new Error('current reclaim lookup failed'),
    incoming = { ...current, updated_at: new Date(3000), spendable: true },
    findTransactions = jest.fn(async () => {
      throw reason
    }),
    updateOutput = jest.fn()
  await expect(
    entity.mergeExisting(
      { findTransactions, updateOutput } as unknown as EntityStorage,
      undefined,
      incoming,
      createSyncMap()
    )
  ).rejects.toBe(reason)
  expect(entity.toApi()).toBe(current)
  expect(current.updated_at).toEqual(new Date(2000))
  expect(current.spendable).toBe(true)
  expect(updateOutput).not.toHaveBeenCalled()
})
test('large TEXT descriptors select mutable descriptions and preserve immutable derivations', () => {
  const current: OutputMergeRow<Field, string | Field> = {
      ...row(),
      outputDescription: original,
      customInstructions: original,
      derivationPrefix: original,
      derivationSuffix: original
    },
    incoming: OutputMergeRow<Field, string | Field> = {
      ...row(),
      updated_at: new Date(3000),
      outputDescription: incomingField,
      spendingDescription: incomingField,
      customInstructions: undefined,
      derivationPrefix: incomingField,
      derivationSuffix: incomingField,
      type: incomingField,
      purpose: incomingField
    },
    planned = planOutputMerge(current, incoming, createSyncMap())
  expect(planned?.outputDescription).toBe(incomingField)
  expect(planned?.spendingDescription).toBe(incomingField)
  expect(planned?.customInstructions).toBeUndefined()
  expect(planned?.derivationPrefix).toBe(original)
  expect(planned?.derivationSuffix).toBe(original)
  expect(planned?.type).toBe(incomingField)
  expect(planned?.purpose).toBe(incomingField)
  expect(current.outputDescription).toBe(original)
  expect(incoming.outputDescription).toBe(incomingField)
})
