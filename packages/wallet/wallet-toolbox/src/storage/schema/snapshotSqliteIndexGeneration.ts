import { runInSeries } from '../../utility/runInSeries'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { validateLegacy, legacySchema, retiredTables } from './snapshotSqliteLegacyOwnership'
import type { Knex } from 'knex'
import { readIdentity, identityDDL, type IdentityDefinition } from './snapshotSqliteIdentity'
import { numeric, relations, membershipTriggers, type MembershipNames } from './snapshotSqliteMembership'
import { validateSqliteSource } from './snapshotGlobalIndexSqlite'
import { snapshotGlobalIndexTriggers } from './snapshotGlobalIndexTriggers'
export const names: MembershipNames = {
  profile: 'snapshot_profile_keys_v2',
  relation: 'snapshot_relation_keys_v2',
  certificate: 'snapshot_certificate_field_keys_v2',
  edges: 'snapshot_global_edges_v2',
  keys: 'snapshot_global_keys_v2',
  guards: 'snapshot_global_guards_v2'
}
export const progress = 'snapshot_index_rebuild_v2'
export const metadata = 'snapshot_index_generation_v2'
export const oldProgress = [
  'snapshot_profile_index_progress',
  'snapshot_relation_index_progress',
  'snapshot_certificate_index_progress',
  'snapshot_global_index_progress'
]
const q = (name: string) => '"' + name.replaceAll('"', '""') + '"'
interface Part {
  name: string | null
  coll: string
  key: number
  desc: number
}
export interface Plan {
  identities: IdentityDefinition[]
  fieldCollation: string
  source: string
  ddl: string[]
  triggers: string[]
}
async function compositeOrder(k: Knex, table: string, columns: string[]): Promise<string> {
  const indexes: Array<{
    name: string
    unique: number
    partial: number
  }> = await k.raw('PRAGMA index_list(??)', [table])
  const unique = indexes.filter(index => index.unique !== 0)
  if (unique.length !== 1 || unique[0].partial !== 0)
    throw new WERR_INVALID_OPERATION('Unsupported composite identity constraints')
  const parts: Part[] = (await k.raw('PRAGMA index_xinfo(??)', [unique[0].name])).filter((part: Part) => part.key !== 0)
  if (
    parts.length !== columns.length ||
    parts.some(
      (part, i) => part.name !== columns[i] || part.desc !== 0 || !['BINARY', 'NOCASE', 'RTRIM'].includes(part.coll)
    ) ||
    parts.slice(table === 'certificate_fields' ? 1 : 0).some(part => part.coll !== 'BINARY')
  )
    throw new WERR_INVALID_OPERATION('Unsupported composite identity comparison')
  const plan: Array<{
    detail: string
  }> = await k.raw(
    `EXPLAIN QUERY PLAN SELECT ${columns.map(q).join(',')} FROM ${q(table)} INDEXED BY ${q(unique[0].name)} ORDER BY ${columns.map(q).join(',')} LIMIT 1`
  )
  if (plan.some(step => step.detail.includes('TEMP B-TREE')))
    throw new WERR_INVALID_OPERATION('Composite source order mismatch')
  return parts[0].coll
}
function tables(fieldCollation: string): string[] {
  const definitions: Array<[string, string, string[]]> = [
    [
      names.profile,
      'snapshotTableId INTEGER NOT NULL,snapshotUserId INTEGER NOT NULL,snapshotRowId INTEGER NOT NULL',
      ['snapshotTableId', 'snapshotUserId', 'snapshotRowId']
    ],
    [
      names.relation,
      'snapshotTableId INTEGER NOT NULL,snapshotUserId INTEGER NOT NULL,snapshotLeftId INTEGER NOT NULL,snapshotRightId INTEGER NOT NULL,snapshotMembership INTEGER NOT NULL',
      ['snapshotTableId', 'snapshotUserId', 'snapshotLeftId', 'snapshotRightId']
    ],
    [
      names.certificate,
      `snapshotUserId INTEGER NOT NULL,snapshotFieldName VARCHAR(100) COLLATE ${fieldCollation} NOT NULL,snapshotCertificateId INTEGER NOT NULL,snapshotMembership INTEGER NOT NULL`,
      ['snapshotUserId', 'snapshotFieldName', 'snapshotCertificateId']
    ],
    [
      names.edges,
      'transactionId INTEGER NOT NULL,requestId INTEGER NOT NULL,tableId INTEGER NOT NULL,rowId INTEGER NOT NULL,userId INTEGER NOT NULL',
      ['transactionId', 'requestId', 'tableId', 'rowId']
    ],
    [
      names.keys,
      'tableId INTEGER NOT NULL,userId INTEGER NOT NULL,rowId INTEGER NOT NULL,refs BIGINT NOT NULL,present BOOLEAN NOT NULL',
      ['tableId', 'userId', 'rowId']
    ],
    [names.guards, 'proofId INTEGER NOT NULL,present BOOLEAN NOT NULL', ['proofId']],
    [
      progress,
      `stream INTEGER NOT NULL,afterId INTEGER NOT NULL,afterSecond INTEGER NOT NULL,afterText VARCHAR(100) COLLATE ${fieldCollation} NOT NULL,complete BOOLEAN NOT NULL`,
      ['stream']
    ],
    [
      metadata,
      'id INTEGER NOT NULL,source TEXT NOT NULL,complete BOOLEAN NOT NULL,legacy TEXT NOT NULL,retireTable INTEGER NOT NULL',
      ['id']
    ]
  ]
  const indexes: Array<[string, string, string[]]> = [
    [
      'snapshot_relation_right_v2',
      names.relation,
      ['snapshotTableId', 'snapshotUserId', 'snapshotRightId', 'snapshotLeftId']
    ],
    [
      'snapshot_relation_map_v2',
      names.relation,
      ['snapshotTableId', 'snapshotLeftId', 'snapshotRightId', 'snapshotUserId']
    ],
    [
      'snapshot_certificate_parent_v2',
      names.certificate,
      ['snapshotCertificateId', 'snapshotUserId', 'snapshotFieldName']
    ],
    [
      'snapshot_certificate_lookup_v2',
      names.certificate,
      ['snapshotFieldName', 'snapshotCertificateId', 'snapshotUserId']
    ],
    ['snapshot_global_page_v2', names.keys, ['tableId', 'userId', 'present', 'rowId']],
    ['snapshot_global_target_v2', names.keys, ['tableId', 'rowId', 'userId']],
    ['snapshot_global_request_v2', names.edges, ['requestId', 'transactionId']]
  ]
  return [
    ...definitions.map(
      ([name, columns, primary]) => `CREATE TABLE ${q(name)} (${columns},PRIMARY KEY (${primary.map(q).join(',')}))`
    ),
    ...indexes.map(([name, table, columns]) => `CREATE INDEX ${q(name)} ON ${q(table)} (${columns.map(q).join(',')})`)
  ]
}
export async function readPlan(k: Knex): Promise<Plan> {
  if (!String(k.client.config.client).includes('sqlite'))
    throw new WERR_INVALID_OPERATION('SQLite rebuild requires SQLite')
  await validateSqliteSource(k)
  const identities: IdentityDefinition[] = []
  await runInSeries(numeric, async source => {
    identities.push(await readIdentity(k, source))
  })
  await runInSeries(relations, async relation => {
    await compositeOrder(k, relation.table, [relation.leftKey, relation.rightKey])
  })
  const fieldCollation = await compositeOrder(k, 'certificate_fields', ['fieldName', 'certificateId'])
  const sources = [
    ...numeric.map(source => source.table),
    ...relations.map(relation => relation.table),
    'certificate_fields'
  ]
  const schema = await k('sqlite_master')
    .whereIn('tbl_name', sources)
    .whereIn('type', ['table', 'index'])
    .select('type', 'name', 'tbl_name', 'sql')
    .orderBy(['type', 'name'])
  const source = JSON.stringify(schema)
  const ddl = [...tables(fieldCollation), ...identities.flatMap(identityDDL)]
  const observer = snapshotGlobalIndexTriggers(false)
    .filter(trigger => trigger.table === 'snapshot_global_edges')
    .map(trigger =>
      trigger.sql
        .replaceAll('snapshot_global_edges', names.edges)
        .replaceAll('snapshot_global_keys', names.keys)
        .replaceAll('snapshot_global_guards', names.guards)
        .replaceAll('snapshot_global_edge_', 'snapshot_global_v2_edge_')
    )
  return {
    identities,
    fieldCollation,
    source,
    ddl,
    triggers: [...observer, ...membershipTriggers(identities, names)]
  }
}
async function validateInstallLock(k: Knex): Promise<void> {
  const lock = await k('sqlite_master').where({ type: 'table', name: 'snapshot_index_install_lock_v2' }).first('sql')
  if (lock?.sql !== 'CREATE TABLE snapshot_index_install_lock_v2(id INTEGER PRIMARY KEY)')
    throw new WERR_INVALID_OPERATION('Invalid rebuild lock definition')
}

