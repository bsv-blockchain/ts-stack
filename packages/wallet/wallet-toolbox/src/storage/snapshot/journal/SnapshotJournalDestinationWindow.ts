import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { SnapshotJournalDestinationBinding, SnapshotJournalDestinationCheckpoint } from './SnapshotJournalTypes'
export type { SnapshotJournalDestinationBinding, SnapshotJournalDestinationCheckpoint } from './SnapshotJournalTypes'
import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { snapshotArchiveDatabaseNow } from '../archive/SnapshotArchiveSql'
import { snapshotSyncTables } from '../SnapshotSync'
import {
  snapshotJournalReceiptBinding,
  SNAPSHOT_JOURNAL_RECEIPT_MAX_LIFETIME,
  type SnapshotJournalReceipt,
  type SnapshotJournalReceiptBinding
} from './SnapshotJournalReceipt'
import { snapshotJournalRevision, compareSnapshotJournalRevisions } from './SnapshotJournalRevision'
import { snapshotJournalRevisionText } from './SnapshotJournalRevisionSql'
import type { SnapshotJournalPosition } from './SnapshotJournalPage'
import { snapshotJournalLineage, snapshotJournalAssociationGeneration } from './SnapshotJournalLineage'

/** All scope streams, then both physical global streams, in one coherent view. */
export const snapshotJournalDestinationStreams = Object.freeze([
  ...Array.from({ length: 13 }, (_, tableId) => Object.freeze({ stream: 'scope' as const, tableId })),
  Object.freeze({ stream: 'physical' as const, tableId: 8 }),
  Object.freeze({ stream: 'physical' as const, tableId: 9 })
])

export type SnapshotJournalDestinationStep =
  | {
      phase: 'intake'
      examined: number
      complete: boolean
      after?: SnapshotJournalPosition
    }
  | {
      phase: 'promoting'
      examined: number
      complete: boolean
      promotionSequence: number
      /** A validated staged empty frame can advance without claiming a row. */
      emptyFrameDigest?: string
    }

const table = 'snapshot_reconciliation_windows'
const digest = /^[0-9a-f]{64}$/
const chains = ['main', 'test', 'stn', 'ttn', 'tstn', 'regtest', 'mock']

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or stale journal destination window')
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid()
  return value
}

function storageIdentity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    Buffer.byteLength(value, 'utf8') > 256 ||
    Buffer.from(value, 'utf8').toString('utf8') !== value
  )
    return invalid()
  return value
}

function transaction(k: Knex): boolean {
  if (!k.isTransaction) return invalid()
  const client = k.client.config.client
  if (client === 'better-sqlite3' || client === 'sqlite3' || isOwnedNativeSqlite(k)) return false
  if (client === 'mysql' || client === 'mysql2') return true
  return invalid()
}

/** Own auxiliary DDL only. This does not register a migration or establish ownership. */
export function snapshotJournalDestinationWindowDdl(k: Knex): string {
  const client = k.client.config.client
  if (
    (typeof client !== 'string' || !['better-sqlite3', 'sqlite3', 'mysql', 'mysql2'].includes(client)) &&
    !isOwnedNativeSqlite(k)
  )
    return invalid()
  return (
    'CREATE TABLE snapshot_reconciliation_windows(userId BIGINT NOT NULL,sourceStorageIdentity VARCHAR(256) NOT NULL,sessionId VARCHAR(64) NOT NULL,binding VARCHAR(64) NOT NULL,bindingJson TEXT NOT NULL,stateJson TEXT NOT NULL,sequence BIGINT NOT NULL,retired INTEGER NOT NULL,PRIMARY KEY(userId,sourceStorageIdentity))' +
    (client === 'mysql' || client === 'mysql2'
      ? ' ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin ROW_FORMAT=DYNAMIC'
      : '')
  )
}

