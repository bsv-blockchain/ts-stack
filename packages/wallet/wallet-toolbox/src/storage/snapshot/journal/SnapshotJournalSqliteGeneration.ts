import type { Knex } from 'knex'
import { createHash, randomUUID } from 'node:crypto'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { runInSeries } from '../../../utility/runInSeries'
import { numeric } from '../../schema/snapshotSqliteMembership'
import { names, metadata as indexMetadata } from '../../schema/snapshotSqliteIndexGeneration'
import { readGenerationIndexState } from '../../schema/snapshotSqliteIndexState'
import { SNAPSHOT_JOURNAL_SQLITE_CLOCK_DDL } from './SnapshotJournalSqliteClock'
import {
  snapshotJournalSqliteObserverSql,
  SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL
} from './SnapshotJournalSqliteObservers'
import { SNAPSHOT_JOURNAL_BOOTSTRAP_DDL } from './SnapshotJournalBootstrap'
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
const local = (k: Knex) => k.client.config.client === 'sqlite3' || k.client.config.client === 'better-sqlite3'
async function plan(k: Knex, config?: Knex.MigratorConfig): Promise<Plan> {
  if (!local(k) || (await readGenerationIndexState(k, config)) !== 'v2') return invalid()
  const ddl = [
    SNAPSHOT_JOURNAL_SQLITE_GENERATION_DDL,
    SNAPSHOT_JOURNAL_SQLITE_CLOCK_DDL,
    ...SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL,
    SNAPSHOT_JOURNAL_BOOTSTRAP_DDL,
    ...(await snapshotJournalSqliteObserverSql(k))
  ]
  const objects = ddl.map(sql => {
    const match = /^CREATE (TABLE|INDEX|TRIGGER) (snapshot_journal_[A-Za-z0-9_]+)/.exec(sql)
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
  const rows: SchemaObject[] = await k('sqlite_master')
    .whereIn('tbl_name', sources)
    .select('type', 'name', 'tbl_name', k.raw('substr(sql,1,65537) AS sql'))
    .orderBy(['type', 'name'])
    .limit(513)
  if (rows.length > 512 || rows.some(row => row.sql !== null && Buffer.byteLength(row.sql, 'utf8') > 65536))
    return invalid()
  if (['users', 'settings'].some(table => !rows.some(row => row.type === 'table' && row.name === table)))
    return invalid()
  const expectedNames = new Set(objects.map(object => object.name))
  const source = JSON.stringify(rows.filter(row => !expectedNames.has(row.name)))
  if (Buffer.byteLength(source, 'utf8') > 1048576) return invalid()
  return {
    source: createHash('sha256').update('snapshot-journal-sqlite-source-v1\n').update(source).digest('hex'),
    objects
  }
}
async function reserved(k: Knex): Promise<SchemaObject[]> {
  return await k('sqlite_master')
    .whereRaw('lower(substr(name,1,17))=?', ['snapshot_journal_'])
    .select('type', 'name', 'tbl_name', k.raw('substr(sql,1,65537) AS sql'))
    .orderBy(['type', 'name'])
    .limit(513)
}
async function validate(k: Knex, p: Plan): Promise<SnapshotJournalSqliteGeneration> {
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
    (row.complete === 1 && position.stream !== 17)
  )
    return invalid()
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
  config?: Knex.MigratorConfig
): Promise<SnapshotJournalSqliteGeneration> {
  if (!local(k) || snapshotJournalRevision(ceiling) === '0') return invalid()
  return await k.transaction(async t => {
    if ((await readGenerationIndexState(t, config)) !== 'v2') return invalid()
    await t(indexMetadata)
      .where('id', 0)
      .update({ complete: t.ref('complete') })
    const p = await plan(t, config),
      existing = await reserved(t)
    if (existing.length) {
      const current = await validate(t, p)
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
    await t('snapshot_journal_bootstrap').insert({ id: 1, stream: 0, cursor: null })
    return await validate(t, p)
  })
}

/** Validate in the caller's pinned view; migration publication remains a separate prerequisite. */
export async function readSnapshotJournalSqliteGeneration(
  k: Knex,
  config?: Knex.MigratorConfig
): Promise<SnapshotJournalSqliteGeneration> {
  return await validate(k, await plan(k, config))
}

/** Atomic completion cannot be inferred from a caller's last-page acknowledgement. */
export async function completeSnapshotJournalSqliteGeneration(
  k: Knex,
  config?: Knex.MigratorConfig
): Promise<SnapshotJournalSqliteGeneration> {
  if (!local(k)) return invalid()
  return await k.transaction(async t => {
    await t(indexMetadata)
      .where('id', 0)
      .update({ complete: t.ref('complete') })
    const p = await plan(t, config),
      state = await validate(t, p)
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
