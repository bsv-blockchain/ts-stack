import { hasSnapshotSqliteCellComparison } from '../../schema/snapshotSqliteCellComparison'
import { snapshotJournalNativePointerDefinitions } from './SnapshotJournalPackedPointerGroup'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import {
  snapshotJournalReceiptDdl,
  snapshotJournalReceiptPolicy,
  type SnapshotJournalReceiptPolicy
} from './SnapshotJournalReceipt'
import type { Knex } from 'knex'
import { createHash, randomUUID } from 'node:crypto'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { runInSeries } from '../../../utility/runInSeries'
import { snapshotArchiveDatabaseNow } from '../archive/SnapshotArchiveSql'
import { numeric } from '../../schema/snapshotSqliteMembership'
import { names, metadata as indexMetadata } from '../../schema/snapshotSqliteIndexGeneration'
import { readGenerationIndexState } from '../../schema/snapshotSqliteIndexState'
import { SNAPSHOT_JOURNAL_SQLITE_CLOCK_DDL } from './SnapshotJournalSqliteClock'
import {
  snapshotJournalSqliteObserverSql,
  SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL,
  SNAPSHOT_JOURNAL_SQLITE_COMPACT_METADATA_DDL,
  SNAPSHOT_JOURNAL_SQLITE_SHARED_EFFECT_DDL,
  SNAPSHOT_JOURNAL_SQLITE_SHARED_EVENT_DDL,
  SNAPSHOT_JOURNAL_SQLITE_SHARED_SOURCE_EVENT_DDL,
  SNAPSHOT_JOURNAL_SQLITE_POSITIONAL_SOURCE_EVENT_DDL,
  snapshotJournalPositionalEventSql,
  snapshotJournalSharedClockObserverSql
} from './SnapshotJournalSqliteObservers'
import { SNAPSHOT_JOURNAL_BOOTSTRAP_DDL, validSnapshotJournalBootstrapBudget } from './SnapshotJournalBootstrap'
import {
  snapshotJournalRevision,
  compareSnapshotJournalRevisions,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'

export const SNAPSHOT_JOURNAL_SQLITE_GENERATION = 'snapshot_journal_generation'
export const SNAPSHOT_JOURNAL_SQLITE_GENERATION_DDL =
  'CREATE TABLE snapshot_journal_generation(id INTEGER NOT NULL PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1),epoch TEXT NOT NULL,source TEXT NOT NULL,ceiling TEXT NOT NULL,complete INTEGER NOT NULL CHECK(complete IN (0,1)))'
interface ObjectDefinition {
  type: string
  name: string
  sql: string
}
interface SchemaObject {
  type: string
  name: string
  tbl_name: string
  sql: string | null
}
interface Plan {
  source: string
  objects: ObjectDefinition[]
}
export interface SnapshotJournalSqliteGeneration {
  epoch: string
  source: string
  ceiling: SnapshotJournalRevision
  complete: boolean
  enabled: boolean
}
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or unowned SQLite snapshot journal generation')
}
const local = (k: Knex) =>
  k.client.config.client === 'sqlite3' || k.client.config.client === 'better-sqlite3' || isOwnedNativeSqlite(k)
/** Read the complete schema in one retained view without putting all DDL in a
 * native IPC response. Small rows share one at-most-16KiB BLOB response; larger
 * rows retain individual byte chunks. Positions and lengths are DATA, never
 * admission or ownership. Literal whitespace and UTF-8 boundaries are exact. */
