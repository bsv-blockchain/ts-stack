import type { SnapshotJournalHashedFieldPage } from './SnapshotJournalFieldTypes'
import { encodeSnapshotJournalFieldFrame, decodeSnapshotJournalFieldFrame } from './SnapshotJournalDeltaFrame'
import {
  writeSnapshotJournalPayloadRow,
  readSnapshotJournalPayloadRow,
  snapshotJournalPayloadLength
} from './SnapshotJournalNativePayload'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { snapshotSyncTables } from '../SnapshotSync'
import type { SnapshotJournalDeltaPage } from './SnapshotJournalDeltaPage'
import {
  encodeSnapshotJournalDeltaFrame,
  decodeSnapshotJournalDeltaFrame,
  SNAPSHOT_JOURNAL_DELTA_FRAME_BYTES,
  type SnapshotJournalDeltaFrameContext
} from './SnapshotJournalDeltaFrame'
import {
  advanceSnapshotJournalDestinationWindow,
  readSnapshotJournalDestinationWindow,
  snapshotJournalDestinationStreams,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'
import { snapshotJournalRevision, compareSnapshotJournalRevisions } from './SnapshotJournalRevision'
import type { SnapshotJournalPosition } from './SnapshotJournalPage'

export interface SnapshotJournalDestinationStageLimits {
  maximumBytes: number
  maximumPages: number
  /** Integrated shared-quota policy; version1 keeps its original limits. */
  version?: 2
}

export interface SnapshotJournalDestinationStageReceipt {
  sequence: number
  streamIndex: number
  tableId: number
  examined: number
  bytes: number
  digest: string
}

const budgets = 'snapshot_reconciliation_stage_budgets'
const pages = 'snapshot_reconciliation_stage_pages'
const chains = 'snapshot_reconciliation_stage_chains'

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or exhausted journal destination staging')
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}

function sqlInteger(value: unknown, maximum: number): number {
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/.test(value)) return integer(Number(value), 0, maximum)
  return integer(value, 0, maximum)
}

function boundedStoredInteger(k: Knex, field: string, maximum: number, mysql: boolean): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(cast(?? as char)) BETWEEN 1 AND 16 AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??) = 'integer' AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??",
    [field, field, maximum, field, field]
  )
}

function boundedStoredHash(k: Knex, field: 'binding' | 'digest', mysql: boolean): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(??) = 64 THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??) = 'text' AND length(cast(?? as blob)) = 64 THEN ?? ELSE NULL END AS ??",
    mysql ? [field, field, field] : [field, field, field, field]
  )
}

function transaction(k: Knex): boolean {
  if (!k.isTransaction) invalid()
  const client = k.client.config.client
  if (client === 'better-sqlite3' || client === 'sqlite3' || isOwnedNativeSqlite(k)) return false
  if (client === 'mysql' || client === 'mysql2') return true
  return invalid()
}

/** Auxiliary DDL only; deployment/migration and actual backend/schema custody
 * remain caller-owned. Per-window limits do not replace shared staging quotas. */
