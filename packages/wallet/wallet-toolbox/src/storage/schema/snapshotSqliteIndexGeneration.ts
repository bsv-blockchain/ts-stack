import { hasSnapshotSqliteCellComparison } from './snapshotSqliteCellComparison'
import { isOwnedNativeSqlite } from './ownedNativeSqliteRuntimeNode'
import { runInSeries } from '../../utility/runInSeries'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { validateLegacy, legacySchema, retiredTables } from './snapshotSqliteLegacyOwnership'
import type { Knex } from 'knex'
import {
  readIdentities,
  identityDDL,
  sharedIdentityLayout,
  sharedIdentityTable,
  type IdentityDefinition
} from './snapshotSqliteIdentity'
import {
  numeric,
  relations,
  membershipTriggers,
  sharedMembershipTriggers,
  type MembershipNames
} from './snapshotSqliteMembership'
import { validateSqliteSource } from './snapshotGlobalIndexSqlite'
import { snapshotGlobalIndexTriggers } from './snapshotGlobalIndexTriggers'
import { createHash } from 'node:crypto'
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
/** The complete inventory remains in the freshly observed Plan. Only the
 * unpublished owned native generation persists this versioned compact binding;
 * standard SQLite retains its full JSON format. A digest never validates or
 * authorizes the source: every complete definition is inspected separately. */