export async function readBoundedSnapshotJournalSqliteSchema(
  k: Knex.Transaction,
  sources: readonly string[] | null,
  excludedSourceNames: ReadonlySet<string> = new Set()
): Promise<SchemaObject[]> {
  const check = (): void => {
    if (!k.isTransaction || !local(k)) invalid()
  }
  check()
  const selection = k('sqlite_master')
  if (sources === null)
    selection
      .where(function () {
        void this.whereRaw('lower(substr(name,1,17))=?', ['snapshot_journal_']).orWhereRaw(
          'lower(substr(tbl_name,1,17))=?',
          ['snapshot_journal_']
        )
      })
      .whereRaw('substr(name,1,17)<>?', ['sqlite_autoindex_'])
  else selection.whereIn('tbl_name', [...sources])
  const positions: Array<{ position: string }> = await selection
    .select(k.raw('CAST(rowid AS TEXT) AS position'))
    .orderBy(['type', 'name'])
    .limit(513)
  if (positions.length > 512) invalid()
  const rows: SchemaObject[] = []
  let sourceBytes = 2
  type Lengths = Record<'type' | 'name' | 'tbl_name' | 'sql', number | null> &
    Record<'type_bytes' | 'name_bytes' | 'tbl_name_bytes' | 'sql_bytes', unknown>
  const columns = ['type', 'name', 'tbl_name', 'sql'] as const
  let nativeBatch = new Map<string, Lengths>()
  const prepareNativeBatch = async (selected: readonly { position: string }[]): Promise<Map<string, Lengths>> => {
    check()
    const coordinates = selected.map(row => row.position)
    if (coordinates.some(value => typeof value !== 'string' || !/^-?(0|[1-9][0-9]{0,18})$/.test(value))) invalid()
    const metadata = (await k('sqlite_master')
      .whereIn('rowid', coordinates)
      .select(
        k.raw('CAST(rowid AS TEXT) AS position'),
        ...columns.map(column => k.raw('length(CAST(?? AS BLOB)) AS ??', [column, column]))
      )
      .limit(9)) as Array<Lengths & { position: string }>
    check()
    const values = new Map<string, Lengths>()
    if (metadata.length !== coordinates.length) invalid()
    for (const row of metadata) {
      if (!coordinates.includes(row.position) || values.has(row.position)) invalid()
      for (const column of columns) {
        const length = row[column]
        if (length === null) {
          if (column !== 'sql') invalid()
        } else if (!Number.isSafeInteger(length) || length < 0 || length > (column === 'sql' ? 65536 : 1048576))
          invalid()
      }
      values.set(row.position, row)
    }
    let group: string[] = [],
      bytes = 0
    const transfer = async (): Promise<void> => {
      if (group.length === 0) return
      check()
      // Recheck the actual aggregate in SQL before placing BLOBs in a response.
      // The lengths are temporary data in this retained view, not authority.
      const total = k('sqlite_master')
        .whereIn('rowid', group)
        .select(
          k.raw(
            'coalesce(sum(coalesce(length(CAST(type AS BLOB)),0)+coalesce(length(CAST(name AS BLOB)),0)+coalesce(length(CAST(tbl_name AS BLOB)),0)+coalesce(length(CAST(sql AS BLOB)),0)),0)'
          )
        )
      const blobs = (await k('sqlite_master')
        .whereIn('rowid', group)
        .select(
          k.raw('CAST(rowid AS TEXT) AS position'),
          ...columns.map(column =>
            k.raw('CASE WHEN (?)<=16384 THEN CAST(?? AS BLOB) END AS ??', [total, column, `${column}_bytes`])
          )
        )
        .limit(9)) as Array<Lengths & { position: string }>
      check()
      if (blobs.length !== group.length) invalid()
      const seen = new Set<string>()
      for (const row of blobs) {
        if (!group.includes(row.position) || seen.has(row.position)) invalid()
        seen.add(row.position)
        const value = values.get(row.position)!
        for (const column of columns) {
          const blob = row[`${column}_bytes`],
            length = value[column]
          if (length === null ? blob !== null : !Buffer.isBuffer(blob) || blob.length !== length) invalid()
          value[`${column}_bytes`] = blob
        }
      }
      group = []
      bytes = 0
    }
    for (const { position } of selected) {
      check()
      const value = values.get(position)!,
        amount = columns.reduce((sum, column) => sum + (value[column] ?? 0), 0)
      if (amount > 16384) {
        await transfer()
        continue // This row retains the original individual chunk path.
      }
      if (group.length !== 0 && amount > 16384 - bytes) await transfer()
      group.push(position)
      bytes += amount
    }
    await transfer()
    return values
  }
  for (const [rowIndex, { position }] of positions.entries()) {
    check()
    if (typeof position !== 'string' || !/^-?(0|[1-9][0-9]{0,18})$/.test(position)) invalid()
    if (isOwnedNativeSqlite(k) && rowIndex % 8 === 0)
      nativeBatch = await prepareNativeBatch(positions.slice(rowIndex, rowIndex + 8))
    const combinedLength = columns.map(() => 'coalesce(length(CAST(?? AS BLOB)),0)').join('+'),
      lengths =
        nativeBatch.get(position) ??
        ((await k('sqlite_master')
          .where('rowid', position)
          .select(
            columns.flatMap(column => [
              k.raw('length(CAST(?? AS BLOB)) AS ??', [column, column]),
              k.raw(`CASE WHEN ${combinedLength}<=16384 THEN CAST(?? AS BLOB) END AS ??`, [
                ...columns,
                column,
                `${column}_bytes`
              ])
            ])
          )
          .first()) as
          | (Record<(typeof columns)[number], number | null> & Record<`${(typeof columns)[number]}_bytes`, unknown>)
          | undefined)
    if (lengths === undefined) invalid()
    const combined = columns.reduce((total, column) => total + (lengths[column] ?? 0), 0)
    const read = async (column: (typeof columns)[number]): Promise<string | null> => {
      check()
      const length = lengths[column]
      if (length === null) {
        if (column !== 'sql') invalid()
        return null
      }
      // Names cannot exceed the original complete source JSON bound; SQL keeps
      // its original per-definition bound. Neither limit increases IPC size.
      if (!Number.isSafeInteger(length) || length < 0 || length > (column === 'sql' ? 65536 : 1048576)) invalid()
      const chunks: Buffer[] = []
      if (combined <= 16384) {
        const part = lengths[`${column}_bytes`]
        if (!Buffer.isBuffer(part) || part.length !== length) invalid()
        chunks.push(part)
      } else {
        for (let offset = 0; offset < length; offset += 16384) {
          check()
          const count = Math.min(16384, length - offset),
            part = (await k('sqlite_master')
              .where('rowid', position)
              .select(k.raw('substr(CAST(?? AS BLOB),?,?) AS chunk', [column, offset + 1, count]))
              .first()) as { chunk: unknown } | undefined
          if (!Buffer.isBuffer(part?.chunk) || part.chunk.length !== count) invalid()
          chunks.push(part.chunk)
        }
      }
      try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, length))
      } catch {
        return invalid()
      }
    }
    const type = await read('type'),
      name = await read('name'),
      table = await read('tbl_name')
    if (type === null || name === null || table === null) invalid()
    const row = { type, name, tbl_name: table, sql: await read('sql') }
    if (sources !== null && !excludedSourceNames.has(name)) {
      sourceBytes += Buffer.byteLength(JSON.stringify(row), 'utf8') + (sourceBytes === 2 ? 0 : 1)
      if (sourceBytes > 1048576) invalid()
    }
    rows.push(row)
  }
  check()
  return rows
}
/** A fresh genuine receiver selects the compact authored layout. Existing
 * native generations retain their exact complete pair of anchor definitions;
 * mixed, altered and shadowed objects never select a new source plan. */
