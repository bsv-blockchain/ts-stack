import { writeSnapshotJournalPayloadRow, readSnapshotJournalPayloadRow } from './SnapshotJournalNativePayload'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { Knex } from 'knex'
import { snapshotJournalAssociationGeneration } from './SnapshotJournalLineage'
import { createHash } from 'node:crypto'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { snapshotSyncTables } from '../SnapshotSync'
import type { SnapshotJournalDeltaPage } from './SnapshotJournalDeltaPage'
import { encodeSnapshotJournalDeltaFrame, decodeSnapshotJournalDeltaFrame } from './SnapshotJournalDeltaFrame'
import { snapshotJournalIdentityLineage } from './SnapshotJournalIdentityLedger'
import { snapshotJournalRevision, compareSnapshotJournalRevisions } from './SnapshotJournalRevision'
import {
  withSnapshotJournalDestinationWindowFence,
  withSnapshotJournalAcknowledgedWindowFence,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'

const table = 'snapshot_reconciliation_provenance'
const budgets = 'snapshot_reconciliation_provenance_budgets'
export interface SnapshotJournalProvenanceLimits {
  maximumProvenanceRows: number
  maximumProvenanceBytes: number
}
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or stale journal source provenance')
}
function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/.test(value)) value = Number(value)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid()
  return value
}
function sourceId(value: unknown): number {
  if (typeof value === 'string' && /^-?(?:0|[1-9]\d{0,15})$/.test(value)) value = Number(value)
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid()
  return value
}
function sourceIdProjection(k: Knex, mysql: boolean): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(cast(incomingId as char)) BETWEEN 1 AND 17 AND incomingId BETWEEN ? AND ? THEN incomingId ELSE NULL END AS incomingId'
      : "CASE WHEN typeof(incomingId)='integer' AND incomingId BETWEEN ? AND ? THEN incomingId ELSE NULL END AS incomingId",
    [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
  )
}
function bounded(k: Knex, field: string, maximum: number, mysql: boolean): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(cast(?? as char)) BETWEEN 1 AND 16 AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='integer' AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??",
    [field, field, maximum, field, field]
  )
}
export function snapshotJournalProvenanceDdl(k: Knex): string[] {
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  if (!mysql && !['sqlite3', 'better-sqlite3'].includes(String(k.client.config.client)) && !isOwnedNativeSqlite(k))
    invalid()
  const suffix = mysql ? ' ENGINE=InnoDB DEFAULT CHARACTER SET ascii COLLATE ascii_bin ROW_FORMAT=DYNAMIC' : ''
  return [
    'CREATE TABLE ' +
      budgets +
      '(userId BIGINT NOT NULL,lineage VARCHAR(64) NOT NULL,maximumRows INTEGER NOT NULL,maximumBytes BIGINT NOT NULL,`rows` INTEGER NOT NULL,bytes BIGINT NOT NULL,PRIMARY KEY(userId,lineage))' +
      suffix,
    'CREATE TABLE ' +
      table +
      '(userId BIGINT NOT NULL,lineage VARCHAR(64) NOT NULL,incomingId BIGINT NOT NULL,revision VARCHAR(19) NOT NULL,bytes INTEGER NOT NULL,digest VARCHAR(64) NOT NULL,seenSession VARCHAR(64) NOT NULL,sourceGeneration VARCHAR(64) NOT NULL,payload ' +
      (mysql ? 'LONGBLOB' : 'BLOB') +
      ' NOT NULL,PRIMARY KEY(userId,lineage,incomingId))' +
      suffix,
    'CREATE INDEX snapshot_reconciliation_provenance_scan ON ' + table + '(userId,lineage,seenSession,incomingId)'
  ]
}

/** Preserve original operational sync-state cells separately from destination
 * checkpoints. They are never applied to native sync_states or user activation.
 * Raw frame bytes retain null/history/binary/source IDs exactly. */
