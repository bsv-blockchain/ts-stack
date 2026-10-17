import type { StorageKnex } from '../StorageKnex'
import type { TableProvenTxReq, TableTransaction } from '../schema/tables'
import { KnexSnapshotSyncDestination } from './KnexSnapshotSyncDestination'
import { snapshotSyncTables, type SnapshotSyncCheckpoint } from './SnapshotSync'
import type { WalletReadSnapshot } from './WalletReadSnapshot'

function requireCase(condition: boolean): asserts condition {
  if (!condition)
    throw new Error('Independent native request history/notify, retained payload or atomic ACK oracle differs')
}
function exactRow(expected: Readonly<TableProvenTxReq>, actual: TableProvenTxReq): void {
  for (const [name, wanted] of Object.entries(expected as Readonly<Record<string, unknown>>)) {
    const value: unknown = Object.getOwnPropertyDescriptor(actual, name)?.value
    if (wanted instanceof Date) requireCase(value instanceof Date && value.getTime() === wanted.getTime())
    else if (Array.isArray(wanted) || wanted instanceof Uint8Array)
      requireCase(
        (Array.isArray(value) || value instanceof Uint8Array) && Buffer.from(wanted).equals(Buffer.from(value))
      )
    else requireCase(value === wanted)
  }
}
/** Authored UNRUN. A finite actual native controller supplies real issued
 * providers/source, complete session/predecessor mappings/journal and full
 * independent expected DTOs. Run new/occupied no-change/changed history/notify,
 * conflicting batch, duplicate txid, retained status/proof/raw/input, normalized
 * unsafe IDs/duplicates and multichunk fixtures. This selects no runtime/pool. */
export async function verifyNativeSnapshotSyncProvenTxReqs(
  storage: StorageKnex,
  source: WalletReadSnapshot,
  checkpoint: SnapshotSyncCheckpoint,
  expected: readonly Readonly<TableProvenTxReq>[],
  inserts: number
): Promise<void> {
  requireCase(
    source.fieldReader !== undefined &&
      snapshotSyncTables[checkpoint.tableIndex] === 'provenTxReqs' &&
      expected.length > 0 &&
      expected.length <= 2 &&
      Number.isSafeInteger(inserts) &&
      inserts >= 0 &&
      inserts <= expected.length
  )
  const destination = new KnexSnapshotSyncDestination(storage, async () => {
      throw new Error('Request entered legacy proof I/O')
    }),
    page = await source.fieldReader.readMetadataPage('provenTxReqs', checkpoint.cursor, { maxRows: 2, maxBytes: 32768 })
  requireCase(
    page.done &&
      page.rows.length > 0 &&
      page.rows.length === expected.length &&
      page.rows.some(row => Object.values(row.extents).some(field => field.bytes > 65536))
  )
  const prepared = await destination.prepareNativeFields(checkpoint, page, source)
  try {
    Reflect.set(page, 'payloadBytes', 0)
    Reflect.set(page, 'done', false)
    Reflect.set(page.rows[0].fields, 'txid', 'mutated caller input')
    const result = await prepared.apply()
    requireCase(
      result.inserts === inserts &&
        result.updates === 0 &&
        result.checkpoint.done &&
        result.checkpoint.sequence === checkpoint.sequence + 1 &&
        result.checkpoint.tableIndex === snapshotSyncTables.length &&
        JSON.stringify(result.checkpoint) ===
          JSON.stringify(await destination.checkpoint(checkpoint.identityKey, checkpoint.sourceStorageIdentityKey))
    )
    for (const wanted of expected) {
      const actual = await storage.findProvenTxReqs({
        partial: { provenTxReqId: wanted.provenTxReqId, txid: wanted.txid }
      })
      requireCase(actual.length === 1)
      exactRow(wanted, actual[0])
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
/** Real ordinary current writers/mapping DML after preparation must refuse
 * before any request or ACK effect. Run all three independent variants with
 * fresh actual fixtures; no fake checkpoint/counter/descriptor is supplied. */
export async function verifyNativeSnapshotSyncRequestStale(
  storage: StorageKnex,
  source: WalletReadSnapshot,
  checkpoint: SnapshotSyncCheckpoint,
  fixture:
    | Readonly<{ kind: 'request'; row: Readonly<TableProvenTxReq> }>
    | Readonly<{ kind: 'transaction'; row: Readonly<TableTransaction> }>
    | Readonly<{ kind: 'mapping'; userId: number; incomingId: number; localId: number }>
): Promise<void> {
  requireCase(source.fieldReader !== undefined && snapshotSyncTables[checkpoint.tableIndex] === 'provenTxReqs')
  const destination = new KnexSnapshotSyncDestination(storage, async () => {
      throw new Error('Unexpected proof I/O')
    }),
    before = await destination.checkpoint(checkpoint.identityKey, checkpoint.sourceStorageIdentityKey),
    page = await source.fieldReader.readMetadataPage('provenTxReqs', checkpoint.cursor, {
      maxRows: 2,
      maxBytes: 32768
    }),
    prepared = await destination.prepareNativeFields(checkpoint, page, source)
  try {
    if (fixture.kind === 'request')
      requireCase(
        (await storage.updateProvenTxReq(fixture.row.provenTxReqId, {
          updated_at: new Date(fixture.row.updated_at.getTime() + 1000)
        })) === 1
      )
    else if (fixture.kind === 'transaction')
      requireCase(
        (await storage.updateTransaction(fixture.row.transactionId, {
          updated_at: new Date(fixture.row.updated_at.getTime() + 1000)
        })) === 1
      )
    else
      await storage.knex.transaction(async trx => {
        requireCase(
          (await trx('snapshot_sync_ids')
            .where({
              userId: fixture.userId,
              sourceStorageIdentityKey: checkpoint.sourceStorageIdentityKey,
              entity: 'transaction',
              incomingId: fixture.incomingId
            })
            .update({ localId: fixture.localId })) === 1
        )
      })
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
  } finally {
    await prepared.close()
  }
}
