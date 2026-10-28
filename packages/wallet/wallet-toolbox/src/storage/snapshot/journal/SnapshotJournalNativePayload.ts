import { promiseFromSync } from '../../../utility/promiseFromSync'
import { createHash, randomBytes } from 'node:crypto'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  withBrc38NativeLocalPackedWalletMutation,
  withBrc38NativeLocalPackedWalletTransaction,
  brc38NativeLocalPackedWalletLength,
  readBrc38NativeLocalPackedBinaryPacket
} from '../../portable/Brc38NativeLocalPackedWalletNode'
import { writeBrc38NativePackedBytes } from '../../portable/Brc38NativePackedFieldsNode'
import { collectBrc38NativePackedContent } from '../../portable/Brc38NativePackedTextFieldsNode'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'

export type SnapshotJournalPayloadTable = 'snapshot_reconciliation_stage_pages' | 'snapshot_reconciliation_provenance'
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Journal payload differs from its actual row or bounded frame')
}
function table(value: SnapshotJournalPayloadTable): void {
  if (value !== 'snapshot_reconciliation_stage_pages' && value !== 'snapshot_reconciliation_provenance') invalid()
}
function retained(k: Knex): void {
  if (isOwnedNativeSqlite(k) && !k.isTransaction) invalid()
}
/** Internal storage adaptation only. The caller retains its original actual
 * authenticated window/ACK fence. Neither keys nor frame bytes grant admission.
 * One already encoded <=1MiB frame is the existing bounded DTO contract. */
export async function writeSnapshotJournalPayloadRow(
  k: Knex,
  selected: SnapshotJournalPayloadTable,
  key: Record<string, unknown>,
  metadata: Record<string, unknown>,
  payload: Uint8Array,
  expected?: Record<string, unknown>
): Promise<void> {
  table(selected)
  retained(k)
  if (
    !(payload instanceof Uint8Array) ||
    payload.byteLength < 4 ||
    payload.byteLength > 1048576 ||
    Object.hasOwn(metadata, 'payload') ||
    metadata.bytes !== payload.byteLength
  )
    invalid()
  await withBrc38NativeLocalPackedWalletMutation(k, async (database, packed) => {
    const row = { ...metadata, payload: packed ? Buffer.alloc(0) : Buffer.from(payload) }
    try {
      if (expected === undefined) await database(selected).insert({ ...key, ...row })
      else if (
        (await database(selected)
          .where({ ...key, ...expected })
          .update(row)) !== 1
      )
        invalid()
      if (packed) {
        const trx = database as Knex.Transaction,
          rows = (await trx(selected)
            .where(key)
            .select(trx.raw('rowid AS physical'))
            .limit(2)
            .options({ safeIntegers: true })) as Array<{ physical: bigint }>
        if (
          rows.length !== 1 ||
          typeof rows[0].physical !== 'bigint' ||
          rows[0].physical < -9007199254740991n ||
          rows[0].physical > 9007199254740991n
        )
          invalid()
        await writeBrc38NativePackedBytes(
          trx,
          { table: selected, field: 'payload', rowId: Number(rows[0].physical) },
          payload
        )
        await collectBrc38NativePackedContent(trx, 16)
      }
    } finally {
      row.payload.fill(0)
    }
  })
}
/** Length expression for the SAME retained view as the actual page query. */
export async function snapshotJournalPayloadLength(
  k: Knex,
  selected: SnapshotJournalPayloadTable
): Promise<{ expression: Knex.Raw }> {
  table(selected)
  retained(k)
  return await withBrc38NativeLocalPackedWalletTransaction(k, (database, packed) =>
    promiseFromSync(() => ({
      // Knex.Raw is thenable. Box it so async return/await cannot execute this
      // SELECT fragment as a standalone query before the retained page query.
      expression: packed
        ? database.raw('? AS actualBytes', [
            brc38NativeLocalPackedWalletLength(database as Knex.Transaction, selected, 'payload')
          ])
        : database.raw(
            (['mysql', 'mysql2'].includes(String(database.client.config.client))
              ? 'octet_length(??)'
              : 'length(cast(?? as blob))') + ' AS actualBytes',
            ['payload']
          )
    }))
  )
}
/** Complete negotiated frame only; chunk reads remain <=64KiB and their full
 * SHA is verified before returning. Never return the physical empty marker. */
