import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import {
  withSnapshotJournalDestinationWindowFence,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'
import {
  compareSnapshotJournalRevisions,
  snapshotJournalRevision,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'
import type { SnapshotJournalIdentityReference, SnapshotJournalIdentityTable } from './SnapshotJournalIdentityLedger'
import type { SnapshotJournalSourceIdentity, SnapshotJournalSourceNaturalKey } from './SnapshotJournalSourceIdentities'

export interface SnapshotJournalCapturedIdentity extends SnapshotJournalIdentityReference {
  naturalKey: Readonly<SnapshotJournalSourceNaturalKey>
}

export interface SnapshotJournalCapturedIdentityLimits {
  maximumIdentities: number
}

const table = 'snapshot_reconciliation_captured_identities'
const budgets = 'snapshot_reconciliation_captured_identity_budgets'
const frames = 'snapshot_reconciliation_identity_frames'
const hash = /^[0-9a-f]{64}$/
const entityTables = [0, 1, 2, 3, 4, 5, 6, 8, 9]
const maximumCount = 2147483647
const naturalKeyBytes = 8192

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or stale captured journal identity data')
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/.test(value)) value = Number(value)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !hash.test(value)) invalid()
  return value
}

function naturalKey(value: unknown, tableId: SnapshotJournalIdentityTable): Readonly<SnapshotJournalSourceNaturalKey> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const descriptor = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(value).length > 3 ||
    Object.values(descriptor).some(d => !d.enumerable || !Object.hasOwn(d, 'value'))
  )
    invalid()
  const row = Object.fromEntries(Object.entries(descriptor).map(([key, d]) => [key, d.value]))
  if (row.tableId !== tableId) invalid()
  const fields: Readonly<Record<number, readonly string[]>> = {
    0: ['reference', 'txid'],
    1: ['transactionId', 'vout'],
    2: ['serialNumber', 'certifier'],
    3: ['label'],
    4: ['name'],
    5: ['tag'],
    6: ['transactionId'],
    8: ['txid'],
    9: ['txid']
  }
  const required = fields[tableId]
  if (Object.keys(row).some(key => key !== 'tableId' && !required.includes(key))) invalid()
  for (const name of required) {
    const part = row[name]
    if (tableId === 0 && name === 'txid' && part === undefined) continue
    if (name === 'transactionId' || name === 'vout') {
      if (typeof part !== 'number' || !Number.isSafeInteger(part) || part < (name === 'vout' ? 0 : 1)) invalid()
    } else if (typeof part !== 'string' || Buffer.byteLength(part, 'utf8') > 1200) invalid()
  }
  if (Buffer.byteLength(JSON.stringify(row), 'utf8') > naturalKeyBytes) invalid()
  return Object.freeze(row) as unknown as Readonly<SnapshotJournalSourceNaturalKey>
}

function transaction(k: Knex): boolean {
  if (!k.isTransaction) invalid()
  const client = k.client.config.client
  if (client === 'sqlite3' || client === 'better-sqlite3' || isOwnedNativeSqlite(k)) return false
  if (client === 'mysql' || client === 'mysql2') return true
  return invalid()
}

function scope(binding: SnapshotJournalDestinationBinding, state: SnapshotJournalDestinationCheckpoint) {
  return {
    userId: binding.destinationUserId,
    sourceStorageIdentity: binding.source.storageIdentity,
    sessionId: state.sessionId,
    binding: state.binding
  }
}

function boundedNumber(k: Knex, field: string, maximum: number, remote: boolean): Knex.Raw {
  return k.raw(
    remote
      ? 'CASE WHEN octet_length(cast(?? as char)) BETWEEN 1 AND 16 AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='integer' AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??",
    [field, field, maximum, field, field]
  )
}

function boundedText(k: Knex, field: string, maximum: number, remote: boolean): Knex.Raw {
  return k.raw(
    remote
      ? 'CASE WHEN octet_length(??) BETWEEN 1 AND ? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='text' AND length(cast(?? as blob)) BETWEEN 1 AND ? THEN ?? ELSE NULL END AS ??",
    remote ? [field, maximum, field, field] : [field, field, maximum, field, field]
  )
}