function ownBinding(input: SnapshotJournalDestinationBinding): {
  value: SnapshotJournalDestinationBinding
  json: string
  hash: string
} {
  const source: SnapshotJournalReceiptBinding = {
    backend: input.source.backend,
    epoch: input.source.epoch,
    source: input.source.source,
    schema: input.source.schema,
    storageIdentity: input.source.storageIdentity,
    identityKey: input.source.identityKey,
    userId: input.source.userId,
    chain: input.source.chain
  }
  const sourceHash = snapshotJournalReceiptBinding(source)
  const receipt: SnapshotJournalReceipt = {
    requestId: input.receipt.requestId,
    binding: input.receipt.binding,
    highWater: snapshotJournalRevision(input.receipt.highWater),
    floor: snapshotJournalRevision(input.receipt.floor),
    expiresAt: integer(input.receipt.expiresAt, 1)
  }
  const value: SnapshotJournalDestinationBinding = {
    ...(input.lineageVersion === 2 ? { lineageVersion: 2 as const } : {}),
    ...(input.bootstrap === true ? { bootstrap: true as const } : {}),
    source,
    receipt,
    low: snapshotJournalRevision(input.low),
    destinationBackend: input.destinationBackend,
    destinationStorageIdentity: storageIdentity(input.destinationStorageIdentity),
    destinationUserId: integer(input.destinationUserId, 1),
    primaryEpoch: snapshotJournalRevision(input.primaryEpoch),
    activeStorage: input.activeStorage === null ? null : storageIdentity(input.activeStorage)
  }
  if (
    !digest.test(receipt.requestId) ||
    receipt.binding !== sourceHash ||
    !digest.test(value.destinationBackend) ||
    value.destinationBackend === source.backend ||
    value.destinationStorageIdentity === source.storageIdentity ||
    !chains.includes(source.chain) ||
    receipt.highWater === '0' ||
    (input.lineageVersion !== undefined && input.lineageVersion !== 2) ||
    (input.bootstrap !== undefined && input.bootstrap !== true) ||
    (value.bootstrap === true
      ? value.low !== '0' || compareSnapshotJournalRevisions(receipt.floor, receipt.highWater) > 0
      : compareSnapshotJournalRevisions(receipt.floor, value.low) > 0) ||
    compareSnapshotJournalRevisions(value.low, receipt.highWater) > 0
  )
    return invalid()
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf8') > 4096) return invalid()
  return {
    value,
    json,
    hash: createHash('sha256').update('snapshot-journal-destination-window-v1\n').update(json).digest('hex')
  }
}

function position(
  value: SnapshotJournalPosition,
  binding: SnapshotJournalDestinationBinding,
  streamIndex: number
): SnapshotJournalPosition {
  const revision = snapshotJournalRevision(value.revision)
  if (
    compareSnapshotJournalRevisions(revision, binding.low) <= 0 ||
    compareSnapshotJournalRevisions(revision, binding.receipt.highWater) > 0
  )
    return invalid()
  const exactText = value.exactText
  if (
    typeof exactText !== 'string' ||
    Buffer.byteLength(exactText, 'utf8') > 400 ||
    Buffer.from(exactText, 'utf8').toString('utf8') !== exactText
  )
    return invalid()
  return {
    revision,
    id1: integer(
      value.id1,
      snapshotJournalDestinationStreams[streamIndex]?.tableId === 7 ? -Number.MAX_SAFE_INTEGER : 1
    ),
    id2: integer(value.id2),
    exactText
  }
}

function compare(left: SnapshotJournalPosition, right: SnapshotJournalPosition): number {
  return (
    compareSnapshotJournalRevisions(left.revision, right.revision) ||
    left.id1 - right.id1 ||
    left.id2 - right.id2 ||
    Buffer.compare(Buffer.from(left.exactText), Buffer.from(right.exactText))
  )
}

