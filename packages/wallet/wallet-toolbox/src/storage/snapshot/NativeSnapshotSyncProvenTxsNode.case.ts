import { promiseFromSync } from '../../utility/promiseFromSync'
import type { StorageKnex } from '../StorageKnex'
import type { TableProvenTx } from '../schema/tables'
import { KnexSnapshotSyncDestination } from './KnexSnapshotSyncDestination'
import { snapshotSyncTables, type SnapshotSyncCheckpoint } from './SnapshotSync'
import type { WalletReadSnapshot } from './WalletReadSnapshot'

function requireCase(condition: boolean): asserts condition {
  if (!condition) throw new Error('Independent native proof bytes, current row, mapping or durable ACK oracle differs')
}
function exactProof(expected: Readonly<TableProvenTx>, actual: Readonly<TableProvenTx>, replacement: boolean): void {
  for (const name of ['provenTxId', 'txid', 'blockHash', 'merkleRoot', 'height', 'index'] as const)
    requireCase(actual[name] === expected[name])
  requireCase(actual.created_at.getTime() === expected.created_at.getTime())
  requireCase(
    replacement
      ? actual.updated_at.getTime() >= expected.updated_at.getTime()
      : actual.updated_at.getTime() === expected.updated_at.getTime()
  )
  for (const name of ['rawTx', 'merklePath'] as const)
    requireCase(Buffer.from(actual[name]).equals(Buffer.from(expected[name])))
}
/** Authored UNRUN. The finite native controller supplies actual issued source,
 * storage/session/full journal, controlled active-header oracle and complete
 * independent expected public DTOs. Run new, exact occupied, valid replacement
 * and multichunk fixtures separately; this file selects no runtime or pool. */
export async function verifyNativeSnapshotSyncProvenTxs(
  storage: StorageKnex,
  source: WalletReadSnapshot,
  checkpoint: SnapshotSyncCheckpoint,
  expected: readonly Readonly<TableProvenTx>[],
  replacement: boolean
): Promise<void> {
  requireCase(
    source.fieldReader !== undefined &&
      snapshotSyncTables[checkpoint.tableIndex] === 'provenTxs' &&
      expected.length > 0 &&
      expected.length <= 4
  )
  const destination = new KnexSnapshotSyncDestination(storage, () => {
      return promiseFromSync(() => {
        throw new Error('Native field proof component performed legacy whole-payload preparation')
      })
    }),
    page = await source.fieldReader.readMetadataPage('provenTxs', checkpoint.cursor, { maxRows: 4, maxBytes: 32768 })
  requireCase(
    page.done &&
      page.rows.length === expected.length &&
      page.rows.some(row => Object.values(row.extents).some(field => field.bytes > 65536))
  )
  const prepared = await destination.prepareNativeProofFields(checkpoint, page, source)
  try {
    Reflect.set(page, 'payloadBytes', 0)
    Reflect.set(page, 'done', false)
    Reflect.set(page.rows[0].fields, 'height', -1)
    const result = await prepared.apply()
    requireCase(
      result.checkpoint.sequence === checkpoint.sequence + 1 &&
        result.checkpoint.tableIndex === checkpoint.tableIndex + 1 &&
        result.checkpoint.cursor === undefined &&
        JSON.stringify(result.checkpoint) ===
          JSON.stringify(await destination.checkpoint(checkpoint.identityKey, checkpoint.sourceStorageIdentityKey))
    )
    for (const wanted of expected) {
      const rows = await storage.findProvenTxs({ partial: { txid: wanted.txid } })
      requireCase(rows.length === 1)
      exactProof(wanted, rows[0], replacement)
    }
    let refused = false
    try {
      await prepared.apply()
    } catch {
      refused = true
    }
    requireCase(refused)
  } finally {
    await prepared.close()
  }
}
/** Actual foreground mutation after preparation must invalidate the old proof
 * effect even if its natural key survives. Durable checkpoint and the new
 * foreground bytes remain unchanged; no expected digest grants admission. */
export async function verifyNativeSnapshotSyncProofStaleCurrent(
  storage: StorageKnex,
  source: WalletReadSnapshot,
  checkpoint: SnapshotSyncCheckpoint,
  foreground: Readonly<TableProvenTx>
): Promise<void> {
  requireCase(source.fieldReader !== undefined && snapshotSyncTables[checkpoint.tableIndex] === 'provenTxs')
  const destination = new KnexSnapshotSyncDestination(storage, () => {
      return promiseFromSync(() => {
        throw new Error('Unexpected legacy proof I/O')
      })
    }),
    before = await destination.checkpoint(checkpoint.identityKey, checkpoint.sourceStorageIdentityKey),
    page = await source.fieldReader.readMetadataPage('provenTxs', checkpoint.cursor, { maxRows: 4, maxBytes: 32768 }),
    prepared = await destination.prepareNativeProofFields(checkpoint, page, source)
  try {
    requireCase((await storage.updateProvenTx(foreground.provenTxId, { ...foreground })) === 1)
    let refused = false
    try {
      await prepared.apply()
    } catch {
      refused = true
    }
    requireCase(
      refused &&
        JSON.stringify(await destination.checkpoint(checkpoint.identityKey, checkpoint.sourceStorageIdentityKey)) ===
          JSON.stringify(before)
    )
    const rows = await storage.findProvenTxs({ partial: { txid: foreground.txid } })
    requireCase(rows.length === 1)
    exactProof(foreground, rows[0], false)
  } finally {
    await prepared.close()
  }
}
/** An invalid occupied replacement (raw framing/hash, Merkle/header or original
 * deadline refusal) must fail before its final writer and preserve every row
 * and checkpoint. The supplied invalid source remains an actual factory view. */
export async function verifyNativeSnapshotSyncProofRejectedReplacement(
  storage: StorageKnex,
  source: WalletReadSnapshot,
  checkpoint: SnapshotSyncCheckpoint,
  existing: Readonly<TableProvenTx>
): Promise<void> {
  requireCase(source.fieldReader !== undefined)
  const destination = new KnexSnapshotSyncDestination(storage, () => {
      return promiseFromSync(() => {
        throw new Error('Unexpected legacy proof I/O')
      })
    }),
    before = await destination.checkpoint(checkpoint.identityKey, checkpoint.sourceStorageIdentityKey),
    page = await source.fieldReader.readMetadataPage('provenTxs', checkpoint.cursor, { maxRows: 4, maxBytes: 32768 })
  let refused = false
  try {
    const prepared = await destination.prepareNativeProofFields(checkpoint, page, source)
    await prepared.close()
  } catch {
    refused = true
  }
  requireCase(
    refused &&
      JSON.stringify(await destination.checkpoint(checkpoint.identityKey, checkpoint.sourceStorageIdentityKey)) ===
        JSON.stringify(before)
  )
  const rows = await storage.findProvenTxs({ partial: { txid: existing.txid } })
  requireCase(rows.length === 1)
  exactProof(existing, rows[0], false)
}