async function nativeJournalLayout(
  k: Knex
): Promise<'original' | 'clock-shared' | 'effects-shared' | 'events-shared' | 'sources-shared' | 'sources-positional'> {
  if (!isOwnedNativeSqlite(k)) return 'original'
  if (!k.isTransaction) return invalid()
  if (
    (
      await k('sqlite_temp_schema')
        .whereRaw('lower(substr(name,1,17))=?', ['snapshot_journal_'])
        .select('name')
        .limit(1)
    ).length !== 0
  )
    return invalid()
  const names = ['snapshot_journal_physical', 'snapshot_journal_scope'],
    rows: Array<{ type: string; name: string; sql: string }> = await k('main.sqlite_schema')
      .whereIn('name', names)
      .select('type', 'name', k.raw('CASE WHEN length(CAST(sql AS BLOB))<=4096 THEN sql END AS sql'))
      .limit(3)
  if (rows.length === 0) return 'sources-positional'
  if (rows.length !== 2 || rows.some(row => row.type !== 'table')) return invalid()
  const matches = (definitions: readonly string[]): boolean => {
    const expected = new Map(definitions.map(sql => [/^CREATE TABLE (\w+)/.exec(sql)![1], sql]))
    return rows.every(row => expected.get(row.name) === row.sql)
  }
  if (matches(SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL.slice(0, 2))) return 'original'
  if (!matches(SNAPSHOT_JOURNAL_SQLITE_COMPACT_METADATA_DDL.slice(0, 2))) return invalid()
  const families = [
    ['effects-shared', SNAPSHOT_JOURNAL_SQLITE_SHARED_EFFECT_DDL],
    ['events-shared', [...SNAPSHOT_JOURNAL_SQLITE_SHARED_EFFECT_DDL, ...SNAPSHOT_JOURNAL_SQLITE_SHARED_EVENT_DDL]],
    [
      'sources-shared',
      [...SNAPSHOT_JOURNAL_SQLITE_SHARED_EFFECT_DDL, ...SNAPSHOT_JOURNAL_SQLITE_SHARED_SOURCE_EVENT_DDL]
    ],
    [
      'sources-positional',
      [...SNAPSHOT_JOURNAL_SQLITE_SHARED_EFFECT_DDL, ...SNAPSHOT_JOURNAL_SQLITE_POSITIONAL_SOURCE_EVENT_DDL]
    ]
  ] as const
  const definitions = (family: readonly string[]) =>
    new Map(
      family.map(sql => {
        const match = /^CREATE (VIEW|TRIGGER) (\w+)/.exec(sql)!
        return [match[2], { type: match[1].toLowerCase(), sql }]
      })
    )
  const helperNames = new Set(families.flatMap(([, family]) => [...definitions(family).keys()]))
  const helpers: Array<{ type: string; name: string; sql: string }> = await k('main.sqlite_schema')
    .whereIn('name', [...helperNames])
    .select('type', 'name', k.raw('CASE WHEN length(CAST(sql AS BLOB))<=16384 THEN sql END AS sql'))
    .limit(helperNames.size + 1)
  if (helpers.length === 0) return 'clock-shared'
  for (const [layout, family] of families) {
    const expected = definitions(family)
    if (
      helpers.length === expected.size &&
      helpers.every(row => expected.get(row.name)?.type === row.type && expected.get(row.name)?.sql === row.sql)
    )
      return layout
  }
  return invalid()
}
async function plan(k: Knex, config?: Knex.MigratorConfig): Promise<Plan> {
  if (!local(k) || (await readGenerationIndexState(k, config)) !== 'v2') return invalid()
  const layout = await nativeJournalLayout(k),
    compact = layout !== 'original',
    positional = layout === 'sources-positional',
    shared = layout === 'effects-shared' || layout === 'events-shared' || layout === 'sources-shared' || positional,
    events = layout === 'events-shared' || layout === 'sources-shared' || positional,
    projectedSources = layout === 'sources-shared' || positional,
    historicalObservers = await snapshotJournalSqliteObserverSql(k, shared, events)
  let observers = historicalObservers
  if (projectedSources) {
    const nativeCells = await hasSnapshotSqliteCellComparison(k)
    const cellObservers = await snapshotJournalSqliteObserverSql(k, shared, events, true)
    const probeName = 'snapshot_journal_physical_0_UPDATE'
    const expected = (definitions: string[]) =>
      (positional ? snapshotJournalPositionalEventSql(definitions) : definitions).find(sql =>
        sql.startsWith(`CREATE TRIGGER ${probeName} `)
      )!
    const installed = (await k('main.sqlite_schema').where({ type: 'trigger', name: probeName }).first('sql')) as
      { sql: string } | undefined
    if (installed === undefined) observers = nativeCells ? cellObservers : historicalObservers
    else if (nativeCells && installed.sql === expected(cellObservers)) observers = cellObservers
    else if (installed.sql !== expected(historicalObservers)) return invalid()
  }
  const originalDdl = [
    SNAPSHOT_JOURNAL_SQLITE_GENERATION_DDL,
    SNAPSHOT_JOURNAL_SQLITE_CLOCK_DDL,
    ...(compact ? SNAPSHOT_JOURNAL_SQLITE_COMPACT_METADATA_DDL : SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL),
    SNAPSHOT_JOURNAL_BOOTSTRAP_DDL,
    ...snapshotJournalReceiptDdl(k),
    ...(shared ? SNAPSHOT_JOURNAL_SQLITE_SHARED_EFFECT_DDL : []),
    ...(compact ? snapshotJournalSharedClockObserverSql(observers, events, projectedSources) : observers)
  ]
  const ddl = positional
    ? await snapshotJournalNativePointerDefinitions(k, snapshotJournalPositionalEventSql(originalDdl))
    : originalDdl
  const objects = ddl.map(sql => {
    const match = /^CREATE (TABLE|INDEX|TRIGGER|VIEW) (snapshot_journal_\w+)/.exec(sql)
    if (!match) return invalid()
    return { type: match[1].toLowerCase(), name: match[2], sql }
  })
  const sources = [
    ...numeric.map(source => source.table),
    'tx_labels_map',
    'output_tags_map',
    'certificate_fields',
    'users',
    'settings',
    ...Object.values(names)
  ]
  const expectedNames = new Set(objects.map(object => object.name))
  const rows: SchemaObject[] = isOwnedNativeSqlite(k)
    ? await readBoundedSnapshotJournalSqliteSchema(k as Knex.Transaction, sources, expectedNames)
    : await k('sqlite_master')
        .whereIn('tbl_name', sources)
        .select('type', 'name', 'tbl_name', k.raw('substr(sql,1,65537) AS sql'))
        .orderBy(['type', 'name'])
        .limit(513)
  if (rows.length > 512 || rows.some(row => row.sql !== null && Buffer.byteLength(row.sql, 'utf8') > 65536))
    return invalid()
  if (['users', 'settings'].some(table => !rows.some(row => row.type === 'table' && row.name === table)))
    return invalid()
  const source = JSON.stringify(rows.filter(row => !expectedNames.has(row.name)))
  if (Buffer.byteLength(source, 'utf8') > 1048576) return invalid()
  return {
    source: createHash('sha256').update('snapshot-journal-sqlite-source-v1\n').update(source).digest('hex'),
    objects
  }
}
async function reserved(k: Knex): Promise<SchemaObject[]> {
  if (isOwnedNativeSqlite(k)) return await readBoundedSnapshotJournalSqliteSchema(k as Knex.Transaction, null)
  return await k('sqlite_master')
    .where(function () {
      void this.whereRaw('lower(substr(name,1,17))=?', ['snapshot_journal_']).orWhereRaw(
        'lower(substr(tbl_name,1,17))=?',
        ['snapshot_journal_']
      )
    })
    .whereRaw('substr(name,1,17)<>?', ['sqlite_autoindex_'])
    .select('type', 'name', 'tbl_name', k.raw('substr(sql,1,65537) AS sql'))
    .orderBy(['type', 'name'])
    .limit(513)
}