export function snapshotJournalDestinationStageDdl(k: Knex): string[] {
  const client = k.client.config.client
  if (!['better-sqlite3', 'sqlite3', 'mysql', 'mysql2'].includes(String(client)) && !isOwnedNativeSqlite(k)) invalid()
  const mysql = client === 'mysql' || client === 'mysql2'
  const suffix = mysql ? ' ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin ROW_FORMAT=DYNAMIC' : ''
  return [
    'CREATE TABLE ' +
      budgets +
      '(userId BIGINT NOT NULL,sourceStorageIdentity VARCHAR(256) NOT NULL,sessionId VARCHAR(64) NOT NULL,binding VARCHAR(64) NOT NULL,maximumBytes BIGINT NOT NULL,maximumPages INTEGER NOT NULL,bytes BIGINT NOT NULL,pages INTEGER NOT NULL,PRIMARY KEY(userId,sourceStorageIdentity,sessionId))' +
      suffix,
    'CREATE TABLE ' +
      pages +
      '(userId BIGINT NOT NULL,sourceStorageIdentity VARCHAR(256) NOT NULL,sessionId VARCHAR(64) NOT NULL,binding VARCHAR(64) NOT NULL,sequence BIGINT NOT NULL,ordinal INTEGER NOT NULL,nextSequence BIGINT NOT NULL,streamIndex INTEGER NOT NULL,tableId INTEGER NOT NULL,examined INTEGER NOT NULL,bytes BIGINT NOT NULL,digest VARCHAR(64) NOT NULL,payload ' +
      (mysql ? 'LONGBLOB' : 'BLOB') +
      ' NOT NULL,PRIMARY KEY(userId,sourceStorageIdentity,sessionId,sequence))' +
      suffix,
    'CREATE TABLE ' +
      chains +
      '(userId BIGINT NOT NULL,sourceStorageIdentity VARCHAR(256) NOT NULL,sessionId VARCHAR(64) NOT NULL,tableId INTEGER NOT NULL,binding VARCHAR(64) NOT NULL,headSequence BIGINT NOT NULL,tailSequence BIGINT NOT NULL,pages INTEGER NOT NULL,bytes BIGINT NOT NULL,PRIMARY KEY(userId,sourceStorageIdentity,sessionId,tableId))' +
      suffix,
    'CREATE INDEX snapshot_reconciliation_stage_promotion ON ' +
      pages +
      '(userId,sourceStorageIdentity,sessionId,tableId,sequence)'
  ]
}

function owned(
  input: SnapshotJournalDestinationBinding,
  checkpoint: SnapshotJournalDestinationCheckpoint
): {
  binding: SnapshotJournalDestinationBinding
  state: SnapshotJournalDestinationCheckpoint
} {
  return {
    binding: { ...input, source: { ...input.source }, receipt: { ...input.receipt } },
    state: {
      ...checkpoint,
      ...(checkpoint.after === undefined ? {} : { after: { ...checkpoint.after } })
    }
  }
}

function scope(binding: SnapshotJournalDestinationBinding, state: SnapshotJournalDestinationCheckpoint) {
  return {
    userId: binding.destinationUserId,
    sourceStorageIdentity: binding.source.storageIdentity,
    sessionId: state.sessionId
  }
}

function pageInterval(
  page: Pick<SnapshotJournalHashedFieldPage, 'changes' | 'after'> | SnapshotJournalDeltaPage,
  binding: SnapshotJournalDestinationBinding
): void {
  for (const value of [
    ...page.changes.map(change => change.metadata.revision),
    ...(page.after === undefined ? [] : [page.after.revision])
  ]) {
    const revision = snapshotJournalRevision(value)
    if (
      compareSnapshotJournalRevisions(revision, binding.low) <= 0 ||
      compareSnapshotJournalRevisions(revision, binding.receipt.highWater) > 0
    )
      invalid()
  }
}

function comparePosition(left: SnapshotJournalPosition, right: SnapshotJournalPosition): number {
  return (
    compareSnapshotJournalRevisions(left.revision, right.revision) ||
    left.id1 - right.id1 ||
    left.id2 - right.id2 ||
    Buffer.compare(Buffer.from(left.exactText, 'utf8'), Buffer.from(right.exactText, 'utf8'))
  )
}

/** Own and bound the entire frame before await; stage bytes, charge and progress
 * share the caller's fenced writer transaction. A returned checkpoint is only
 * acknowledged after successful OUTER commit. No entity or ID-map writes occur. */
export async function stageSnapshotJournalDestinationPage(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  inputPage: SnapshotJournalDeltaPage,
  inputLimits: SnapshotJournalDestinationStageLimits
): Promise<{
  checkpoint: SnapshotJournalDestinationCheckpoint
  result: SnapshotJournalDestinationStageReceipt
}> {
  if (input.fieldEncoding !== undefined) invalid()
  return await stageDestinationPage(k, input, expected, { kind: 'rows', page: inputPage }, inputLimits)
}

export async function stageSnapshotJournalDestinationFieldPage(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  inputPage: SnapshotJournalHashedFieldPage,
  inputLimits: SnapshotJournalDestinationStageLimits
): Promise<{
  checkpoint: SnapshotJournalDestinationCheckpoint
  result: SnapshotJournalDestinationStageReceipt
}> {
  if (input.fieldEncoding !== 'wallet-journal-fields/1') invalid()
  return await stageDestinationPage(k, input, expected, { kind: 'fields', page: inputPage }, inputLimits)
}