export async function readSnapshotJournalPayloadRow(
  k: Knex,
  selected: SnapshotJournalPayloadTable,
  key: Record<string, unknown>,
  expectedBytes: number
): Promise<Uint8Array> {
  table(selected)
  retained(k)
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 4 || expectedBytes > 1048576) invalid()
  return await withBrc38NativeLocalPackedWalletTransaction(k, async (database, packed) => {
    if (packed) {
      const trx = database as Knex.Transaction,
        rows = (await trx(selected)
          .where(key)
          .select(trx.raw('rowid AS physical'))
          .limit(2)
          .options({ safeIntegers: true })) as Array<{ physical: bigint }>
      if (
        rows.length !== 1 ||
        typeof rows[0].physical !== 'bigint' ||
        rows[0].physical < -9007199254740991n ||
        rows[0].physical > 9007199254740991n
      )
        invalid()
      const bytes = await readBrc38NativeLocalPackedBinaryPacket(trx, selected, Number(rows[0].physical), expectedBytes)
      if (bytes.byteLength !== expectedBytes) {
        bytes.fill(0)
        invalid()
      }
      return bytes
    }
    const mysql = ['mysql', 'mysql2'].includes(String(database.client.config.client)),
      rows = (await database(selected)
        .where(key)
        .select(
          database.raw(
            mysql
              ? 'CASE WHEN octet_length(payload)=? THEN substr(payload,1,?) ELSE NULL END AS payload'
              : "CASE WHEN typeof(payload)='blob' AND length(payload)=? THEN substr(payload,1,?) ELSE NULL END AS payload",
            [expectedBytes, expectedBytes + 1]
          )
        )
        .limit(2)) as Array<{ payload: unknown }>
    if (rows.length !== 1 || !(rows[0].payload instanceof Uint8Array) || rows[0].payload.byteLength !== expectedBytes)
      invalid()
    return rows[0].payload
  })
}

export const snapshotJournalFieldCacheNames = Object.freeze({
  budgets: 'snapshot_reconciliation_pf_budgets',
  versions: 'snapshot_reconciliation_pf_versions',
  chunks: 'snapshot_reconciliation_pf_chunks'
})
/** Auxiliary field custody only. Payload chunks are real bounded SQL BLOBs;
 * no empty financial cell or native pointer authority is introduced. */
export function snapshotJournalFieldCacheDdl(k: Knex): string[] {
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client)),
    suffix = mysql ? ' ENGINE=InnoDB DEFAULT CHARACTER SET ascii COLLATE ascii_bin ROW_FORMAT=DYNAMIC' : '',
    textSuffix = mysql ? ' ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin ROW_FORMAT=DYNAMIC' : '',
    n = snapshotJournalFieldCacheNames
  return [
    `CREATE TABLE ${n.budgets}(userId BIGINT NOT NULL,lineage VARCHAR(64) NOT NULL,maximumBytes BIGINT NOT NULL,reserved BIGINT NOT NULL,versions BIGINT NOT NULL,PRIMARY KEY(userId,lineage))${suffix}`,
    `CREATE TABLE ${n.versions}(versionId VARCHAR(64) NOT NULL,userId BIGINT NOT NULL,lineage VARCHAR(64) NOT NULL,sourceStorageIdentity VARCHAR(256) NOT NULL,sessionId VARCHAR(64) NOT NULL,windowBinding VARCHAR(64) NOT NULL,frameDigest VARCHAR(64) NOT NULL,changeIndex INTEGER NOT NULL,incomingId BIGINT NOT NULL,sourceGeneration VARCHAR(64) NOT NULL,sourceRevision VARCHAR(19) NOT NULL,fieldName VARCHAR(64) NOT NULL,kind VARCHAR(8) NOT NULL,bytes BIGINT NOT NULL,sha256 VARCHAR(64) NOT NULL,accepted BIGINT NOT NULL,revision BIGINT NOT NULL,state VARCHAR(16) NOT NULL,linked INTEGER NOT NULL,recordDigest VARCHAR(64) NOT NULL,expiresAt BIGINT NOT NULL,PRIMARY KEY(versionId))${textSuffix}`,
    `CREATE INDEX snapshot_reconciliation_pf_owner ON ${n.versions}(userId,lineage,sessionId,frameDigest,changeIndex,fieldName)`,
    `CREATE INDEX snapshot_reconciliation_pf_current ON ${n.versions}(userId,lineage,incomingId,linked,fieldName)`,
    `CREATE INDEX snapshot_reconciliation_pf_gc ON ${n.versions}(userId,lineage,linked,state,expiresAt,versionId)`,
    `CREATE TABLE ${n.chunks}(versionId VARCHAR(64) NOT NULL,byteOffset BIGINT NOT NULL,bytes INTEGER NOT NULL,sha256 VARCHAR(64) NOT NULL,payload ${mysql ? 'LONGBLOB' : 'BLOB'} NOT NULL,PRIMARY KEY(versionId,byteOffset))${suffix}`
  ]
}
export interface SnapshotJournalFieldCacheTrigger {
  name: string
  table: string
  event: 'INSERT' | 'UPDATE' | 'DELETE'
  timing: 'BEFORE' | 'AFTER'
  body: string
  sql: string
}
/** Every byte mutation has an actual SQL event revision, including direct
 * writes. Immutable owner/descriptor coordinates and bounded append prefixes
 * are enforced in SQL; no stored SEALED bit substitutes for byte verification. */