/** Erasure only, after physical source sessions drain. Verify every owned
 * definition before dropping observers, then auxiliary tables. No data value or
 * caller-supplied schema description can authorize adopting a different object. */
export async function dropSnapshotJournalSqliteForDataDeletion(k: Knex, config?: Knex.MigratorConfig): Promise<void> {
  if (!local(k)) return invalid()
  await k.transaction(async trx => {
    const actual = await reserved(trx)
    if (!actual.length) return
    const expected = (await plan(trx, config)).objects
    if (
      actual.length !== expected.length ||
      actual.some(
        object =>
          !expected.some(value => value.name === object.name && value.type === object.type && value.sql === object.sql)
      )
    )
      return invalid()
    for (const object of expected.filter(value => value.type === 'trigger').reverse())
      await trx.raw('DROP TRIGGER ??', [object.name])
    for (const object of expected.filter(value => value.type === 'view').reverse())
      await trx.raw('DROP VIEW ??', [object.name])
    for (const object of expected.filter(value => value.type === 'table').reverse())
      await trx.schema.dropTable(object.name)
  })
}
async function validateBootstrap(k: Knex, complete: number): Promise<void> {
  const positions = await k('snapshot_journal_bootstrap').select('*').limit(2)
  if (positions.length !== 1) return invalid()
  const position = positions[0]
  if (
    position.id !== 1 ||
    !Number.isInteger(position.stream) ||
    position.stream < 0 ||
    position.stream > 17 ||
    !(
      position.cursor === null ||
      (typeof position.cursor === 'string' && Buffer.byteLength(position.cursor, 'utf8') <= 2048)
    ) ||
    (position.stream === 17 && position.cursor !== null) ||
    (complete === 1 && position.stream !== 17) ||
    !validSnapshotJournalBootstrapBudget(position) ||
    (position.rowLimit === null && (position.stream !== 0 || position.cursor !== null))
  )
    return invalid()
}
async function validateRetention(
  k: Knex,
  policy: SnapshotJournalReceiptPolicy,
  ceiling: SnapshotJournalRevision
): Promise<void> {
  const retention = await k('snapshot_journal_retention')
    .select('id', 'receiptLimit', 'receiptLifetimeMs', k.raw('substr(??,1,20) AS ??', ['floor', 'floor']))
    .limit(2)
  if (
    retention.length !== 1 ||
    retention[0].id !== 1 ||
    retention[0].receiptLimit !== policy.receiptLimit ||
    retention[0].receiptLifetimeMs !== policy.receiptLifetimeMs ||
    compareSnapshotJournalRevisions(snapshotJournalRevision(retention[0].floor), ceiling) > 0
  )
    return invalid()
  const receipts = await k('snapshot_journal_receipts')
    .select(k.raw('1 AS occupied'))
    .limit(policy.receiptLimit + 1)
  if (receipts.length > policy.receiptLimit) return invalid()
}
async function validate(
  k: Knex,
  p: Plan,
  policy: SnapshotJournalReceiptPolicy
): Promise<SnapshotJournalSqliteGeneration> {
  const actual = await reserved(k)
  if (actual.length !== p.objects.length) return invalid()
  for (const expected of p.objects) {
    const matches = actual.filter(object => object.name === expected.name && object.type === expected.type)
    if (matches.length !== 1 || matches[0].sql !== expected.sql) return invalid()
  }
  const rows = await k(SNAPSHOT_JOURNAL_SQLITE_GENERATION).select('*').limit(2)
  if (rows.length !== 1) return invalid()
  const row = rows[0]
  if (
    row.id !== 1 ||
    row.version !== 1 ||
    typeof row.epoch !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.epoch) ||
    row.source !== p.source ||
    ![0, 1].includes(row.complete)
  )
    return invalid()
  const ceiling = snapshotJournalRevision(row.ceiling)
  if (ceiling === '0') return invalid()
  const clocks = await k('snapshot_journal_clock')
    .select('id', 'enabled', 'reason', k.raw('CAST(revision AS TEXT) revision'), k.raw('CAST(ceiling AS TEXT) ceiling'))
    .limit(2)
  if (
    clocks.length !== 1 ||
    clocks[0].id !== 1 ||
    clocks[0].ceiling !== ceiling ||
    compareSnapshotJournalRevisions(snapshotJournalRevision(clocks[0].revision), ceiling) > 0
  )
    return invalid()
  const clock = clocks[0]
  if (
    clock.enabled === 1
      ? clock.reason !== null
      : clock.enabled !== 0 || !['capacity-exhausted', 'revision-exhausted', 'key-out-of-range'].includes(clock.reason)
  )
    return invalid()
  await validateBootstrap(k, row.complete)
  await validateRetention(k, policy, ceiling)
  return {
    epoch: row.epoch,
    source: p.source,
    ceiling,
    complete: row.complete === 1,
    enabled: clock.enabled === 1
  }
}

