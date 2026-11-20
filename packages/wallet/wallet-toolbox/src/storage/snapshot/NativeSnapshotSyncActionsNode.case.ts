import { promiseFromSync } from '../../utility/promiseFromSync'
import type { StorageKnex } from '../StorageKnex'
import type { Brc38ImportRowTypes } from '../portable/Brc38ImportPage'
import type { TableTransaction } from '../schema/tables'
import { KnexSnapshotSyncDestination } from './KnexSnapshotSyncDestination'
import { snapshotSyncTables, type SnapshotSyncCheckpoint } from './SnapshotSync'
import type { WalletReadSnapshot } from './WalletReadSnapshot'

export type NativeActionCaseFixture = {
  [K in 'transactions' | 'outputs']: Readonly<{ table: K; expected: readonly Readonly<Brc38ImportRowTypes[K]>[] }>
}['transactions' | 'outputs']
function requireCase(condition: boolean, column?: string): asserts condition {
  if (!condition)
    throw new Error(
      'Independent native action lifecycle, payload, quarantine or atomic ACK oracle differs' +
        (column === undefined ? '' : ` at column ${column}`)
    )
}
function exactRow(wanted: object, actual: object): void {
  for (const [name, expected] of Object.entries(wanted)) {
    const value: unknown = Object.getOwnPropertyDescriptor(actual, name)?.value
    if (expected instanceof Date) requireCase(value instanceof Date && value.getTime() === expected.getTime(), name)
    else if (Array.isArray(expected) || expected instanceof Uint8Array)
      requireCase(
        (Array.isArray(value) || value instanceof Uint8Array) && Buffer.from(expected).equals(Buffer.from(value)),
        name
      )
    else requireCase(value === expected, name)
  }
  requireCase(!Object.hasOwn(actual, 'rowid'), 'rowid')
}
/** Authored UNRUN. The finite native controller supplies actual issued storage,
 * retained source, complete predecessor mappings/journal/session and independent
 * full DTO expectations. Run new/older/newer/reference-fallback/alias and every
 * BRC-177 winner/quarantine fixture for both tables. No pool/runtime is selected
 * here, and partial component results cannot admit the complete system. */
export async function verifyNativeSnapshotSyncActions(
  storage: StorageKnex,
  source: WalletReadSnapshot,
  checkpoint: SnapshotSyncCheckpoint,
  fixture: NativeActionCaseFixture
): Promise<void> {
  requireCase(
    source.fieldReader !== undefined &&
      snapshotSyncTables[checkpoint.tableIndex] === fixture.table &&
      fixture.expected.length > 0 &&
      fixture.expected.length <= 2
  )
  const destination = new KnexSnapshotSyncDestination(storage, () => {
      return promiseFromSync(() => {
        throw new Error('Action performed legacy proof I/O')
      })
    }),
    page = await source.fieldReader.readMetadataPage(fixture.table, checkpoint.cursor, { maxRows: 2, maxBytes: 32768 })
  requireCase(
    page.done &&
      page.rows.length > 0 &&
      page.rows.length <= 2 &&
      page.rows.some(row => Object.values(row.extents).some(field => field.bytes > 65536))
  )
  const prepared = await destination.prepareNativeActionFields(checkpoint, page, source)
  try {
    Reflect.set(page, 'payloadBytes', 0)
    Reflect.set(page, 'done', false)
    Reflect.set(page.rows[0].fields, 'userId', 999999)
    const result = await prepared.apply()
    requireCase(
      result.checkpoint.sequence === checkpoint.sequence + 1 &&
        result.checkpoint.tableIndex === checkpoint.tableIndex + 1 &&
        result.checkpoint.cursor === undefined &&
        JSON.stringify(result.checkpoint) ===
          JSON.stringify(await destination.checkpoint(checkpoint.identityKey, checkpoint.sourceStorageIdentityKey))
    )
    if (fixture.table === 'transactions')
      for (const wanted of fixture.expected) {
        const rows = await storage.findTransactions({
          partial: { userId: wanted.userId, transactionId: wanted.transactionId }
        })
        requireCase(rows.length === 1)
        exactRow(wanted, rows[0])
      }
    else
      for (const wanted of fixture.expected) {
        const rows = await storage.findOutputs({ partial: { userId: wanted.userId, outputId: wanted.outputId } })
        requireCase(rows.length === 1)
        exactRow(wanted, rows[0])
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
/** The actual mapped transaction is changed after output preparation. Matching
 * its numeric ID is insufficient: the old parent revision must refuse before
 * the row/map/ACK effect. This tests actual journal observers and own writers. */
export async function verifyNativeSnapshotSyncOutputStaleParent(
  storage: StorageKnex,
  source: WalletReadSnapshot,
  checkpoint: SnapshotSyncCheckpoint,
  parent: Readonly<TableTransaction>
): Promise<void> {
  requireCase(source.fieldReader !== undefined && snapshotSyncTables[checkpoint.tableIndex] === 'outputs')
  const destination = new KnexSnapshotSyncDestination(storage, () => {
      return promiseFromSync(() => {
        throw new Error('Unexpected proof I/O')
      })
    }),
    before = await destination.checkpoint(checkpoint.identityKey, checkpoint.sourceStorageIdentityKey),
    page = await source.fieldReader.readMetadataPage('outputs', checkpoint.cursor, { maxRows: 2, maxBytes: 32768 }),
    prepared = await destination.prepareNativeActionFields(checkpoint, page, source)
  try {
    requireCase(
      (await storage.updateTransaction(parent.transactionId, {
        updated_at: new Date(parent.updated_at.getTime() + 1000)
      })) === 1
    )
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
/** Verify actual collateral quarantine independently of the target merge row.
 * The caller invokes this after a target-winner fixture; no descriptor or
 * component-reported count substitutes for the public output postimage. */
export async function verifyNativeSnapshotSyncReclaimQuarantine(
  storage: StorageKnex,
  userId: number,
  reclaimTxid: string
): Promise<void> {
  const outputs = await storage.findOutputs({ partial: { userId, txid: reclaimTxid, vout: 0 } })
  requireCase(outputs.length === 1 && !outputs[0].spendable)
}