function persistedSource(k: Knex, source: string): string {
  return isOwnedNativeSqlite(k)
    ? 'brc38-native-sqlite-source/v1:' + createHash('sha256').update(source, 'utf8').digest('hex')
    : source
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
async function readSourcePlan(k: Knex): Promise<Omit<Plan, 'ddl' | 'triggers'>> {
  if (!String(k.client.config.client).includes('sqlite') && !isOwnedNativeSqlite(k))
    throw new WERR_INVALID_OPERATION('SQLite rebuild requires SQLite')
  await validateSqliteSource(k)
  const identities = await readIdentities(k, numeric)
  await runInSeries(relations, async relation => {
    await compositeOrder(k, relation.table, [relation.leftKey, relation.rightKey])
  })
  const fieldCollation = await compositeOrder(k, 'certificate_fields', ['fieldName', 'certificateId'])
  const sources = [
    ...numeric.map(source => source.table),
    ...relations.map(relation => relation.table),
    'certificate_fields'
  ]
  const schema: Array<{ type: unknown; name: unknown; tbl_name: unknown; sql: unknown }> = await k('sqlite_master')
    .whereIn('tbl_name', sources)
    .whereIn('type', ['table', 'index'])
    .select(
      'type',
      k.raw('substr(name,1,129) AS name'),
      k.raw('substr(tbl_name,1,129) AS tbl_name'),
      k.raw(
        "CASE WHEN sql IS NULL OR (typeof(sql)='text' AND length(cast(sql as blob))<=65536) THEN sql ELSE 0 END AS sql"
      )
    )
    .orderBy(['type', 'name'])
    .limit(257)
  if (
    schema.length > 256 ||
    schema.some(
      row =>
        typeof row.name !== 'string' ||
        row.name.length > 128 ||
        typeof row.tbl_name !== 'string' ||
        row.tbl_name.length > 128 ||
        !(row.sql === null || typeof row.sql === 'string')
    )
  )
    throw new WERR_INVALID_OPERATION('SQLite source schema exceeds bounded metadata limits')
  const source = JSON.stringify(schema)
  if (Buffer.byteLength(source, 'utf8') > 4194304)
    throw new WERR_INVALID_OPERATION('SQLite source schema exceeds bounded metadata limits')
  return { identities, fieldCollation, source }
}
export async function readPlan(k: Knex): Promise<Plan> {
  const { identities, fieldCollation, source } = await readSourcePlan(k)
  const legacyDDL = [...tables(fieldCollation), ...identities.flatMap(identityDDL)]
  let compact = false
  let sharedWitnesses: ReturnType<typeof sharedIdentityLayout>
  let nativeCells = false
  if (isOwnedNativeSqlite(k)) {
    // These derived tables have no operational physical-rowid contract. Keep
    // an existing generation's exact layout; only a fresh genuine native
    // generation selects a single primary-key B-tree. Every definition is
    // still validated below, so this observation cannot adopt a mixed layout.
    const installed = (await k('sqlite_master').where({ type: 'table', name: metadata }).first('sql')) as
      { sql: string } | undefined
    const expected = legacyDDL.find(sql => sql.startsWith(`CREATE TABLE ${q(metadata)} `))!
    if (installed !== undefined && installed.sql !== expected && installed.sql !== expected + ' WITHOUT ROWID')
      throw new WERR_INVALID_OPERATION('Rebuild schema definition mismatch: ' + metadata)
    compact = installed === undefined || installed.sql === expected + ' WITHOUT ROWID'
    nativeCells = await hasSnapshotSqliteCellComparison(k)
    const candidate = nativeCells ? sharedIdentityLayout(identities) : undefined
    const witness = (await k('main.sqlite_schema').where({ name: sharedIdentityTable }).first('type', 'sql')) as
      { type: string; sql: string } | undefined
    if (
      witness !== undefined &&
      (candidate === undefined || witness.type !== 'table' || witness.sql !== candidate.ddl[0])
    )
      throw new WERR_INVALID_OPERATION('Rebuild shared witness definition mismatch')
    // Preserve occupied shared generations, but a fresh generation must retain
    // the original named physical witness tables. A shared witness table cannot
    // satisfy those consumers merely by returning equivalent row values.
    if (candidate !== undefined && witness !== undefined) sharedWitnesses = candidate
    if (
      (
        await k('sqlite_temp_schema')
          .whereRaw('lower(substr(name,1,18))=?', ['snapshot_identity_'])
          .select('name')
          .limit(1)
      ).length !== 0
    )
      throw new WERR_INVALID_OPERATION('Rebuild shared witness temporary shadow')
  }
  const ddl =
    sharedWitnesses === undefined
      ? legacyDDL.map(sql => (compact && sql.startsWith('CREATE TABLE ') ? sql + ' WITHOUT ROWID' : sql))
      : [
          ...tables(fieldCollation).map(sql => (sql.startsWith('CREATE TABLE ') ? sql + ' WITHOUT ROWID' : sql)),
          ...sharedWitnesses.ddl
        ]
  const observer = snapshotGlobalIndexTriggers(false)
    .filter(trigger => trigger.table === 'snapshot_global_edges')
    .map(trigger =>
      trigger.sql
        .replaceAll('snapshot_global_edges', names.edges)
        .replaceAll('snapshot_global_keys', names.keys)
        .replaceAll('snapshot_global_guards', names.guards)
        .replaceAll('snapshot_global_edge_', 'snapshot_global_v2_edge_')
    )
  const historicalTriggers = membershipTriggers(identities, names)
  let selectedTriggers = historicalTriggers
  if (isOwnedNativeSqlite(k)) {
    const reducedTriggers = membershipTriggers(identities, names, true)
    const sharedTriggers = sharedMembershipTriggers(identities, names)
    const completeTriggers = sharedMembershipTriggers(identities, names, true)
    const cellTriggers = sharedMembershipTriggers(identities, names, true, true)
    const compactTriggers = sharedMembershipTriggers(identities, names, true, true, true)
    const witnessTriggers =
      sharedWitnesses === undefined
        ? undefined
        : sharedMembershipTriggers(sharedWitnesses.definitions, names, true, true)
    const probeName = 'snapshot_identity_after_transactions_UPDATE'
    const expected = (definitions: string[]) =>
      definitions.find(sql => sql.startsWith(`CREATE TRIGGER ${q(probeName)} `))!
    // Select only from actual, complete definitions. An occupied historical
    // generation keeps its exact observers; every other definition is still
    // checked by validateInstalled, so a mixed layout is never adopted.
    const installed = (await k('sqlite_master').where({ type: 'trigger', name: probeName }).first('sql')) as
      { sql: string } | undefined
    if (
      installed !== undefined &&
      installed.sql !== expected(historicalTriggers) &&
      installed.sql !== expected(reducedTriggers) &&
      installed.sql !== expected(sharedTriggers) &&
      installed.sql !== expected(completeTriggers) &&
      !(nativeCells && installed.sql === expected(cellTriggers)) &&
      !(witnessTriggers !== undefined && installed.sql === expected(witnessTriggers))
    )
      throw new WERR_INVALID_OPERATION('Rebuild schema definition mismatch: ' + probeName)
    if (witnessTriggers !== undefined) {
      if (installed !== undefined && installed.sql !== expected(witnessTriggers))
        throw new WERR_INVALID_OPERATION('Rebuild shared witness observer mismatch')
      selectedTriggers = witnessTriggers
    } else if (nativeCells && (installed === undefined || installed.sql === expected(cellTriggers))) {
      // Source point observers remain identical. Read the actual helper too:
      // only a fresh generation chooses compact keys; occupied full-key and
      // compact-key helpers retain their complete exact definition families.
      const handlerName = 'snapshot_identity_apply_transactions',
        handler = (await k('main.sqlite_schema').where({ type: 'trigger', name: handlerName }).first('sql')) as
          { sql: string } | undefined,
        helper = (definitions: string[]) =>
          definitions.find(sql => sql.startsWith(`CREATE TRIGGER ${q(handlerName)} `))!
      if (installed === undefined) {
        if (handler !== undefined)
          throw new WERR_INVALID_OPERATION('Rebuild schema definition mismatch: ' + handlerName)
        selectedTriggers = compactTriggers
      } else if (handler?.sql === helper(compactTriggers)) selectedTriggers = compactTriggers
      else if (handler?.sql === helper(cellTriggers)) selectedTriggers = cellTriggers
      else throw new WERR_INVALID_OPERATION('Rebuild schema definition mismatch: ' + handlerName)
    } else if (installed === undefined) selectedTriggers = completeTriggers
    else if (installed.sql === expected(completeTriggers)) selectedTriggers = completeTriggers
    else if (installed.sql === expected(sharedTriggers)) selectedTriggers = sharedTriggers
    else if (installed.sql === expected(reducedTriggers)) selectedTriggers = reducedTriggers
  }
  return {
    identities: sharedWitnesses?.definitions ?? identities,
    fieldCollation,
    source,
    ddl,
    triggers: [...observer, ...selectedTriggers]
  }
}
async function validateInstallLock(k: Knex): Promise<void> {
  const lock = await k('sqlite_master').where({ type: 'table', name: 'snapshot_index_install_lock_v2' }).first('sql')
  if (lock?.sql !== 'CREATE TABLE snapshot_index_install_lock_v2(id INTEGER PRIMARY KEY)')
    throw new WERR_INVALID_OPERATION('Invalid rebuild lock definition')
}

interface InstalledDefinition {
  type: string
  name: string
  sql: string
}
function installedDefinition(sql: string): InstalledDefinition | undefined {
  const match = /^CREATE (TABLE|INDEX|TRIGGER|VIEW) ("[^"]+"|\w+)/.exec(sql)
  return match ? { type: match[1].toLowerCase(), name: match[2].replaceAll('"', ''), sql } : undefined
}
async function validateDefinition(k: Knex, sql: string): Promise<void> {
  const definition = installedDefinition(sql)
  if (!definition) throw new WERR_INVALID_OPERATION('Invalid generated schema definition')
  const row = (await k('sqlite_master')
    .where({ type: definition.type, name: definition.name })
    .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [definition.sql])
    .count({ matches: '*' })
    .first()) as { matches: unknown } | undefined
  if (row?.matches !== 1) throw new WERR_INVALID_OPERATION('Rebuild schema definition mismatch: ' + definition.name)
}
async function validateDefinitions(k: Knex, expected: string[]): Promise<void> {
  // Keep the original sixteen-object ceiling and bound encoded bindings too.
  // Exact SQL is compared in SQLite; only two scalar counts cross the native
  // reply boundary, instead of up to sixteen 65KiB schema strings.
  const pages: string[][] = [],
    encoder = new TextEncoder()
  let page: string[] = [],
    bytes = 0
  for (const sql of expected) {
    const definition = typeof sql === 'string' ? installedDefinition(sql) : undefined
    const amount =
      definition === undefined ? 0 : encoder.encode(definition.type + definition.name + definition.sql).length
    if (page.length !== 0 && (page.length === 16 || amount > 32768 - bytes)) {
      pages.push(page)
      page = []
      bytes = 0
    }
    page.push(sql)
    bytes += amount
    if (bytes > 32768) {
      pages.push(page)
      page = []
      bytes = 0
    }
  }
  if (page.length !== 0) pages.push(page)
  await runInSeries(pages, async group => {
    const definitions = group.map(sql => (typeof sql === 'string' ? installedDefinition(sql) : undefined))
    if (definitions.includes(undefined)) {
      await runInSeries(group, async sql => await validateDefinition(k, sql))
      return
    }
    const selected = definitions.filter((definition): definition is InstalledDefinition => definition !== undefined)
    const bindings: string[] = []
    const values = selected
      .map(definition => {
        bindings.push(definition.type, definition.name, definition.sql)
        return '(?,?,CAST(? AS BLOB))'
      })
      .join(',')
    // One bounded tuple set preserves the exact type/name/SQL comparison and
    // avoids recompiling and evaluating a separate OR branch per definition.
    const row = (await k('sqlite_master')
      .whereRaw('(type,name,CAST(sql AS BLOB)) IN (VALUES ' + values + ')', bindings)
      .count({ matches: '*' })
      .countDistinct({ names: 'name' })
      .first()) as { matches: unknown; names: unknown } | undefined
    if (row?.matches !== selected.length || row.names !== selected.length)
      // Preserve first-mismatch errors and historical duplicate expected entries.
      await runInSeries(group, async sql => await validateDefinition(k, sql))
  })
}
/** Exact generated DDL ownership; never adopt a similarly named foreign object. */
export async function validateInstalled(k: Knex, plan: Plan): Promise<void> {
  await validateInstallLock(k)
  if ((await readSourcePlan(k)).source !== plan.source)
    throw new WERR_INVALID_OPERATION('Rebuild source schema changed')
  await validateInstalledObjects(k, plan)
}

