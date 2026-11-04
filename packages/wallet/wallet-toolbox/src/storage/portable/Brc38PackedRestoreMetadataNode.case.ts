import { nativePackedTextSource } from './Brc38NativePackedTextSources'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { brc38ImportTargetIndexes, type Brc38ImportTargetIndex } from './Brc38ImportTargetIndexes'
import type { Brc38ImportEntityTarget } from './Brc38ImportEntityTargets'
import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38ImportRowTypes } from './Brc38ImportPage'
import { brc38ImportRowForm } from './Brc38ImportForms'
import {
  brc38PackedRestoreBinaryTable,
  insertBrc38PackedRestoreMetadata,
  updateBrc38PackedPrivateMetadata
} from './Brc38PackedRestoreMetadataNode'
import {
  readBrc38NativePackedDescriptor,
  readBrc38NativePackedExtent,
  writeBrc38NativePackedBytes
} from './Brc38NativePackedFieldsNode'
import type { Brc38NativeBlobRead } from './Brc38NativeBlobProtocol'
import { brc38JsonBinaryField } from './Brc38JsonBinaryFields'
import {
  prepareBrc38NativePackedTextWalletWrite,
  isBrc38NativePackedTextWalletTable
} from './Brc38NativePackedTextWalletNode'
import { writeBrc38NativePackedTextBytes, readBrc38NativePackedTextDescriptor } from './Brc38NativePackedTextFieldsNode'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'

type BinaryTable = Brc38NativeBlobRead['table']
export interface PackedRestoreMetadataCaseRow {
  readonly table: BinaryTable
  /** Complete independent fixture, with actual pre-existing parent/user IDs.
   * This SQL case does not admit an archive or validate a transaction proof. */
  readonly row: Brc38ImportRowTypes[BinaryTable]
  readonly binaries: ReadonlyArray<Readonly<{ field: Brc38NativeBlobRead['field']; bytes: Uint8Array }>>
}
function requireCase(condition: boolean): asserts condition {
  if (!condition) throw new Error('Independent packed restore metadata oracle differs')
}
/** Authored UNRUN. The actual finite private-native controller supplies all five
 * complete binary-table fixtures. Both rollback and commit exercise real SQL
 * metadata plus packed pointers; a copied Knex facade cannot run this case. */
