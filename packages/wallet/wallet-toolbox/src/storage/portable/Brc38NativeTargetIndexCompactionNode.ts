import type { Knex } from 'knex'
import { isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'

export const brc38NativeTargetIndexCompactionMigration = '2026-09-29-001 fresh private native target index compaction'
// Fixed migration DATA only. Each invocation independently inspects the actual
// private writer, empty target, complete SQL and current key/order/collation.
const replacements = [
  ['proven_tx_reqs', 'proven_tx_reqs_txid_index', 'proven_tx_reqs_txid_unique', ['txid'], true],
  ['commissions', 'commissions_transactionid_index', 'commissions_transactionid_unique', ['transactionId'], true],
  ['sync_states', 'sync_states_refnum_index', 'sync_states_refnum_unique', ['refNum'], true],
  [
    'action_batch_outputs',
    'action_batch_outputs_actionbatchid_index',
    'sqlite_autoindex_action_batch_outputs_1',
    ['actionBatchId', 'outputId'],
    true
  ],
  [
    'action_batch_blobs',
    'action_batch_blobs_actionbatchid_index',
    'action_batch_blobs_actionbatchid_digest_unique',
    ['actionBatchId', 'digest'],
    true
  ],
  [
    'output_tags_map',
    'output_tags_map_outputid_index',
    'idx_output_tags_map_output_deleted_tag',
    ['outputId', 'isDeleted', 'outputTagId'],
    false
  ],
  [
    'tx_labels_map',
    'tx_labels_map_transactionid_index',
    'idx_tx_labels_map_tx_deleted',
    ['transactionId', 'isDeleted'],
    false
  ]
] as const
function invalid(): never {
  throw new Error('Native target index compaction requires its exact fresh private source')
}
function indexSql(table: string, name: string, columns: readonly string[], unique: boolean): string {
  return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${name}\` on \`${table}\` (${columns.map(column => `\`${column}\``).join(', ')})`
}
/** Runs only in the explicitly registered fresh private-target migration before
 * generation/source publication. Ordinary/occupied/retired profiles never use
 * it. The retained unique/primary trees and all table definitions are unchanged;
 * no compatibility object or persisted schema/admission verdict is installed. */
export async function compactBrc38NativeTargetIndexes(k: Knex.Transaction): Promise<void> {
  const deadline = performance.now() + 10000
  const check = (): void => {
    if (!isBrc38OwnedPrivateNativeWriter(k) || performance.now() >= deadline) invalid()
  }
  check()
  const tables = replacements.map(([table]) => table),
    names = replacements.flatMap(([, removed, kept]) => [removed, kept])
  if (
    (
      await k('main.sqlite_schema')
        .whereIn('name', [
          'snapshot_index_generation_v2',
          'snapshot_journal_generation',
          'brc38_local_baseline_clock',
          'private_native_restore'
        ])
        .count({ count: '*' })
        .first()
    )?.count !== 0 ||
    (
      await k('sqlite_temp_schema')
        .whereIn('name', [...tables, ...names])
        .orWhereIn('tbl_name', tables)
        .count({ count: '*' })
        .first()
    )?.count !== 0
  )
    invalid()
  // All observations and DDL share the actual outer migration transaction.
  // Refuse a partial or altered family before dropping even the first index.
  for (const [table, removed, kept, columns, unique] of replacements) {
    check()
    if ((await k(table).withSchema('main').select(k.raw('1 AS present')).limit(1)).length !== 0) invalid()
    const layout: Array<{ name: string; wr: number }> = await k.raw('PRAGMA main.table_list(??)', [table])
    if (layout.length !== 1 || layout[0].name !== table || layout[0].wr !== 0) invalid()
    await k.raw('SELECT _rowid_ FROM main.?? LIMIT 1', [table])
    for (const [name, expected, expectedUnique, origin] of [
      [removed, indexSql(table, removed, [columns[0]], false), false, 'c'],
      [
        kept,
        kept.startsWith('sqlite_autoindex_') ? null : indexSql(table, kept, columns, unique),
        unique,
        kept.startsWith('sqlite_autoindex_') ? 'pk' : 'c'
      ]
    ] as const) {
      check()
      const query = k('main.sqlite_schema').where({ name, type: 'index', tbl_name: table })
      if (expected === null) query.whereNull('sql')
      else query.whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [expected])
      if ((await query.count({ count: '*' }).first())?.count !== 1) invalid()
      const shape: Array<{ unique: number; origin: string; partial: number }> = await k.raw(
        'SELECT "unique",origin,partial FROM pragma_index_list(?) WHERE name=? LIMIT 2',
        [table, name]
      )
      if (
        shape.length !== 1 ||
        shape[0].unique !== Number(expectedUnique) ||
        shape[0].origin !== origin ||
        shape[0].partial !== 0
      )
        invalid()
      const parts: Array<{ seqno: number; cid: number; name: string; desc: number; coll: string }> = await k.raw(
        'SELECT seqno,cid,name,"desc",coll FROM pragma_index_xinfo(?) WHERE "key"=1 ORDER BY seqno LIMIT 4',
        [name]
      )
      const keys = name === removed ? [columns[0]] : columns
      if (
        parts.length !== keys.length ||
        parts.some(
          (part, i) =>
            part.seqno !== i || part.cid < 0 || part.name !== keys[i] || part.desc !== 0 || part.coll !== 'BINARY'
        )
      )
        invalid()
    }
    const plan: Array<{ detail: string }> = await k.raw(
      'EXPLAIN QUERY PLAN SELECT _rowid_ FROM main.?? INDEXED BY ?? WHERE ??=? LIMIT 8',
      [table, kept, columns[0], 'probe']
    )
    if (
      plan.length !== 1 ||
      (!plan[0].detail.startsWith(`SEARCH main.${table} USING `) &&
        !plan[0].detail.startsWith(`SEARCH ${table} USING `)) ||
      !plan[0].detail.includes(`INDEX ${kept} (`)
    )
      invalid()
  }
  let savepoint = false
  try {
    await k.raw('SAVEPOINT __brc38_native_target_index_compaction')
    savepoint = true
    for (const [, removed] of replacements) {
      check()
      await k.raw('DROP INDEX main.??', [removed])
    }
    check()
    if (
      (
        await k('main.sqlite_schema')
          .whereIn(
            'name',
            replacements.map(([, removed]) => removed)
          )
          .count({ count: '*' })
          .first()
      )?.count !== 0
    )
      invalid()
    await k.raw('RELEASE __brc38_native_target_index_compaction')
    savepoint = false
  } catch (cause) {
    if (savepoint) {
      try {
        await k.raw('ROLLBACK TO __brc38_native_target_index_compaction')
        await k.raw('RELEASE __brc38_native_target_index_compaction')
      } catch (error_) {
        throw new AggregateError([cause, error_], 'Native target index compaction and rollback failed')
      }
    }
    throw cause
  }
  check()
}