/** Construct and validate our own complete plan in one pinned transaction.
 * No callback or write occurs between the source observation and validation.
 * Caller-supplied plans and unpinned connections retain the independent source
 * comparison in validateInstalled; no verdict is stored on the connection. */
export async function readInstalledPlan(k: Knex): Promise<Plan> {
  const plan = await readPlan(k)
  if (k.isTransaction) {
    await validateInstallLock(k)
    await validateInstalledObjects(k, plan)
  } else await validateInstalled(k, plan)
  return plan
}

async function validateInstalledObjects(k: Knex, plan: Plan): Promise<void> {
  await validateDefinitions(k, [...plan.ddl, ...plan.triggers])
  // A second handler on a rowless event view could change membership effects
  // while every expected SQL definition still matched. Inspect the complete
  // reserved and attached inventory, including historical-layout absence.
  const shared = plan.triggers
      .map(installedDefinition)
      .filter(
        (value): value is InstalledDefinition =>
          value !== undefined &&
          (value.name.startsWith('snapshot_identity_events_') || value.name.startsWith('snapshot_identity_apply_'))
      ),
    views = shared.filter(value => value.type === 'view').map(value => value.name),
    helpers = (await k('sqlite_master')
      .where(query => {
        void query
          .whereRaw('substr(name,1,?)=?', [25, 'snapshot_identity_events_'])
          .orWhereRaw('substr(name,1,?)=?', [24, 'snapshot_identity_apply_'])
          .orWhereIn('tbl_name', views)
      })
      .count({ count: '*' })
      .first()) as { count: number } | undefined
  if (helpers?.count !== shared.length) throw new WERR_INVALID_OPERATION('Rebuild shared observer inventory mismatch')
  const identities = [...plan.ddl, ...plan.triggers]
    .map(installedDefinition)
    .filter((value): value is InstalledDefinition => value !== undefined && value.name.startsWith('snapshot_identity_'))
  const witnesses = identities.filter(value => value.type === 'table').map(value => value.name)
  const inventory = (await k('main.sqlite_schema')
    .where(query => {
      void query.whereRaw('lower(substr(name,1,18))=?', ['snapshot_identity_']).orWhereIn('tbl_name', witnesses)
    })
    .whereNot(query => {
      void query.where({ type: 'index', sql: null })
    })
    .count({ count: '*' })
    .first()) as { count: number } | undefined
  if (inventory?.count !== identities.length) throw new WERR_INVALID_OPERATION('Rebuild witness inventory mismatch')
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
    (rows[0].source !== plan.source && rows[0].source !== persistedSource(k, plan.source)) ||
    ![0, 1].includes(rows[0].complete) ||
    !Number.isSafeInteger(rows[0].retireTable) ||
    rows[0].retireTable < 0 ||
    rows[0].retireTable > retiredTables.length ||
    typeof rows[0].legacy !== 'string'
  )
    throw new WERR_INVALID_OPERATION('Rebuild source binding mismatch')
}