export async function applySnapshotJournalProvenancePage(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  page: SnapshotJournalDeltaPage,
  limits: SnapshotJournalProvenanceLimits
): Promise<void> {
  if (page.table !== 'syncStates') invalid()
  // Validate the complete source page before allocating/storing individual rows.
  encodeSnapshotJournalDeltaFrame(page, { stream: 'scope', tableId: 7 })
  const maximumRows = number(limits.maximumProvenanceRows, 2147483647)
  const maximumBytes = number(limits.maximumProvenanceBytes)
  if (maximumRows < 1 || maximumBytes < 1) invalid()
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  await withSnapshotJournalDestinationWindowFence(k, binding, expected, async trx => {
    const scope = { userId: binding.destinationUserId, lineage: snapshotJournalIdentityLineage(binding) }
    const counts: Array<Record<string, unknown>> = await trx(budgets)
      .where(scope)
      .select(
        bounded(trx, 'maximumRows', 2147483647, mysql),
        bounded(trx, 'maximumBytes', Number.MAX_SAFE_INTEGER, mysql),
        bounded(trx, 'rows', maximumRows, mysql),
        bounded(trx, 'bytes', maximumBytes, mysql)
      )
      .limit(2)
    if (counts.length > 1) invalid()
    if (!counts.length) {
      if ((await trx(table).where(scope).select('incomingId').limit(1)).length) invalid()
      await trx(budgets).insert({ ...scope, maximumRows, maximumBytes, rows: 0, bytes: 0 })
    } else if (number(counts[0].maximumRows) !== maximumRows || number(counts[0].maximumBytes) !== maximumBytes)
      invalid()
    const initial = {
      rows: counts.length ? number(counts[0].rows) : 0,
      bytes: counts.length ? number(counts[0].bytes) : 0
    }
    let rows = initial.rows,
      bytes = initial.bytes
    for (const change of page.changes) {
      const key = { ...scope, incomingId: change.metadata.id1 }
      const old: Array<Record<string, unknown>> = await trx(table)
        .where(key)
        .select(
          trx.raw('substr(sourceGeneration,1,65) AS sourceGeneration'),
          bounded(trx, 'bytes', 1048576, mysql),
          trx.raw(
            mysql
              ? 'CASE WHEN octet_length(revision) BETWEEN 1 AND 19 THEN revision ELSE NULL END AS revision'
              : "CASE WHEN typeof(revision)='text' AND length(revision) BETWEEN 1 AND 19 THEN revision ELSE NULL END AS revision"
          ),
          trx.raw(
            mysql
              ? 'CASE WHEN octet_length(digest)=64 THEN digest ELSE NULL END AS digest'
              : "CASE WHEN typeof(digest)='text' AND length(digest)=64 THEN digest ELSE NULL END AS digest"
          )
        )
        .limit(2)
      if (
        old.length > 1 ||
        (old.length &&
          (typeof old[0].digest !== 'string' ||
            !/^[0-9a-f]{64}$/.test(old[0].digest) ||
            typeof old[0].sourceGeneration !== 'string' ||
            !/^[0-9a-f]{64}$/.test(old[0].sourceGeneration)))
      )
        invalid()
      const sourceGeneration = snapshotJournalAssociationGeneration(binding)
      const currentGeneration = old.length > 0 && old[0].sourceGeneration === sourceGeneration
      if (old.length) snapshotJournalRevision(old[0].revision)
      if (
        currentGeneration &&
        compareSnapshotJournalRevisions(snapshotJournalRevision(old[0].revision), change.metadata.revision) > 0
      )
        invalid()
      const previousBytes = old.length ? number(old[0].bytes, 1048576) : 0
      if (!change.present) {
        if (old.length) {
          if (
            (await trx(table)
              .where({
                ...key,
                sourceGeneration: old[0].sourceGeneration,
                revision: old[0].revision,
                bytes: previousBytes,
                digest: old[0].digest
              })
              .delete()) !== 1
          )
            invalid()
          rows--
          bytes -= previousBytes
        }
        continue
      }
      if (Number(change.row.userId) !== binding.source.userId) invalid()
      const { revision, id1, id2, exactText } = change.metadata
      const payload = encodeSnapshotJournalDeltaFrame(
        {
          table: 'syncStates',
          changes: [change],
          examined: 1,
          payloadBytes: 0,
          complete: false,
          after: { revision, id1, id2, exactText }
        },
        { stream: 'scope', tableId: 7 }
      )
      const digest = createHash('sha256').update(payload).digest('hex')
      const replacement = {
        revision,
        sourceGeneration,
        bytes: payload.byteLength,
        digest,
        seenSession: expected.sessionId
      }
      if (currentGeneration && old[0].revision === revision && old[0].digest !== digest) invalid()
      if (!old.length) rows++
      bytes += payload.byteLength - previousBytes
      if (rows > maximumRows || bytes > maximumBytes)
        throw new SnapshotResourceLimitError('Source provenance exceeds negotiated durable capacity')
      try {
        await writeSnapshotJournalPayloadRow(
          trx,
          table,
          key,
          replacement,
          payload,
          old.length
            ? {
                sourceGeneration: old[0].sourceGeneration,
                revision: old[0].revision,
                bytes: previousBytes,
                digest: old[0].digest
              }
            : undefined
        )
      } finally {
        payload.fill(0)
      }
    }
    if (
      rows < 0 ||
      bytes < 0 ||
      (await trx(budgets)
        .where({ ...scope, maximumRows, maximumBytes, ...initial })
        .update({ rows, bytes })) !== 1
    )
      invalid()
  })
}