async function stageDestinationPage(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  selectedPage:
    { kind: 'rows'; page: SnapshotJournalDeltaPage } | { kind: 'fields'; page: SnapshotJournalHashedFieldPage },
  inputLimits: SnapshotJournalDestinationStageLimits
): Promise<{
  checkpoint: SnapshotJournalDestinationCheckpoint
  result: SnapshotJournalDestinationStageReceipt
}> {
  const mysql = transaction(k)
  const { binding, state } = owned(input, expected)
  if (state.phase !== 'intake') invalid()
  const bound = snapshotJournalDestinationStreams[integer(state.streamIndex, 0, 14)]
  if (inputLimits.version !== undefined && inputLimits.version !== 2) invalid()
  const limits = {
    maximumBytes: integer(inputLimits.maximumBytes, 1, inputLimits.version === 2 ? Number.MAX_SAFE_INTEGER : 67108864),
    maximumPages: integer(inputLimits.maximumPages, 1, inputLimits.version === 2 ? 2147483647 : 4096)
  }
  const frame =
    selectedPage.kind === 'fields'
      ? encodeSnapshotJournalFieldFrame(selectedPage.page, bound)
      : encodeSnapshotJournalDeltaFrame(selectedPage.page, bound)
  const page =
    selectedPage.kind === 'fields'
      ? decodeSnapshotJournalFieldFrame(frame, bound)
      : decodeSnapshotJournalDeltaFrame(frame, bound)
  pageInterval(page, binding)
  const cursor = state.after
  if (cursor !== undefined && page.changes.some(change => comparePosition(change.metadata, cursor) <= 0)) invalid()
  if (frame.byteLength > limits.maximumBytes) invalid()
  const receipt: SnapshotJournalDestinationStageReceipt = {
    sequence: integer(state.sequence, 0, Number.MAX_SAFE_INTEGER - 1) + 1,
    streamIndex: state.streamIndex,
    tableId: bound.tableId,
    examined: page.examined,
    bytes: frame.byteLength,
    digest: createHash('sha256').update(frame).digest('hex')
  }
  const selected = scope(binding, state)
  return await advanceSnapshotJournalDestinationWindow(
    k,
    binding,
    state,
    {
      phase: 'intake',
      examined: page.examined,
      complete: page.complete,
      ...(page.after === undefined ? {} : { after: page.after })
    },
    async trx => {
      const rows: Array<Record<string, unknown>> = await trx(budgets)
        .select(
          boundedStoredHash(trx, 'binding', mysql),
          boundedStoredInteger(trx, 'maximumBytes', Number.MAX_SAFE_INTEGER, mysql),
          boundedStoredInteger(trx, 'maximumPages', 2147483647, mysql),
          boundedStoredInteger(trx, 'bytes', limits.maximumBytes, mysql),
          boundedStoredInteger(trx, 'pages', limits.maximumPages, mysql)
        )
        .where(selected)
        .limit(2)
      if (rows.length > 1) invalid()
      if (rows.length === 0) {
        if (state.sequence !== 0 || state.streamIndex !== 0 || state.after !== undefined) invalid()
        await trx(budgets).insert({
          ...selected,
          binding: state.binding,
          ...limits,
          bytes: 0,
          pages: 0
        })
      }
      const prior = rows[0] ?? { binding: state.binding, ...limits, bytes: 0, pages: 0 }
      const bytes = sqlInteger(prior.bytes, limits.maximumBytes),
        count = sqlInteger(prior.pages, limits.maximumPages)
      if (
        prior.binding !== state.binding ||
        sqlInteger(prior.maximumBytes, Number.MAX_SAFE_INTEGER) !== limits.maximumBytes ||
        sqlInteger(prior.maximumPages, 2147483647) !== limits.maximumPages ||
        count !== state.sequence ||
        count >= limits.maximumPages ||
        bytes + frame.byteLength > limits.maximumBytes
      )
        invalid()
      const chainRows: Array<Record<string, unknown>> = await trx(chains)
        .select(
          boundedStoredHash(trx, 'binding', mysql),
          boundedStoredInteger(trx, 'headSequence', count, mysql),
          boundedStoredInteger(trx, 'tailSequence', count, mysql),
          boundedStoredInteger(trx, 'pages', count, mysql),
          boundedStoredInteger(trx, 'bytes', bytes, mysql)
        )
        .where({ ...selected, tableId: receipt.tableId })
        .limit(2)
      if (chainRows.length > 1) invalid()
      let chain: { headSequence: number; tailSequence: number; pages: number; bytes: number }
      if (chainRows.length === 0) {
        const firstStream = snapshotJournalDestinationStreams.findIndex(stream => stream.tableId === receipt.tableId)
        if (state.streamIndex !== firstStream || state.after !== undefined) invalid()
        const previousPages = await trx(pages)
          .select(boundedStoredInteger(trx, 'sequence', count, mysql))
          .where({ ...selected, tableId: receipt.tableId })
          .limit(1)
        if (previousPages.length !== 0) invalid()
        chain = { headSequence: receipt.sequence, tailSequence: 0, pages: 0, bytes: 0 }
      } else {
        const stored = chainRows[0]
        chain = {
          headSequence: sqlInteger(stored.headSequence, count),
          tailSequence: sqlInteger(stored.tailSequence, count),
          pages: sqlInteger(stored.pages, count),
          bytes: sqlInteger(stored.bytes, bytes)
        }
        if (
          stored.binding !== state.binding ||
          chain.headSequence < 1 ||
          chain.tailSequence < chain.headSequence ||
          chain.pages < 1 ||
          chain.bytes < 4 ||
          chain.tailSequence >= receipt.sequence
        )
          invalid()
        if (
          (await trx(pages)
            .where({
              ...selected,
              binding: state.binding,
              tableId: receipt.tableId,
              sequence: chain.tailSequence,
              ordinal: chain.pages,
              nextSequence: 0
            })
            .update({ nextSequence: receipt.sequence })) !== 1
        )
          invalid()
      }
      await writeSnapshotJournalPayloadRow(
        trx,
        pages,
        { ...selected, sequence: receipt.sequence },
        {
          binding: state.binding,
          ...receipt,
          ordinal: chain.pages + 1,
          nextSequence: 0
        },
        frame
      )
      if (
        (await trx(budgets)
          .where({
            ...selected,
            binding: state.binding,
            bytes,
            pages: count,
            maximumBytes: limits.maximumBytes,
            maximumPages: limits.maximumPages
          })
          .update({ bytes: bytes + frame.byteLength, pages: count + 1 })) !== 1
      )
        invalid()
      const nextChain = {
        headSequence: chain.headSequence,
        tailSequence: receipt.sequence,
        pages: chain.pages + 1,
        bytes: chain.bytes + frame.byteLength
      }
      if (chainRows.length === 0) {
        await trx(chains).insert({
          ...selected,
          tableId: receipt.tableId,
          binding: state.binding,
          ...nextChain
        })
      } else if (
        (await trx(chains)
          .where({ ...selected, tableId: receipt.tableId, binding: state.binding, ...chain })
          .update(nextChain)) !== 1
      )
        invalid()
      return receipt
    }
  )
}

