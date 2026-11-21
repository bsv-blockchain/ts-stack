import { Brc38RetiredNativeReadNode } from './Brc38RetiredNativeReadNode'
import { requireBrc38PackedRead } from './Brc38NativePackedSchemaNode'
import { requireBrc38NativeProfileTransaction } from './Brc38PublishedProfileNode'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { requireBrc38ImportSqliteTransaction } from './Brc38ImportJournalSchema'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import type { Brc38ImportMapScope } from './Brc38ImportIdMap'
import type { Brc38AuthenticatedImportReader } from './KnexBrc38StagingStore'
import type { Brc38PreparedImportData } from './Brc38ImportPage'
import type { BRC38WalletData } from './index'
import type { Brc38StageTable } from './Brc38SemanticStage'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { chargeBrc38ImportDecodedBudget, type Brc38ImportDecodedBudget } from './Brc38ImportEntityMergeNode'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { runInSeries } from '../../utility/runInSeries'
import { readBrc38ImportSchemaFamily } from './Brc38ImportJournalSchemaBody'

/** Fixed internal provenance families. SQL text expectations are DATA; every
 * install/read/prepare/apply independently checks the current owned transaction
 * and actual schema. The streamed family never replaces a legacy full-row
 * original with metadata or descriptors. No schema/backend verdict is cached. */
