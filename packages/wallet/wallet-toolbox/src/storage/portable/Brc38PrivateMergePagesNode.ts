import { createHash } from 'node:crypto'
import {
  brc38PrivateCheckpointData,
  brc38PrivateCheckpointMaterializationCursor,
  type Brc38PrivateCheckpointData
} from './Brc38PrivateCheckpointData'
import type { Knex } from 'knex'
import { isBrc38OwnedPrivateNativeSqlite, isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import {
  readBrc38ImportJournal,
  type Brc38ImportJournalAdmission,
  type Brc38ImportJournalReceipt,
  type Brc38ImportJournalStep
} from './Brc38ImportJournal'
import { brc38ImportTableOrder } from './Brc38ImportForms'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { stepCopy } from './Brc38ImportJournalContract'
import { brc38ImportTargetIndexName } from './Brc38ImportTargetIndexes'
import { brc38ImportRowForm } from './Brc38ImportForms'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { readBrc38SqlBinaryDescriptors } from './Brc38SqlBinaryStaging'
import { readBrc38SqlStructuredDescriptors } from './Brc38SqlStructuredStaging'
import { readBrc38SqlTextDescriptors } from './Brc38SqlTextStaging'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'

export const brc38PrivateMergePagesTable = 'brc38_private_merge_pages'
export const brc38PrivateMergePagesBudgetTable = 'brc38_private_merge_pages_budget'
const table = brc38PrivateMergePagesTable,
  budget = brc38PrivateMergePagesBudgetTable,
  pageCharge = 3072,
  context = `EXISTS(SELECT 1 FROM brc38_private_merge_recovery r JOIN brc38_import_journal j ON j.importId=r.activeImportId WHERE r.slot=1 AND r.phase='IMPORT' AND j.importId=NEW.importId AND j.bindingSha256=r.bindingSha256 AND j.cleanupAllowed=0)`,
  definitions = Object.freeze([
    `CREATE TABLE ${budget}(importId TEXT PRIMARY KEY REFERENCES brc38_import_journal(importId),pages INTEGER NOT NULL CHECK(typeof(pages)='integer' AND pages BETWEEN 0 AND 1000000000)) WITHOUT ROWID`,
    `CREATE TRIGGER ${budget}_insert BEFORE INSERT ON ${budget} WHEN NEW.pages!=0 OR NOT ${context} BEGIN SELECT RAISE(ABORT,'Private merge page original scope differs'); END`,
    `CREATE TRIGGER ${budget}_update BEFORE UPDATE ON ${budget} WHEN NEW.importId IS NOT OLD.importId OR NEW.pages!=OLD.pages+1 OR NOT ${context} BEGIN SELECT RAISE(ABORT,'Private merge page charge differs'); END`,
    `CREATE TRIGGER ${budget}_delete BEFORE DELETE ON ${budget} BEGIN SELECT RAISE(ABORT,'Private merge pages require candidate retirement'); END`,
    `CREATE TABLE ${table}(importId TEXT NOT NULL REFERENCES ${budget}(importId),fromRow INTEGER NOT NULL CHECK(typeof(fromRow)='integer' AND fromRow BETWEEN 0 AND 1000000000),previousFromRow INTEGER,tableName TEXT NOT NULL CHECK(tableName IN ('header',${brc38ImportTableOrder.map(value => `'${value}'`).join(',')})),stepJson TEXT NOT NULL CHECK(typeof(stepJson)='text' AND length(CAST(stepJson AS BLOB)) BETWEEN 1 AND 1024),sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 1000000000),nextRow INTEGER NOT NULL CHECK(typeof(nextRow)='integer' AND nextRow>fromRow),mappedIds INTEGER NOT NULL CHECK(typeof(mappedIds)='integer' AND mappedIds BETWEEN 0 AND 1000000000),beforeDestinationSha256 TEXT NOT NULL CHECK(length(beforeDestinationSha256)=64),afterDestinationSha256 TEXT NOT NULL CHECK(length(afterDestinationSha256)=64),beforeReceiptSha256 TEXT NOT NULL CHECK(length(beforeReceiptSha256)=64),afterReceiptSha256 TEXT NOT NULL CHECK(length(afterReceiptSha256)=64),cacheEpochBefore INTEGER NOT NULL CHECK(typeof(cacheEpochBefore)='integer' AND cacheEpochBefore BETWEEN 0 AND 9007199254740991),cacheEpochAfter INTEGER NOT NULL CHECK(typeof(cacheEpochAfter)='integer' AND cacheEpochAfter BETWEEN cacheEpochBefore AND cacheEpochBefore+1),cacheReadyId INTEGER CHECK(cacheReadyId IS NULL OR (typeof(cacheReadyId)='integer' AND cacheReadyId BETWEEN 1 AND 9007199254740991)),writerStartedAt INTEGER NOT NULL CHECK(typeof(writerStartedAt)='integer' AND writerStartedAt>=0),writerFinishedAt INTEGER NOT NULL CHECK(typeof(writerFinishedAt)='integer' AND writerFinishedAt>=writerStartedAt),checkpointJson TEXT CHECK(checkpointJson IS NULL OR (typeof(checkpointJson)='text' AND length(CAST(checkpointJson AS BLOB)) BETWEEN 1 AND 512)),cacheUpdatedAt TEXT CHECK(cacheUpdatedAt IS NULL OR (typeof(cacheUpdatedAt)='text' AND length(CAST(cacheUpdatedAt AS BLOB))=24 AND cacheEpochAfter=cacheEpochBefore+1 AND cacheReadyId IS NOT NULL)),PRIMARY KEY(importId,fromRow),FOREIGN KEY(importId,previousFromRow) REFERENCES ${table}(importId,fromRow)) WITHOUT ROWID`,
    `CREATE TRIGGER ${table}_insert BEFORE INSERT ON ${table} WHEN NOT ${context} OR json_extract(NEW.stepJson,'$.fromRow') IS NOT NEW.fromRow OR json_extract(NEW.stepJson,'$.rows')!=NEW.nextRow-NEW.fromRow OR NOT EXISTS(SELECT 1 FROM brc38_import_journal j WHERE j.importId=NEW.importId AND j.receiptSha256=NEW.afterReceiptSha256 AND json_extract(j.receiptJson,'$.sequence')=NEW.sequence AND json_extract(j.receiptJson,'$.nextRow')=NEW.nextRow AND json_extract(j.receiptJson,'$.mappedIds')=NEW.mappedIds AND json_extract(j.receiptJson,'$.destinationSha256')=NEW.afterDestinationSha256) OR NOT ((NEW.fromRow=0 AND NEW.previousFromRow IS NULL AND NEW.sequence=1 AND NEW.tableName='header' AND NEW.cacheEpochAfter=NEW.cacheEpochBefore) OR EXISTS(SELECT 1 FROM ${table} p WHERE p.importId=NEW.importId AND p.fromRow=NEW.previousFromRow AND p.nextRow=NEW.fromRow AND p.sequence=NEW.sequence-1 AND p.afterReceiptSha256=NEW.beforeReceiptSha256 AND p.afterDestinationSha256=NEW.beforeDestinationSha256 AND p.cacheEpochAfter=NEW.cacheEpochBefore AND p.mappedIds+json_extract(NEW.stepJson,'$.mappedIds')=NEW.mappedIds)) OR (NEW.tableName!='provenTxs' AND NEW.cacheEpochAfter!=NEW.cacheEpochBefore) BEGIN SELECT RAISE(ABORT,'Private merge page receipt chain differs'); END`,
    `CREATE TRIGGER ${table}_charge AFTER INSERT ON ${table} BEGIN UPDATE ${budget} SET pages=pages+1 WHERE importId=NEW.importId; END`,
    `CREATE TRIGGER ${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Private merge pages are immutable'); END`,
    `CREATE TRIGGER ${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Private merge pages require candidate retirement'); END`
  ])
function invalid(): never {
  throw new Error('Private merge page history differs from its original journal, receipt chain, cache epoch or charge')
}
function actual(k: Knex.Transaction, writer = false): void {
  if (
    !k.isTransaction ||
    k.isCompleted() ||
    !(writer ? isBrc38OwnedPrivateNativeWriter(k) : isBrc38OwnedPrivateNativeSqlite(k))
  )
    invalid()
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function hasBrc38PrivateMergePages(k: Knex.Transaction): Promise<boolean> {
  actual(k)
  const total = (await k('sqlite_schema')
    .whereRaw('substr(name,1,?)=?', [table.length, table])
    .count({ count: '*' })
    .first()) as { count: number } | undefined
  if (total?.count === 0) return false
  if (total?.count !== definitions.length) invalid()
  for (const sql of definitions) {
    const [, type, name] = /^CREATE (TABLE|TRIGGER) (\w+)/.exec(sql)!,
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
export async function installBrc38PrivateMergePages(k: Knex.Transaction): Promise<void> {
  actual(k, true)
  if (!(await hasBrc38PrivateMergePages(k))) for (const sql of definitions) await k.raw(sql)
  if (!(await hasBrc38PrivateMergePages(k))) invalid()
}
export async function prepareBrc38PrivateMergePageBudget(
  k: Knex.Transaction,
  admission: Brc38ImportJournalAdmission
): Promise<void> {
  actual(k, true)
  if (!(await hasBrc38PrivateMergePages(k))) invalid()
  const rows = await k(budget).where({ importId: admission.scope.importId }).select('pages').limit(2)
  if (rows.length === 0) await k(budget).insert({ importId: admission.scope.importId, pages: 0 })
  else if (rows.length !== 1) invalid()
}
export async function brc38PrivateMergePageCharge(k: Knex.Transaction): Promise<number> {
  actual(k)
  if (!(await hasBrc38PrivateMergePages(k))) invalid()
  const rows = (await k(budget).select('importId', 'pages').orderBy('importId').limit(5)) as Array<{
    importId: string
    pages: number
  }>
  if (rows.length > 4) invalid()
  let charge = 0
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.pages) ||
      row.pages < 0 ||
      row.pages > 1000000000 ||
      (await k('brc38_import_journal').where({ importId: row.importId, cleanupAllowed: 0 }).select('importId').limit(2))
        .length !== 1
    )
      invalid()
    charge += row.pages * pageCharge
  }
  if (!Number.isSafeInteger(charge)) invalid()
  return charge
}
export async function readBrc38PrivateMergePageCacheEpoch(k: Knex.Transaction): Promise<number | undefined> {
  if (!isBrc38OwnedPrivateNativeSqlite(k)) return undefined
  actual(k, true)
  if (!(await hasBrc38PrivateMergePages(k))) {
    if (
      (await k('sqlite_schema').where({ type: 'table', name: 'brc38_private_merge_program' }).select('name').limit(1))
        .length
    )
      invalid()
    return undefined
  }
  const rows = (await k('prepared_beef_metadata')
    .where({ preparedBeefMetadataId: 1 })
    .select(
      k.raw(
        "CASE WHEN typeof(proofEpoch)='integer' AND proofEpoch BETWEEN 0 AND 9007199254740991 THEN proofEpoch END AS epoch"
      )
    )
    .limit(2)) as Array<{ epoch: number }>
  if (rows.length !== 1 || !Number.isSafeInteger(rows[0].epoch)) invalid()
  return rows[0].epoch
}
export interface Brc38PrivateMergePageCacheBefore {
  readonly epoch: number
  readonly readyId?: number
  readonly writerStartedAt: number
}
/** Actual bounded cache metadata captured before this page's effects. It does
 * not establish whether those effects are semantically warranted. */
export async function readBrc38PrivateMergePageCacheBefore(
  k: Knex.Transaction
): Promise<Brc38PrivateMergePageCacheBefore | undefined> {
  const writerStartedAt = Date.now(),
    epoch = await readBrc38PrivateMergePageCacheEpoch(k)
  if (epoch === undefined) return undefined
  const rows = (await k('prepared_beefs')
    .from(k.raw('?? INDEXED BY ??', ['prepared_beefs', brc38ImportTargetIndexName('preparedBeefReady', k)]))
    .where({ state: 'ready' })
    .orderBy('preparedBeefId')
    .select('preparedBeefId')
    .limit(1)) as Array<{ preparedBeefId: number }>
  const readyId = rows[0]?.preparedBeefId
  if (readyId !== undefined && (!Number.isSafeInteger(readyId) || readyId < 1)) invalid()
  actual(k, true)
  return Object.freeze({ epoch, writerStartedAt, ...(readyId === undefined ? {} : { readyId }) })
}
/** Compact DATA for every actually committed page, including the header and
 * archived sync states. The receipt has advanced in this SAME writer before
 * this append; any append/budget failure rolls back the whole page and receipt.
 * A lost-ACK replay bypasses append and cannot add an episode or page charge. */
export async function appendBrc38PrivateMergePage(
  k: Knex.Transaction,
  admission: Brc38ImportJournalAdmission,
  step: Brc38ImportJournalStep,
  previous: Brc38ImportJournalReceipt,
  next: Brc38ImportJournalReceipt,
  before: Brc38PrivateMergePageCacheBefore | undefined,
  checkpoint?: Readonly<Brc38PrivateCheckpointData>
): Promise<void> {
  if (before === undefined) return
  const cacheEpochBefore = before.epoch
  actual(k, true)
  const actualReceipt = await readBrc38ImportJournal(k, admission),
    stepJson = JSON.stringify(step),
    cacheEpochAfter = await readBrc38PrivateMergePageCacheEpoch(k)
  if (
    JSON.stringify(actualReceipt) !== JSON.stringify(next) ||
    previous.nextRow !== step.fromRow ||
    next.sequence !== previous.sequence + 1 ||
    next.nextRow !== step.fromRow + step.rows ||
    JSON.stringify(next.lastStep) !== stepJson ||
    Buffer.byteLength(stepJson) > 1024 ||
    cacheEpochAfter === undefined ||
    cacheEpochAfter < cacheEpochBefore ||
    cacheEpochAfter > cacheEpochBefore + 1
  )
    invalid()
  const original = (await k('brc38_import_structured_original')
    .where({ ...admission.scope, sourceRow: step.fromRow })
    .select('tableName')
    .limit(2)) as Array<{ tableName: string }>
  if (original.length !== 1 || !['header', ...brc38ImportTableOrder].includes(original[0].tableName)) invalid()
  const writerFinishedAt = Date.now(),
    checkpointData = checkpoint === undefined ? undefined : brc38PrivateCheckpointData(checkpoint)
  if (
    checkpointData !== undefined &&
    (checkpointData.preparedAt > writerFinishedAt ||
      checkpointData.preparedAt >= admission.expiresAt ||
      (checkpointData.mode === 'NEW' &&
        (original[0].tableName !== 'header' || Date.parse(checkpointData.timestamp!) !== checkpointData.preparedAt)) ||
      (checkpointData.mode === 'SKIP' && original[0].tableName !== 'syncStates'))
  )
    invalid()
  let cacheUpdatedAt: string | null = null
  if (cacheEpochAfter !== cacheEpochBefore && before.readyId !== undefined) {
    const artifacts = (await k('prepared_beefs')
      .where({ preparedBeefId: before.readyId })
      .select('state', 'formatVersion', 'updated_at')
      .limit(2)) as Array<{ state: string; formatVersion: number; updated_at: unknown }>
    if (
      artifacts.length !== 1 ||
      artifacts[0].state !== 'stale' ||
      artifacts[0].formatVersion !== 0 ||
      typeof artifacts[0].updated_at !== 'string'
    )
      invalid()
    cacheUpdatedAt = artifacts[0].updated_at
    const time = Date.parse(cacheUpdatedAt)
    if (
      !Number.isSafeInteger(time) ||
      new Date(time).toISOString() !== cacheUpdatedAt ||
      time < before.writerStartedAt ||
      time > writerFinishedAt
    )
      invalid()
  }
  if (writerFinishedAt < before.writerStartedAt || writerFinishedAt >= admission.expiresAt) invalid()
  await k(table).insert({
    importId: admission.scope.importId,
    fromRow: step.fromRow,
    previousFromRow: previous.lastStep?.fromRow ?? null,
    tableName: original[0].tableName,
    stepJson,
    sequence: next.sequence,
    nextRow: next.nextRow,
    mappedIds: next.mappedIds,
    beforeDestinationSha256: previous.destinationSha256,
    afterDestinationSha256: next.destinationSha256,
    beforeReceiptSha256: digest(previous),
    afterReceiptSha256: digest(next),
    cacheEpochBefore,
    cacheEpochAfter,
    cacheReadyId: before.readyId ?? null,
    writerStartedAt: before.writerStartedAt,
    writerFinishedAt,
    cacheUpdatedAt,
    checkpointJson: checkpointData === undefined ? null : JSON.stringify(checkpointData)
  })
  actual(k, true)
}
interface PageRow {
  fromRow: number
  previousFromRow: number | null
  tableName: string
  stepJson: string
  sequence: number
  nextRow: number
  mappedIds: number
  beforeDestinationSha256: string
  afterDestinationSha256: string
  beforeReceiptSha256: string
  afterReceiptSha256: string
  cacheEpochBefore: number
  cacheEpochAfter: number
  cacheReadyId: number | null
  writerStartedAt: number
  writerFinishedAt: number
  cacheUpdatedAt: string | null
  checkpointJson: string | null
}
/** Rebuild every page fingerprint from actual staged DATA, then rebuild the
 * complete receipt chain. Page records are not accepted as semantic/cache
 * verdicts: the later proof inventory must independently derive invalidations. */
export async function inspectBrc38PrivateMergePages(
  store: KnexBrc38StagingStore,
  k: Knex.Transaction,
  admission: Brc38ImportJournalAdmission,
  selected: Readonly<{ workingAllocation: Brc38WorkingAllocation; signal?: AbortSignal }>
): Promise<
  Readonly<{ pages: number; cacheInvalidations: number; cacheEpochBefore?: number; cacheEpochAfter?: number }>
> {
  const working = brc38WorkingAllocation(selected.workingAllocation),
    signal = selected.signal,
    binding = store.binding,
    // Original admission expiry still bounds every historical writer below.
    // Read-only recovery is owned by its independently bounded actual copy.
    deadline = performance.now() + Math.max(0, store.operationExpiresAt - Date.now())
  if (
    working === undefined ||
    binding === undefined ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    admission.scope.bindingSha256 !== binding.digest ||
    admission.originalLimitsJson !== binding.limitsJson ||
    admission.expiresAt !== store.limits.expiresAt
  )
    invalid()
  const frame = working.claim(2097152),
    check = (): void => {
      signal?.throwIfAborted()
      if (store.binding !== binding || Date.now() >= store.operationExpiresAt || performance.now() >= deadline)
        invalid()
      store.assertPrivateNativeReadTransaction(k)
    },
    limits = JSON.parse(admission.originalLimitsJson) as number[],
    counts = new Map<string, number>(),
    offsets = new Map<string, number>()
  let pages = 0,
    cacheInvalidations = 0,
    cacheEpochBefore: number | undefined,
    cacheEpochAfter: number | undefined
  try {
    check()
    await verifyBrc38AuthenticatedSourceSeal(k)
    if (!(await hasBrc38PrivateMergePages(k))) invalid()
    const receipt = await readBrc38ImportJournal(k, admission, working)
    if (receipt.state === 'EXPIRED') invalid()
    let ordinal = 1
    for (const name of brc38ImportTableOrder) {
      const values = (await k('table_counts').where({ tableName: name }).select('rows').limit(2)) as Array<{
        rows: number
      }>
      if (values.length !== 1 || !Number.isSafeInteger(values[0].rows) || values[0].rows < 0) invalid()
      counts.set(name, values[0].rows)
      offsets.set(name, ordinal)
      ordinal += values[0].rows
      if (!Number.isSafeInteger(ordinal) || ordinal > admission.totalRows) invalid()
    }
    if (ordinal !== admission.totalRows) invalid()
    let previous: Brc38ImportJournalReceipt = Object.freeze({
        protocol: 'brc38-destination-import/v1',
        state: 'PREPARED',
        sequence: 0,
        nextRow: 0,
        mappedIds: 0,
        logicalBytes: 4096,
        destinationSha256: admission.initialDestinationSha256,
        lastStep: null
      }),
      after = -1,
      materializedNextRow = 0,
      incrementalCheckpoint = false
    const feed = (hash: ReturnType<typeof createHash>, value: unknown): number => {
      let bytes = 0
      for (const chunk of canonicalPortableChunks(value, {
        maximumValueBytes: limits[4],
        maximumChunkBytes: 4096,
        signal
      })) {
        try {
          bytes += chunk.length
          hash.update(chunk)
        } finally {
          chunk.fill(0)
        }
      }
      if (!Number.isSafeInteger(bytes) || bytes > limits[3]) invalid()
      return bytes
    }
    for (;;) {
      check()
      const values = (await k(table)
        .where({ importId: admission.scope.importId })
        .where('fromRow', '>', after)
        .orderBy('fromRow')
        .select(
          'fromRow',
          'previousFromRow',
          'tableName',
          'stepJson',
          'sequence',
          'nextRow',
          'mappedIds',
          'beforeDestinationSha256',
          'afterDestinationSha256',
          'beforeReceiptSha256',
          'afterReceiptSha256',
          'cacheEpochBefore',
          'cacheEpochAfter',
          'cacheReadyId',
          'writerStartedAt',
          'writerFinishedAt',
          'cacheUpdatedAt',
          'checkpointJson'
        )
        .limit(1)) as PageRow[]
      if (values.length === 0) break
      const page = values[0],
        step = stepCopy(JSON.parse(page.stepJson), admission)
      if (
        JSON.stringify(step) !== page.stepJson ||
        step.fromRow !== page.fromRow ||
        page.fromRow !== previous.nextRow ||
        page.previousFromRow !== (previous.lastStep?.fromRow ?? null) ||
        page.sequence !== previous.sequence + 1 ||
        page.nextRow !== page.fromRow + step.rows ||
        page.nextRow > receipt.nextRow ||
        page.mappedIds !== previous.mappedIds + step.mappedIds ||
        page.beforeDestinationSha256 !== previous.destinationSha256 ||
        page.beforeReceiptSha256 !== digest(previous) ||
        (cacheEpochAfter !== undefined && page.cacheEpochBefore !== cacheEpochAfter) ||
        !Number.isSafeInteger(page.cacheEpochBefore) ||
        !Number.isSafeInteger(page.cacheEpochAfter) ||
        page.cacheEpochBefore < 0 ||
        page.cacheEpochAfter < page.cacheEpochBefore ||
        page.cacheEpochAfter > page.cacheEpochBefore + 1 ||
        (page.tableName !== 'provenTxs' && page.cacheEpochAfter !== page.cacheEpochBefore)
      )
        invalid()
      if (
        !Number.isSafeInteger(page.writerStartedAt) ||
        !Number.isSafeInteger(page.writerFinishedAt) ||
        page.writerStartedAt < 0 ||
        page.writerFinishedAt < page.writerStartedAt ||
        page.writerFinishedAt >= admission.expiresAt ||
        (page.cacheReadyId !== null && (!Number.isSafeInteger(page.cacheReadyId) || page.cacheReadyId < 1))
      )
        invalid()
      if (page.checkpointJson !== null) {
        if (typeof page.checkpointJson !== 'string' || Buffer.byteLength(page.checkpointJson) > 512) invalid()
        const data = brc38PrivateCheckpointData(JSON.parse(page.checkpointJson))
        if (
          JSON.stringify(data) !== page.checkpointJson ||
          data.preparedAt > page.writerFinishedAt ||
          data.preparedAt >= admission.expiresAt ||
          (data.mode === 'NEW' && (page.tableName !== 'header' || Date.parse(data.timestamp!) !== data.preparedAt)) ||
          (data.mode === 'SKIP' && page.tableName !== 'syncStates')
        )
          invalid()
        if (data.protocol === 'brc38-private-checkpoint-data/v2') {
          materializedNextRow = brc38PrivateCheckpointMaterializationCursor(
            data,
            page.fromRow,
            page.nextRow,
            materializedNextRow
          )
          incrementalCheckpoint = true
        } else {
          if (incrementalCheckpoint && materializedNextRow !== page.fromRow) invalid()
          materializedNextRow = page.nextRow
        }
      } else if (incrementalCheckpoint) invalid()
      if (page.cacheEpochAfter !== page.cacheEpochBefore && page.cacheReadyId !== null) {
        if (typeof page.cacheUpdatedAt !== 'string') invalid()
        const time = Date.parse(page.cacheUpdatedAt)
        if (
          !Number.isSafeInteger(time) ||
          new Date(time).toISOString() !== page.cacheUpdatedAt ||
          time < page.writerStartedAt ||
          time > page.writerFinishedAt
        )
          invalid()
      } else if (page.cacheUpdatedAt !== null) invalid()
      const hash = createHash('sha256')
      hash.update(
        JSON.stringify(['brc38-prepared-structured-import-page/v1', admission.scope, admission.previewId, page.fromRow])
      )
      let bytes = 0
      if (page.fromRow === 0) {
        if (page.tableName !== 'header' || step.rows !== 1 || step.mappedIds !== 0) invalid()
        const extents = (await k('metadata')
          .where({ slot: 1 })
          .select(k.raw('length(CAST(header AS BLOB)) AS bytes'))
          .limit(2)) as Array<{ bytes: number }>
        if (
          extents.length !== 1 ||
          !Number.isSafeInteger(extents[0].bytes) ||
          extents[0].bytes < 1 ||
          extents[0].bytes > limits[3]
        )
          invalid()
        const allocation = working.claim(131072 + 64 * extents[0].bytes)
        try {
          const headers = (await k('metadata').where({ slot: 1 }).select('header').limit(2)) as Array<{
            header: string
          }>
          if (
            headers.length !== 1 ||
            typeof headers[0].header !== 'string' ||
            Buffer.byteLength(headers[0].header) !== extents[0].bytes
          )
            invalid()
          bytes = feed(hash, JSON.parse(headers[0].header))
        } finally {
          allocation.close()
        }
      } else {
        const name = brc38ImportTableOrder.find(
          value => page.fromRow >= offsets.get(value)! && page.fromRow < offsets.get(value)! + counts.get(value)!
        )
        if (name === undefined || page.tableName !== name) invalid()
        const position = page.fromRow - offsets.get(name)!
        if (
          position + step.rows > counts.get(name)! ||
          step.mappedIds !== (brc38ImportRowForm(name).entity === undefined ? 0 : step.rows)
        )
          invalid()
        hash.update(JSON.stringify([name, position]))
        for (let index = position; index < position + step.rows; index++) {
          check()
          const extents = (await k('rows')
            .where({ tableName: name, position: index })
            .select(
              'bytes',
              k.raw("CASE WHEN typeof(payload)='text' THEN length(CAST(payload AS BLOB)) END AS actualBytes")
            )
            .limit(2)) as Array<{ bytes: number; actualBytes: number }>
          if (
            extents.length !== 1 ||
            !Number.isSafeInteger(extents[0].bytes) ||
            extents[0].bytes < 1 ||
            extents[0].bytes > limits[3] ||
            extents[0].bytes !== extents[0].actualBytes
          )
            invalid()
          const allocation = working.claim(131072 + 64 * extents[0].bytes)
          try {
            const cells = (await k('rows')
              .where({ tableName: name, position: index })
              .select('payload')
              .limit(2)) as Array<{ payload: string }>
            if (
              cells.length !== 1 ||
              typeof cells[0].payload !== 'string' ||
              Buffer.byteLength(cells[0].payload) !== extents[0].bytes
            )
              invalid()
            const fields = JSON.parse(cells[0].payload),
              binaries = await readBrc38SqlBinaryDescriptors(k, name, index),
              structured = await readBrc38SqlStructuredDescriptors(k, name, index),
              texts = await readBrc38SqlTextDescriptors(k, name, index),
              row = {
                fields,
                binaries,
                ...(Object.keys(structured ?? {}).length === 0 ? {} : { structured }),
                ...(Object.keys(texts ?? {}).length === 0 ? {} : { texts })
              }
            bytes += feed(hash, row)
          } finally {
            allocation.close()
          }
        }
      }
      if (bytes !== step.bytes || hash.digest('hex') !== step.pageSha256) invalid()
      const next: Brc38ImportJournalReceipt = Object.freeze({
        protocol: previous.protocol,
        state: page.nextRow === admission.totalRows ? 'COMPLETE' : 'COMMITTED',
        sequence: page.sequence,
        nextRow: page.nextRow,
        mappedIds: page.mappedIds,
        logicalBytes: 4096 + 512 * page.mappedIds,
        destinationSha256: page.afterDestinationSha256,
        lastStep: step
      })
      if (digest(next) !== page.afterReceiptSha256) invalid()
      if (cacheEpochBefore === undefined) cacheEpochBefore = page.cacheEpochBefore
      cacheInvalidations += page.cacheEpochAfter - page.cacheEpochBefore
      cacheEpochAfter = page.cacheEpochAfter
      previous = next
      after = page.fromRow
      if (++pages > receipt.nextRow) invalid()
    }
    const budgets = (await k(budget).where({ importId: admission.scope.importId }).select('pages').limit(2)) as Array<{
      pages: number
    }>
    if (
      budgets.length !== 1 ||
      budgets[0].pages !== pages ||
      pages !== receipt.sequence ||
      JSON.stringify(previous) !== JSON.stringify(receipt)
    )
      invalid()
    if (incrementalCheckpoint && receipt.state === 'COMPLETE' && materializedNextRow !== receipt.nextRow) invalid()
    check()
    return Object.freeze({
      pages,
      cacheInvalidations,
      ...(cacheEpochBefore === undefined ? {} : { cacheEpochBefore, cacheEpochAfter })
    })
  } finally {
    frame.close()
  }
}
