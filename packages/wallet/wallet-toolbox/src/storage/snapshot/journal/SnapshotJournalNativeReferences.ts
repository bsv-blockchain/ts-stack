import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { snapshotJournalNativeEntityKeys } from './SnapshotJournalNativeRows'
import type { SnapshotJournalNativeCustodyResult } from './SnapshotJournalNativeCustody'
import { brc38ImportTargetIndexes } from '../../portable/Brc38ImportTargetIndexes'

export const snapshotJournalCleanupIndexes = Object.freeze({
  transactions: ['outputs', ['transactionId', 'outputId']],
  spentBy: ['outputs', ['spentBy', 'outputId']],
  baskets: ['outputs', ['basketId', 'outputId']],
  certificates: ['certificate_fields', ['certificateId', 'userId', 'fieldName']]
} as const)
export function snapshotJournalCleanupIndexDdl(): string[] {
  return Object.entries(snapshotJournalCleanupIndexes).map(
    ([key, [table, fields]]) =>
      'CREATE INDEX brc38_import_target_cleanup_' + key + ' ON ' + table + ' (' + fields.join(', ') + ')'
  )
}
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Native reference lookup lacks a current bounded index')
}

/** Resolve a CURRENT physical index prefix. Names and column metadata are
 * observed on every call, and are used only through quoted SQL identifiers. */
async function index(k: Knex, table: string, fields: readonly string[]): Promise<string> {
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  const rows: Array<{
    name: unknown
    column: unknown
    position: unknown
    direction: unknown
    prefix: unknown
    expression: unknown
  }> = mysql
    ? await k('information_schema.STATISTICS')
        .whereRaw('TABLE_SCHEMA=DATABASE()')
        .where('TABLE_NAME', table)
        .select({
          name: 'INDEX_NAME',
          column: 'COLUMN_NAME',
          position: 'SEQ_IN_INDEX',
          direction: 'COLLATION',
          prefix: 'SUB_PART',
          expression: 'EXPRESSION'
        })
        .where({ IS_VISIBLE: 'YES', INDEX_TYPE: 'BTREE' })
        .orderBy(['INDEX_NAME', 'SEQ_IN_INDEX'])
        .limit(129)
    : await k.raw(
        'SELECT il.name,ix.name AS "column",ix.seqno+1 AS position,ix.desc AS direction,NULL AS prefix,NULL AS expression FROM pragma_index_list(?) il JOIN pragma_index_xinfo(il.name) ix WHERE il.partial=0 AND ix.key=1 ORDER BY il.name,ix.seqno LIMIT 129',
        [table]
      )
  if (rows.length > 128) invalid()
  const groups = new Map<string, typeof rows>()
  for (const row of rows) {
    if (typeof row.name !== 'string' || row.name.length > 128) invalid()
    const group = groups.get(row.name) ?? []
    group.push(row)
    groups.set(row.name, group)
  }
  for (const [name, parts] of groups) {
    if (
      parts.length >= fields.length &&
      fields.every(
        (field, i) =>
          parts[i].column === field &&
          Number(parts[i].position) === i + 1 &&
          parts[i].direction === (mysql ? 'A' : 0) &&
          parts[i].prefix === null &&
          parts[i].expression === null
      )
    )
      return name
  }
  invalid()
}
async function exists(k: Knex, table: string, key: Readonly<Record<string, string | number>>): Promise<boolean> {
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client)),
    name = await index(k, table, Object.keys(key))
  const q = k
    .from(k.raw(mysql ? '?? FORCE INDEX (??)' : '?? INDEXED BY ??', [table, name]))
    .where(key)
    .select(k.raw('1 AS occupied'))
    .limit(1)
  if (mysql) q.forUpdate().noWait()
  return (await q).length !== 0
}

/** Check all actual native foreign-key references, including independent
 * application ownership outside the reconciliation ledger. An unknown added
 * relationship retains the row rather than guessing its deletion semantics.
 * Recognized lookups must have actual indexed prefixes; no wallet-sized scan. */
export async function snapshotJournalNativeHasReferences(
  k: Knex,
  userId: number,
  actual: SnapshotJournalNativeCustodyResult
): Promise<boolean> {
  if (!k.isTransaction) invalid()
  if (actual.tableId === 8 || actual.tableId === 9) return true
  const [entity, fields] = snapshotJournalNativeEntityKeys[actual.tableId]
  const target = brc38ImportTargetIndexes[entity][0],
    targetField = fields[0],
    id = actual.local.id1
  const allowed: Readonly<Record<number, readonly (readonly [string, string])[]>> = {
    0: [
      ['outputs', 'transactionId'],
      ['outputs', 'spentBy'],
      ['commissions', 'transactionId'],
      ['tx_labels_map', 'transactionId']
    ],
    1: [
      ['output_tags_map', 'outputId'],
      ['action_batch_outputs', 'outputId']
    ],
    2: [['certificate_fields', 'certificateId']],
    3: [['tx_labels_map', 'txLabelId']],
    4: [['outputs', 'basketId']],
    5: [['output_tags_map', 'outputTagId']],
    6: []
  }
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  const refs: Array<{ table: unknown; field: unknown; targetField: unknown; position: unknown }> = []
  if (mysql) {
    refs.push(
      ...(await k('information_schema.KEY_COLUMN_USAGE')
        .whereRaw('TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_SCHEMA=DATABASE()')
        .where('REFERENCED_TABLE_NAME', target)
        .select({
          table: 'TABLE_NAME',
          field: 'COLUMN_NAME',
          targetField: 'REFERENCED_COLUMN_NAME',
          position: 'ORDINAL_POSITION'
        })
        .limit(65))
    )
  } else {
    const tables: Array<{ name: unknown }> = await k('sqlite_schema')
      .where('type', 'table')
      .select(k.raw('substr(name,1,129) AS name'))
      .limit(129)
    if (tables.length > 128) invalid()
    for (const table of tables) {
      if (typeof table.name !== 'string' || table.name.length > 128) invalid()
      const rows: Array<{ table: unknown; from: unknown; to: unknown; seq: unknown }> = await k.raw(
        'SELECT "table","from","to",seq FROM pragma_foreign_key_list(?) WHERE "table"=? LIMIT 65',
        [table.name, target]
      )
      if (rows.length > 64) invalid()
      refs.push(
        ...rows.map(row => ({ table: table.name, field: row.from, targetField: row.to, position: Number(row.seq) + 1 }))
      )
      if (refs.length > 64) invalid()
    }
  }
  if (refs.length > 64) invalid()
  for (const ref of refs) {
    if (
      typeof ref.table !== 'string' ||
      typeof ref.field !== 'string' ||
      ref.targetField !== targetField ||
      Number(ref.position) !== 1 ||
      !(allowed[actual.tableId] ?? []).some(([table, field]) => table === ref.table && field === ref.field)
    )
      return true
    if (await exists(k, ref.table, { [ref.field]: id })) return true
  }
  if (actual.tableId === 0) {
    const edges = mysql ? 'snapshot_global_edges' : 'snapshot_global_edges_v2'
    if (await exists(k, edges, { transactionId: id })) return true
    const txid = actual.row.txid
    if (typeof txid === 'string' && txid !== '') {
      if (await exists(k, 'transactions', { userId, noSendExpiryReclaimTxid: txid })) return true
      if (await exists(k, 'outputs', { userId, txid })) return true
    }
  }
  return false
}