function owned(
  value: Pick<SnapshotJournalSourceIdentity, 'tableId' | 'incomingId' | 'generation' | 'naturalIdentity' | 'required'>,
  highWater: SnapshotJournalRevision
): SnapshotJournalIdentityReference {
  if (!entityTables.includes(value.tableId) || typeof value.required !== 'boolean') invalid()
  const generation = snapshotJournalRevision(value.generation)
  if (generation === '0' || compareSnapshotJournalRevisions(generation, highWater) > 0) invalid()
  return {
    tableId: value.tableId,
    incomingId: integer(value.incomingId, 1),
    generation,
    naturalIdentity: digest(value.naturalIdentity),
    required: value.required
  }
}

export function snapshotJournalCapturedIdentitiesDdl(k: Knex): string[] {
  const client = k.client.config.client
  if (!['sqlite3', 'better-sqlite3', 'mysql', 'mysql2'].includes(String(client)) && !isOwnedNativeSqlite(k)) invalid()
  const suffix =
    client === 'mysql' || client === 'mysql2'
      ? ' ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin ROW_FORMAT=DYNAMIC'
      : ''
  return [
    'CREATE TABLE ' +
      budgets +
      '(userId BIGINT NOT NULL,sourceStorageIdentity VARCHAR(256) NOT NULL,sessionId VARCHAR(64) NOT NULL,binding VARCHAR(64) NOT NULL,maximumIdentities INTEGER NOT NULL,identities INTEGER NOT NULL,PRIMARY KEY(userId,sourceStorageIdentity,sessionId))' +
      suffix,
    'CREATE TABLE ' +
      table +
      '(userId BIGINT NOT NULL,sourceStorageIdentity VARCHAR(256) NOT NULL,sessionId VARCHAR(64) NOT NULL,binding VARCHAR(64) NOT NULL,frameDigest VARCHAR(64) NOT NULL,changeIndex INTEGER NOT NULL,tableId INTEGER NOT NULL,incomingId BIGINT NOT NULL,generation VARCHAR(19) NOT NULL,naturalIdentity VARCHAR(64) NOT NULL,naturalKeyJson TEXT NOT NULL,required INTEGER NOT NULL,PRIMARY KEY(userId,sourceStorageIdentity,sessionId,frameDigest,changeIndex,tableId,incomingId))' +
      suffix,
    'CREATE TABLE ' +
      frames +
      '(userId BIGINT NOT NULL,sourceStorageIdentity VARCHAR(256) NOT NULL,sessionId VARCHAR(64) NOT NULL,binding VARCHAR(64) NOT NULL,frameDigest VARCHAR(64) NOT NULL,windowSequence BIGINT NOT NULL,identities INTEGER NOT NULL,sealed INTEGER NOT NULL,changes INTEGER NOT NULL,PRIMARY KEY(userId,sourceStorageIdentity,sessionId,frameDigest))' +
      suffix
  ]
}

/** Receive one finite producer batch before its frame is acknowledged. These
 * records are DATA bound to a frame and window; neither their existence nor
 * their hashes authorize writes, source adoption, retirement or activation.
 * Exact duplicates from a lost prefix reply are idempotent. Conflicting data
 * cannot overwrite the first captured association. Per-window disk capacity
 * remains explicit and is charged before inserting each new identity.
 */