export function snapshotJournalFieldCacheTriggers(mysql: boolean): SnapshotJournalFieldCacheTrigger[] {
  const n = snapshotJournalFieldCacheNames,
    guard = (condition: string): string =>
      mysql
        ? `IF ${condition} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Journal field custody differs'; END IF;`
        : `SELECT CASE WHEN ${condition} THEN RAISE(ABORT,'Journal field custody differs') END;`,
    definition = (
      suffix: string,
      table: string,
      timing: 'BEFORE' | 'AFTER',
      event: SnapshotJournalFieldCacheTrigger['event'],
      statements: string
    ): SnapshotJournalFieldCacheTrigger => {
      const name = 'snapshot_reconciliation_pf_' + suffix,
        body = 'BEGIN ' + statements + ' END'
      return {
        name,
        table,
        event,
        timing,
        body,
        sql: `CREATE TRIGGER ${name} ${timing} ${event} ON ${table} ${mysql ? 'FOR EACH ROW ' : ''}${body}`
      }
    },
    length = (value: string): string => (mysql ? `octet_length(${value})` : `length(CAST(${value} AS BLOB))`),
    different = (field: string): string =>
      mysql ? `NOT(NEW.${field}<=>OLD.${field})` : `NEW.${field} IS NOT OLD.${field}`,
    immutable = [
      'versionId',
      'userId',
      'lineage',
      'sourceStorageIdentity',
      'sessionId',
      'windowBinding',
      'frameDigest',
      'changeIndex',
      'incomingId',
      'sourceGeneration',
      'sourceRevision',
      'fieldName',
      'kind',
      'bytes',
      'sha256',
      'expiresAt'
    ],
    integerCells = mysql
      ? '1=1'
      : ['bytes', 'accepted', 'revision', 'linked', 'expiresAt', 'changeIndex', 'incomingId', 'userId']
          .map(name => `typeof(NEW.${name})='integer'`)
          .join(' AND '),
    valid =
      `(${integerCells}) AND ` +
      "NEW.userId>0 AND NEW.changeIndex BETWEEN 0 AND 255 AND NEW.expiresAt>0 AND NEW.kind IN('binary','utf8') AND NEW.accepted>=0 AND NEW.accepted<=NEW.bytes AND NEW.bytes BETWEEN 0 AND 1000000000 AND NEW.revision BETWEEN 0 AND 9223372036854775807 AND NEW.state IN('PENDING','SEALED','RETIRING') AND NEW.linked IN(0,1) AND (NEW.linked=0 OR (NEW.state='SEALED' AND NEW.accepted=NEW.bytes))"
  return [
    definition(
      'version_insert',
      n.versions,
      'BEFORE',
      'INSERT',
      guard(
        `NOT(${valid}) OR NEW.accepted<>0 OR NEW.revision<>0 OR NEW.state<>'PENDING' OR NEW.linked<>0 OR NEW.recordDigest<>'' OR EXISTS(SELECT 1 FROM ${n.versions} v WHERE v.userId=NEW.userId AND v.lineage=NEW.lineage AND v.sessionId=NEW.sessionId AND v.frameDigest=NEW.frameDigest AND v.changeIndex=NEW.changeIndex AND v.fieldName=NEW.fieldName LIMIT 1)`
      )
    ),
    definition(
      'version_update',
      n.versions,
      'BEFORE',
      'UPDATE',
      guard(
        `NOT(${valid}) OR OLD.revision>=9223372036854775807 OR NEW.revision<>OLD.revision+1 OR NEW.accepted<OLD.accepted OR (${immutable.map(different).join(' OR ')}) OR (OLD.state='RETIRING' AND NEW.state<>'RETIRING') OR (OLD.state='SEALED' AND NEW.state='PENDING') OR (OLD.linked=1 AND NEW.linked=0 AND NEW.state<>'RETIRING')`
      )
    ),
    definition(
      'version_delete',
      n.versions,
      'BEFORE',
      'DELETE',
      guard(
        `OLD.linked<>0 OR OLD.state<>'RETIRING' OR EXISTS(SELECT 1 FROM ${n.chunks} c WHERE c.versionId=OLD.versionId LIMIT 1)`
      )
    ),
    definition(
      'chunk_insert',
      n.chunks,
      'BEFORE',
      'INSERT',
      guard(
        `NEW.bytes NOT BETWEEN 1 AND 16384 OR ${length('NEW.payload')}<>NEW.bytes OR ${length('NEW.sha256')}<>64 OR NOT EXISTS(SELECT 1 FROM ${n.versions} v WHERE v.versionId=NEW.versionId AND v.state='PENDING' AND v.linked=0 AND NEW.byteOffset=v.accepted AND NEW.bytes<=v.bytes-v.accepted)`
      )
    ),
    definition(
      'chunk_update',
      n.chunks,
      'BEFORE',
      'UPDATE',
      guard(
        `${different('versionId')} OR ${different('byteOffset')} OR ${different('bytes')} OR ${length('NEW.payload')}<>NEW.bytes OR ${length('NEW.sha256')}<>64`
      )
    ),
    definition(
      'chunk_delete',
      n.chunks,
      'BEFORE',
      'DELETE',
      guard(
        `NOT EXISTS(SELECT 1 FROM ${n.versions} v WHERE v.versionId=OLD.versionId AND v.state='RETIRING' AND v.linked=0)`
      )
    ),
    definition(
      'chunk_insert_event',
      n.chunks,
      'AFTER',
      'INSERT',
      `UPDATE ${n.versions} SET accepted=accepted+NEW.bytes,revision=revision+1 WHERE versionId=NEW.versionId;`
    ),
    definition(
      'chunk_update_event',
      n.chunks,
      'AFTER',
      'UPDATE',
      `UPDATE ${n.versions} SET revision=revision+1 WHERE versionId=NEW.versionId;`
    ),
    definition(
      'chunk_delete_event',
      n.chunks,
      'AFTER',
      'DELETE',
      `UPDATE ${n.versions} SET revision=revision+1 WHERE versionId=OLD.versionId;`
    )
  ]
}

