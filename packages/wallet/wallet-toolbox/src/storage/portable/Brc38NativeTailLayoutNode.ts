import { requireBrc38NativeProfileTransaction, requireBrc38PublishedCopyInspection } from './Brc38PublishedProfileNode'
import type { Knex } from 'knex'
import { isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { brc38NativeTailLayout } from './Brc38NativeTailLayout'
import { runInSeries } from '../../utility/runInSeries'

export const brc38NativeTailLayoutMigration = '2026-09-29-000 private streamed native binary tail layout'
const layouts = Object.freeze({
  transactions: ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx'],
  proven_txs: ['rawTx', 'merklePath'],
  proven_tx_reqs: ['rawTx', 'inputBEEF'],
  outputs: ['lockingScript'],
  commissions: ['lockingScript']
} as const)
function invalid(): never {
  throw new Error('Fresh private native binary layout differs')
}
async function columns(trx: Knex.Transaction, table: string): Promise<Array<Record<string, unknown>>> {
  const rows = (await trx.raw(`PRAGMA table_info("${table}")`)) as Array<Record<string, unknown>>
  if (
    rows.length < 1 ||
    rows.length > 128 ||
    rows.some(row => typeof row.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(row.name))
  )
    invalid()
  return rows
}
/** Fresh private candidate ONLY, before generation/journal/restore publication.
 * All binary columns become trailing fields, allowing one INSERT to reserve
 * consecutive zeroblobs without expanding a full record in SQLite. No existing
 * wallet data, source/archive table or public migration is rewritten. */
export async function installBrc38NativeTailLayout(trx: Knex.Transaction): Promise<void> {
  if (!isBrc38OwnedPrivateNativeWriter(trx)) invalid()
  const foreign = (await trx.raw('PRAGMA foreign_keys')) as Array<{ foreign_keys: number }>
  if (foreign.length !== 1 || foreign[0].foreign_keys !== 0) invalid()
  for (const table of Object.keys(layouts)) {
    const rows = (await trx(table).count({ count: '*' }).first()) as { count: number }
    if (Number(rows.count) !== 0) invalid()
  }
  await runInSeries(Object.keys(layouts) as Array<keyof typeof layouts>, async table => {
    if (!isBrc38OwnedPrivateNativeWriter(trx)) invalid()
    const before = await columns(trx, table),
      rows = (await trx('sqlite_schema')
        .where({ type: 'table', name: table })
        .select(trx.raw('CASE WHEN length(CAST(sql AS BLOB))<=65536 THEN sql ELSE NULL END AS sql'))
        .limit(2)) as Array<{ sql: string }>,
      temporary = 'brc38_tail_' + table
    if (rows.length !== 1 || typeof rows[0].sql !== 'string' || (await trx.schema.hasTable(temporary))) invalid()
    const definitions = (await trx('sqlite_schema')
      .where({ tbl_name: table })
      .whereIn('type', ['index', 'trigger'])
      .whereNotNull('sql')
      .select(
        'type',
        trx.raw('CASE WHEN length(CAST(name AS BLOB))<=128 THEN name ELSE NULL END AS name'),
        trx.raw('length(CAST(sql AS BLOB)) AS bytes')
      )
      .limit(65)) as Array<{ type: string; name: string; bytes: number }>
    if (
      definitions.length > 64 ||
      definitions.some(
        row =>
          row.type !== 'index' ||
          typeof row.name !== 'string' ||
          !Number.isSafeInteger(row.bytes) ||
          row.bytes < 1 ||
          row.bytes > 65536
      ) ||
      definitions.reduce((sum, row) => sum + row.bytes, 0) > 524288
    )
      invalid()
    const indexes: string[] = []
    for (const definition of definitions) {
      const value = (await trx('sqlite_schema')
        .where({ type: definition.type, name: definition.name, tbl_name: table })
        .first(trx.raw('CASE WHEN length(CAST(sql AS BLOB))=? THEN sql ELSE NULL END AS sql', [definition.bytes]))) as {
        sql: string
      }
      if (typeof value?.sql !== 'string' || !/^CREATE (?:UNIQUE )?INDEX /i.test(value.sql)) invalid()
      indexes.push(value.sql)
    }
    const foreignBefore = await trx.raw(`PRAGMA foreign_key_list("${table}")`)
    await trx.raw(
      brc38NativeTailLayout(
        rows[0].sql,
        table,
        temporary,
        before.map(row => String(row.name)),
        layouts[table]
      )
    )
    await trx.raw(`DROP TABLE "${table}"`)
    await trx.raw(`ALTER TABLE "${temporary}" RENAME TO "${table}"`)
    for (const index of indexes) await trx.raw(index)
    const after = await columns(trx, table),
      withoutOrder = (values: typeof before) =>
        values.map(({ cid: _cid, ...row }) => row).sort((a, b) => String(a.name).localeCompare(String(b.name)))
    if (
      JSON.stringify(withoutOrder(before)) !== JSON.stringify(withoutOrder(after)) ||
      JSON.stringify(foreignBefore) !== JSON.stringify(await trx.raw(`PRAGMA foreign_key_list("${table}")`))
    )
      invalid()
  })
  await verifyBrc38NativeTailLayout(trx)
}
/** A fresh physical schema check on every field-aware restore/inventory page.
 * The ordering result is never cached as schema or runtime authority. */
export async function verifyBrc38NativeTailLayout(trx: Knex.Transaction): Promise<void> {
  const { isBrc38OwnedPrivateNativeSqlite } = await import('./KnexBrc38StagingStore')
  if (!isBrc38OwnedPrivateNativeSqlite(trx)) invalid()
  await verifyLayout(trx)
}
export async function verifyBrc38PublishedNativeTailLayout(trx: Knex.Transaction): Promise<void> {
  requireBrc38NativeProfileTransaction(trx)
  await verifyLayout(trx)
}
export async function verifyBrc38PublishedCopyTailLayout(trx: Knex.Transaction): Promise<void> {
  requireBrc38PublishedCopyInspection(trx)
  await verifyLayout(trx)
}
async function verifyLayout(trx: Knex.Transaction): Promise<void> {
  await runInSeries(Object.keys(layouts) as Array<keyof typeof layouts>, async table => {
    const expected = layouts[table],
      total = (await trx.raw(
        "SELECT count(*) AS count,coalesce(sum(CASE WHEN typeof(name)='text' AND name GLOB '[A-Za-z]*' AND name NOT GLOB '*[^A-Za-z0-9_]*' THEN 0 ELSE 1 END),0) AS invalidNames FROM pragma_table_info(?)",
        [table]
      )) as Array<{ count: number; invalidNames: number }>
    if (
      total.length !== 1 ||
      !Number.isSafeInteger(total[0].count) ||
      total[0].count < expected.length ||
      total[0].count > 128 ||
      total[0].invalidNames !== 0
    )
      invalid()
    // Inventory requires only the tail order. Bound the actual transfer before
    // loading names; an unknown long column cannot allocate a whole PRAGMA DTO.
    const tail = (await trx.raw(
      "SELECT CASE WHEN typeof(name)='text' AND length(CAST(name AS BLOB))<=128 THEN name ELSE NULL END AS name FROM pragma_table_info(?) ORDER BY cid DESC LIMIT ?",
      [table, expected.length]
    )) as Array<{ name: string | null }>
    if (
      tail.length !== expected.length ||
      JSON.stringify(tail.map(row => row.name).reverse()) !== JSON.stringify(expected)
    )
      invalid()
  })
}