function ownState(
  input: SnapshotJournalDestinationCheckpoint,
  binding: ReturnType<typeof ownBinding>
): SnapshotJournalDestinationCheckpoint {
  if (
    input.version !== 1 ||
    !digest.test(input.sessionId) ||
    input.binding !== binding.hash ||
    !['intake', 'promoting', 'acknowledged'].includes(input.phase)
  )
    return invalid()
  const result: SnapshotJournalDestinationCheckpoint = {
    version: 1,
    sessionId: input.sessionId,
    binding: input.binding,
    sequence: integer(input.sequence),
    phase: input.phase,
    streamIndex: integer(input.streamIndex, 0, snapshotJournalDestinationStreams.length),
    tableIndex: integer(input.tableIndex, 0, snapshotSyncTables.length),
    ...(input.after === undefined ? {} : { after: position(input.after, binding.value, input.streamIndex) }),
    promotionSequence: integer(input.promotionSequence)
  }
  if (result.phase === 'intake') {
    if (
      result.streamIndex === snapshotJournalDestinationStreams.length ||
      result.tableIndex !== 0 ||
      result.promotionSequence !== 0
    )
      return invalid()
  } else if (
    result.streamIndex !== snapshotJournalDestinationStreams.length ||
    result.after !== undefined ||
    (result.phase === 'promoting'
      ? result.tableIndex === snapshotSyncTables.length
      : result.tableIndex !== snapshotSyncTables.length || result.promotionSequence !== 0)
  )
    return invalid()
  return result
}

/** Reacquire the actual user first, preserving the existing session lock order.
 * Caller additionally verifies complete source/destination schema and physical
 * backend ownership. This helper does not turn a supplied digest into authority. */
async function fence(k: Knex, value: SnapshotJournalDestinationBinding, observeOnly = false): Promise<void> {
  transaction(k)
  const scope = {
    userId: value.destinationUserId,
    identityKey: value.source.identityKey
  }
  if (
    (await k('users')
      .where(scope)
      .update({ userId: k.ref('userId') })) !== 1
  )
    return invalid()
  const users = await k('users')
    .select('userId', k.raw('substr(??,1,257) AS ??', ['activeStorage', 'activeStorage']))
    .where(scope)
    .limit(2)
  const settings = await k('settings')
    .select(
      k.raw('substr(??,1,257) AS ??', ['storageIdentityKey', 'storageIdentityKey']),
      k.raw('substr(??,1,9) AS ??', ['chain', 'chain'])
    )
    .limit(2)
  const epochs = await k('snapshot_sync_primary_epochs')
    .select({ epoch: snapshotJournalRevisionText(k, 'epoch') })
    .where('userId', scope.userId)
    .limit(2)
  if (
    users.length !== 1 ||
    (!observeOnly && users[0].activeStorage !== value.activeStorage) ||
    settings.length !== 1 ||
    settings[0].storageIdentityKey !== value.destinationStorageIdentity ||
    settings[0].chain !== value.source.chain ||
    epochs.length > 1 ||
    (!observeOnly && snapshotJournalRevision(epochs[0]?.epoch ?? '0') !== value.primaryEpoch)
  )
    return invalid()
  const now = await snapshotArchiveDatabaseNow(k)
  if (
    !Number.isSafeInteger(now) ||
    now < 1 ||
    (!observeOnly &&
      (value.receipt.expiresAt <= now || value.receipt.expiresAt - now > SNAPSHOT_JOURNAL_RECEIPT_MAX_LIFETIME))
  )
    return invalid()
}

async function read(
  k: Knex,
  binding: ReturnType<typeof ownBinding>,
  allowRetired = false
): Promise<SnapshotJournalDestinationCheckpoint | undefined> {
  const rows: Array<Record<string, unknown>> = await k(table)
    .select(
      'sessionId',
      'binding',
      'sequence',
      'retired',
      k.raw('substr(??,1,4097) AS ??', ['bindingJson', 'bindingJson']),
      k.raw('substr(??,1,4097) AS ??', ['stateJson', 'stateJson'])
    )
    .where({
      userId: binding.value.destinationUserId,
      sourceStorageIdentity: binding.value.source.storageIdentity
    })
    .limit(2)
  if (rows.length > 1) return invalid()
  const row = rows[0]
  if (row === undefined) return undefined
  if (
    ![0, 1].includes(Number(row.retired)) ||
    (!allowRetired && Number(row.retired) !== 0) ||
    row.binding !== binding.hash ||
    row.bindingJson !== binding.json ||
    typeof row.stateJson !== 'string' ||
    Buffer.byteLength(row.stateJson, 'utf8') > 4096
  )
    return invalid()
  const state = ownState(JSON.parse(row.stateJson), binding)
  if (
    state.sessionId !== row.sessionId ||
    String(state.sequence) !== String(row.sequence) ||
    row.stateJson !== JSON.stringify(state)
  )
    return invalid()
  return state
}