/** Exact generated DDL ownership; never adopt a similarly named foreign object. */
export async function validateInstalled(k: Knex, plan: Plan): Promise<void> {
  await validateInstallLock(k)
  if ((await readPlan(k)).source !== plan.source) throw new WERR_INVALID_OPERATION('Rebuild source schema changed')
  const expected = [...plan.ddl, ...plan.triggers]
  await runInSeries(expected, async sql => {
    const match = /^CREATE (TABLE|INDEX|TRIGGER) ("[^"]+"|\w+)/.exec(sql)
    if (!match) throw new WERR_INVALID_OPERATION('Invalid generated schema definition')
    const name = match[2].replaceAll('"', '')
    const rows: Array<{
      sql: string
    }> = await k('sqlite_master').where({ type: match[1].toLowerCase(), name }).select('sql')
    if (rows.length !== 1 || rows[0].sql !== sql)
      throw new WERR_INVALID_OPERATION('Rebuild schema definition mismatch: ' + name)
  })
  const rows: Array<{
    id: number
    source: string
    complete: number
    legacy: string
    retireTable: number
  }> = await k(metadata).select('*').limit(2)
  if (
    rows.length !== 1 ||
    rows[0].id !== 0 ||
    rows[0].source !== plan.source ||
    ![0, 1].includes(rows[0].complete) ||
    !Number.isSafeInteger(rows[0].retireTable) ||
    rows[0].retireTable < 0 ||
    rows[0].retireTable > retiredTables.length ||
    typeof rows[0].legacy !== 'string'
  )
    throw new WERR_INVALID_OPERATION('Rebuild source binding mismatch')
}
/** Atomically install owned observers and invalidate the previous generation. */
export async function installGeneration(k: Knex, config?: Knex.MigratorConfig): Promise<Plan> {
  return await k.transaction(async trx => {
    // A harmless DDL write reserves SQLite's writer lock before schema observation.
    // The connection remains in this transaction until all observer swaps commit.
    await trx.raw('CREATE TABLE IF NOT EXISTS snapshot_index_install_lock_v2(id INTEGER PRIMARY KEY)')
    await validateInstallLock(trx)
    await trx.raw('UPDATE snapshot_index_install_lock_v2 SET id=id')
    const plan = await readPlan(trx)
    if (await trx.schema.hasTable(metadata)) {
      await validateInstalled(trx, plan)
      return plan
    }
    const legacyNames = await validateLegacy(trx, config)
    const namesToOwn = plan.ddl
      .map(sql => /^CREATE (?:TABLE|INDEX) "([^"]+)"/.exec(sql)?.[1])
      .filter((name): name is string => name !== undefined)
    if ((await trx('sqlite_master').whereIn('name', namesToOwn)).length !== 0)
      throw new WERR_INVALID_OPERATION('Orphan rebuild schema refuses adoption')
    await runInSeries(plan.ddl, async sql => {
      await trx.raw(sql)
    })
    const old: Array<{
      name: string
    }> = await trx('sqlite_master')
      .where('type', 'trigger')
      .whereIn('tbl_name', [
        ...numeric.map(source => source.table),
        ...relations.map(relation => relation.table),
        'certificate_fields'
      ])
      .select('name')
    await runInSeries(old, async trigger => {
      if (/^snapshot_(profile|relation|certificate|global)_/.test(trigger.name)) {
        if (!legacyNames.has(trigger.name)) throw new WERR_INVALID_OPERATION('Unknown legacy source trigger')
        await trx.raw('DROP TRIGGER ??', [trigger.name])
      }
    })
    await runInSeries(
      snapshotGlobalIndexTriggers(false).filter(trigger => trigger.table === 'snapshot_global_edges'),
      async trigger => {
        await trx.raw('DROP TRIGGER ??', [trigger.name])
      }
    )
    const legacy = JSON.stringify(await legacySchema(trx))
    await runInSeries(plan.triggers, async sql => {
      await trx.raw(sql)
    })
    await runInSeries(oldProgress, async table => {
      await trx(table).update({ complete: false })
    })
    await trx(metadata).insert({
      id: 0,
      source: plan.source,
      complete: false,
      legacy,
      retireTable: 0
    })
    await trx(progress).insert(
      Array.from({ length: 12 }, (_, stream) => ({
        stream,
        afterId: 0,
        afterSecond: 0,
        afterText: '',
        complete: false
      }))
    )
    return plan
  })
}