/** Owned atomic SQLite installation. It does not advertise a reader or register a migration. */
export async function installSnapshotJournalSqliteGeneration(
  k: Knex,
  ceiling: SnapshotJournalRevision,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  config?: Knex.MigratorConfig
): Promise<SnapshotJournalSqliteGeneration> {
  const policy = snapshotJournalReceiptPolicy(receiptPolicy)
  if (!local(k) || snapshotJournalRevision(ceiling) === '0') return invalid()
  return await k.transaction(async t => {
    if ((await readGenerationIndexState(t, config)) !== 'v2') return invalid()
    await t(indexMetadata)
      .where('id', 0)
      .update({ complete: t.ref('complete') })
    const p = await plan(t, config),
      existing = await reserved(t)
    if (existing.length) {
      const current = await validate(t, p, policy)
      if (current.ceiling !== ceiling) return invalid()
      return current
    }
    await runInSeries(p.objects, async object => {
      await t.raw(object.sql)
    })
    const epoch = randomUUID()
    await t(SNAPSHOT_JOURNAL_SQLITE_GENERATION).insert({
      id: 1,
      version: 1,
      epoch,
      source: p.source,
      ceiling,
      complete: 0
    })
    await t('snapshot_journal_clock').insert({
      id: 1,
      revision: 0,
      ceiling,
      enabled: 1,
      reason: null
    })
    await t('snapshot_journal_bootstrap').insert({ id: 1, stream: 0, cursor: null, rowLimit: null, rowsUsed: 0 })
    await t('snapshot_journal_retention').insert({ id: 1, floor: '0', ...policy })
    return await validate(t, p, policy)
  })
}