/** Recovery reads destination-owned committed state in a NEW transaction,
 * including after source expiry or a primary change. Observation grants no
 * further write or cutover authority: begin/advance recheck the complete fence.
 * A sender's local progress cannot replace this read after a missing response. */
export async function readSnapshotJournalDestinationWindow(
  k: Knex,
  input: SnapshotJournalDestinationBinding
): Promise<SnapshotJournalDestinationCheckpoint | undefined> {
  transaction(k)
  const binding = ownBinding(input)
  await fence(k, binding.value, true)
  return await read(k, binding)
}

/** Resolve a missing succession ACK from destination custody in a NEW writer.
 * A sender need not remember the random successor session ID. Exact bound JSON
 * and the actual profile/storage still have to match; observation grants no
 * permission to advance a source view that has expired or changed primary. */
export async function readSnapshotJournalDestinationSuccessorWindow(
  k: Knex,
  previousInput: SnapshotJournalDestinationBinding,
  nextInput: SnapshotJournalDestinationBinding
): Promise<SnapshotJournalDestinationCheckpoint | undefined> {
  transaction(k)
  const previous = ownBinding(previousInput),
    next = ownBinding(nextInput)
  if (
    previous.value.destinationUserId !== next.value.destinationUserId ||
    previous.value.destinationStorageIdentity !== next.value.destinationStorageIdentity ||
    previous.value.destinationBackend !== next.value.destinationBackend ||
    previous.value.source.storageIdentity !== next.value.source.storageIdentity
  )
    return invalid()
  await fence(k, next.value, true)
  const rows: Array<{ binding: unknown }> = await k(table)
    .where({ userId: next.value.destinationUserId, sourceStorageIdentity: next.value.source.storageIdentity })
    .select('binding')
    .limit(2)
  if (rows.length !== 1) return invalid()
  if (rows[0].binding === next.hash) return await read(k, next)
  if (rows[0].binding !== previous.hash || (await read(k, previous)) === undefined) return invalid()
  return undefined
}

/** Recheck the actual write fence around a bounded partial-page commit. A
 * savepoint protects callers that catch an error inside an outer transaction.
 * Source receipt, lease, schema and physical backend verification remain part
 * of the source-owned coordinator; this function grants no source authority. */
export async function withSnapshotJournalDestinationWindowFence<T>(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  apply: (trx: Knex) => Promise<T>
): Promise<T> {
  transaction(k)
  const binding = ownBinding(input)
  const prior = ownState(expected, binding)
  if (prior.phase === 'acknowledged' || typeof apply !== 'function') return invalid()
  return await k.transaction(async trx => {
    await fence(trx, binding.value)
    if (JSON.stringify(await read(trx, binding)) !== JSON.stringify(prior)) return invalid()
    const result = await apply(trx)
    await fence(trx, binding.value)
    if (JSON.stringify(await read(trx, binding)) !== JSON.stringify(prior)) return invalid()
    return result
  })
}

/** Primary coordination is separate from semantic import. This consumes only
 * the exact actual ACKed window under its current destination primary fence.
 * The caller independently holds fresh source-data fences and authenticated
 * manager ownership through the bounded update and physical connection close. */
