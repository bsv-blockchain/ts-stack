import { EntityProvenTxReq, planProvenTxReqMergeMetadata } from './EntityProvenTxReq'
import type { EntityStorage } from './EntityBase'
import { createSyncMap } from './EntityBase'
import { WERR_INTERNAL } from '../../../sdk/WERR_errors'

test('metadata selection retains current payload/proof/status/attempts and selects only batch/maximum time', () => {
  const current = EntityProvenTxReq.fromTxid('a'.repeat(64), [1]),
    incoming = EntityProvenTxReq.fromTxid('a'.repeat(64), [2])
  current.updated_at = new Date('2026-01-01')
  current.batch = ''
  current.status = 'completed'
  current.attempts = 9
  incoming.updated_at = new Date('2026-02-01')
  incoming.batch = 'incoming'
  incoming.status = 'invalid'
  incoming.attempts = 1
  const old = current.toApi(),
    other = incoming.toApi(),
    planned = planProvenTxReqMergeMetadata(old, other)
  expect(planned).toEqual({ ...old, batch: 'incoming', updated_at: new Date('2026-02-01') })
  expect(planned.rawTx).toBe(old.rawTx)
  expect(planned.inputBEEF).toBe(old.inputBEEF)
  expect(old.batch).toBe('')
  expect(old.updated_at).toEqual(new Date('2026-01-01'))
  expect(planProvenTxReqMergeMetadata(other, old).updated_at).toEqual(new Date('2026-02-01'))
})
test('separate descriptor DATA is selected without fabrication, parsing or replacement grants', () => {
  const current = EntityProvenTxReq.fromTxid('a'.repeat(64), []).toApi(),
    incoming = { ...current, batch: 'batch' },
    raw: Readonly<{ bytes: number; sha256: string }> = Object.freeze({ bytes: 70000, sha256: 'a'.repeat(64) }),
    history: Readonly<{ bytes: number; sha256: string }> = Object.freeze({ bytes: 180000, sha256: 'b'.repeat(64) }),
    otherRaw = Object.freeze({ bytes: 80000, sha256: 'c'.repeat(64) }),
    a = { ...current, rawTx: raw, inputBEEF: undefined, history, notify: history },
    b = { ...incoming, rawTx: otherRaw, inputBEEF: otherRaw, history: otherRaw, notify: otherRaw },
    planned = planProvenTxReqMergeMetadata(a, b)
  expect(planned.rawTx).toBe(raw)
  expect(planned.history).toBe(history)
  expect(planned.notify).toBe(history)
  expect(planned.inputBEEF).toBeUndefined()
  expect(planned.batch).toBe('batch')
})
test('conflicting nonempty batch keeps the original error identity and causes no entity write', async () => {
  const current = EntityProvenTxReq.fromTxid('a'.repeat(64), []),
    incoming = EntityProvenTxReq.fromTxid('a'.repeat(64), []),
    updateProvenTxReq = jest.fn(async () => undefined)
  current.batch = 'old'
  incoming.batch = 'different'
  await expect(
    current.mergeExisting(
      { updateProvenTxReq } as unknown as EntityStorage,
      undefined,
      incoming.toApi(),
      createSyncMap()
    )
  ).rejects.toBeInstanceOf(WERR_INTERNAL)
  expect(updateProvenTxReq).not.toHaveBeenCalled()
  expect(current.batch).toBe('old')
})
test('a duplicate mapped notify ID resets the in-memory flag but causes no persisted write when compared fields stay equal', async () => {
  const current = EntityProvenTxReq.fromTxid('a'.repeat(64), []),
    incoming = EntityProvenTxReq.fromTxid('a'.repeat(64), []),
    when = new Date('2026-01-01'),
    map = createSyncMap(),
    updateProvenTxReq = jest.fn(async () => undefined)
  current.updated_at = when
  incoming.updated_at = new Date(when.getTime())
  current.apiNotify = '{"transactionIds":[3]}'
  incoming.apiNotify = '{"transactionIds":[1]}'
  current.notified = true
  map.transaction.idMap[1] = 3
  expect(
    await current.mergeExisting({ updateProvenTxReq } as unknown as EntityStorage, undefined, incoming.toApi(), map)
  ).toBe(false)
  expect(current.notified).toBe(false)
  expect(updateProvenTxReq).not.toHaveBeenCalled()
})