export async function verifyPackedRestoreMetadata(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  fixtures: readonly PackedRestoreMetadataCaseRow[]
): Promise<void> {
  requireCase(
    fixtures.length === 5 &&
      new Set(fixtures.map(row => row.table)).size === 5 &&
      ['provenTxs', 'provenTxReqs', 'transactions', 'outputs', 'commissions'].every(table =>
        fixtures.some(row => row.table === table)
      )
  )
  const writer = async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> =>
    await store.withPrivateNativeDatabase(
      false,
      async root =>
        await root.transaction(async trx => {
          store.assertPrivateNativeWriteTransaction(trx)
          return await work(trx)
        })
    )
  for (const fixture of fixtures) {
    const sql = brc38PackedRestoreBinaryTable(fixture.table),
      key = brc38ImportRowForm(fixture.table).id,
      original: Record<string, unknown> = { ...fixture.row },
      textTable = sql !== undefined && isBrc38NativePackedTextWalletTable(sql) ? sql : undefined,
      preparedText = textTable === undefined ? undefined : prepareBrc38NativePackedTextWalletWrite(textTable, original),
      metadata: Record<string, unknown> = { ...(preparedText?.row ?? original) },
      nullFields = Object.keys(original).filter(
        field => brc38JsonBinaryField(fixture.table, field) && original[field] == null
      )
    requireCase(
      sql !== undefined &&
        key !== undefined &&
        fixture.binaries.length > 0 &&
        fixture.binaries.length <= 3 &&
        new Set(fixture.binaries.map(value => value.field)).size === fixture.binaries.length
    )
    metadata[key] = 0
    for (const binary of fixture.binaries) {
      requireCase(binary.bytes instanceof Uint8Array && binary.bytes.byteLength <= 65536)
      delete metadata[binary.field]
    }
    const count = async (trx: Knex.Transaction): Promise<number> => {
        const value = await trx(sql).count({ count: '*' }).first()
        requireCase(value !== undefined && typeof value.count === 'number' && Number.isSafeInteger(value.count))
        return value.count
      },
      before = await writer(count),
      rollback = new Error('Actual packed metadata rollback case'),
      insert = async (trx: Knex.Transaction): Promise<number> => {
        if (preparedText !== undefined) requireCase(await hasBrc38NativePackedTextSchema(trx))
        const id = await insertBrc38PackedRestoreMetadata(
          storage,
          trx,
          fixture.table,
          metadata,
          fixture.binaries.map(value => value.field),
          { maximum: 16777216, remaining: 16777216 }
        )
        requireCase(typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
        for (const text of preparedText?.fields ?? []) {
          await writeBrc38NativePackedTextBytes(
            trx,
            { table: nativePackedTextSource(textTable!).table, field: text.field, rowId: id },
            text.bytes
          )
          const descriptor = await readBrc38NativePackedTextDescriptor(trx, {
            table: nativePackedTextSource(textTable!).table,
            field: text.field,
            rowId: id
          })
          requireCase(
            descriptor?.bytes === text.bytes.byteLength &&
              descriptor.sha256 === createHash('sha256').update(text.bytes).digest('hex')
          )
        }
        for (const binary of fixture.binaries) {
          const coordinate = { table: fixture.table, field: binary.field, rowId: id }
          await writeBrc38NativePackedBytes(trx, coordinate, binary.bytes)
          const descriptor = await readBrc38NativePackedDescriptor(trx, coordinate)
          requireCase(
            descriptor?.bytes === binary.bytes.byteLength &&
              descriptor.sha256 === createHash('sha256').update(binary.bytes).digest('hex')
          )
          const physical = await trx(sql)
            .where(key, id)
            .first(trx.raw('typeof(??) AS kind,length(??) AS bytes', [binary.field, binary.field]))
          requireCase(physical?.kind === 'blob' && physical.bytes === 0)
          if (binary.bytes.byteLength > 0) {
            const actual = await readBrc38NativePackedExtent(trx, {
              ...coordinate,
              offset: 0,
              totalBytes: binary.bytes.byteLength,
              length: binary.bytes.byteLength
            })
            requireCase(Buffer.from(actual).equals(binary.bytes))
            actual.fill(0)
          }
        }
        for (const field of nullFields) {
          const coordinate = { table: fixture.table, field: field as Brc38NativeBlobRead['field'], rowId: id },
            physical = await trx(sql)
              .where(key, id)
              .first(trx.raw('typeof(??) AS kind', [field]))
          requireCase(
            physical?.kind === 'null' && (await readBrc38NativePackedDescriptor(trx, coordinate)) === undefined
          )
        }
        return id
      }
    let rolledBack = false
    try {
      await writer(async trx => {
        await insert(trx)
        throw rollback
      })
    } catch (cause) {
      requireCase(cause === rollback)
      rolledBack = true
    }
    requireCase(rolledBack && (await writer(count)) === before)
    let committedId: number | undefined
    await writer(async trx => {
      // SQL expression injection and a full binary masquerading as metadata
      // must fail before an INSERT can escape the caller transaction.
      for (const bad of [
        { ...metadata, updated_at: trx.raw('CURRENT_TIMESTAMP') },
        { ...metadata, [fixture.binaries[0].field]: fixture.binaries[0].bytes }
      ]) {
        let refused = false
        try {
          await insertBrc38PackedRestoreMetadata(
            storage,
            trx,
            fixture.table,
            bad,
            fixture.binaries.map(value => value.field),
            { maximum: 16777216, remaining: 16777216 }
          )
        } catch {
          refused = true
        }
        requireCase(refused && (await count(trx)) === before)
      }
      committedId = await insert(trx)
    })
    requireCase(committedId !== undefined && (await writer(count)) === before + 1)
    await verifyOccupiedMetadataUpdate(writer, storage, fixture, sql, key, metadata, committedId)
  }
}

/** Authored UNRUN, actual same-owner SQL/pointers only. These cases do not
 * qualify archive admission, original policies, checkpoint or primary cutover. */
async function verifyOccupiedMetadataUpdate(
  writer: <T>(work: (trx: Knex.Transaction) => Promise<T>) => Promise<T>,
  storage: StorageKnex,
  fixture: PackedRestoreMetadataCaseRow,
  sql: string,
  key: string,
  metadata: Readonly<Record<string, unknown>>,
  committedId: number
): Promise<void> {
  const indices: Brc38ImportTargetIndex[] =
      fixture.table === 'transactions' ? ['transactions', 'transactionReference'] : [fixture.table],
    changed = fixture.binaries.map(value => ({
      field: value.field,
      bytes: Uint8Array.from(value.bytes, byte => byte ^ 0x5a)
    }))
  for (const index of indices) {
    const [indexedSql, names] = brc38ImportTargetIndexes[index]
    requireCase(indexedSql === sql)
    const selected = await writer(async trx => {
        const actual: Array<Record<string, unknown>> = await trx(sql)
          .where(key, committedId)
          .select(key, ...names, 'updated_at', trx.raw('rowid AS physical'))
          .limit(2)
        // Select the exact committed fixture; existing parent rows may already
        // occupy this table, and must not be mistaken for the row under test.
        requireCase(actual.length === 1)
        const row = actual[0],
          localId = row[key],
          natural: Record<string, string | number> = {}
        requireCase(
          typeof localId === 'number' &&
            Number.isSafeInteger(localId) &&
            localId > 0 &&
            typeof row.physical === 'number' &&
            Number.isSafeInteger(row.physical)
        )
        for (const name of names) {
          const value = row[name]
          requireCase(typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)))
          natural[name] = value
        }
        const target: Brc38ImportEntityTarget = { table: fixture.table, index, key: natural, found: true, localId }
        return {
          target,
          physical: row.physical,
          stamp: row.updated_at,
          old: await Promise.all(
            fixture.binaries.map(
              async value =>
                await readBrc38NativePackedDescriptor(trx, {
                  table: fixture.table,
                  field: value.field,
                  rowId: row.physical as number
                })
            )
          )
        }
      }),
      updated = {
        ...metadata,
        [key]: selected.target.localId,
        updated_at: new Date((fixture.row.updated_at as Date).getTime() + 1000)
      },
      apply = async (trx: Knex.Transaction): Promise<void> => {
        const physical = await updateBrc38PackedPrivateMetadata(
          storage,
          trx,
          fixture.table,
          updated,
          fixture.binaries.map(value => value.field),
          selected.target,
          { maximum: 16777216, remaining: 16777216 }
        )
        requireCase(physical === selected.physical)
        for (const value of changed)
          await writeBrc38NativePackedBytes(
            trx,
            { table: fixture.table, field: value.field, rowId: physical },
            value.bytes
          )
      },
      rollback = new Error('Actual occupied metadata/pointer rollback case')
    let rolledBack = false
    try {
      await writer(async trx => {
        await apply(trx)
        throw rollback
      })
    } catch (cause) {
      requireCase(cause === rollback)
      rolledBack = true
    }
    requireCase(rolledBack)
    await writer(async trx => {
      const actual = await trx(sql)
        .where(key, selected.target.localId!)
        .first('updated_at', trx.raw('rowid AS physical'))
      requireCase(actual?.physical === selected.physical && actual.updated_at === selected.stamp)
      for (const [position, value] of fixture.binaries.entries())
        requireCase(
          JSON.stringify(
            await readBrc38NativePackedDescriptor(trx, {
              table: fixture.table,
              field: value.field,
              rowId: selected.physical
            })
          ) === JSON.stringify(selected.old[position])
        )
      const bad = { ...selected.target, localId: selected.target.localId! + 1 }
      let refused = false
      try {
        await updateBrc38PackedPrivateMetadata(
          storage,
          trx,
          fixture.table,
          updated,
          fixture.binaries.map(value => value.field),
          bad,
          { maximum: 16777216, remaining: 16777216 }
        )
      } catch {
        refused = true
      }
      requireCase(refused)
      await apply(trx)
      const rows: Array<Record<string, unknown>> = await trx(sql)
        .where(key, committedId)
        .select(key, trx.raw('rowid AS physical'))
        .limit(2)
      requireCase(
        rows.length === 1 && rows[0][key] === selected.target.localId && rows[0].physical === selected.physical
      )
      for (const value of changed) {
        const coordinate = { table: fixture.table, field: value.field, rowId: selected.physical },
          descriptor = await readBrc38NativePackedDescriptor(trx, coordinate)
        requireCase(
          descriptor?.bytes === value.bytes.length &&
            descriptor.sha256 === createHash('sha256').update(value.bytes).digest('hex')
        )
        if (value.bytes.length > 0) {
          const actual = await readBrc38NativePackedExtent(trx, {
            ...coordinate,
            offset: 0,
            length: value.bytes.length,
            totalBytes: value.bytes.length
          })
          requireCase(Buffer.from(actual).equals(value.bytes))
          actual.fill(0)
        }
      }
    })
  }
  for (const value of changed) value.bytes.fill(0)
}