export async function selectSnapshotJournalDestinationPrimary(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  activeStorage: string,
  update: (trx: Knex, userId: number) => Promise<number>
): Promise<void> {
  transaction(k)
  const binding = ownBinding(input),
    prior = ownState(expected, binding)
  if (
    prior.phase !== 'acknowledged' ||
    typeof activeStorage !== 'string' ||
    Buffer.byteLength(activeStorage, 'utf8') < 1 ||
    Buffer.byteLength(activeStorage, 'utf8') > 256 ||
    Buffer.from(activeStorage, 'utf8').toString('utf8') !== activeStorage ||
    typeof update !== 'function'
  )
    invalid()
  await fence(k, binding.value)
  if (JSON.stringify(await read(k, binding)) !== JSON.stringify(prior)) invalid()
  if (activeStorage === binding.value.activeStorage) return
  if ((await update(k, binding.value.destinationUserId)) !== 1) invalid()
  const users = await k('users')
    .where({ userId: binding.value.destinationUserId, identityKey: binding.value.source.identityKey })
    .select(k.raw('substr(activeStorage,1,257) AS activeStorage'))
    .limit(2)
  const epochs = await k('snapshot_sync_primary_epochs')
    .where('userId', binding.value.destinationUserId)
    .select({ epoch: snapshotJournalRevisionText(k, 'epoch') })
    .limit(2)
  if (
    users.length !== 1 ||
    users[0].activeStorage !== activeStorage ||
    epochs.length !== 1 ||
    BigInt(snapshotJournalRevision(epochs[0].epoch)) !== BigInt(binding.value.primaryEpoch) + 1n
  )
    invalid()
}

/** Auxiliary GC after committed acknowledgement. Expiry or a primary change
 * does not grant new semantic write authority, but cannot strand old stage
 * payloads. Observe the actual profile/storage and exact committed window before
 * and after a bounded cleanup savepoint; the window itself is retained. */
export async function withSnapshotJournalAcknowledgedWindowFence<T>(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  cleanup: (trx: Knex) => Promise<T>
): Promise<T> {
  if (expected.phase !== 'acknowledged') return invalid()
  return await withSnapshotJournalWindowCustodyFence(k, input, expected, cleanup)
}

/** Session payload cleanup after an interrupted receiver. This observes exact
 * committed custody and current destination identity/backend, never source
 * authority, primary activation or permission to resume old semantic writes. */
export async function withSnapshotJournalWindowCustodyFence<T>(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  cleanup: (trx: Knex) => Promise<T>
): Promise<T> {
  transaction(k)
  const binding = ownBinding(input),
    prior = ownState(expected, binding)
  if (typeof cleanup !== 'function') return invalid()
  return await k.transaction(async trx => {
    await fence(trx, binding.value, true)
    if (JSON.stringify(await read(trx, binding, true)) !== JSON.stringify(prior)) return invalid()
    if (
      prior.phase !== 'acknowledged' &&
      !(
        await trx(table)
          .where({
            userId: binding.value.destinationUserId,
            sourceStorageIdentity: binding.value.source.storageIdentity,
            sessionId: prior.sessionId,
            retired: 1
          })
          .select('retired')
          .limit(1)
      ).length
    )
      return invalid()
    const result = await cleanup(trx)
    await fence(trx, binding.value, true)
    if (JSON.stringify(await read(trx, binding, true)) !== JSON.stringify(prior)) return invalid()
    return result
  })
}

/** Durable recovery data only, read under actual authenticated destination
 * ownership. A new process must establish fresh source authority separately. */
export async function readSnapshotJournalStoredWindow(
  k: Knex,
  currentInput: SnapshotJournalDestinationBinding
): Promise<
  | { binding: SnapshotJournalDestinationBinding; checkpoint: SnapshotJournalDestinationCheckpoint; retired: boolean }
  | undefined
> {
  transaction(k)
  const current = ownBinding(currentInput)
  await fence(k, current.value, true)
  const rows: Array<{ bindingJson: unknown; retired: unknown }> = await k(table)
    .where({
      userId: current.value.destinationUserId,
      sourceStorageIdentity: current.value.source.storageIdentity
    })
    .select('retired', k.raw('substr(bindingJson,1,4097) AS bindingJson'))
    .limit(2)
  if (rows.length > 1) return invalid()
  if (!rows.length) return undefined
  if (typeof rows[0].bindingJson !== 'string' || Buffer.byteLength(rows[0].bindingJson, 'utf8') > 4096) return invalid()
  const previous = ownBinding(JSON.parse(rows[0].bindingJson))
  if (
    previous.json !== rows[0].bindingJson ||
    previous.value.destinationBackend !== current.value.destinationBackend ||
    previous.value.destinationUserId !== current.value.destinationUserId ||
    previous.value.destinationStorageIdentity !== current.value.destinationStorageIdentity ||
    previous.value.source.storageIdentity !== current.value.source.storageIdentity ||
    previous.value.source.identityKey !== current.value.source.identityKey ||
    previous.value.source.chain !== current.value.source.chain
  )
    return invalid()
  await fence(k, previous.value, true)
  const checkpoint = await read(k, previous, true)
  if (checkpoint === undefined) return invalid()
  return { binding: previous.value, checkpoint, retired: Number(rows[0].retired) === 1 }
}