/** Capacity/binding DATA. Only the actual live transaction/root operation grant
 * authorizes these SQL operations. These records never issue a financial field
 * attachment or replace independent source/stored-byte verification. */
export interface SnapshotJournalFieldCacheScope {
  root: Knex
  backend: string
  userId: number
  lineage: string
  maximumBytes: number
}
export interface SnapshotJournalFieldCacheVersion {
  versionId: string
  userId: number
  lineage: string
  sourceStorageIdentity: string
  sessionId: string
  windowBinding: string
  frameDigest: string
  changeIndex: number
  incomingId: number
  sourceGeneration: string
  sourceRevision: string
  fieldName: string
  kind: 'binary' | 'utf8'
  bytes: number
  sha256: string
  accepted: number
  revision: string
  state: 'PENDING' | 'SEALED' | 'RETIRING'
  linked: number
  recordDigest: string
  expiresAt: number
}
type FieldCacheInput = Omit<
  SnapshotJournalFieldCacheVersion,
  'versionId' | 'accepted' | 'revision' | 'state' | 'linked' | 'recordDigest'
>
function cacheInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value === 'string' && /^-?(?:0|[1-9]\d{0,15})$/.test(value)) value = Number(value)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}
function cacheText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) < 1 ||
    Buffer.byteLength(value) > maximum ||
    Buffer.from(value).toString('utf8') !== value
  )
    invalid()
  return value
}
function cacheHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid()
  return value
}
function requireFieldCache(trx: Knex, scope: SnapshotJournalFieldCacheScope): void {
  // Resolve the actual writer guard only at the operation boundary. A static
  // import would cycle through migration/schema initialization.
  const owner = require('./SnapshotJournalOwnedWriter') as typeof import('./SnapshotJournalOwnedWriter')
  owner.requireSnapshotJournalOwnedWriter(trx, scope.root, scope.backend)
  cacheInteger(scope.userId, 1)
  cacheHash(scope.lineage)
  cacheInteger(scope.maximumBytes, 1)
}
function parseFieldCacheVersion(
  row: Record<string, unknown>,
  scope: SnapshotJournalFieldCacheScope
): SnapshotJournalFieldCacheVersion {
  const result: SnapshotJournalFieldCacheVersion = {
    versionId: cacheHash(row.versionId),
    userId: cacheInteger(row.userId, 1),
    lineage: cacheHash(row.lineage),
    sourceStorageIdentity: cacheText(row.sourceStorageIdentity, 256),
    sessionId: cacheHash(row.sessionId),
    windowBinding: cacheHash(row.windowBinding),
    frameDigest: cacheHash(row.frameDigest),
    changeIndex: cacheInteger(row.changeIndex, 0, 255),
    incomingId: cacheInteger(row.incomingId, -Number.MAX_SAFE_INTEGER),
    sourceGeneration: cacheHash(row.sourceGeneration),
    sourceRevision: snapshotJournalRevision(row.sourceRevision),
    fieldName: cacheText(row.fieldName, 64),
    kind: row.kind === 'binary' ? 'binary' : row.kind === 'utf8' ? 'utf8' : invalid(),
    bytes: cacheInteger(row.bytes, 0, 1000000000),
    sha256: cacheHash(row.sha256),
    accepted: cacheInteger(row.accepted, 0, 1000000000),
    revision: snapshotJournalRevision(row.revision),
    state: row.state === 'PENDING' || row.state === 'SEALED' || row.state === 'RETIRING' ? row.state : invalid(),
    linked: cacheInteger(row.linked, 0, 1),
    recordDigest: row.recordDigest === '' ? '' : cacheHash(row.recordDigest),
    expiresAt: cacheInteger(row.expiresAt, 1)
  }
  if (
    result.userId !== scope.userId ||
    result.lineage !== scope.lineage ||
    result.accepted > result.bytes ||
    (result.linked === 1 &&
      (result.state !== 'SEALED' || result.accepted !== result.bytes || result.recordDigest === ''))
  )
    invalid()
  return Object.freeze(result)
}
export async function readSnapshotJournalFieldCacheVersion(
  trx: Knex,
  scope: SnapshotJournalFieldCacheScope,
  versionId: string
): Promise<Readonly<SnapshotJournalFieldCacheVersion>> {
  requireFieldCache(trx, scope)
  const mysql = ['mysql', 'mysql2'].includes(String(trx.client.config.client)),
    rows: Array<Record<string, unknown>> = await trx(snapshotJournalFieldCacheNames.versions)
      .where({ versionId: cacheHash(versionId), userId: scope.userId, lineage: scope.lineage })
      .select(
        ...Object.entries({
          versionId: 64,
          lineage: 64,
          sourceStorageIdentity: 256,
          sessionId: 64,
          windowBinding: 64,
          frameDigest: 64,
          sourceGeneration: 64,
          sourceRevision: 19,
          fieldName: 64,
          kind: 8,
          sha256: 64,
          state: 16,
          recordDigest: 64
        }).map(([name, maximum]) =>
          trx.raw(
            mysql
              ? 'CASE WHEN octet_length(??)<=? THEN ?? ELSE NULL END AS ??'
              : "CASE WHEN typeof(??)='text' AND length(CAST(?? AS BLOB))<=? THEN ?? ELSE NULL END AS ??",
            mysql ? [name, maximum, name, name] : [name, name, maximum, name, name]
          )
        ),
        ...Object.entries({
          userId: [1, Number.MAX_SAFE_INTEGER],
          changeIndex: [0, 255],
          incomingId: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
          bytes: [0, 1000000000],
          accepted: [0, 1000000000],
          linked: [0, 1],
          expiresAt: [1, Number.MAX_SAFE_INTEGER]
        }).map(([name, [minimum, maximum]]) =>
          trx.raw(
            mysql
              ? 'CASE WHEN ?? BETWEEN ? AND ? THEN ?? ELSE NULL END AS ??'
              : "CASE WHEN typeof(??)='integer' AND ?? BETWEEN ? AND ? THEN ?? ELSE NULL END AS ??",
            mysql ? [name, minimum, maximum, name, name] : [name, name, minimum, maximum, name, name]
          )
        ),
        trx.raw(
          mysql
            ? 'CASE WHEN revision BETWEEN 0 AND 9223372036854775807 THEN CAST(revision AS CHAR) ELSE NULL END AS revision'
            : "CASE WHEN typeof(revision)='integer' AND revision BETWEEN 0 AND 9223372036854775807 THEN CAST(revision AS TEXT) ELSE NULL END AS revision"
        )
      )
      .limit(2)
  if (rows.length !== 1) invalid()
  return parseFieldCacheVersion(rows[0], scope)
}
/** Reserve the full immutable field before accepting its first chunk. Existing
 * bounded owner coordinates resume the same prefix, never a second reservation.
 * A returned header is DATA, including SEALED; callers must rehash actual bytes. */