/** Remove missing operational records only after a complete current-state scan.
 * Payloads are not loaded for this bounded cleanup; native sync/primary values
 * remain untouched. Counters and removals share the destination writer. */
export async function cleanupUnseenSnapshotJournalProvenance(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint
): Promise<boolean> {
  if (
    binding.bootstrap !== true ||
    expected.phase !== 'promoting' ||
    expected.tableIndex !== snapshotSyncTables.length - 1
  )
    invalid()
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  return await withSnapshotJournalDestinationWindowFence(k, binding, expected, async trx => {
    const scope = { userId: binding.destinationUserId, lineage: snapshotJournalIdentityLineage(binding) }
    const query = trx
      .from(
        trx.raw(
          mysql
            ? table + ' FORCE INDEX (snapshot_reconciliation_provenance_scan)'
            : table + ' INDEXED BY snapshot_reconciliation_provenance_scan'
        )
      )
      .where(scope)
      .whereNot('seenSession', expected.sessionId)
      .select(
        sourceIdProjection(trx, mysql),
        bounded(trx, 'bytes', 1048576, mysql),
        trx.raw('substr(seenSession,1,65) AS seenSession')
      )
      .orderBy(['seenSession', 'incomingId'])
      .limit(32)
    if (mysql) query.forUpdate().noWait()
    const rows: Array<Record<string, unknown>> = await query
    if (rows.length) {
      const countRows: Array<Record<string, unknown>> = await trx(budgets)
        .where(scope)
        .select(bounded(trx, 'rows', 2147483647, mysql), bounded(trx, 'bytes', Number.MAX_SAFE_INTEGER, mysql))
        .limit(2)
      if (countRows.length !== 1) invalid()
      const previous = { rows: number(countRows[0].rows), bytes: number(countRows[0].bytes) }
      let removedBytes = 0
      for (const row of rows) {
        const incomingId = sourceId(row.incomingId),
          bytes = number(row.bytes, 1048576)
        if (
          typeof row.seenSession !== 'string' ||
          !/^[0-9a-f]{64}$/.test(row.seenSession) ||
          row.seenSession === expected.sessionId ||
          (await trx(table)
            .where({ ...scope, incomingId, bytes, seenSession: row.seenSession })
            .delete()) !== 1
        )
          invalid()
        removedBytes += bytes
      }
      if (
        previous.rows < rows.length ||
        previous.bytes < removedBytes ||
        (await trx(budgets)
          .where({ ...scope, ...previous })
          .update({ rows: previous.rows - rows.length, bytes: previous.bytes - removedBytes })) !== 1
      )
        invalid()
    }
    return !(await trx(table).where(scope).whereNot('seenSession', expected.sessionId).select('incomingId').limit(1))
      .length
  })
}