export async function captureSnapshotJournalIdentities(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  inputFrameDigest: string,
  inputChangeIndex: number,
  inputIdentities: ReadonlyMap<string, SnapshotJournalSourceIdentity>,
  inputLimits: SnapshotJournalCapturedIdentityLimits
): Promise<number> {
  const remote = transaction(k)
  const frameDigest = digest(inputFrameDigest)
  const changeIndex = integer(inputChangeIndex, 0, 255)
  const maximumIdentities = integer(inputLimits.maximumIdentities, 1, maximumCount)
  if (expected.phase !== 'intake' || !(inputIdentities instanceof Map) || inputIdentities.size > 128) invalid()
  const binding = { ...input, source: { ...input.source }, receipt: { ...input.receipt } }
  const high = snapshotJournalRevision(binding.receipt.highWater)
  const identities = [...inputIdentities].map(([key, value]) => {
    const result = owned(value, high)
    if (key !== result.tableId + ':' + result.incomingId) invalid()
    return { ...result, naturalKeyJson: JSON.stringify(naturalKey(value.naturalKey, result.tableId)) }
  })
  return await withSnapshotJournalDestinationWindowFence(k, binding, expected, async trx => {
    const selected = scope(binding, expected)
    const frameScope = { ...selected, frameDigest }
    const frameRows: Array<Record<string, unknown>> = await trx(frames)
      .select(
        boundedNumber(trx, 'windowSequence', Number.MAX_SAFE_INTEGER, remote),
        boundedNumber(trx, 'identities', maximumIdentities, remote),
        boundedNumber(trx, 'sealed', 1, remote)
      )
      .where(frameScope)
      .limit(2)
    if (frameRows.length > 1) invalid()
    if (frameRows.length === 0)
      await trx(frames).insert({
        ...frameScope,
        windowSequence: expected.sequence,
        identities: 0,
        sealed: 0,
        changes: 0
      })
    else if (integer(frameRows[0].windowSequence) !== expected.sequence || integer(frameRows[0].sealed, 0, 1) !== 0)
      invalid()
    const priorFrameCount = frameRows.length === 0 ? 0 : integer(frameRows[0].identities, 0, maximumIdentities)
    const rows: Array<Record<string, unknown>> = await trx(budgets)
      .select(
        boundedText(trx, 'binding', 64, remote),
        boundedNumber(trx, 'maximumIdentities', maximumCount, remote),
        boundedNumber(trx, 'identities', maximumIdentities, remote)
      )
      .where({
        userId: selected.userId,
        sourceStorageIdentity: selected.sourceStorageIdentity,
        sessionId: selected.sessionId
      })
      .limit(2)
    if (rows.length > 1) invalid()
    if (rows.length === 0) {
      if ((await trx(table).select('incomingId').where(selected).limit(1)).length !== 0) invalid()
      await trx(budgets).insert({ ...selected, maximumIdentities, identities: 0 })
    } else if (
      rows[0].binding !== selected.binding ||
      integer(rows[0].maximumIdentities, 1, maximumCount) !== maximumIdentities
    )
      invalid()
    const prior = rows.length === 0 ? 0 : integer(rows[0].identities, 0, maximumIdentities)
    let count = prior
    for (const value of identities) {
      const key = { ...selected, frameDigest, changeIndex, tableId: value.tableId, incomingId: value.incomingId }
      const existing: Array<Record<string, unknown>> = await trx(table)
        .select(
          boundedText(trx, 'generation', 19, remote),
          boundedText(trx, 'naturalIdentity', 64, remote),
          boundedText(trx, 'naturalKeyJson', naturalKeyBytes, remote),
          boundedNumber(trx, 'required', 1, remote)
        )
        .where(key)
        .limit(2)
      if (existing.length > 1) invalid()
      if (existing.length !== 0) {
        if (
          existing[0].generation !== value.generation ||
          existing[0].naturalIdentity !== value.naturalIdentity ||
          existing[0].naturalKeyJson !== value.naturalKeyJson ||
          integer(existing[0].required, 0, 1) !== Number(value.required)
        )
          invalid()
        continue
      }
      if (count === maximumIdentities)
        throw new SnapshotResourceLimitError('Captured journal identities exceed negotiated storage capacity')
      await trx(table).insert({
        ...key,
        generation: value.generation,
        naturalIdentity: value.naturalIdentity,
        naturalKeyJson: value.naturalKeyJson,
        required: Number(value.required)
      })
      count++
    }
    if (
      (await trx(budgets)
        .where({ ...selected, identities: prior })
        .update({ identities: count })) !== 1
    )
      invalid()
    if (
      (await trx(frames)
        .where({ ...frameScope, windowSequence: expected.sequence, identities: priorFrameCount, sealed: 0 })
        .update({ identities: priorFrameCount + count - prior })) !== 1
    )
      invalid()
    return count - prior
  })
}