export async function beginSnapshotJournalFieldCache(
  trx: Knex,
  scope: SnapshotJournalFieldCacheScope,
  input: FieldCacheInput
): Promise<Readonly<SnapshotJournalFieldCacheVersion>> {
  requireFieldCache(trx, scope)
  const n = snapshotJournalFieldCacheNames,
    candidate = parseFieldCacheVersion(
      {
        ...input,
        versionId: randomBytes(32).toString('hex'),
        accepted: 0,
        revision: '0',
        state: 'PENDING',
        linked: 0,
        recordDigest: ''
      },
      scope
    ),
    owner = {
      userId: scope.userId,
      lineage: scope.lineage,
      sessionId: candidate.sessionId,
      frameDigest: candidate.frameDigest,
      changeIndex: candidate.changeIndex,
      fieldName: candidate.fieldName
    },
    existing: Array<{ versionId: unknown }> = await trx(n.versions).where(owner).select('versionId').limit(2)
  if (existing.length > 1) invalid()
  if (existing.length === 1) {
    const actual = await readSnapshotJournalFieldCacheVersion(trx, scope, cacheHash(existing[0].versionId))
    for (const [name, value] of Object.entries(input)) if (Reflect.get(actual, name) !== value) invalid()
    if (actual.state === 'RETIRING') invalid()
    return actual
  }
  const key = { userId: scope.userId, lineage: scope.lineage },
    budgets: Array<Record<string, unknown>> = await trx(n.budgets)
      .where(key)
      .select('maximumBytes', 'reserved', 'versions')
      .limit(2)
  if (budgets.length > 1) invalid()
  if (budgets.length === 0) {
    if ((await trx(n.versions).where(key).select('versionId').limit(1)).length !== 0) invalid()
    await trx(n.budgets).insert({ ...key, maximumBytes: scope.maximumBytes, reserved: 0, versions: 0 })
  }
  const reserved = budgets.length === 0 ? 0 : cacheInteger(budgets[0].reserved),
    versions = budgets.length === 0 ? 0 : cacheInteger(budgets[0].versions, 0, 2147483647)
  if (budgets.length && cacheInteger(budgets[0].maximumBytes, 1) !== scope.maximumBytes) invalid()
  const original: Array<{ bytes: unknown }> = await trx('snapshot_reconciliation_provenance_budgets')
    .where(key)
    .select('bytes')
    .limit(2)
  if (original.length > 1) invalid()
  const provenanceBytes = original.length === 0 ? 0 : cacheInteger(original[0].bytes)
  if (candidate.bytes > scope.maximumBytes - reserved - provenanceBytes || versions === 2147483647)
    throw new SnapshotResourceLimitError('Provenance field custody exceeds its original logical capacity')
  if (
    (await trx(n.budgets)
      .where({ ...key, maximumBytes: scope.maximumBytes, reserved, versions })
      .update({ reserved: reserved + candidate.bytes, versions: versions + 1 })) !== 1
  )
    invalid()
  await trx(n.versions).insert({ ...candidate, revision: 0 })
  return candidate
}
function sameFieldCacheVersion(
  expected: Readonly<SnapshotJournalFieldCacheVersion>,
  actual: Readonly<SnapshotJournalFieldCacheVersion>
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) invalid()
}
export async function appendSnapshotJournalFieldCache(
  trx: Knex,
  scope: SnapshotJournalFieldCacheScope,
  expected: Readonly<SnapshotJournalFieldCacheVersion>,
  bytes: Uint8Array
): Promise<Readonly<SnapshotJournalFieldCacheVersion>> {
  requireFieldCache(trx, scope)
  sameFieldCacheVersion(expected, await readSnapshotJournalFieldCacheVersion(trx, scope, expected.versionId))
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 1 ||
    bytes.length > 16384 ||
    expected.state !== 'PENDING' ||
    expected.linked !== 0 ||
    bytes.length > expected.bytes - expected.accepted
  )
    invalid()
  const payload = Buffer.from(bytes)
  try {
    await trx(snapshotJournalFieldCacheNames.chunks).insert({
      versionId: expected.versionId,
      byteOffset: expected.accepted,
      bytes: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
      payload
    })
  } finally {
    payload.fill(0)
  }
  const actual = await readSnapshotJournalFieldCacheVersion(trx, scope, expected.versionId)
  if (
    actual.accepted !== expected.accepted + bytes.length ||
    BigInt(actual.revision) !== BigInt(expected.revision) + 1n
  )
    invalid()
  return actual
}
export async function readSnapshotJournalFieldCacheChunk(
  trx: Knex,
  scope: SnapshotJournalFieldCacheScope,
  expected: Readonly<SnapshotJournalFieldCacheVersion>,
  offset: number
): Promise<Readonly<{ bytes: Uint8Array; nextOffset: number }>> {
  requireFieldCache(trx, scope)
  sameFieldCacheVersion(expected, await readSnapshotJournalFieldCacheVersion(trx, scope, expected.versionId))
  cacheInteger(offset, 0, expected.accepted)
  if (offset === expected.accepted) return Object.freeze({ bytes: new Uint8Array(0), nextOffset: offset })
  const mysql = ['mysql', 'mysql2'].includes(String(trx.client.config.client)),
    rows: Array<{ bytes: unknown; sha256: unknown; payload: unknown }> = await trx(
      snapshotJournalFieldCacheNames.chunks
    )
      .where({ versionId: expected.versionId, byteOffset: offset })
      .select(
        'bytes',
        'sha256',
        trx.raw(
          mysql
            ? 'CASE WHEN bytes BETWEEN 1 AND 16384 AND octet_length(payload)=bytes THEN payload ELSE NULL END AS payload'
            : "CASE WHEN typeof(bytes)='integer' AND bytes BETWEEN 1 AND 16384 AND typeof(payload)='blob' AND length(payload)=bytes THEN payload ELSE NULL END AS payload"
        )
      )
      .limit(2)
  if (rows.length !== 1 || !(rows[0].payload instanceof Uint8Array)) invalid()
  const bytes = rows[0].payload
  try {
    if (
      bytes.length !== cacheInteger(rows[0].bytes, 1, 16384) ||
      bytes.length > expected.accepted - offset ||
      createHash('sha256').update(bytes).digest('hex') !== cacheHash(rows[0].sha256)
    )
      invalid()
    return Object.freeze({ bytes, nextOffset: offset + bytes.length })
  } catch (cause) {
    bytes.fill(0)
    throw cause
  }
}
/** Prefix-completion marker only, NOT a source/stored hash verdict or an issuer.
 * The actual field preparer must independently hash both complete byte streams. */
