import type { Knex } from 'knex'
import { isOwnedPrivateNativeSqlite } from './privateNativeSqliteRuntimeNode'

type ArchiveTable = 'snapshot_archive_pages' | 'snapshot_archive_requests'
const original: Record<ArchiveTable, readonly string[]> = {
  snapshot_archive_pages: [
    'create table `snapshot_archive_pages` (`archiveId` varchar(64) not null, `sequence` integer not null, `tableName` varchar(32) not null, `rows` integer not null, `done` boolean not null, `digest` varchar(64) not null, `payload` BLOB not null, primary key (`archiveId`, `sequence`))'
  ],
  snapshot_archive_requests: [
    'create table `snapshot_archive_requests` (`identityKey` varchar(130) not null, `requestId` varchar(64) not null, `claimToken` varchar(64) not null, `state` varchar(16) not null, `requestJson` varchar(512) not null, `expiresAt` bigint not null, `reservedBytes` bigint not null, `archiveId` varchar(64) null, `released` boolean not null, primary key (`identityKey`, `requestId`))',
    'create index `snapshot_archive_requests_expiresat_index` on `snapshot_archive_requests` (`expiresAt`)'
  ]
}
function invalid(): never {
  throw new Error('Native archive layout requires its exact fresh private migration')
}

/** Fixed creation DATA only. Existing non-NULL composite keys own one primary
 * tree. Archive pages use logical key reads, never native incremental rowid I/O.
 * Keep the original ordinary/occupied definitions separate and unchanged. */
export function snapshotNativeArchiveDefinitions(
  table: ArchiveTable,
  commands: readonly Readonly<{ sql: string; bindings?: readonly unknown[] }>[]
): readonly string[] {
  const expected = original[table]
  if (
    expected === undefined ||
    commands.length !== expected.length ||
    commands.some((command, index) => command.sql !== expected[index] || (command.bindings?.length ?? 0) !== 0)
  )
    invalid()
  return Object.freeze(expected.map((sql, index) => (index === 0 ? sql + ' WITHOUT ROWID' : sql)))
}

/** Called only for an absent table by its original migration. Ordinary drivers
 * execute the original builder; actual private native writers independently
 * fence generation publication, temporary shadows and the complete fixed DDL.
 * The outer migration transaction owns creation and rollback. */
export async function createSnapshotArchiveTable(
  k: Knex,
  table: ArchiveTable,
  builder: Knex.SchemaBuilder
): Promise<void> {
  if (!isOwnedPrivateNativeSqlite(k)) {
    await builder
    return
  }
  const deadline = performance.now() + 10000,
    actual: {
      isBrc38OwnedPrivateNativeWriter: (trx: Knex.Transaction) => boolean
    } = require('../portable/KnexBrc38StagingStore'),
    check = (): void => {
      if (!k.isTransaction || !actual.isBrc38OwnedPrivateNativeWriter(k as Knex.Transaction)) invalid()
      if (performance.now() >= deadline) invalid()
    },
    statements = snapshotNativeArchiveDefinitions(table, builder.toSQL()),
    names = [table, `${table}_expiresat_index`, `sqlite_autoindex_${table}_1`]
  check()
  if (
    (await k('main.sqlite_schema').where({ name: table }).select('name').limit(1)).length !== 0 ||
    (
      await k('main.sqlite_schema')
        .whereIn('name', [
          'snapshot_index_generation_v2',
          'snapshot_journal_generation',
          'brc38_local_baseline_clock',
          'private_native_restore'
        ])
        .select('name')
        .limit(1)
    ).length !== 0 ||
    (
      await k('sqlite_temp_schema')
        .where(query => {
          for (const name of names) void query.orWhereRaw('name=? COLLATE NOCASE', [name])
        })
        .orWhereRaw('tbl_name=? COLLATE NOCASE', [table])
        .select('name')
        .limit(1)
    ).length !== 0
  )
    invalid()
  for (const sql of statements) {
    check()
    await k.raw(sql)
  }
  check()
  const layout: Array<{ name: string; wr: number }> = await k.raw('PRAGMA main.table_list(??)', [table])
  if (layout.length !== 1 || layout[0].name !== table || layout[0].wr !== 1) invalid()
}
