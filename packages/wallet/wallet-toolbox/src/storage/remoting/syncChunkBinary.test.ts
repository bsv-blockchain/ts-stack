import { syncChunkBinary } from './syncChunkBinary'
import { binaryJsonReviver, stringifyJsonRpc } from './BinaryJson'
import { validateSyncChunkEntities } from './entityValidationHelpers'
import type { SyncChunk } from '../../sdk/WalletStorage.interfaces'

test('binary sync transport preserves invalid, sparse, small, and unrelated arrays without coercion', () => {
  for (const rawTx of [[1, 2], Array(128), Array(128).fill(256), Array(128).fill(-1), Array(128).fill(1.5)]) {
    const chunk = { provenTxs: [{ rawTx }] } as SyncChunk
    expect((syncChunkBinary(chunk).provenTxs as Array<{ rawTx: unknown }>)[0].rawTx).toBe(rawTx)
  }
})

test('all declared sync byte fields round trip through the historical reviver', () => {
  const bytes = Array.from({ length: 1024 }, (_, i) => i % 256)
  const time = { created_at: new Date(), updated_at: new Date() }
  const chunk = {
    provenTxs: [{ ...time, rawTx: bytes, merklePath: bytes }],
    provenTxReqs: [{ ...time, rawTx: bytes, inputBEEF: bytes }],
    transactions: [{ ...time, rawTx: bytes, inputBEEF: bytes, noSendExpiryReclaimRawTx: bytes }],
    outputs: [{ ...time, lockingScript: bytes }],
    commissions: [{ ...time, lockingScript: bytes }]
  } as SyncChunk
  const wire = stringifyJsonRpc(syncChunkBinary(chunk), true)
  expect(wire.length).toBeLessThan(JSON.stringify(chunk).length / 2)
  expect(validateSyncChunkEntities(JSON.parse(wire, binaryJsonReviver))).toEqual(chunk)
})