/** Fence the obsolete receiver BEFORE any staged row can be collected. Every
 * old semantic/intake fence rejects retired custody, including a delayed reply.
 * Repeating retirement after a committed lost reply is idempotent. */
export async function retireSnapshotJournalDestinationWindow(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint
): Promise<void> {
  transaction(k)
  const binding = ownBinding(input),
    prior = ownState(expected, binding)
  await fence(k, binding.value, true)
  if (JSON.stringify(await read(k, binding, true)) !== JSON.stringify(prior)) return invalid()
  const key = {
    userId: binding.value.destinationUserId,
    sourceStorageIdentity: binding.value.source.storageIdentity,
    sessionId: prior.sessionId,
    sequence: prior.sequence,
    binding: binding.hash
  }
  const rows: Array<{ retired: unknown }> = await k(table).where(key).select('retired').limit(2)
  if (rows.length !== 1 || ![0, 1].includes(Number(rows[0].retired))) return invalid()
  if (
    Number(rows[0].retired) === 0 &&
    (await k(table)
      .where({ ...key, retired: 0 })
      .update({ retired: 1 })) !== 1
  )
    return invalid()
}

/** Replace obsolete intake/promotion custody with a freshly authorized complete
 * scan of the same authenticated profile and physical destination. Partial semantic
 * merges remain governed by their original memberships; the new scan repairs
 * and sweeps them. Auxiliary cleanup must already be complete. No expired
 * source receipt is renewed and no sender-local progress is adopted. */
export async function replaceSnapshotJournalDestinationWindow(
  k: Knex,
  previousInput: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  nextInput: SnapshotJournalDestinationBinding,
  sessionId: string,
  requireClean: (trx: Knex) => Promise<void>
): Promise<SnapshotJournalDestinationCheckpoint> {
  transaction(k)
  const previous = ownBinding(previousInput),
    next = ownBinding(nextInput),
    prior = ownState(expected, previous)
  const sameGeneration =
    snapshotJournalAssociationGeneration(previous.value) === snapshotJournalAssociationGeneration(next.value)
  const sameProfile =
    previous.value.lineageVersion === 2 &&
    next.value.lineageVersion === 2 &&
    snapshotJournalLineage(previous.value) === snapshotJournalLineage(next.value)
  if (
    next.value.bootstrap !== true ||
    next.value.low !== '0' ||
    !digest.test(sessionId) ||
    (!sameGeneration && !sameProfile) ||
    previous.value.destinationBackend !== next.value.destinationBackend ||
    previous.value.destinationStorageIdentity !== next.value.destinationStorageIdentity ||
    previous.value.destinationUserId !== next.value.destinationUserId ||
    (sameGeneration &&
      compareSnapshotJournalRevisions(previous.value.receipt.highWater, next.value.receipt.highWater) > 0) ||
    typeof requireClean !== 'function'
  )
    return invalid()
  return await k.transaction(async trx => {
    await fence(trx, next.value)
    if (JSON.stringify(await read(trx, previous, true)) !== JSON.stringify(prior)) return invalid()
    await requireClean(trx)
    if (
      (await trx(table)
        .where({
          userId: previous.value.destinationUserId,
          sourceStorageIdentity: previous.value.source.storageIdentity,
          sessionId: prior.sessionId,
          sequence: prior.sequence,
          binding: previous.hash,
          bindingJson: previous.json,
          stateJson: JSON.stringify(prior),
          retired: 1
        })
        .delete()) !== 1
    )
      return invalid()
    return await beginSnapshotJournalDestinationWindow(trx, next.value, sessionId)
  })
}

