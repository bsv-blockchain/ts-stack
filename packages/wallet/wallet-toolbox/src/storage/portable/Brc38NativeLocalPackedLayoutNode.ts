import type { Knex } from 'knex'
import { rebindFreshSnapshotSqliteSpentByIndex } from '../schema/snapshotSqliteIndexGeneration'
import {
  brc38NativeLocalPackedLayoutName as name,
  brc38NativeLocalPackedLayoutDefinitions as marker,
  brc38NativeLocalPackedFamilyDefinitions,
  brc38NativeCompactPackedDefinitions
} from './Brc38NativeLocalPackedLayout'
import {
  hasBrc38NativePackedSchema,
  brc38NativePackedBinarySourceDefinitions,
  requireBrc38PackedRead
} from './Brc38NativePackedSchemaNode'
import {
  hasBrc38NativePackedTextSchema,
  brc38NativePackedTextSourceDefinitions
} from './Brc38NativePackedTextSchemaNode'
import { hasBrc38NativePreparedFieldsSchema, nativePreparedFieldsTable } from './Brc38NativePreparedFieldSchemaNode'
import { isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { brc38NativeLocalBaselineTables } from './Brc38NativeLocalBaselineTables'

export { brc38NativeLocalPackedLayoutMigration } from './Brc38NativeLocalPackedLayout'
function invalid(): never {
  throw new Error('Local packed layout requires its exact empty private candidate')
}
function definition(sql: string): Readonly<{ name: string; type: string; sql: string }> {
  const match = /^CREATE (TABLE|INDEX|TRIGGER) ([A-Za-z0-9_]+)/.exec(sql)
  if (match === null) invalid()
  return Object.freeze({ name: match[2], type: match[1].toLowerCase(), sql })
}
/** Fresh exact marker inspection on the genuine retained transaction. This is
 * layout DATA only: callers still inspect both complete packed families and
 * admit the original profile/source/row before operating. */
export async function hasBrc38NativeLocalPackedLayout(k: Knex.Transaction): Promise<boolean> {
  requireBrc38PackedRead(k)
  const count = (await k('sqlite_schema')
    .whereRaw('substr(name,1,?)=?', [name.length, name])
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (count?.count === 0) return false
  if (count?.count !== marker.length) invalid()
  for (const sql of marker) {
    requireBrc38PackedRead(k)
    const selected = definition(sql),
      actual = (await k('sqlite_schema')
        .where({ name: selected.name, type: selected.type })
        .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
        .count({ count: '*' })
        .first()) as { count: unknown } | undefined
    if (actual?.count !== 1) invalid()
  }
  const rows = (await k(name).select('slot', 'protocol').limit(2)) as Array<{ slot: unknown; protocol: unknown }>
  if (rows.length !== 1 || rows[0].slot !== 1 || rows[0].protocol !== 'brc38-native-local-packed/v2') invalid()
  requireBrc38PackedRead(k)
  return true
}
/** The outer installer has already fenced every original empty table and
 * migration seed in this writer. Reuse the exact cleanup tree's leading key
 * before replacing any packed family. Ordinary/occupied schemas never enter
 * this path; the installer's savepoint owns both the drop and later rollback. */
async function compactFreshSpentByIndex(k: Knex.Transaction, check: () => void): Promise<void> {
  const removed = 'idx_outputs_spentby',
    kept = 'brc38_import_target_cleanup_spentBy'
  check()
  if (
    (
      await k('sqlite_temp_schema')
        .whereIn('name', ['outputs', removed, kept])
        .orWhere({ tbl_name: 'outputs' })
        .select('name')
        .limit(1)
    ).length !== 0
  )
    invalid()
  const layout: Array<{ name: string; wr: number }> = await k.raw('PRAGMA main.table_list(??)', ['outputs'])
  if (layout.length !== 1 || layout[0].name !== 'outputs' || layout[0].wr !== 0) invalid()
  await k.raw('SELECT _rowid_ FROM main.outputs LIMIT 1')
  for (const [name, sql, columns] of [
    [removed, 'CREATE INDEX `idx_outputs_spentby` on `outputs` (`spentBy`)', ['spentBy']],
    [kept, 'CREATE INDEX brc38_import_target_cleanup_spentBy ON outputs (spentBy, outputId)', ['spentBy', 'outputId']]
  ] as const) {
    check()
    const object = (await k('main.sqlite_schema')
      .where({ type: 'index', tbl_name: 'outputs', name })
      .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
      .select('rootpage')
      .limit(2)) as Array<{ rootpage: unknown }>
    if (
      object.length !== 1 ||
      typeof object[0].rootpage !== 'number' ||
      !Number.isSafeInteger(object[0].rootpage) ||
      object[0].rootpage < 1
    )
      invalid()
    const flags: Array<{ unique: number; origin: string; partial: number }> = await k.raw(
      'SELECT "unique",origin,partial FROM pragma_index_list(?) WHERE name=? LIMIT 2',
      ['outputs', name]
    )
    if (flags.length !== 1 || flags[0].unique !== 0 || flags[0].origin !== 'c' || flags[0].partial !== 0) invalid()
    const keys: Array<{ seqno: number; cid: number; name: string; desc: number; coll: string }> = await k.raw(
      'SELECT seqno,cid,name,"desc",coll FROM pragma_index_xinfo(?) WHERE "key"=1 ORDER BY seqno LIMIT 3',
      [name]
    )
    if (
      keys.length !== columns.length ||
      keys.some(
        (key, i) => key.seqno !== i || key.cid < 0 || key.name !== columns[i] || key.desc !== 0 || key.coll !== 'BINARY'
      )
    )
      invalid()
  }
  const plan: Array<{ detail: string }> = await k.raw(
    'EXPLAIN QUERY PLAN SELECT _rowid_ FROM main.outputs INDEXED BY ?? WHERE spentBy=? ORDER BY outputId LIMIT 8',
    [kept, 0]
  )
  if (
    plan.length !== 1 ||
    (!plan[0].detail.startsWith('SEARCH main.outputs USING ') && !plan[0].detail.startsWith('SEARCH outputs USING ')) ||
    !plan[0].detail.includes(`INDEX ${kept} (spentBy=?)`)
  )
    invalid()
  check()
  await k.raw('DROP INDEX main.??', [removed])
  if (
    (await k('main.sqlite_schema').where({ type: 'index', name: removed }).count({ count: '*' }).first())?.count !== 0
  )
    invalid()
  check()
}
/** Explicit installation BEFORE any candidate rows/content. No live source
 * schema is rewritten; pointer tables are replaced only when proven empty in
 * the actual private writer. Both families retain the existing shared budget,
 * chunk/version/preparation and garbage-collection guards. */
export async function installBrc38NativeLocalPackedLayout(k: Knex.Transaction): Promise<void> {
  if (!isBrc38OwnedPrivateNativeWriter(k)) invalid()
  const deadline = performance.now() + 10000,
    check = (): void => {
      if (!isBrc38OwnedPrivateNativeWriter(k) || performance.now() >= deadline) invalid()
    }
  check()
  if (
    (await hasBrc38NativeLocalPackedLayout(k)) ||
    !(await hasBrc38NativePackedSchema(k)) ||
    !(await hasBrc38NativePackedTextSchema(k)) ||
    !(await hasBrc38NativePreparedFieldsSchema(k))
  )
    invalid()
  let savepoint = false
  try {
    await k.raw('SAVEPOINT __brc38_local_packed_layout')
    savepoint = true
    // Same writer and savepoint retain the empty-state observation through DDL.
    for (const table of [
      ...brc38NativeLocalBaselineTables.filter(
        table => table !== 'settings' && table !== 'sync_transfers' && table !== 'prepared_beef_metadata'
      ),
      nativePreparedFieldsTable,
      'brc38_native_binary_versions',
      'brc38_native_binary_fields',
      'brc38_native_binary_chunks',
      'brc38_native_binary_garbage',
      'brc38_native_text_versions',
      'brc38_native_text_fields',
      'brc38_native_text_chunks',
      'brc38_native_text_garbage'
    ]) {
      check()
      if ((await k(table).select(k.raw('1 AS present')).limit(1)).length !== 0) invalid()
    }
    // Wallet migrations create one settings row, the initial proof epoch and
    // nine idle transfer slots. Accept only the exact unused migration seeds.
    const settings = (await k('settings').count({ count: '*' }).first()) as { count: unknown } | undefined,
      prepared = (await k('prepared_beef_metadata').count({ count: '*' }).first()) as { count: unknown } | undefined,
      initialProof = (await k('prepared_beef_metadata')
        .where({ preparedBeefMetadataId: 1, proofEpoch: 0 })
        .whereRaw("typeof(preparedBeefMetadataId)='integer' AND typeof(proofEpoch)='integer'")
        .count({ count: '*' })
        .first()) as { count: unknown } | undefined,
      transfers = (await k('sync_transfers').count({ count: '*' }).first()) as { count: unknown } | undefined,
      idle = (await k('sync_transfers')
        .whereBetween('slot', [0, 8])
        .where({ receivedBytes: 0, expiresAt: 0 })
        .whereNull('transferId')
        .whereNull('identityKey')
        .whereNull('context')
        .whereNull('direction')
        .whereNull('digest')
        .whereNull('totalBytes')
        .whereNull('partBytes')
        .whereNull('state')
        .whereNull('result')
        .count({ count: '*' })
        .first()) as { count: unknown } | undefined
    if (
      settings?.count !== 1 ||
      prepared?.count !== 1 ||
      initialProof?.count !== 1 ||
      transfers?.count !== 9 ||
      idle?.count !== 9
    )
      invalid()
    // Installing after a local journal would remove observers during table DDL.
    if (
      (await k('sqlite_schema').whereRaw('substr(name,1,21)=?', ['brc38_local_baseline_']).select('name').limit(1))
        .length !== 0
    )
      invalid()
    await rebindFreshSnapshotSqliteSpentByIndex(k, async () => await compactFreshSpentByIndex(k, check))
    for (const [kind, base] of [
      ['binary', await brc38NativePackedBinarySourceDefinitions(k)],
      ['text', await brc38NativePackedTextSourceDefinitions(k)]
    ] as const) {
      const fields = `brc38_native_${kind}_fields`,
        expanded = base.some(
          sql => sql.startsWith(`CREATE TABLE brc38_native_${kind}_versions(`) && sql.endsWith(' WITHOUT ROWID')
        )
          ? brc38NativeCompactPackedDefinitions(
              kind,
              brc38NativeLocalPackedFamilyDefinitions(kind, base, true),
              base.some(
                sql =>
                  sql.startsWith(`CREATE TRIGGER brc38_native_${kind}_fields_row_0 `) &&
                  sql.includes(kind === 'binary' ? " IS X''" : " COLLATE BINARY IS ''")
              )
            )
          : brc38NativeLocalPackedFamilyDefinitions(kind, base, true),
        oldNames = new Set(base.map(sql => definition(sql).name)),
        objects = (await k('sqlite_schema')
          .where({ tbl_name: fields })
          .whereNotNull('sql')
          .select('name', 'type')
          .limit(base.length + 1)) as Array<{ name: string; type: string }>
      // The complete original family and every source are already fenced
      // empty in this savepoint. Retain individual original observer names
      // and guards while extending their complete local field family.
      const nextNames = new Set(expanded.map(sql => definition(sql).name))
      const renamed = new Set<string>()
      for (const sql of base) {
        const selected = definition(sql)
        if (selected.type === 'trigger' && !nextNames.has(selected.name)) {
          check()
          await k.raw('DROP TRIGGER ??', [selected.name])
          renamed.add(selected.name)
        }
      }
      for (const object of objects) {
        check()
        if (!oldNames.has(object.name)) invalid()
        if (renamed.has(object.name)) continue
        if (object.type === 'trigger' || object.type === 'index')
          await k.raw(`DROP ${object.type.toUpperCase()} ??`, [object.name])
        else if (object.type !== 'table' || object.name !== fields) invalid()
      }
      check()
      await k.raw('DROP TABLE ??', [fields])
      // Install the replaced table and its dependent definitions and the new
      // auxiliary guards. Unchanged original observers, anchors
      // and original version/clock identities remain in place.
      const replaced = new Set(objects.map(object => object.name))
      for (const sql of expanded) {
        check()
        const selected = definition(sql)
        if (replaced.has(selected.name) || !oldNames.has(selected.name)) await k.raw(sql)
      }
    }
    for (const sql of marker) {
      check()
      await k.raw(sql)
    }
    await k(name).insert({ slot: 1, protocol: 'brc38-native-local-packed/v2' })
    check()
    if (
      !(await hasBrc38NativeLocalPackedLayout(k)) ||
      !(await hasBrc38NativePackedSchema(k)) ||
      !(await hasBrc38NativePackedTextSchema(k))
    )
      invalid()
    check()
    await k.raw('RELEASE __brc38_local_packed_layout')
    savepoint = false
  } catch (cause) {
    const cleanup: unknown[] = []
    if (savepoint) {
      try {
        await k.raw('ROLLBACK TO __brc38_local_packed_layout')
      } catch (error) {
        cleanup.push(error)
      }
      if (cleanup.length === 0)
        try {
          await k.raw('RELEASE __brc38_local_packed_layout')
        } catch (error) {
          cleanup.push(error)
        }
    }
    if (cleanup.length !== 0)
      throw new AggregateError([cause, ...cleanup], 'Local packed layout retains private cleanup', { cause })
    throw cause
  }
}