/** Validate in the caller's pinned view; migration publication remains a separate prerequisite. */
export async function readSnapshotJournalSqliteGeneration(
  k: Knex,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  config?: Knex.MigratorConfig
): Promise<SnapshotJournalSqliteGeneration> {
  const policy = snapshotJournalReceiptPolicy(receiptPolicy)
  if (isOwnedNativeSqlite(k) && !k.isTransaction)
    return await k.transaction(async trx => await validate(trx, await plan(trx, config), policy))
  return await validate(k, await plan(k, config), policy)
}

/** A source-owned additive schema migration may retain journal events, floor,
 * bootstrap progress and data generations. It must first drain every live
 * receipt, then validate both complete old and new object plans in the same
 * SQLite writer. Rotate the epoch so no old source binding can be resumed. */
export async function migrateSnapshotJournalSqliteSourceAddition(
  k: Knex,
  apply: () => Promise<void>,
  config?: Knex.MigratorConfig
): Promise<void> {
  if (!k.isTransaction || !local(k)) return invalid()
  if (!(await k.schema.hasTable(SNAPSHOT_JOURNAL_SQLITE_GENERATION))) {
    await apply()
    return
  }
  const policies: Array<{ receiptLimit: unknown; receiptLifetimeMs: unknown }> = await k('snapshot_journal_retention')
    .select('receiptLimit', 'receiptLifetimeMs')
    .where('id', 1)
    .limit(2)
  if (policies.length !== 1) return invalid()
  const policy = snapshotJournalReceiptPolicy({
    receiptLimit: Number(policies[0].receiptLimit),
    receiptLifetimeMs: Number(policies[0].receiptLifetimeMs)
  })
  const oldPlan = await plan(k, config)
  const before = await validate(k, oldPlan, policy)
  if (!before.enabled || !before.complete) return invalid()
  const now = await snapshotArchiveDatabaseNow(k)
  if ((await k('snapshot_journal_receipts').where('expiresAt', '>', now).select('requestId').limit(1)).length)
    throw new WERR_INVALID_OPERATION('Drain live journal captures before changing their source schema')
  await apply()
  const next = await plan(k, config)
  if (JSON.stringify(oldPlan.objects) !== JSON.stringify(next.objects)) return invalid()
  if (
    (await k(SNAPSHOT_JOURNAL_SQLITE_GENERATION)
      .where({ id: 1, source: before.source, epoch: before.epoch })
      .update({ source: next.source, epoch: randomUUID() })) !== 1
  )
    return invalid()
  await validate(k, next, policy)
}

/** Atomic completion cannot be inferred from a caller's last-page acknowledgement. */
export async function completeSnapshotJournalSqliteGeneration(
  k: Knex,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  config?: Knex.MigratorConfig
): Promise<SnapshotJournalSqliteGeneration> {
  const policy = snapshotJournalReceiptPolicy(receiptPolicy)
  if (!local(k)) return invalid()
  return await k.transaction(async t => {
    await t(indexMetadata)
      .where('id', 0)
      .update({ complete: t.ref('complete') })
    const p = await plan(t, config),
      state = await validate(t, p, policy)
    const progress = await t('snapshot_journal_bootstrap').select('*').limit(2)
    const clock = await t('snapshot_journal_clock').where('id', 1).first('enabled')
    if (
      progress.length !== 1 ||
      progress[0].id !== 1 ||
      progress[0].stream !== 17 ||
      progress[0].cursor !== null ||
      clock.enabled !== 1
    )
      return invalid()
    await t(SNAPSHOT_JOURNAL_SQLITE_GENERATION).where('id', 1).update({ complete: 1 })
    return { ...state, complete: true }
  })
}