/** Mark producer completion only after the owned source method has returned
 * successfully, including its final fresh source verification. This data marker
 * permits intake of the matching frame; it does not authenticate the producer
 * or grant promotion authority. Empty/tombstone/provenance frames need a marker
 * too, so absent sidecars can never be mistaken for interrupted capture.
 */
export async function sealSnapshotJournalCapturedFrame(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint,
  frameDigest: string,
  changes: number
): Promise<void> {
  const remote = transaction(k)
  const selected = { ...scope(binding, state), frameDigest: digest(frameDigest) }
  const count = integer(changes, 0, 256)
  if (state.phase !== 'intake') invalid()
  await withSnapshotJournalDestinationWindowFence(k, binding, state, async trx => {
    const rows: Array<Record<string, unknown>> = await trx(frames)
      .select(
        boundedNumber(trx, 'windowSequence', Number.MAX_SAFE_INTEGER, remote),
        boundedNumber(trx, 'sealed', 1, remote),
        boundedNumber(trx, 'changes', 256, remote)
      )
      .where(selected)
      .limit(2)
    if (rows.length > 1) invalid()
    if (rows.length === 0) {
      await trx(frames).insert({
        ...selected,
        windowSequence: state.sequence,
        identities: 0,
        sealed: 1,
        changes: count
      })
      return
    }
    if (integer(rows[0].windowSequence) !== state.sequence) invalid()
    if (integer(rows[0].sealed, 0, 1) === 1) {
      if (integer(rows[0].changes, 0, 256) !== count) invalid()
      return
    }
    if (
      (await trx(frames)
        .where({ ...selected, windowSequence: state.sequence, sealed: 0 })
        .update({ sealed: 1, changes: count })) !== 1
    )
      invalid()
  })
}

export async function requireSnapshotJournalCapturedFrame(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint,
  frameDigest: string,
  changes: number
): Promise<void> {
  const remote = transaction(k)
  const rows: Array<Record<string, unknown>> = await k(frames)
    .select(boundedNumber(k, 'sealed', 1, remote), boundedNumber(k, 'changes', 256, remote))
    .where({ ...scope(binding, state), frameDigest: digest(frameDigest) })
    .limit(2)
  if (
    rows.length !== 1 ||
    integer(rows[0].sealed, 0, 1) !== 1 ||
    integer(rows[0].changes, 0, 256) !== integer(changes, 0, 256)
  )
    invalid()
}

/** Indexed, bounded read of captured data during semantic promotion. Iterate
 * this cursor for large notification sets; no query loads the entire wallet or
 * every ID map. The actual destination/source fences are independently required.
 */