export interface SnapshotJournalProvenancePage {
  rows: ReadonlyArray<{ incomingId: number; revision: string; raw: Readonly<Record<string, unknown>> }>
  after?: number
  complete: boolean
  payloadBytes: number
}

/** Read original source rows after durable acknowledgement, in bounded keyset
 * pages. Authenticated provider/profile/backend checks belong to the actual
 * owning writer; the ACK fence rechecks that profile and exact durable window.
 * Every payload is size-checked before SQL selection, then hash/codec checked.
 * No native sync cursor or primary is substituted for these original cells. */
export async function readSnapshotJournalProvenancePage(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  after?: number,
  maximumRows = 32,
  maximumBytes = 1048576
): Promise<SnapshotJournalProvenancePage> {
  if (after !== undefined) sourceId(after)
  if (
    !Number.isSafeInteger(maximumRows) ||
    maximumRows < 1 ||
    maximumRows > 64 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 1048576
  )
    invalid()
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  return await withSnapshotJournalAcknowledgedWindowFence(k, binding, expected, async trx => {
    const scope = { userId: binding.destinationUserId, lineage: snapshotJournalIdentityLineage(binding) }
    const query = trx(table)
      .where(scope)
      .select(
        sourceIdProjection(trx, mysql),
        bounded(trx, 'bytes', 1048576, mysql),
        trx.raw('substr(digest,1,65) AS digest'),
        trx.raw('substr(revision,1,20) AS revision'),
        trx.raw('substr(sourceGeneration,1,65) AS sourceGeneration')
      )
      .orderBy('incomingId')
      .limit(maximumRows)
    if (after !== undefined) query.where('incomingId', '>', after)
    const metadata: Array<Record<string, unknown>> = await query
    let payloadBytes = 0,
      previousId = after
    const rows: Array<{ incomingId: number; revision: string; raw: Readonly<Record<string, unknown>> }> = []
    for (const record of metadata) {
      const incomingId = sourceId(record.incomingId),
        bytes = number(record.bytes, 1048576),
        revision = snapshotJournalRevision(record.revision)
      if (
        (previousId !== undefined && incomingId <= previousId) ||
        bytes < 1 ||
        typeof record.digest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(record.digest) ||
        record.sourceGeneration !== snapshotJournalAssociationGeneration(binding) ||
        compareSnapshotJournalRevisions(revision, binding.receipt.highWater) > 0
      )
        invalid()
      if (bytes > maximumBytes - payloadBytes) {
        if (!rows.length) throw new SnapshotResourceLimitError('Source provenance row exceeds its page byte allowance')
        break
      }
      const payload = await readSnapshotJournalPayloadRow(
        trx,
        table,
        { ...scope, incomingId, bytes, digest: record.digest, revision, sourceGeneration: record.sourceGeneration },
        bytes
      )
      if (createHash('sha256').update(payload).digest('hex') !== record.digest) {
        payload.fill(0)
        invalid()
      }
      let page: SnapshotJournalDeltaPage
      try {
        page = decodeSnapshotJournalDeltaFrame(payload, { stream: 'scope', tableId: 7 })
      } finally {
        payload.fill(0)
      }
      if (
        page.table !== 'syncStates' ||
        page.changes.length !== 1 ||
        !page.changes[0].present ||
        page.changes[0].metadata.id1 !== incomingId ||
        page.changes[0].metadata.revision !== revision ||
        Number(page.changes[0].row.userId) !== binding.source.userId
      )
        invalid()
      rows.push({ incomingId, revision, raw: Object.freeze({ ...page.changes[0].row }) })
      payloadBytes += bytes
      previousId = incomingId
    }
    const remaining = trx(table).where(scope)
    if (previousId !== undefined) remaining.where('incomingId', '>', previousId)
    const more = await remaining.select('incomingId').limit(1)
    return { rows, ...(rows.length ? { after: previousId } : {}), complete: more.length === 0, payloadBytes }
  })
}