/** Add only exact source-owned indexes while retaining all existing rows,
 * observers and cursor progress. Validate the old generation before DDL and
 * compare the entire native table/index inventory afterwards. A newly computed
 * source hash alone must never bless a changed column, removed index or trigger.
 * The caller must hold SQLite's writer in this transaction and separately
 * reconcile any journal receipts bound to the previous source schema. */
export async function addSnapshotSqliteSourceIndexes(
  k: Knex,
  statements: readonly string[],
  apply: () => Promise<void>
): Promise<void> {
  if (
    !k.isTransaction ||
    (!['sqlite3', 'better-sqlite3'].includes(String(k.client.config.client)) && !isOwnedNativeSqlite(k))
  )
    throw new WERR_INVALID_OPERATION('Source index addition requires a SQLite writer transaction')
  const present = await k.schema.hasTable(metadata)
  if (!present) {
    await apply()
    return
  }
  const before = await readPlan(k)
  await validateInstalled(k, before)
  // Retain the actual old representation for the conditional update. A legacy
  // native full inventory is accepted only after complete fresh validation.
  const recorded = (await k(metadata).where('id', 0).first('source')) as { source: string }
  const allowed = new Map(
    statements.map(sql => {
      const match = /^CREATE INDEX ([A-Za-z_][A-Za-z_0-9]*) ON ([A-Za-z_][A-Za-z_0-9]*) \(([^)]+)\)$/.exec(sql)
      if (match === null) throw new WERR_INVALID_OPERATION('Invalid owned additive source index')
      return [match[1], { type: 'index', name: match[1], tbl_name: match[2], sql }]
    })
  )
  if (allowed.size !== statements.length) throw new WERR_INVALID_OPERATION('Duplicate owned additive source index')
  await apply()
  // The migration can also own indexes on auxiliary tables outside the thirteen
  // snapshot source tables. Verify every supplied definition, but count only
  // source-table additions in this generation's source inventory.
  await validateDefinitions(k, [...statements])
  const after = await readPlan(k)
  if (
    JSON.stringify([before.ddl, before.triggers, before.identities, before.fieldCollation]) !==
    JSON.stringify([after.ddl, after.triggers, after.identities, after.fieldCollation])
  )
    throw new WERR_INVALID_OPERATION('Source index addition changed snapshot observers or entity identity')
  const old: Array<{ type: string; name: string; tbl_name: string; sql: string }> = JSON.parse(before.source)
  const current: Array<{ type: string; name: string; tbl_name: string; sql: string }> = JSON.parse(after.source)
  const sourceTables = new Set(old.filter(row => row.type === 'table').map(row => row.name))
  const addedSourceIndexes = [...allowed.values()].filter(
    row => sourceTables.has(row.tbl_name) && !old.some(previous => previous.name === row.name)
  )
  if (
    current.length !== old.length + addedSourceIndexes.length ||
    old.some(row => !current.some(actual => JSON.stringify(actual) === JSON.stringify(row))) ||
    current.some(
      row =>
        !old.some(actual => JSON.stringify(actual) === JSON.stringify(row)) &&
        JSON.stringify(allowed.get(row.name)) !== JSON.stringify(row)
    )
  )
    throw new WERR_INVALID_OPERATION('Source index addition changed an unowned schema object')
  if (
    (await k(metadata)
      .where({ id: 0, source: recorded.source })
      .update({ source: persistedSource(k, after.source) })) !== 1
  )
    throw new WERR_INVALID_OPERATION('Source index generation changed during migration')
  await validateInstalled(k, after)
}
/** Rebind only the fixed redundant spentBy tree of an empty, unpublished
 * private native candidate. Complete old/new plans prove the change; a hash
 * alone cannot adopt schema drift. The caller's existing layout savepoint owns
 * both this conditional binding update and its independently verified drop. */