export async function readSnapshotJournalCapturedIdentities(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint,
  frameDigest: string,
  changeIndex: number,
  after?: { tableId: SnapshotJournalIdentityTable; incomingId: number },
  selection?: { kind: 'request-scalars' } | { kind: 'transaction-points'; ids: readonly number[] }
): Promise<SnapshotJournalCapturedIdentity[]> {
  const remote = transaction(k)
  const selected = {
    ...scope(binding, state),
    frameDigest: digest(frameDigest),
    changeIndex: integer(changeIndex, 0, 255)
  }
  const cursor =
    after === undefined
      ? undefined
      : { tableId: integer(after.tableId, 0, 9), incomingId: integer(after.incomingId, 1) }
  if (cursor !== undefined && !entityTables.includes(cursor.tableId)) invalid()
  const query = k(table)
    .where(selected)
    .select(
      boundedNumber(k, 'tableId', 9, remote),
      boundedNumber(k, 'incomingId', Number.MAX_SAFE_INTEGER, remote),
      boundedText(k, 'generation', 19, remote),
      boundedText(k, 'naturalIdentity', 64, remote),
      boundedText(k, 'naturalKeyJson', naturalKeyBytes, remote),
      boundedNumber(k, 'required', 1, remote)
    )
    .orderBy(['tableId', 'incomingId'])
    .limit(128)
  if (cursor !== undefined)
    query.andWhere(function () {
      void this.where('tableId', '>', cursor.tableId).orWhere(function () {
        void this.where('tableId', cursor.tableId).andWhere('incomingId', '>', cursor.incomingId)
      })
    })
  if (selection?.kind === 'request-scalars') {
    // Explicit ranges exclude the possibly million-member notification family.
    // Unexpected non-transaction parent families still reach the parser and refuse.
    query.whereIn('tableId', [1, 2, 3, 4, 5, 6, 8, 9])
  } else if (selection?.kind === 'transaction-points') {
    if (after !== undefined || !Array.isArray(selection.ids) || selection.ids.length < 1 || selection.ids.length > 128)
      invalid()
    const ids = selection.ids.map(id => integer(id, 1))
    query.where('tableId', 0).whereIn('incomingId', ids)
  } else if (selection !== undefined) invalid()
  const rows: Array<Record<string, unknown>> = await query
  return rows.map(row => {
    const reference = owned(
      {
        tableId: integer(row.tableId, 0, 9) as SnapshotJournalIdentityTable,
        incomingId: integer(row.incomingId, 1),
        generation: snapshotJournalRevision(row.generation),
        naturalIdentity: digest(row.naturalIdentity),
        required: integer(row.required, 0, 1) === 1
      },
      binding.receipt.highWater
    )
    if (typeof row.naturalKeyJson !== 'string') invalid()
    if (selection?.kind === 'request-scalars' && ![8, 9].includes(reference.tableId)) invalid()
    const key = naturalKey(JSON.parse(row.naturalKeyJson), reference.tableId)
    if (JSON.stringify(key) !== row.naturalKeyJson) invalid()
    return { ...reference, naturalKey: key }
  })
}

/** Reentry compares the genuine authenticated archive prefix against the
 * original sealed target capture. Bounded point reads retain no whole-frame
 * notification map and do not accept new identities during promotion. */
export async function verifySnapshotJournalCapturedIdentityPrefix(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint,
  inputFrameDigest: string,
  inputChangeIndex: number,
  identities: ReadonlyMap<string, SnapshotJournalSourceIdentity>
): Promise<void> {
  const remote = transaction(k),
    frameDigest = digest(inputFrameDigest),
    changeIndex = integer(inputChangeIndex, 0, 255)
  if (state.phase !== 'promoting' || !(identities instanceof Map) || identities.size > 128) invalid()
  await withSnapshotJournalDestinationWindowFence(k, binding, state, async trx => {
    const selected = { ...scope(binding, state), frameDigest }
    const frame: Array<Record<string, unknown>> = await trx(frames)
      .where(selected)
      .select(boundedNumber(trx, 'sealed', 1, remote), boundedNumber(trx, 'changes', 256, remote))
      .limit(2)
    if (frame.length !== 1 || integer(frame[0].sealed, 0, 1) !== 1 || changeIndex >= integer(frame[0].changes, 0, 256))
      invalid()
    for (const [key, value] of identities) {
      const expected = owned(value, binding.receipt.highWater),
        naturalKeyJson = JSON.stringify(naturalKey(value.naturalKey, expected.tableId))
      if (key !== expected.tableId + ':' + expected.incomingId) invalid()
      const rows: Array<Record<string, unknown>> = await trx(table)
        .where({ ...selected, changeIndex, tableId: expected.tableId, incomingId: expected.incomingId })
        .select(
          boundedText(trx, 'generation', 19, remote),
          boundedText(trx, 'naturalIdentity', 64, remote),
          boundedText(trx, 'naturalKeyJson', naturalKeyBytes, remote),
          boundedNumber(trx, 'required', 1, remote)
        )
        .limit(2)
      if (
        rows.length !== 1 ||
        rows[0].generation !== expected.generation ||
        rows[0].naturalIdentity !== expected.naturalIdentity ||
        rows[0].naturalKeyJson !== naturalKeyJson ||
        integer(rows[0].required, 0, 1) !== Number(expected.required)
      )
        invalid()
    }
  })
}
