import type { StorageKnex } from '../StorageKnex'
import type { Brc38ImportRowTypes } from '../portable/Brc38ImportPage'
import { KnexSnapshotSyncDestination } from './KnexSnapshotSyncDestination'
import { snapshotSyncTables, type SnapshotSyncCheckpoint } from './SnapshotSync'
import type { WalletReadSnapshot } from './WalletReadSnapshot'
import type { NativeSimplePayloadTable } from './writeNativeSnapshotSyncRowNode'

export type NativeSimplePayloadCaseFixture = {
  [K in NativeSimplePayloadTable]: Readonly<{ table: K; expected: readonly Readonly<Brc38ImportRowTypes[K]>[] }>
}[NativeSimplePayloadTable]
type NativeSimplePayloadCurrentFixture = {
  [K in NativeSimplePayloadTable]: Readonly<{ table: K; row: Readonly<Brc38ImportRowTypes[K]> }>
}[NativeSimplePayloadTable]
function requireCase(condition: boolean): asserts condition {
  if (!condition) throw new Error('Independent native payload entity/current-row/ACK oracle differs')
}
async function expectedRows(
  storage: StorageKnex,
  fixture: NativeSimplePayloadCaseFixture
): Promise<Array<{ expected: object; actual: object }>> {
  const result: Array<{ expected: object; actual: object }> = []
  switch (fixture.table) {
    case 'certificates':
      for (const expected of fixture.expected) {
        const rows = await storage.findCertificates({
          partial: { userId: expected.userId, certificateId: expected.certificateId }
        })
        requireCase(rows.length === 1)
        result.push({ expected, actual: rows[0] })
      }
      break
    case 'certificateFields':
      for (const expected of fixture.expected) {
        const rows = await storage.findCertificateFields({
          partial: { userId: expected.userId, certificateId: expected.certificateId, fieldName: expected.fieldName }
        })
        requireCase(rows.length === 1)
        result.push({ expected, actual: rows[0] })
      }
      break
    case 'commissions':
      for (const expected of fixture.expected) {
        const rows = await storage.findCommissions({
          partial: { userId: expected.userId, commissionId: expected.commissionId }
        })
        requireCase(rows.length === 1)
        result.push({ expected, actual: rows[0] })
      }
  }
  return result
}
/** Authored UNRUN. Actual finite controller supplies factory-owned source and
 * destination, complete predecessor maps/session, source-owned journal and
 * independently computed complete expected rows. It runs this case for all
 * three tables with new/older/newer/tombstone/alias and multichunk fixtures.
 * It selects no runtime/controller/pool and proves no full-system admission. */
export async function verifyNativeSimplePayloadSession(
  storage: StorageKnex,
  source: WalletReadSnapshot,
  checkpoint: SnapshotSyncCheckpoint,
  fixture: NativeSimplePayloadCaseFixture
): Promise<void> {
  requireCase(
    snapshotSyncTables[checkpoint.tableIndex] === fixture.table &&
      source.fieldReader !== undefined &&
      fixture.expected.length > 0 &&
      fixture.expected.length <= 4
  )
  const destination = new KnexSnapshotSyncDestination(storage, async () => {
      throw new Error('Simple native payload performed proof I/O')
    }),
    page = await source.fieldReader.readMetadataPage(fixture.table, checkpoint.cursor, { maxRows: 4, maxBytes: 32768 })
  requireCase(
    page.done &&
      page.rows.length > 0 &&
      page.rows.length <= 4 &&
      page.rows.some(row => Object.values(row.extents).some(field => field.bytes > 65536))
  )
  const prepared = await destination.prepareNativeSimpleFields(checkpoint, page, source)
  try {
    Reflect.set(page.rows[0].fields, 'userId', 999999)
    Reflect.set(page, 'payloadBytes', 0)
    Reflect.set(page, 'done', false)
    const result = await prepared.apply(),
      persisted = await destination.checkpoint(checkpoint.identityKey, checkpoint.sourceStorageIdentityKey)
    requireCase(
      result.checkpoint.sequence === checkpoint.sequence + 1 &&
        result.checkpoint.tableIndex === checkpoint.tableIndex + 1 &&
        result.checkpoint.cursor === undefined &&
        JSON.stringify(persisted) === JSON.stringify(result.checkpoint)
    )
    for (const { expected, actual: row } of await expectedRows(storage, fixture)) {
      for (const [name, value] of Object.entries(expected)) {
        const actual: unknown = Object.getOwnPropertyDescriptor(row, name)?.value
        if (value instanceof Date) requireCase(actual instanceof Date && actual.getTime() === value.getTime())
        else if (Array.isArray(value) || value instanceof Uint8Array)
          requireCase(
            (Array.isArray(actual) || actual instanceof Uint8Array) && Buffer.from(actual).equals(Buffer.from(value))
          )
        else requireCase(actual === value)
      }
      requireCase(!Object.hasOwn(row, 'rowid'))
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

/** A real foreground update changes the current row/journal after preparation.
 * The old effect must refuse and leave its durable sequence/cursor unchanged.
 * Source and target are actual actors; no borrowed transaction is manufactured. */
export async function verifyNativeSimplePayloadStaleCurrent(
  storage: StorageKnex,
  source: WalletReadSnapshot,
  checkpoint: SnapshotSyncCheckpoint,
  fixture: NativeSimplePayloadCurrentFixture
): Promise<void> {
  requireCase(source.fieldReader !== undefined && snapshotSyncTables[checkpoint.tableIndex] === fixture.table)
  const destination = new KnexSnapshotSyncDestination(storage, async () => {
      throw new Error('Simple native payload performed proof I/O')
    }),
    before = await destination.checkpoint(checkpoint.identityKey, checkpoint.sourceStorageIdentityKey),
    page = await source.fieldReader.readMetadataPage(fixture.table, checkpoint.cursor, { maxRows: 4, maxBytes: 32768 }),
    prepared = await destination.prepareNativeSimpleFields(checkpoint, page, source),
    updated_at = new Date(fixture.row.updated_at.getTime() + 1000)
  try {
    const changed =
      fixture.table === 'certificates'
        ? await storage.updateCertificate(fixture.row.certificateId, { updated_at })
        : fixture.table === 'certificateFields'
          ? await storage.updateCertificateField(fixture.row.certificateId, fixture.row.fieldName, { updated_at })
          : await storage.updateCommission(fixture.row.commissionId, { updated_at })
    requireCase(changed === 1)
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
