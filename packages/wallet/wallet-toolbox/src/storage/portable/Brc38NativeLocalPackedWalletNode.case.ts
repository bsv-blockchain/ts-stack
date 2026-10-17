import type { StorageKnex } from '../StorageKnex'
import type { TableActionBatch, TableActionBatchBlob, TableMonitorEvent } from '../schema/tables'
import type { TablePreparedBeef } from '../schema/tables/TablePreparedBeef.interfaces'
import { KnexSyncTransferStore } from '../remoting/KnexSyncTransferStore'
import { syncTransferDigest } from '../remoting/SyncTransfer'
import {
  withBrc38NativeLocalPackedWalletTransaction,
  withBrc38NativeLocalPackedWalletMutation,
  prepareBrc38NativeLocalPackedWalletWrite,
  releaseBrc38NativeLocalPackedWalletWrite
} from './Brc38NativeLocalPackedWalletNode'
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Actual native local foreground adapter differs from its independent fixture')
}
function bytesEqual(a: number[] | Uint8Array, b: number[] | Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}
/** UNRUN. Genuine fresh authenticated local-layout receiver inside its actual
 * owner scope, independent small foreground fixtures and real StorageKnex API.
 * No candidate points, hashes or marker cells supply the expected DTOs. */
export async function verifyBrc38NativeLocalPackedForeground(
  storage: StorageKnex,
  fixtures: Readonly<{
    batch: TableActionBatch
    blob: TableActionBatchBlob
    monitor: TableMonitorEvent
    beef: TablePreparedBeef
  }>,
  check: () => void
): Promise<void> {
  check()
  await withBrc38NativeLocalPackedWalletTransaction(storage.knex, async (_db, packed) => {
    requireCase(packed)
  })
  const batch = { ...fixtures.batch },
    monitor = { ...fixtures.monitor },
    beef = { ...fixtures.beef },
    expectedBlob = new Uint8Array(fixtures.blob.bytes),
    expectedBeef = new Uint8Array(fixtures.beef.beef)
  requireCase(
    expectedBlob.length <= 65536 &&
      expectedBeef.length <= 65536 &&
      typeof batch.manifest === 'string' &&
      typeof batch.uploadDigests === 'string' &&
      typeof batch.result === 'string' &&
      typeof monitor.details === 'string'
  )
  await storage.insertActionBatch(batch)
  const blob = { ...fixtures.blob, actionBatchId: batch.actionBatchId, bytes: expectedBlob }
  await storage.putActionBatchBlobRecord(blob)
  // Duplicate digest retains the original saved bytes under conflict-ignore.
  await storage.putActionBatchBlobRecord({ ...blob, bytes: new Uint8Array(expectedBlob.length) })
  const foundBlob = await storage.findActionBatchBlobRecord(batch.actionBatchId, blob.digest),
    foundBatch = await storage.findActionBatch(batch.userId, batch.batchId)
  requireCase(
    foundBatch !== undefined &&
      foundBlob !== undefined &&
      bytesEqual(foundBlob.bytes, expectedBlob) &&
      foundBatch?.manifest === fixtures.batch.manifest &&
      foundBatch.uploadDigests === fixtures.batch.uploadDigests &&
      foundBatch.result === fixtures.batch.result
  )
  await storage.updateActionBatch(batch.actionBatchId, { result: 'new independent result' })
  requireCase((await storage.findActionBatch(batch.userId, batch.batchId))?.result === 'new independent result')
  await storage.insertMonitorEvent(monitor)
  requireCase(
    (await storage.findMonitorEvents({ partial: { id: monitor.id, details: fixtures.monitor.details } })).length === 1
  )
  requireCase(
    (await storage.countMonitorEvents({ partial: { id: monitor.id, details: 'independent nonmatch' } })) === 0
  )
  const epoch = await storage.readPreparedBeefProofEpoch()
  requireCase(await storage.upsertPreparedBeef(beef, epoch))
  const foundBeef = await storage.findPreparedBeefs(beef.userId, [beef.rootTxid])
  requireCase(
    foundBeef.length === 1 &&
      bytesEqual(foundBeef[0].beef, expectedBeef) &&
      (await storage.readPreparedBeefLookupByteLength(beef.userId, [beef.rootTxid])) === expectedBeef.length
  )
  check()
  // Catching a row helper failure must not let a surrounding caller commit
  // its partial metadata effect. Savepoint ownership is independently tested.
  await storage.knex.transaction(async trx => {
    const original = await trx('monitor_events').where({ id: monitor.id }).first('event'),
      failure = new Error('independent local row failure')
    try {
      await withBrc38NativeLocalPackedWalletMutation(trx, async db => {
        await db('monitor_events').where({ id: monitor.id }).update({ event: 'must roll back' })
        throw failure
      })
    } catch (cause) {
      requireCase(cause === failure)
    }
    requireCase((await trx('monitor_events').where({ id: monitor.id }).first('event')).event === original.event)
  })
  const prepared = prepareBrc38NativeLocalPackedWalletWrite('action_batch_blobs', { bytes: expectedBlob })
  releaseBrc38NativeLocalPackedWalletWrite(prepared)
  requireCase(
    prepared.fields.every(field => field.bytes.every(byte => byte === 0)) &&
      bytesEqual(expectedBlob, fixtures.blob.bytes)
  )
}

/** Actual durable part/replay/result behavior. Run on a separately admitted
 * local-layout owner with the fixed finite negotiated transport capabilities. */
export async function verifyBrc38NativeLocalPackedTransfer(
  store: KnexSyncTransferStore,
  identityKey: string,
  input: Uint8Array,
  check: () => void
): Promise<void> {
  requireCase(input.length > store.capabilities.partBytes && input.length <= 1048576)
  const digest = syncTransferDigest(input),
    write = await store.beginWrite(identityKey, digest, input.length)
  for (let offset = 0; offset < input.length; offset += write.partBytes) {
    check()
    const packet = input.subarray(offset, Math.min(input.length, offset + write.partBytes)),
      accepted = await store.write(identityKey, write.transferId, offset, packet)
    requireCase((await store.write(identityKey, write.transferId, offset, packet)) === accepted)
  }
  requireCase(bytesEqual((await store.loadWrite(identityKey, write.transferId)).bytes, input))
  let applications = 0
  const apply = async (): Promise<{ saved: string }> => {
    applications++
    return { saved: 'independent acknowledged result' }
  }
  const first = await store.commitPreparedWrite(identityKey, write.transferId, digest, apply),
    replay = await store.commitPreparedWrite(identityKey, write.transferId, digest, apply)
  requireCase(
    applications === 1 &&
      JSON.stringify(first) === JSON.stringify(replay) &&
      JSON.stringify((await store.loadWrite(identityKey, write.transferId)).result) === JSON.stringify(first)
  )
  const read = await store.beginRead(identityKey, '3'.repeat(64), input)
  for (let offset = 0; offset < input.length; offset += read.partBytes) {
    check()
    requireCase(
      bytesEqual(
        (await store.read(identityKey, read.transferId, offset)).bytes,
        input.subarray(offset, Math.min(input.length, offset + read.partBytes))
      )
    )
  }
  await store.release(identityKey, write.transferId)
  await store.release(identityKey, read.transferId)
  check()
}