export async function beginSnapshotJournalDestinationWindow(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  sessionId: string
): Promise<SnapshotJournalDestinationCheckpoint> {
  transaction(k)
  const binding = ownBinding(input)
  if (!digest.test(sessionId)) return invalid()
  await fence(k, binding.value)
  const prior = await read(k, binding)
  if (prior !== undefined) {
    if (prior.sessionId !== sessionId) return invalid()
    return prior
  }
  const state: SnapshotJournalDestinationCheckpoint = {
    version: 1,
    sessionId,
    binding: binding.hash,
    sequence: 0,
    phase: 'intake',
    streamIndex: 0,
    tableIndex: 0,
    promotionSequence: 0
  }
  await k(table).insert({
    userId: binding.value.destinationUserId,
    sourceStorageIdentity: binding.value.source.storageIdentity,
    sessionId,
    binding: binding.hash,
    bindingJson: binding.json,
    stateJson: JSON.stringify(state),
    sequence: state.sequence,
    retired: 0
  })
  return state
}

/** Atomic progress for caller-owned validated staging or entity/ID-map writes.
 * The caller must await successful OUTER transaction commit before replying.
 * All fifteen streams finish before promotion in the existing twelve-table
 * dependency order. Operational source syncStates remain staged provenance.
 * No primary switch, replacement window, deletion policy or capability is added. */
export async function advanceSnapshotJournalDestinationWindow<T>(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  step: SnapshotJournalDestinationStep,
  apply: (trx: Knex) => Promise<T>
): Promise<{ checkpoint: SnapshotJournalDestinationCheckpoint; result: T }> {
  transaction(k)
  const binding = ownBinding(input),
    prior = ownState(expected, binding)
  if (step.phase !== prior.phase || typeof step.complete !== 'boolean' || prior.sequence === Number.MAX_SAFE_INTEGER)
    return invalid()
  const examined = integer(step.examined, 0, 256)
  let next: SnapshotJournalDestinationCheckpoint = {
    ...prior,
    ...(prior.after === undefined ? {} : { after: { ...prior.after } }),
    sequence: prior.sequence + 1
  }
  if (step.phase === 'intake') {
    const after = step.after === undefined ? undefined : position(step.after, binding.value, prior.streamIndex)
    if (
      examined === 0
        ? !step.complete || JSON.stringify(after) !== JSON.stringify(prior.after)
        : after === undefined || (prior.after !== undefined && compare(after, prior.after) <= 0)
    )
      return invalid()
    if (step.complete) {
      next.streamIndex++
      delete next.after
      if (next.streamIndex === snapshotJournalDestinationStreams.length) next.phase = 'promoting'
    } else next.after = after
  } else {
    const sequence = integer(step.promotionSequence)
    const emptyFrame = step.emptyFrameDigest !== undefined
    if (emptyFrame && (examined !== 0 || step.complete || !digest.test(step.emptyFrameDigest!))) return invalid()
    if (
      examined === 0
        ? emptyFrame
          ? sequence <= prior.promotionSequence
          : !step.complete || sequence !== prior.promotionSequence
        : sequence <= prior.promotionSequence
    )
      return invalid()
    if (step.complete) {
      next.tableIndex++
      next.promotionSequence = 0
      if (next.tableIndex === snapshotSyncTables.length) next.phase = 'acknowledged'
    } else next.promotionSequence = sequence
  }
  next = ownState(next, binding)
  await fence(k, binding.value)
  const actual = await read(k, binding)
  if (JSON.stringify(actual) !== JSON.stringify(prior)) return invalid()
  if (step.phase === 'promoting' && step.emptyFrameDigest !== undefined) {
    const frames = await k('snapshot_reconciliation_stage_pages')
      .select('sequence')
      .where({
        userId: binding.value.destinationUserId,
        sourceStorageIdentity: binding.value.source.storageIdentity,
        sessionId: prior.sessionId,
        binding: prior.binding,
        sequence: step.promotionSequence,
        digest: step.emptyFrameDigest,
        examined: 0
      })
      .limit(2)
    if (frames.length !== 1) return invalid()
  }
  const result = await apply(k)
  await fence(k, binding.value)
  if (
    (await k(table)
      .where({
        userId: binding.value.destinationUserId,
        sourceStorageIdentity: binding.value.source.storageIdentity,
        sessionId: prior.sessionId,
        binding: binding.hash,
        sequence: prior.sequence
      })
      .update({ stateJson: JSON.stringify(next), sequence: next.sequence })) !== 1
  )
    return invalid()
  return { checkpoint: next, result }
}