export async function rebindFreshSnapshotSqliteSpentByIndex(
  k: Knex.Transaction,
  apply: () => Promise<void>
): Promise<void> {
  const actual: {
      isBrc38OwnedPrivateNativeWriter: (trx: Knex.Transaction) => boolean
    } = require('../portable/KnexBrc38StagingStore'),
    check = (): void => {
      if (!k.isTransaction || !actual.isBrc38OwnedPrivateNativeWriter(k))
        throw new WERR_INVALID_OPERATION('SpentBy binding requires a fresh private native writer')
    }
  check()
  if (
    (
      await k('main.sqlite_schema')
        .whereIn('name', [
          'snapshot_journal_generation',
          'brc38_local_baseline_clock',
          'brc38_native_local_packed_layout'
        ])
        .select('name')
        .limit(1)
    ).length !== 0
  )
    throw new WERR_INVALID_OPERATION('SpentBy binding requires an unpublished candidate')
  // Candidate schema preparation creates this empty table before the journal
  // callback. A persisted restore admission, rather than the empty definition,
  // ends the fresh layout window.
  if (
    !(await k.schema.hasTable('private_native_restore')) ||
    (await k('private_native_restore').withSchema('main').select(k.raw('1 AS present')).limit(1)).length !== 0
  )
    throw new WERR_INVALID_OPERATION('SpentBy binding requires an unadmitted restore candidate')
  for (const table of [
    ...numeric.map(source => source.table),
    ...relations.map(source => source.table),
    'certificate_fields'
  ]) {
    check()
    if ((await k(table).withSchema('main').select(k.raw('1 AS present')).limit(1)).length !== 0)
      throw new WERR_INVALID_OPERATION('SpentBy binding requires empty source tables')
  }
  const before = await readPlan(k)
  await validateInstalled(k, before)
  const recorded = (await k(metadata).where({ id: 0 }).first('source')) as { source: string },
    removed = {
      type: 'index',
      name: 'idx_outputs_spentby',
      tbl_name: 'outputs',
      sql: 'CREATE INDEX `idx_outputs_spentby` on `outputs` (`spentBy`)'
    },
    old: Array<{ type: string; name: string; tbl_name: string; sql: string | null }> = JSON.parse(before.source)
  if (old.filter(row => JSON.stringify(row) === JSON.stringify(removed)).length !== 1)
    throw new WERR_INVALID_OPERATION('SpentBy binding original source index differs')
  check()
  await apply()
  check()
  const after = await readPlan(k)
  if (
    JSON.stringify([before.ddl, before.triggers, before.identities, before.fieldCollation]) !==
      JSON.stringify([after.ddl, after.triggers, after.identities, after.fieldCollation]) ||
    JSON.stringify(old.filter(row => row.name !== removed.name)) !== after.source
  )
    throw new WERR_INVALID_OPERATION('SpentBy binding changed an unowned source object or observer')
  if (
    (await k(metadata)
      .where({ id: 0, source: recorded.source })
      .update({ source: persistedSource(k, after.source) })) !== 1
  )
    throw new WERR_INVALID_OPERATION('SpentBy source generation changed during compaction')
  await validateInstalled(k, after)
  check()
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
      const recorded = (await trx(metadata).where('id', 0).first('source')) as { source: string }
      const current = persistedSource(trx, plan.source)
      if (
        recorded.source !== current &&
        (await trx(metadata).where({ id: 0, source: recorded.source }).update({ source: current })) !== 1
      )
        throw new WERR_INVALID_OPERATION('Source index generation changed during migration')
      return plan
    }
    const legacyNames = await validateLegacy(trx, config)
    const namesToOwn = [...plan.ddl, ...plan.identities.flatMap(identityDDL)]
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
      source: persistedSource(trx, plan.source),
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