/** Read one bounded staged frame in dependency promotion order from actual
 * destination custody. This observation, even after expiry, grants no authority
 * to apply rows; a separately validated advance must recheck the writer fence. */
export async function readSnapshotJournalDestinationPromotionPage(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint
): Promise<{ receipt: SnapshotJournalDestinationStageReceipt; page: SnapshotJournalDeltaPage } | undefined> {
  if (input.fieldEncoding !== undefined) invalid()
  return await readPromotionPage(k, input, expected, decodeSnapshotJournalDeltaFrame)
}

export async function readSnapshotJournalDestinationFieldPromotionPage(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint
): Promise<{ receipt: SnapshotJournalDestinationStageReceipt; page: SnapshotJournalHashedFieldPage } | undefined> {
  if (input.fieldEncoding !== 'wallet-journal-fields/1') invalid()
  return await readPromotionPage(k, input, expected, decodeSnapshotJournalFieldFrame)
}

async function readPromotionPage<T extends SnapshotJournalDeltaPage | SnapshotJournalHashedFieldPage>(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  decode: (payload: Uint8Array, context: SnapshotJournalDeltaFrameContext) => T
): Promise<{ receipt: SnapshotJournalDestinationStageReceipt; page: T } | undefined> {
  const mysql = transaction(k)
  const { binding, state } = owned(input, expected)
  if (state.phase !== 'promoting') invalid()
  const actual = await readSnapshotJournalDestinationWindow(k, binding)
  if (JSON.stringify(actual) !== JSON.stringify(state)) invalid()
  const table = snapshotSyncTables[integer(state.tableIndex, 0, snapshotSyncTables.length - 1)]
  // Scope syncStates is provenance and is intentionally absent from promotion.
  const tableId = [
    'transactions',
    'outputs',
    'certificates',
    'txLabels',
    'outputBaskets',
    'outputTags',
    'commissions',
    'syncStates',
    'provenTxs',
    'provenTxReqs',
    'txLabelMaps',
    'outputTagMaps',
    'certificateFields'
  ].indexOf(table)
  if (tableId < 0 || tableId === 7) invalid()
  const selected = { ...scope(binding, state), binding: state.binding, tableId }
  const quotaRows: Array<Record<string, unknown>> = await k(budgets)
    .select(
      boundedStoredHash(k, 'binding', mysql),
      boundedStoredInteger(k, 'maximumPages', 2147483647, mysql),
      boundedStoredInteger(k, 'maximumBytes', Number.MAX_SAFE_INTEGER, mysql),
      boundedStoredInteger(k, 'pages', 2147483647, mysql),
      boundedStoredInteger(k, 'bytes', Number.MAX_SAFE_INTEGER, mysql)
    )
    .where(scope(binding, state))
    .limit(2)
  if (quotaRows.length !== 1 || quotaRows[0].binding !== state.binding) invalid()
  const intakePages = sqlInteger(quotaRows[0].pages, 2147483647)
  const intakeBytes = sqlInteger(quotaRows[0].bytes, Number.MAX_SAFE_INTEGER)
  const maximumPages = sqlInteger(quotaRows[0].maximumPages, 2147483647)
  const maximumBytes = sqlInteger(quotaRows[0].maximumBytes, Number.MAX_SAFE_INTEGER)
  if (intakePages > maximumPages || intakeBytes > maximumBytes || maximumPages < 1 || maximumBytes < 1) invalid()
  if (intakePages < 15 || intakePages > state.sequence || intakeBytes < 4 * intakePages) invalid()
  const chainRows: Array<Record<string, unknown>> = await k(chains)
    .select(
      boundedStoredHash(k, 'binding', mysql),
      boundedStoredInteger(k, 'headSequence', intakePages, mysql),
      boundedStoredInteger(k, 'tailSequence', intakePages, mysql),
      boundedStoredInteger(k, 'pages', intakePages, mysql),
      boundedStoredInteger(k, 'bytes', intakeBytes, mysql)
    )
    .where({ ...scope(binding, state), tableId })
    .limit(2)
  if (chainRows.length !== 1 || chainRows[0].binding !== state.binding) invalid()
  const chain = {
    headSequence: sqlInteger(chainRows[0].headSequence, intakePages),
    tailSequence: sqlInteger(chainRows[0].tailSequence, intakePages),
    pages: sqlInteger(chainRows[0].pages, intakePages),
    bytes: sqlInteger(chainRows[0].bytes, intakeBytes)
  }
  if (
    chain.headSequence < 1 ||
    chain.tailSequence < chain.headSequence ||
    chain.pages < 1 ||
    chain.bytes < 4 * chain.pages
  )
    invalid()
  const streamTables = snapshotJournalDestinationStreams.map(stream => stream.tableId)
  const firstStream = streamTables.indexOf(tableId)
  const lastStream = streamTables.lastIndexOf(tableId)
  if (firstStream < 0 || chain.pages < (firstStream === lastStream ? 1 : 2)) invalid()
  let expectedSequence = chain.headSequence
  let expectedOrdinal = 1
  if (state.promotionSequence !== 0) {
    const priorRows: Array<Record<string, unknown>> = await k(pages)
      .select(
        boundedStoredInteger(k, 'ordinal', chain.pages, mysql),
        boundedStoredInteger(k, 'nextSequence', intakePages, mysql)
      )
      .where({ ...selected, sequence: state.promotionSequence })
      .limit(2)
    if (priorRows.length !== 1) invalid()
    const priorOrdinal = sqlInteger(priorRows[0].ordinal, chain.pages)
    expectedSequence = sqlInteger(priorRows[0].nextSequence, intakePages)
    expectedOrdinal = priorOrdinal + 1
    if (priorOrdinal < 1) invalid()
    if (expectedSequence === 0) {
      if (state.promotionSequence !== chain.tailSequence || priorOrdinal !== chain.pages) invalid()
      return undefined
    }
    if (expectedSequence <= state.promotionSequence || expectedOrdinal > chain.pages) invalid()
  }
  const rows: Array<Record<string, unknown>> = await k(pages)
    .select(
      boundedStoredInteger(k, 'sequence', intakePages, mysql),
      boundedStoredInteger(k, 'ordinal', chain.pages, mysql),
      boundedStoredInteger(k, 'nextSequence', intakePages, mysql),
      boundedStoredInteger(k, 'streamIndex', 14, mysql),
      boundedStoredInteger(k, 'tableId', 12, mysql),
      boundedStoredInteger(k, 'examined', 256, mysql),
      boundedStoredInteger(k, 'bytes', SNAPSHOT_JOURNAL_DELTA_FRAME_BYTES, mysql),
      boundedStoredHash(k, 'digest', mysql),
      (await snapshotJournalPayloadLength(k, pages)).expression
    )
    .where(selected)
    .where('sequence', '>', state.promotionSequence)
    .orderBy('sequence')
    .limit(1)
  if (rows.length !== 1) invalid()
  const row = rows[0]
  const digest = row.digest
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) invalid()
  const receipt: SnapshotJournalDestinationStageReceipt = {
    sequence: sqlInteger(row.sequence, intakePages),
    streamIndex: sqlInteger(row.streamIndex, 14),
    tableId: sqlInteger(row.tableId, 12),
    examined: sqlInteger(row.examined, 256),
    bytes: sqlInteger(row.bytes, SNAPSHOT_JOURNAL_DELTA_FRAME_BYTES),
    digest
  }
  const bound: SnapshotJournalDeltaFrameContext = snapshotJournalDestinationStreams[receipt.streamIndex]
  if (
    receipt.sequence !== expectedSequence ||
    sqlInteger(row.ordinal, chain.pages) !== expectedOrdinal ||
    (expectedOrdinal === 1 && receipt.streamIndex !== firstStream) ||
    (expectedOrdinal === chain.pages && receipt.streamIndex !== lastStream) ||
    (expectedOrdinal === chain.pages
      ? receipt.sequence !== chain.tailSequence || sqlInteger(row.nextSequence, intakePages) !== 0
      : receipt.sequence >= chain.tailSequence ||
        sqlInteger(row.nextSequence, intakePages) <= receipt.sequence ||
        sqlInteger(row.nextSequence, intakePages) > chain.tailSequence) ||
    receipt.sequence <= state.promotionSequence ||
    receipt.bytes < 4 ||
    receipt.tableId !== tableId ||
    bound.tableId !== tableId ||
    sqlInteger(row.actualBytes, SNAPSHOT_JOURNAL_DELTA_FRAME_BYTES) !== receipt.bytes
  )
    invalid()
  const payload = await readSnapshotJournalPayloadRow(
    k,
    pages,
    { ...selected, sequence: receipt.sequence },
    receipt.bytes
  )
  if (createHash('sha256').update(payload).digest('hex') !== receipt.digest) {
    payload.fill(0)
    invalid()
  }
  let page: T
  try {
    page = decode(payload, bound)
  } finally {
    payload.fill(0)
  }
  pageInterval(page, binding)
  if (page.examined !== receipt.examined || page.table !== table || (expectedOrdinal === chain.pages && !page.complete))
    invalid()
  return { receipt, page }
}
