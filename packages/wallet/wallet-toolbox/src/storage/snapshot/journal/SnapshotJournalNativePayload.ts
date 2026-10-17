import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  withBrc38NativeLocalPackedWalletMutation,
  withBrc38NativeLocalPackedWalletTransaction,
  brc38NativeLocalPackedWalletLength,
  readBrc38NativeLocalPackedBinaryPacket
} from '../../portable/Brc38NativeLocalPackedWalletNode'
import { writeBrc38NativePackedBytes } from '../../portable/Brc38NativePackedFieldsNode'
import { collectBrc38NativePackedContent } from '../../portable/Brc38NativePackedTextFieldsNode'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'

export type SnapshotJournalPayloadTable = 'snapshot_reconciliation_stage_pages' | 'snapshot_reconciliation_provenance'
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Journal payload differs from its actual row or bounded frame')
}
function table(value: SnapshotJournalPayloadTable): void {
  if (value !== 'snapshot_reconciliation_stage_pages' && value !== 'snapshot_reconciliation_provenance') invalid()
}
function retained(k: Knex): void {
  if (isOwnedNativeSqlite(k) && !k.isTransaction) invalid()
}
/** Internal storage adaptation only. The caller retains its original actual
 * authenticated window/ACK fence. Neither keys nor frame bytes grant admission.
 * One already encoded <=1MiB frame is the existing bounded DTO contract. */
export async function writeSnapshotJournalPayloadRow(
  k: Knex,
  selected: SnapshotJournalPayloadTable,
  key: Record<string, unknown>,
  metadata: Record<string, unknown>,
  payload: Uint8Array,
  expected?: Record<string, unknown>
): Promise<void> {
  table(selected)
  retained(k)
  if (
    !(payload instanceof Uint8Array) ||
    payload.byteLength < 4 ||
    payload.byteLength > 1048576 ||
    Object.hasOwn(metadata, 'payload') ||
    metadata.bytes !== payload.byteLength
  )
    invalid()
  await withBrc38NativeLocalPackedWalletMutation(k, async (database, packed) => {
    const row = { ...metadata, payload: packed ? Buffer.alloc(0) : Buffer.from(payload) }
    try {
      if (expected === undefined) await database(selected).insert({ ...key, ...row })
      else if (
        (await database(selected)
          .where({ ...key, ...expected })
          .update(row)) !== 1
      )
        invalid()
      if (packed) {
        const trx = database as Knex.Transaction,
          rows = (await trx(selected)
            .where(key)
            .select(trx.raw('rowid AS physical'))
            .limit(2)
            .options({ safeIntegers: true })) as Array<{ physical: bigint }>
        if (
          rows.length !== 1 ||
          typeof rows[0].physical !== 'bigint' ||
          rows[0].physical < -9007199254740991n ||
          rows[0].physical > 9007199254740991n
        )
          invalid()
        await writeBrc38NativePackedBytes(
          trx,
          { table: selected, field: 'payload', rowId: Number(rows[0].physical) },
          payload
        )
        await collectBrc38NativePackedContent(trx, 16)
      }
    } finally {
      row.payload.fill(0)
    }
  })
}
/** Length expression for the SAME retained view as the actual page query. */
export async function snapshotJournalPayloadLength(
  k: Knex,
  selected: SnapshotJournalPayloadTable
): Promise<{ expression: Knex.Raw }> {
  table(selected)
  retained(k)
  return await withBrc38NativeLocalPackedWalletTransaction(k, async (database, packed) => ({
    // Knex.Raw is thenable. Box it so async return/await cannot execute this
    // SELECT fragment as a standalone query before the retained page query.
    expression: packed
      ? database.raw('? AS actualBytes', [
          brc38NativeLocalPackedWalletLength(database as Knex.Transaction, selected, 'payload')
        ])
      : database.raw(
          (['mysql', 'mysql2'].includes(String(database.client.config.client))
            ? 'octet_length(??)'
            : 'length(cast(?? as blob))') + ' AS actualBytes',
          ['payload']
        )
  }))
}
/** Complete negotiated frame only; chunk reads remain <=64KiB and their full
 * SHA is verified before returning. Never return the physical empty marker. */
export async function readSnapshotJournalPayloadRow(
  k: Knex,
  selected: SnapshotJournalPayloadTable,
  key: Record<string, unknown>,
  expectedBytes: number
): Promise<Uint8Array> {
  table(selected)
  retained(k)
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 4 || expectedBytes > 1048576) invalid()
  return await withBrc38NativeLocalPackedWalletTransaction(k, async (database, packed) => {
    if (packed) {
      const trx = database as Knex.Transaction,
        rows = (await trx(selected)
          .where(key)
          .select(trx.raw('rowid AS physical'))
          .limit(2)
          .options({ safeIntegers: true })) as Array<{ physical: bigint }>
      if (
        rows.length !== 1 ||
        typeof rows[0].physical !== 'bigint' ||
        rows[0].physical < -9007199254740991n ||
        rows[0].physical > 9007199254740991n
      )
        invalid()
      const bytes = await readBrc38NativeLocalPackedBinaryPacket(trx, selected, Number(rows[0].physical), expectedBytes)
      if (bytes.byteLength !== expectedBytes) {
        bytes.fill(0)
        invalid()
      }
      return bytes
    }
    const mysql = ['mysql', 'mysql2'].includes(String(database.client.config.client)),
      rows = (await database(selected)
        .where(key)
        .select(
          database.raw(
            mysql
              ? 'CASE WHEN octet_length(payload)=? THEN substr(payload,1,?) ELSE NULL END AS payload'
              : "CASE WHEN typeof(payload)='blob' AND length(payload)=? THEN substr(payload,1,?) ELSE NULL END AS payload",
            [expectedBytes, expectedBytes + 1]
          )
        )
        .limit(2)) as Array<{ payload: unknown }>
    if (rows.length !== 1 || !(rows[0].payload instanceof Uint8Array) || rows[0].payload.byteLength !== expectedBytes)
      invalid()
    return rows[0].payload
  })
}