export function createBrc38ImportProvenanceStore(
  mode: 'legacy' | 'streamed' | 'structured',
  runtime: 'private' | 'published-native' | 'retired-read' = 'private'
) {
  if (!['legacy', 'streamed', 'structured'].includes(mode)) throw new TypeError('Invalid provenance family')
  if (runtime !== 'private' && runtime !== 'published-native' && runtime !== 'retired-read')
    throw new TypeError('Invalid provenance runtime')
  const requireCurrent = (trx: Knex.Transaction): void => {
    if (mode === 'structured') requireBrc38PackedRead(trx)
    if (runtime === 'retired-read') {
      if (!Brc38RetiredNativeReadNode.isReadTransaction(trx)) throw new Error('Actual retired provenance read required')
    } else if (runtime === 'published-native') requireBrc38NativeProfileTransaction(trx)
    else requireBrc38ImportSqliteTransaction(trx)
  }

  const rewrite = (value: string): string =>
    mode === 'legacy'
      ? value
      : value.replaceAll(
          'brc38_import_original',
          mode === 'streamed' ? 'brc38_import_streamed_original' : 'brc38_import_structured_original'
        )
  const scopeFields = ['importId', 'bindingSha256', 'archiveSha256', 'userId'] as const
  const budgetSql = rewrite(`CREATE TABLE brc38_import_original_budget (
  importId TEXT NOT NULL PRIMARY KEY REFERENCES brc38_import_journal(importId),
  bindingSha256 TEXT NOT NULL CHECK(typeof(bindingSha256) = 'text' AND length(bindingSha256) = 64),
  archiveSha256 TEXT NOT NULL CHECK(typeof(archiveSha256) = 'text' AND length(archiveSha256) = 64),
  userId INTEGER NOT NULL CHECK(typeof(userId) = 'integer' AND userId BETWEEN -9007199254740991 AND 9007199254740991),
  maximumRows INTEGER NOT NULL CHECK(typeof(maximumRows) = 'integer' AND maximumRows BETWEEN 1 AND 1000000001),
  rows INTEGER NOT NULL DEFAULT 0 CHECK(typeof(rows) = 'integer' AND rows BETWEEN 0 AND maximumRows),
  maximumLogicalBytes INTEGER NOT NULL CHECK(typeof(maximumLogicalBytes) = 'integer' AND maximumLogicalBytes BETWEEN 1 AND 9007199254740991),
  logicalBytes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(logicalBytes) = 'integer' AND logicalBytes BETWEEN 0 AND maximumLogicalBytes)
)`)
  const originalSql = rewrite(`CREATE TABLE brc38_import_original (
  importId TEXT NOT NULL REFERENCES brc38_import_original_budget(importId),
  bindingSha256 TEXT NOT NULL CHECK(typeof(bindingSha256) = 'text' AND length(bindingSha256) = 64),
  archiveSha256 TEXT NOT NULL CHECK(typeof(archiveSha256) = 'text' AND length(archiveSha256) = 64),
  userId INTEGER NOT NULL CHECK(typeof(userId) = 'integer' AND userId BETWEEN -9007199254740991 AND 9007199254740991),
  sourceRow INTEGER NOT NULL CHECK(typeof(sourceRow) = 'integer' AND sourceRow BETWEEN 0 AND 1000000000),
  tableName TEXT NOT NULL CHECK(typeof(tableName) = 'text' AND length(CAST(tableName AS BLOB)) BETWEEN 1 AND 32),
  originalJson TEXT NOT NULL CHECK(typeof(originalJson) = 'text' AND length(CAST(originalJson AS BLOB)) BETWEEN 1 AND 16777216),
  sha256 TEXT NOT NULL CHECK(typeof(sha256) = 'text' AND length(sha256) = 64),
  logicalBytes INTEGER NOT NULL CHECK(typeof(logicalBytes) = 'integer' AND logicalBytes = 512 + length(CAST(originalJson AS BLOB))),
  PRIMARY KEY(importId, bindingSha256, archiveSha256, userId, sourceRow)
)`)
  const triggers = [
    `CREATE TRIGGER brc38_import_original_budget_insert_guard BEFORE INSERT ON brc38_import_original_budget BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM brc38_import_journal j WHERE j.importId = NEW.importId
    AND j.bindingSha256 = NEW.bindingSha256 AND j.archiveSha256 = NEW.archiveSha256 AND j.userId = NEW.userId
    AND j.cleanupAllowed = 0 AND json_extract(j.receiptJson, '$.nextRow') = 0
    AND NEW.maximumRows = json_extract(j.admissionJson, '$.totalRows')
    AND NEW.maximumLogicalBytes = json_extract(json_extract(j.admissionJson, '$.originalLimitsJson'), '$[1]')
    AND NEW.rows = 0 AND NEW.logicalBytes = 0)
    THEN RAISE(ABORT, 'Private import original admission differs') END;
END`,
    `CREATE TRIGGER brc38_import_original_budget_update_guard BEFORE UPDATE ON brc38_import_original_budget BEGIN
  SELECT CASE WHEN NEW.importId IS NOT OLD.importId OR NEW.bindingSha256 IS NOT OLD.bindingSha256
    OR NEW.archiveSha256 IS NOT OLD.archiveSha256 OR NEW.userId IS NOT OLD.userId
    OR NEW.maximumRows IS NOT OLD.maximumRows OR NEW.maximumLogicalBytes IS NOT OLD.maximumLogicalBytes
    OR NEW.rows != OLD.rows + 1 OR NEW.logicalBytes <= OLD.logicalBytes
    THEN RAISE(ABORT, 'Private import original limits and charges are immutable') END;
END`,
    `CREATE TRIGGER brc38_import_original_budget_delete_guard BEFORE DELETE ON brc38_import_original_budget BEGIN
  SELECT RAISE(ABORT, 'Private import originals require owned cleanup');
END`,
    `CREATE TRIGGER brc38_import_original_insert_guard BEFORE INSERT ON brc38_import_original BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM brc38_import_original_budget b JOIN brc38_import_journal j ON j.importId = b.importId
    WHERE b.importId = NEW.importId AND b.bindingSha256 = NEW.bindingSha256
    AND b.archiveSha256 = NEW.archiveSha256 AND b.userId = NEW.userId AND j.cleanupAllowed = 0
    AND NEW.sourceRow = b.rows AND b.rows < b.maximumRows
    AND NEW.logicalBytes <= b.maximumLogicalBytes - b.logicalBytes)
    THEN RAISE(ABORT, 'Private import original scope, prefix or quota differs') END;
END`,
    `CREATE TRIGGER brc38_import_original_insert_charge AFTER INSERT ON brc38_import_original BEGIN
  UPDATE brc38_import_original_budget SET rows = rows + 1, logicalBytes = logicalBytes + NEW.logicalBytes WHERE importId = NEW.importId;
END`,
    `CREATE TRIGGER brc38_import_original_update_guard BEFORE UPDATE ON brc38_import_original BEGIN
  SELECT RAISE(ABORT, 'Private import original records are immutable');
END`,
    `CREATE TRIGGER brc38_import_original_delete_guard BEFORE DELETE ON brc38_import_original BEGIN
  SELECT RAISE(ABORT, 'Private import originals require owned cleanup');
END`
  ].map(rewrite)
  const expected = new Map<string, { type: string; sql: string | null }>(
    (
      [
        [rewrite('brc38_import_original_budget'), { type: 'table', sql: budgetSql }],
        [rewrite('brc38_import_original'), { type: 'table', sql: originalSql }],
        ['sqlite_autoindex_brc38_import_original_budget_1', { type: 'index', sql: null }],
        ['sqlite_autoindex_brc38_import_original_1', { type: 'index', sql: null }],
        ...triggers.map(sql => [sql.split(' ')[2], { type: 'trigger', sql }] as const)
      ] as Array<[string, { type: string; sql: string | null }]>
    ).map(([name, value]): [string, { type: string; sql: string | null }] => [
      rewrite(name),
      { ...value, sql: value.sql === null ? null : rewrite(value.sql) }
    ])
  )
  function invalid(): never {
    throw new Error('Private import original provenance differs from its admitted scope or source')
  }
  /** Migration body only. Existing-wallet/source registration and cleanup must be
   * qualified before advertisement; installing tables does not activate data. */
  async function installBrc38ImportProvenanceSchema(trx: Knex.Transaction): Promise<void> {
    if (runtime === 'retired-read') throw new Error('Retired provenance inspection cannot install content')
    requireCurrent(trx)
    const selected = await readBrc38ImportSchemaFamily(
      trx,
      expected,
      [rewrite('brc38_import_original_budget')],
      'Private import original provenance differs from its admitted scope or source',
      true
    )
    await runInSeries(selected.values(), async value => {
      if (value.sql === null) return
      const sql = value.sql
      await trx.raw(
        sql
          .replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')
          .replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS ')
      )
    })
    await verifyBrc38ImportProvenanceSchema(trx)
  }
  async function verifyBrc38ImportProvenanceSchema(trx: Knex.Transaction): Promise<void> {
    requireCurrent(trx)
    await readBrc38ImportSchemaFamily(
      trx,
      expected,
      [rewrite('brc38_import_original_budget')],
      'Private import original provenance differs from its admitted scope or source'
    )
    requireCurrent(trx)
  }
  interface OriginalBudget {
    rows: number
    logicalBytes: number
    maximumRows: number
    maximumLogicalBytes: number
  }
  async function readBudget(
    trx: Knex.Transaction,
    admission: Brc38ImportJournalAdmission
  ): Promise<OriginalBudget | undefined> {
    const rows: OriginalBudget[] = await trx(rewrite('brc38_import_original_budget'))
      .where(admission.scope)
      .select(
        ...['rows', 'logicalBytes', 'maximumRows', 'maximumLogicalBytes'].map(field =>
          trx.raw('CASE WHEN typeof(??) = ? AND ?? BETWEEN 0 AND 9007199254740991 THEN ?? END AS ??', [
            field,
            'integer',
            field,
            field,
            field
          ])
        )
      )
      .limit(2)
    if (rows.length > 1) invalid()
    if (rows.length === 0) return undefined
    const row = rows[0],
      limits = JSON.parse(admission.originalLimitsJson) as number[]
    if (
      Object.values(row).some(value => !Number.isSafeInteger(value)) ||
      row.maximumRows !== admission.totalRows ||
      row.maximumLogicalBytes !== limits[1] ||
      row.rows > row.maximumRows ||
      row.logicalBytes > row.maximumLogicalBytes
    )
      invalid()
    return row
  }
  interface OriginalRecord {
    readonly sourceRow: number
    readonly tableName: string
    readonly originalJson: string
    readonly sha256: string
    readonly logicalBytes: number
  }
  function encodedOriginal(value: unknown, budget: Brc38ImportDecodedBudget): string {
    let bytes = 0
    for (const chunk of canonicalPortableChunks(value, {
      maximumValueBytes: budget.maximum,
      maximumChunkBytes: 4096,
      signal: budget.signal
    }))
      bytes += chunk.length
    chargeBrc38ImportDecodedBudget(budget, 256 + 8 * bytes)
    const decoder = new TextDecoder(),
      parts: string[] = []
    for (const chunk of canonicalPortableChunks(value, {
      maximumValueBytes: budget.maximum,
      maximumChunkBytes: 4096,
      signal: budget.signal
    }))
      parts.push(decoder.decode(chunk, { stream: true }))
    parts.push(decoder.decode())
    return parts.join('')
  }
  /** Payload preparation is confined to the actual authenticated source/read
   * owner. Apply retains only bounded canonical originals and never source I/O. */
  async function prepareBrc38ImportOriginals(
    trx: Knex.Transaction,
    reader: Readonly<Brc38AuthenticatedImportReader>,
    admission: Brc38ImportJournalAdmission,
    data:
      | Brc38PreparedImportData
      | {
          readonly kind: 'table'
          readonly table: Brc38StageTable
          readonly fromIndex: number
          readonly rows: ReadonlyArray<unknown>
        }
      | {
          readonly kind: 'header'
          readonly original: Readonly<BRC38WalletData>
        },
    fromRow: number,
    budget: Brc38ImportDecodedBudget
  ): Promise<{ apply: (writer: Knex.Transaction) => Promise<void> }> {
    if (runtime === 'retired-read') throw new Error('Retired provenance inspection cannot prepare writes')
    await verifyBrc38ImportProvenanceSchema(trx)
    const before = await readBudget(trx, admission),
      limits = JSON.parse(admission.originalLimitsJson) as number[],
      records: OriginalRecord[] = []
    if (data.kind !== 'header' && before === undefined) invalid()
    const append = (value: unknown, sourceRow: number, tableName: string) => {
      const originalJson = encodedOriginal(value, budget)
      records.push(
        Object.freeze({
          sourceRow,
          tableName,
          originalJson,
          sha256: createHash('sha256').update(originalJson).digest('hex'),
          logicalBytes: 512 + Buffer.byteLength(originalJson)
        })
      )
    }
    if (data.kind === 'header') append(data.original, fromRow, 'header')
    else
      await runInSeries(data.rows.keys(), async index => {
        const original = await reader.row(data.table, data.fromIndex + index)
        if (original === undefined) invalid()
        append(original, fromRow + index, data.table)
      })
    const bytes = records.reduce((sum, row) => sum + row.logicalBytes, 0)
    // The receiver's exact last-page receipt decides replay. Preparation of that
    // acknowledged prefix must not require capacity for a second insertion.
    const alreadyRecorded = before !== undefined && before.rows >= fromRow + records.length
    if (
      !alreadyRecorded &&
      (bytes > limits[1] - (before?.logicalBytes ?? 0) || records.length > admission.totalRows - (before?.rows ?? 0))
    )
      throw new SnapshotResourceLimitError('Private import original provenance exceeds its fixed logical quota')
    let consumed = false
    return {
      async apply(writer) {
        requireCurrent(writer)
        if (consumed) throw new Error('Prepared private import originals are already consumed')
        consumed = true
        budget.signal?.throwIfAborted()
        if (JSON.stringify(await readBudget(writer, admission)) !== JSON.stringify(before)) invalid()
        if (before === undefined)
          await writer(rewrite('brc38_import_original_budget')).insert({
            ...admission.scope,
            maximumRows: admission.totalRows,
            maximumLogicalBytes: limits[1]
          })
        await runInSeries(records, async row => {
          budget.signal?.throwIfAborted()
          await writer(rewrite('brc38_import_original')).insert({ ...admission.scope, ...row })
        })
      }
    }
  }
  /** Internal scoped read: SQL type/byte checks precede native text transfer.
   * Caller still owns authentication and destination access; this is no token. */
  async function readBrc38ImportOriginal(
    trx: Knex.Transaction,
    scope: Brc38ImportMapScope,
    sourceRow: number,
    maximumBytes: number
  ): Promise<Readonly<{ tableName: string; originalJson: string }>> {
    requireCurrent(trx)
    if (
      !Number.isSafeInteger(sourceRow) ||
      sourceRow < 0 ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > 16777216
    )
      invalid()
    const key = { ...Object.fromEntries(scopeFields.map(field => [field, scope[field]])), sourceRow },
      extents: Array<{ bytes: number; tableBytes: number; digestBytes: number }> = await trx(
        rewrite('brc38_import_original')
      )
        .where(key)
        .select(
          trx.raw("CASE WHEN typeof(originalJson) = 'text' THEN length(CAST(originalJson AS BLOB)) END AS bytes"),
          trx.raw('length(CAST(tableName AS BLOB)) AS tableBytes, length(CAST(sha256 AS BLOB)) AS digestBytes')
        )
        .limit(2)
    if (
      extents.length !== 1 ||
      !Number.isSafeInteger(extents[0].bytes) ||
      extents[0].bytes < 1 ||
      extents[0].bytes > maximumBytes ||
      extents[0].tableBytes > 32 ||
      extents[0].digestBytes !== 64
    )
      invalid()
    const row: { tableName: string; originalJson: string; sha256: string } | undefined = await trx(
      rewrite('brc38_import_original')
    )
      .where(key)
      .first('tableName', 'originalJson', 'sha256')
    if (row === undefined || createHash('sha256').update(row.originalJson).digest('hex') !== row.sha256) invalid()
    return Object.freeze({ tableName: row.tableName, originalJson: row.originalJson })
  }

  return Object.freeze({
    install: installBrc38ImportProvenanceSchema,
    verify: verifyBrc38ImportProvenanceSchema,
    prepare: prepareBrc38ImportOriginals,
    read: readBrc38ImportOriginal
  })
}
const legacy = createBrc38ImportProvenanceStore('legacy')
export const installBrc38ImportProvenanceSchema = legacy.install
export const verifyBrc38ImportProvenanceSchema = legacy.verify
export const prepareBrc38ImportOriginals = legacy.prepare
export const readBrc38ImportOriginal = legacy.read