export async function sealSnapshotJournalFieldCache(
  trx: Knex,
  scope: SnapshotJournalFieldCacheScope,
  expected: Readonly<SnapshotJournalFieldCacheVersion>
): Promise<Readonly<SnapshotJournalFieldCacheVersion>> {
  requireFieldCache(trx, scope)
  sameFieldCacheVersion(expected, await readSnapshotJournalFieldCacheVersion(trx, scope, expected.versionId))
  if (expected.state !== 'PENDING' || expected.linked !== 0 || expected.accepted !== expected.bytes) invalid()
  if (
    (await trx(snapshotJournalFieldCacheNames.versions)
      .where({ versionId: expected.versionId, state: 'PENDING' })
      .update({ state: 'SEALED', revision: trx.raw('revision+1') })) !== 1
  )
    invalid()
  return await readSnapshotJournalFieldCacheVersion(trx, scope, expected.versionId)
}
export async function retireSnapshotJournalFieldCache(
  trx: Knex,
  scope: SnapshotJournalFieldCacheScope,
  expected: Readonly<SnapshotJournalFieldCacheVersion>
): Promise<Readonly<SnapshotJournalFieldCacheVersion>> {
  requireFieldCache(trx, scope)
  sameFieldCacheVersion(expected, await readSnapshotJournalFieldCacheVersion(trx, scope, expected.versionId))
  if (
    (await trx(snapshotJournalFieldCacheNames.versions)
      .where('versionId', expected.versionId)
      .update({ state: 'RETIRING', linked: 0, revision: trx.raw('revision+1') })) !== 1
  )
    invalid()
  return await readSnapshotJournalFieldCacheVersion(trx, scope, expected.versionId)
}
/** One bounded physical retirement step. Original reservation stays charged
 * until every actual chunk and header has been removed in this real writer. */