/** Replace only a destination-acknowledged window with its exact successor.
 * Both complete source receipt/generation validations remain caller-owned.
 * Same generation, backend, schema, profile, primary epoch and selected identity
 * are required; a changed generation needs a separately qualified bootstrap.
 * The caller's bounded staging cleanup and checkpoint replacement share THIS
 * transaction. An unfinished window is never abandoned through this helper.
 * Await successful outer commit before reporting successor ownership. */
export async function succeedSnapshotJournalDestinationWindow(
  k: Knex,
  previousInput: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  nextInput: SnapshotJournalDestinationBinding,
  nextSessionId: string,
  retire: (trx: Knex) => Promise<void>
): Promise<SnapshotJournalDestinationCheckpoint> {
  transaction(k)
  const previous = ownBinding(previousInput),
    next = ownBinding(nextInput),
    prior = ownState(expected, previous),
    cleanup = retire
  if (
    prior.phase !== 'acknowledged' ||
    !digest.test(nextSessionId) ||
    nextSessionId === prior.sessionId ||
    typeof cleanup !== 'function' ||
    next.value.receipt.requestId === previous.value.receipt.requestId ||
    snapshotJournalReceiptBinding(previous.value.source) !== snapshotJournalReceiptBinding(next.value.source) ||
    next.value.low !== previous.value.receipt.highWater ||
    next.value.destinationBackend !== previous.value.destinationBackend ||
    next.value.destinationStorageIdentity !== previous.value.destinationStorageIdentity ||
    next.value.destinationUserId !== previous.value.destinationUserId ||
    next.value.primaryEpoch !== previous.value.primaryEpoch ||
    next.value.activeStorage !== previous.value.activeStorage
  )
    return invalid()
  await fence(k, next.value)
  const rows: Array<{ binding: unknown }> = await k(table)
    .select('binding')
    .where({
      userId: previous.value.destinationUserId,
      sourceStorageIdentity: previous.value.source.storageIdentity
    })
    .limit(2)
  if (rows.length !== 1) return invalid()
  // A lost committed reply is resolved against actual successor custody.
  // Retrying the same handoff never repeats cleanup or resets its progress.
  if (rows[0].binding === next.hash) {
    const actual = await read(k, next)
    if (actual === undefined || actual.sessionId !== nextSessionId) return invalid()
    return actual
  }
  if (rows[0].binding !== previous.hash) return invalid()
  const actual = await read(k, previous)
  if (JSON.stringify(actual) !== JSON.stringify(prior)) return invalid()
  const state: SnapshotJournalDestinationCheckpoint = {
    version: 1,
    sessionId: nextSessionId,
    binding: next.hash,
    sequence: 0,
    phase: 'intake',
    streamIndex: 0,
    tableIndex: 0,
    promotionSequence: 0
  }
  await cleanup(k)
  await fence(k, next.value)
  if (JSON.stringify(await read(k, previous)) !== JSON.stringify(prior)) return invalid()
  if (
    (await k(table)
      .where({
        userId: previous.value.destinationUserId,
        sourceStorageIdentity: previous.value.source.storageIdentity,
        sessionId: prior.sessionId,
        binding: previous.hash,
        sequence: prior.sequence
      })
      .update({
        sessionId: state.sessionId,
        binding: next.hash,
        bindingJson: next.json,
        stateJson: JSON.stringify(state),
        sequence: 0
      })) !== 1
  )
    return invalid()
  return state
}
