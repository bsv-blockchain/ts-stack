import type { Knex } from 'knex'
import { assertIsoDate } from './Brc38PortableRows'
import type { Brc38StageTable } from './Brc38SemanticStage'
import type { Brc38PreparedStreamedPage } from './Brc38ImportPage'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { readBrc38PrivateMergeRecovery } from './Brc38PrivateMergeRecoverySchemaNode'
import { brc38ImportRowForm, brc38ImportTableOrder } from './Brc38ImportForms'
import { loadBrc38ImportIdMap, type Brc38ImportIdReference } from './Brc38ImportIdMap'
import { brc38ImportTargetIndexes, brc38ImportTargetIndexName } from './Brc38ImportTargetIndexes'
import { brc38PrivatePageIdForms } from './Brc38PrivatePageIdsNode'
import { chargeBrc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
import { isBrc38OwnedPrivateNativeSqlite, isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'

export const brc38PrivateMergeTargetsTable = 'brc38_private_merge_targets'
export const brc38PrivateMergeTargetsBudgetTable = 'brc38_private_merge_targets_budget'
export const brc38PrivateMergeQuarantineIndex = `${brc38PrivateMergeTargetsTable}_quarantine`
export const brc38PrivateMergeQuarantineTxidIndex = `${brc38PrivateMergeTargetsTable}_quarantine_txid`
export const brc38PrivateMergeTargetLogicalBytes = 512
export interface Brc38PrivateActionQuarantine {
  readonly txidSha256: string
  readonly outputId?: number
  readonly updatedAt?: string
}
const table = brc38PrivateMergeTargetsTable,
  budget = brc38PrivateMergeTargetsBudgetTable,
  index = `${table}_reverse`,
  quarantineIndex = brc38PrivateMergeQuarantineIndex,
  rowCharge = brc38PrivateMergeTargetLogicalBytes,
  context = `EXISTS(SELECT 1 FROM brc38_private_merge_recovery r JOIN brc38_import_journal j ON j.importId=r.activeImportId WHERE r.slot=1 AND r.phase='IMPORT' AND j.importId=NEW.importId AND j.bindingSha256=r.bindingSha256 AND j.cleanupAllowed=0)`,
  definitions = Object.freeze([
    `CREATE TABLE ${budget}(importId TEXT PRIMARY KEY REFERENCES brc38_import_journal(importId),rows INTEGER NOT NULL CHECK(typeof(rows)='integer' AND rows BETWEEN 0 AND 1000000000)) WITHOUT ROWID`,
    `CREATE TRIGGER ${budget}_insert BEFORE INSERT ON ${budget} WHEN NEW.rows!=0 OR NOT ${context} BEGIN SELECT RAISE(ABORT,'Private merge targets original scope differs'); END`,
    `CREATE TRIGGER ${budget}_update BEFORE UPDATE ON ${budget} WHEN NEW.importId IS NOT OLD.importId OR NEW.rows!=OLD.rows+1 OR NOT ${context} BEGIN SELECT RAISE(ABORT,'Private merge targets charge differs'); END`,
    `CREATE TRIGGER ${budget}_delete BEFORE DELETE ON ${budget} BEGIN SELECT RAISE(ABORT,'Private merge targets require candidate retirement'); END`,
    `CREATE TABLE ${table}(importId TEXT NOT NULL REFERENCES ${budget}(importId),sourceRow INTEGER NOT NULL CHECK(typeof(sourceRow)='integer' AND sourceRow BETWEEN 1 AND 1000000000),tableName TEXT NOT NULL CHECK(tableName IN (${brc38ImportTableOrder
      .filter(value => value !== 'syncStates')
      .map(value => `'${value}'`)
      .join(
        ','
      )})),targetRowid INTEGER NOT NULL CHECK(typeof(targetRowid)='integer' AND targetRowid BETWEEN -9007199254740991 AND 9007199254740991),proofChanged INTEGER CHECK((tableName='provenTxs' AND proofChanged IS NOT NULL AND typeof(proofChanged)='integer' AND proofChanged IN (0,1)) OR (tableName!='provenTxs' AND proofChanged IS NULL)),quarantineTxidSha256 TEXT CHECK(quarantineTxidSha256 IS NULL OR (tableName='transactions' AND typeof(quarantineTxidSha256)='text' AND length(CAST(quarantineTxidSha256 AS BLOB))=64)),quarantineOutputId INTEGER CHECK(quarantineOutputId IS NULL OR (quarantineTxidSha256 IS NOT NULL AND typeof(quarantineOutputId)='integer' AND quarantineOutputId BETWEEN 1 AND 9007199254740991)),quarantineUpdatedAt TEXT CHECK((quarantineUpdatedAt IS NULL AND quarantineOutputId IS NULL) OR (quarantineUpdatedAt IS NOT NULL AND quarantineOutputId IS NOT NULL AND typeof(quarantineUpdatedAt)='text' AND length(CAST(quarantineUpdatedAt AS BLOB))=24)),PRIMARY KEY(importId,sourceRow)) WITHOUT ROWID`,
    `CREATE INDEX ${index} ON ${table}(importId,tableName,targetRowid,sourceRow)`,
    `CREATE INDEX ${quarantineIndex} ON ${table}(importId,quarantineOutputId,sourceRow)`,
    `CREATE INDEX ${brc38PrivateMergeQuarantineTxidIndex} ON ${table}(importId,quarantineTxidSha256,sourceRow)`,
    `CREATE TRIGGER ${table}_insert BEFORE INSERT ON ${table} WHEN NOT ${context} OR NOT EXISTS(SELECT 1 FROM brc38_import_structured_original o JOIN brc38_import_journal j ON j.importId=o.importId WHERE o.importId=NEW.importId AND o.sourceRow=NEW.sourceRow AND o.tableName=NEW.tableName AND o.bindingSha256=j.bindingSha256 AND o.archiveSha256=j.archiveSha256 AND o.userId=j.userId AND NEW.sourceRow>=json_extract(j.receiptJson,'$.nextRow')) BEGIN SELECT RAISE(ABORT,'Private merge target original prefix differs'); END`,
    `CREATE TRIGGER ${table}_charge AFTER INSERT ON ${table} BEGIN UPDATE ${budget} SET rows=rows+1 WHERE importId=NEW.importId; END`,
    `CREATE TRIGGER ${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Private merge targets are immutable'); END`,
    `CREATE TRIGGER ${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Private merge targets require candidate retirement'); END`
  ])
function invalid(): never {
  throw new Error('Private merge target lookup differs from its original journal, row, mappings or charge')
}
function actual(k: Knex.Transaction, writer = false): void {
  if (
    !k.isTransaction ||
    k.isCompleted() ||
    !(writer ? isBrc38OwnedPrivateNativeWriter(k) : isBrc38OwnedPrivateNativeSqlite(k))
  )
    invalid()
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid()
  return value
}
export async function hasBrc38PrivateMergeTargets(k: Knex.Transaction): Promise<boolean> {
  actual(k)
  const total = (await k('sqlite_schema')
    .whereRaw('substr(name,1,?)=?', [table.length, table])
    .count({ count: '*' })
    .first()) as { count: number } | undefined
  if (total?.count === 0) return false
  if (total?.count !== definitions.length) invalid()
  for (const sql of definitions) {
    const [, type, name] = /^CREATE (TABLE|INDEX|TRIGGER) (\w+)/.exec(sql)!,
      rows = await k('sqlite_schema')
        .where({ name, type: type.toLowerCase() })
        .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
        .select('name')
        .limit(2)
    if (rows.length !== 1) invalid()
  }
  const objects = (await k('sqlite_schema')
    .whereIn('tbl_name', [table, budget])
    .whereNotNull('sql')
    .count({ count: '*' })
    .first()) as { count: number } | undefined
  if (objects?.count !== definitions.length) invalid()
  actual(k)
  return true
}
export async function installBrc38PrivateMergeTargets(k: Knex.Transaction): Promise<void> {
  actual(k, true)
  if (!(await hasBrc38PrivateMergeTargets(k))) for (const sql of definitions) await k.raw(sql)
  if (!(await hasBrc38PrivateMergeTargets(k))) invalid()
}
export async function prepareBrc38PrivateMergeTargetBudget(
  k: Knex.Transaction,
  admission: Brc38ImportJournalAdmission
): Promise<void> {
  actual(k, true)
  if (!(await hasBrc38PrivateMergeTargets(k))) invalid()
  const rows = (await k(budget).where({ importId: admission.scope.importId }).select('rows').limit(2)) as Array<{
    rows: number
  }>
  if (rows.length === 0) await k(budget).insert({ importId: admission.scope.importId, rows: 0 })
  else if (rows.length !== 1 || integer(rows[0].rows) < 0) invalid()
}
/** Only fixed-size DATA is retained here. Every episode shares the original
 * journal allowance; a rebuild cannot renew this lookup's capacity. */
export async function brc38PrivateMergeTargetCharge(k: Knex.Transaction): Promise<number> {
  actual(k)
  if (!(await hasBrc38PrivateMergeTargets(k))) invalid()
  const rows = (await k(budget).select('importId', 'rows').orderBy('importId').limit(5)) as Array<{
    importId: string
    rows: number
  }>
  if (rows.length > 4) invalid()
  let charge = 0
  for (const row of rows) {
    const amount = integer(row.rows)
    if (amount < 0 || amount > 1000000000) invalid()
    const journal = await k('brc38_import_journal')
      .where({ importId: row.importId, cleanupAllowed: 0 })
      .select('importId')
      .limit(2)
    if (journal.length !== 1) invalid()
    charge += amount * rowCharge
  }
  if (!Number.isSafeInteger(charge)) invalid()
  return charge
}
async function targetRowid(
  k: Knex.Transaction,
  admission: Brc38ImportJournalAdmission,
  selectedTable: Brc38StageTable,
  fields: Readonly<Record<string, unknown>>
): Promise<number> {
  const form = brc38ImportRowForm(selectedTable),
    references: Brc38ImportIdReference[] = []
  if (form.entity !== undefined && form.id !== undefined) {
    const incomingId = fields[form.id]
    if (typeof incomingId !== 'number' || !Number.isInteger(incomingId)) invalid()
    references.push({ entity: form.entity, incomingId, required: true })
  } else
    for (const parent of form.parents) {
      const incomingId = fields[parent.field]
      if (typeof incomingId !== 'number' || !Number.isInteger(incomingId)) invalid()
      references.push({ entity: parent.entity, incomingId, required: true })
    }
  const loaded = await loadBrc38ImportIdMap(k, admission.scope, references)
  let query: Knex.QueryBuilder
  if (form.entity !== undefined && form.id !== undefined) {
    const [sql, id] = brc38PrivatePageIdForms[selectedTable as keyof typeof brc38PrivatePageIdForms],
      localId = integer(loaded.map[form.entity].idMap[fields[form.id] as number])
    query = k(sql).where({ [id]: localId })
    if (!['provenTxs', 'provenTxReqs'].includes(selectedTable)) query.where({ userId: admission.scope.userId })
  } else {
    if (!['txLabelMaps', 'outputTagMaps', 'certificateFields'].includes(selectedTable)) invalid()
    const key: Record<string, string | number> = {}
    for (const parent of form.parents)
      key[parent.field] = integer(loaded.map[parent.entity].idMap[fields[parent.field] as number])
    if (selectedTable === 'certificateFields') {
      if (typeof fields.fieldName !== 'string') invalid()
      key.fieldName = fields.fieldName
      key.userId = admission.scope.userId
    }
    const [sql] = brc38ImportTargetIndexes[selectedTable]
    query = k.from(k.raw('?? INDEXED BY ??', [sql, brc38ImportTargetIndexName(selectedTable, k)])).where(key)
  }
  const rows = (await query
    .select(
      k.raw("CASE WHEN typeof(rowid)='integer' AND rowid BETWEEN ? AND ? THEN rowid END AS targetRowid", [
        -Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER
      ])
    )
    .limit(2)) as Array<{ targetRowid: unknown }>
  if (rows.length !== 1) invalid()
  return integer(rows[0].targetRowid)
}
/** Called AFTER entity/maps/originals and BEFORE checkpoint/receipt, in the
 * SAME actual writer. Replays bypass the apply callback, so lost ACKs do not
 * duplicate targets or charges. No payload, hash, source I/O or DTO is loaded. */
export async function appendBrc38PrivateMergeTargets(
  k: Knex.Transaction,
  admission: Brc38ImportJournalAdmission,
  page: Brc38PreparedStreamedPage,
  proofChanges?: readonly boolean[],
  actionQuarantines?: readonly (Readonly<Brc38PrivateActionQuarantine> | null)[]
): Promise<void> {
  if (!isBrc38OwnedPrivateNativeSqlite(k)) return
  actual(k, true)
  if (!(await hasBrc38PrivateMergeTargets(k))) {
    const program = await k('sqlite_schema')
      .where({ type: 'table', name: 'brc38_private_merge_program' })
      .select('name')
      .limit(1)
    if (program.length !== 0) invalid()
    return
  }
  if (page.data.kind === 'header' || page.data.table === 'syncStates') return
  if (
    page.data.table === 'provenTxs'
      ? proofChanges === undefined ||
        proofChanges.length !== page.data.rows.length ||
        proofChanges.some(value => typeof value !== 'boolean')
      : proofChanges !== undefined
  )
    invalid()
  if (
    page.data.table === 'transactions'
      ? !Array.isArray(actionQuarantines) || actionQuarantines.length !== page.data.rows.length
      : actionQuarantines !== undefined
  )
    invalid()
  chargeBrc38ImportDecodedBudget(page.budget, 8192 + 4096 * page.data.rows.length)
  for (const [offset, row] of page.data.rows.entries()) {
    const physical = await targetRowid(k, admission, page.data.table, row.source.fields)
    const quarantine = actionQuarantines?.[offset]
    if (page.data.table === 'transactions' && quarantine === undefined) invalid()
    if (quarantine !== undefined && quarantine !== null) {
      if (
        !/^[0-9a-f]{64}$/.test(quarantine.txidSha256) ||
        (quarantine.outputId === undefined) !== (quarantine.updatedAt === undefined) ||
        (quarantine.outputId !== undefined && integer(quarantine.outputId) < 1)
      )
        invalid()
      if (quarantine.updatedAt !== undefined) assertIsoDate(quarantine.updatedAt, 'actual quarantine timestamp')
    }
    await k(table).insert({
      importId: admission.scope.importId,
      sourceRow: page.step.fromRow + offset,
      tableName: page.data.table,
      targetRowid: physical,
      proofChanged: proofChanges === undefined ? null : proofChanges[offset] ? 1 : 0,
      quarantineTxidSha256: quarantine?.txidSha256 ?? null,
      quarantineOutputId: quarantine?.outputId ?? null,
      quarantineUpdatedAt: quarantine?.updatedAt ?? null
    })
  }
  actual(k, true)
}
/** Fresh lookup validation during full original-prefix inventory. Historical
 * targets remain inert after a refold; only active targets name current rows. */
export async function inspectBrc38PrivateMergeTarget(
  k: Knex.Transaction,
  admission: Brc38ImportJournalAdmission,
  sourceRow: number,
  selectedTable: Brc38StageTable,
  fields: Readonly<Record<string, unknown>>,
  active: boolean
): Promise<void> {
  actual(k)
  const rows = (await k(table)
    .where({ importId: admission.scope.importId, sourceRow })
    .select(
      'tableName',
      'targetRowid',
      'proofChanged',
      'quarantineTxidSha256',
      'quarantineOutputId',
      'quarantineUpdatedAt'
    )
    .limit(2)) as Array<{
    tableName: string
    targetRowid: unknown
    proofChanged: unknown
    quarantineTxidSha256: unknown
    quarantineOutputId: unknown
    quarantineUpdatedAt: unknown
  }>
  if (selectedTable === 'syncStates') {
    if (rows.length !== 0) invalid()
    return
  }
  if (rows.length !== 1 || rows[0].tableName !== selectedTable) invalid()
  if (
    selectedTable === 'provenTxs'
      ? rows[0].proofChanged !== 0 && rows[0].proofChanged !== 1
      : rows[0].proofChanged !== null
  )
    invalid()
  const effect = rows[0]
  if (effect.quarantineTxidSha256 === null) {
    if (effect.quarantineOutputId !== null || effect.quarantineUpdatedAt !== null) invalid()
  } else {
    if (
      selectedTable !== 'transactions' ||
      typeof effect.quarantineTxidSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(effect.quarantineTxidSha256)
    )
      invalid()
    if (effect.quarantineOutputId === null) {
      if (effect.quarantineUpdatedAt !== null) invalid()
    } else {
      if (integer(effect.quarantineOutputId) < 1) invalid()
      assertIsoDate(effect.quarantineUpdatedAt, 'stored quarantine timestamp')
    }
  }
  const physical = integer(rows[0].targetRowid)
  if (active && (await targetRowid(k, admission, selectedTable, fields)) !== physical) invalid()
}
/** Indexed one-alias cursor for the later semantic inventory. This returns
 * DATA only; the caller must reconstruct and compare originals/current rows. */
export async function nextBrc38PrivateMergeTargetAlias(
  k: Knex.Transaction,
  admission: Brc38ImportJournalAdmission,
  selectedTable: Brc38StageTable,
  physical: number,
  afterSourceRow: number
): Promise<number | undefined> {
  actual(k)
  if (!(await hasBrc38PrivateMergeTargets(k)) || selectedTable === 'syncStates' || integer(afterSourceRow) < 0)
    invalid()
  integer(physical)
  const mode = (await k.raw('PRAGMA query_only')) as Array<{ query_only: number }>,
    recovery = await readBrc38PrivateMergeRecovery(k),
    receipt = await readBrc38ImportJournal(k, admission)
  if (
    mode.length !== 1 ||
    mode[0].query_only !== 1 ||
    Date.now() >= admission.expiresAt ||
    recovery?.phase !== 'IMPORT' ||
    recovery.activeImportId !== admission.scope.importId ||
    recovery.bindingSha256 !== admission.scope.bindingSha256 ||
    receipt.state !== 'COMPLETE' ||
    receipt.nextRow !== admission.totalRows
  )
    invalid()
  const rows = (await k
    .from(k.raw('?? INDEXED BY ??', [table, index]))
    .where({ importId: admission.scope.importId, tableName: selectedTable, targetRowid: physical })
    .where('sourceRow', '>', afterSourceRow)
    .orderBy('sourceRow')
    .select('sourceRow')
    .limit(1)) as Array<{ sourceRow: unknown }>
  actual(k)
  if (Date.now() >= admission.expiresAt) invalid()
  if (rows.length === 0) return undefined
  const sourceRow = integer(rows[0].sourceRow)
  if (sourceRow <= afterSourceRow || sourceRow >= admission.totalRows) invalid()
  return sourceRow
}