export async function collectSnapshotJournalFieldCacheVersion(
  trx: Knex,
  scope: SnapshotJournalFieldCacheScope,
  expected: Readonly<SnapshotJournalFieldCacheVersion>,
  maximumRows = 33
): Promise<boolean> {
  requireFieldCache(trx, scope)
  cacheInteger(maximumRows, 1, 33)
  sameFieldCacheVersion(expected, await readSnapshotJournalFieldCacheVersion(trx, scope, expected.versionId))
  if (expected.state !== 'RETIRING' || expected.linked !== 0) invalid()
  const n = snapshotJournalFieldCacheNames,
    rows: Array<{ byteOffset: unknown }> = await trx(n.chunks)
      .where('versionId', expected.versionId)
      .select('byteOffset')
      .orderBy('byteOffset')
      .limit(Math.min(32, maximumRows))
  for (const row of rows) {
    if (
      (await trx(n.chunks)
        .where({ versionId: expected.versionId, byteOffset: cacheInteger(row.byteOffset) })
        .delete()) !== 1
    )
      invalid()
  }
  if ((await trx(n.chunks).where('versionId', expected.versionId).select('byteOffset').limit(1)).length !== 0)
    return false
  if (rows.length === maximumRows) return false
  if ((await trx(n.versions).where({ versionId: expected.versionId, linked: 0, state: 'RETIRING' }).delete()) !== 1)
    invalid()
  const key = { userId: scope.userId, lineage: scope.lineage },
    budgets: Array<{ reserved: unknown; versions: unknown }> = await trx(n.budgets)
      .where(key)
      .select('reserved', 'versions')
      .limit(2)
  if (budgets.length !== 1) invalid()
  const reserved = cacheInteger(budgets[0].reserved),
    versions = cacheInteger(budgets[0].versions)
  if (
    reserved < expected.bytes ||
    versions < 1 ||
    (await trx(n.budgets)
      .where({ ...key, reserved, versions })
      .update({ reserved: reserved - expected.bytes, versions: versions - 1 })) !== 1
  )
    invalid()
  return true
}
