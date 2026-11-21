import type { Knex } from 'knex'
import type { StorageKnex } from './StorageKnex'
import { WERR_INVALID_OPERATION, WERR_NOT_ACTIVE, WERR_UNAUTHORIZED } from '../sdk/WERR_errors'
import { canonicalPrimaryHandoffPlan } from './PrimaryHandoffPlan'
import {
  PRIMARY_HANDOFF_KEY,
  PRIMARY_HANDOFF_MIGRATION,
  PRIMARY_HANDOFF_TABLE,
  verifyPrimaryHandoffSchema
} from './schema/primaryHandoffMigration'
import { snapshotJournalRevision } from './snapshot/journal/SnapshotJournalRevision'

// Positive existence only: future reads MUST still use the actual table. A
// dropped/changed table cannot become a legacy fallback. Never cache absence,
// profile state, a schema verdict, financial permission or an actual writer.
const requiredTables = new WeakSet<object>()
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Actual primary handoff admission is incomplete or changed')
}
async function hasTable(storage: StorageKnex, k: Knex): Promise<boolean> {
  const root = storage.knex
  if (requiredTables.has(root)) return true
  if (await k.schema.hasTable(PRIMARY_HANDOFF_TABLE)) {
    requiredTables.add(root)
    return true
  }
  // PostgreSQL records this migration as a supported no-op. Only an actual
  // absent table takes that legacy path; present/previously observed controls
  // still require their full verification and cannot downgrade by dialect.
  if (k.client.dialect === 'postgresql') return false
  const migrations = root.client.config.migrations?.tableName ?? 'knex_migrations'
  if (await k.schema.hasTable(migrations)) {
    if ((await k(migrations).where('name', PRIMARY_HANDOFF_MIGRATION).select('name').limit(1)).length) invalid()
  }
  if (storage.knex !== root) invalid()
  return false
}
export async function hasKnexPrimaryEnrollment(storage: StorageKnex): Promise<boolean> {
  if (!(await hasTable(storage, storage.knex))) return false
  return (
    (await storage.knex(PRIMARY_HANDOFF_TABLE).where('sourceKey', PRIMARY_HANDOFF_KEY).select('userId').limit(1))
      .length > 0
  )
}
const fields = {
  operationId: 32,
  localStorageIdentityKey: 130,
  targetStorageIdentityKey: 130,
  side: 6,
  phase: 16,
  sourceEpoch: 19,
  localEpoch: 19,
  plan: 8192,
  roleGateFrom: 130,
  roleGateTo: 130,
  roleGateEpoch: 19
} as const
async function row(storage: StorageKnex, k: Knex, userId: number): Promise<Record<string, unknown> | undefined> {
  if (!(await hasTable(storage, k))) return undefined
  const query = k(PRIMARY_HANDOFF_TABLE)
    .where({ userId, sourceKey: PRIMARY_HANDOFF_KEY })
    .select(
      'version',
      ...Object.entries(fields).map(([key, bound]) => k.raw('substr(??,1,?) AS ??', [key, bound + 1, key]))
    )
    .limit(2)
  // A caller may already own an older MySQL read view. This is current locked
  // control state, after the actual user lock, never that stale read snapshot.
  if (k.isTransaction && String(k.client.config.client).includes('mysql')) query.forUpdate()
  const rows: Array<Record<string, unknown>> = await query
  if (rows.length > 1) invalid()
  return rows[0]
}
async function validate(
  storage: StorageKnex,
  k: Knex,
  value: Record<string, unknown>,
  epoch: string,
  active: string | null
): Promise<void> {
  await verifyPrimaryHandoffSchema(k)
  const local = storage.getSettings().storageIdentityKey
  if (
    value.version !== 1 ||
    value.localStorageIdentityKey !== local ||
    value.localEpoch !== epoch ||
    typeof value.operationId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(value.operationId) ||
    typeof value.targetStorageIdentityKey !== 'string' ||
    !value.targetStorageIdentityKey ||
    value.targetStorageIdentityKey.length > 130 ||
    value.roleGateFrom !== null ||
    value.roleGateTo !== null ||
    value.roleGateEpoch !== null
  )
    invalid()
  if (value.side === 'source') {
    const original = snapshotJournalRevision(value.sourceEpoch)
    if (
      value.plan !== null &&
      parsePlan(value).sources.find(source => source.storageIdentityKey === local)?.epoch !== original
    )
      invalid()
    if (value.targetStorageIdentityKey === local) invalid()
    if (value.phase === 'prepared' || value.phase === 'cancelled') {
      if (active !== local || original !== epoch) invalid()
    } else if (value.phase === 'retired' || value.phase === 'complete') {
      if (active !== value.targetStorageIdentityKey || BigInt(epoch) !== BigInt(original) + 1n) invalid()
      if (parsePlan(value).sources.find(source => source.storageIdentityKey === local)?.epoch !== original) invalid()
    } else invalid()
  } else if (value.side === 'target') {
    if (value.sourceEpoch !== null || value.targetStorageIdentityKey !== local) invalid()
    const plan = parsePlan(value)
    if (value.phase === 'prepared' || value.phase === 'cancelled') {
      if (!plan.sources.some(source => source.storageIdentityKey === active)) invalid()
    } else if (value.phase === 'activated' || value.phase === 'complete') {
      if (active !== local) invalid()
    } else invalid()
  } else if (value.side === 'backup') {
    if (
      value.phase !== 'complete' ||
      value.sourceEpoch !== null ||
      value.targetStorageIdentityKey === local ||
      active !== value.targetStorageIdentityKey
    )
      invalid()
    parsePlan(value)
  } else invalid()
}
function parsePlan(value: Record<string, unknown>) {
  if (typeof value.plan !== 'string' || value.plan.length > 8192) return invalid()
  let plan
  try {
    plan = canonicalPrimaryHandoffPlan(JSON.parse(value.plan))
  } catch {
    return invalid()
  }
  if (
    JSON.stringify(plan) !== value.plan ||
    plan.operationId !== value.operationId ||
    plan.targetStorageIdentityKey !== value.targetStorageIdentityKey
  )
    invalid()
  return plan
}
/** Restricts an existing actual financial writer. It creates no actor, scope,
 * grant, SQL connection or financial acknowledgement from comparison DATA. */
export async function assertKnexPrimaryOrdinaryWrite(
  storage: StorageKnex,
  k: Knex,
  userId: number,
  epoch: string,
  active: string | null
): Promise<void> {
  const value = await row(storage, k, userId)
  if (value === undefined) return
  await validate(storage, k, value, epoch, active)
  if (!(
    (value.side === 'source' && (value.phase === 'prepared' || value.phase === 'cancelled')) ||
    (value.side === 'target' && (value.phase === 'activated' || value.phase === 'complete'))
  ))
    throw new WERR_NOT_ACTIVE('Enrolled profile is not an active primary writer')
}
async function lockUser(
  storage: StorageKnex,
  k: Knex.Transaction,
  partial: { identityKey: string } | { userId: number }
) {
  if (!k.isTransaction || k.isCompleted() || storage.toDb(k) !== k) invalid()
  const mysql = String(k.client.config.client).includes('mysql')
  if (!mysql) {
    if (
      (await k('users')
        .where(partial)
        .update({ userId: k.ref('userId') })) !== 1
    )
      throw new WERR_UNAUTHORIZED()
  }
  const query = k('users')
    .where(partial)
    .select(
      'userId',
      k.raw('substr(??,1,131) AS ??', ['identityKey', 'identityKey']),
      k.raw('substr(??,1,131) AS ??', ['activeStorage', 'activeStorage'])
    )
    .limit(2)
  if (mysql) query.forUpdate()
  const users: Array<{ userId: number; identityKey: string; activeStorage: string | null }> = await query
  if (users.length !== 1 || !Number.isSafeInteger(users[0].userId) || users[0].userId < 1) throw new WERR_UNAUTHORIZED()
  return users[0]
}
/** Call before proof/entity reads or effects in the original destination SQL
 * scope. Retirement then serializes with EVERY participating DATA commit. */
export async function assertKnexPrimaryDataWrite(
  storage: StorageKnex,
  k: Knex.Transaction,
  identityKey: string,
  sourceStorageIdentityKey?: string
): Promise<void> {
  const original = storage.knex,
    user = await lockUser(storage, k, { identityKey })
  if (!(await hasTable(storage, k))) return
  const mysql = String(k.client.config.client).includes('mysql')
  const epochQuery = k('snapshot_sync_primary_epochs')
    .where({ userId: user.userId })
    .select(k.raw(mysql ? 'CAST(epoch AS CHAR) AS epoch' : 'CAST(epoch AS TEXT) AS epoch'))
    .limit(2)
  if (mysql) epochQuery.forUpdate()
  const epochs: Array<{ epoch: string }> = await epochQuery
  if (epochs.length > 1) invalid()
  const value = await row(storage, k, user.userId)
  if (value === undefined) return
  if (value.phase === 'retired')
    throw new WERR_NOT_ACTIVE('Incoming wallet DATA is deferred while its actual source retires')
  await validate(storage, k, value, snapshotJournalRevision(epochs[0]?.epoch ?? '0'), user.activeStorage)
  if (
    (value.side === 'target' &&
      value.phase === 'prepared' &&
      !parsePlan(value).sources.some(source => source.storageIdentityKey === sourceStorageIdentityKey)) ||
    (value.side === 'target' && value.phase === 'cancelled') ||
    ((value.side === 'source' || value.side === 'backup') &&
      value.phase === 'complete' &&
      value.targetStorageIdentityKey !== sourceStorageIdentityKey)
  )
    throw new WERR_NOT_ACTIVE('Pending target only accepts its declared primary-copy sources')
  if (storage.knex !== original) invalid()
}
/** DATA replication cannot select an enrolled primary. Explicit authenticated
 * control and the real database transition gate retain that responsibility. */
export async function primarySelectionFromKnexSync(
  storage: StorageKnex,
  k: Knex.Transaction,
  userId: number,
  proposed: string
): Promise<string> {
  const user = await lockUser(storage, k, { userId })
  const value = await row(storage, k, userId)
  if (value === undefined) return proposed
  if (value.phase === 'retired') throw new WERR_NOT_ACTIVE('Retired primary cannot accept wallet DATA')
  const mysql = String(k.client.config.client).includes('mysql')
  const query = k('snapshot_sync_primary_epochs')
    .where({ userId })
    .select(k.raw(mysql ? 'CAST(epoch AS CHAR) AS epoch' : 'CAST(epoch AS TEXT) AS epoch'))
    .limit(2)
  if (mysql) query.forUpdate()
  const epochs: Array<{ epoch: string }> = await query
  if (epochs.length > 1) invalid()
  await validate(storage, k, value, snapshotJournalRevision(epochs[0]?.epoch ?? '0'), user.activeStorage)
  if (typeof user.activeStorage !== 'string' || !user.activeStorage || user.activeStorage.length > 130) invalid()
  return user.activeStorage
}

/** Negative check inside the ORIGINAL BRC-38 destination writer, after its
 * actual SQLite write reservation. The existing restore kernel still owns all
 * financial/source permission and original preview/epoch comparisons. Read-only
 * preview and journal observation do not call this guard. */
export async function assertKnexPrimaryRestoreWrite(
  storage: StorageKnex,
  k: Knex.Transaction,
  identityKey: string
): Promise<void> {
  if (!k.isTransaction || k.isCompleted() || storage.toDb(k) !== k) invalid()
  if (!(await hasTable(storage, k))) return
  const users: Array<{ userId: number; activeStorage: string | null }> = await k('users')
    .where({ identityKey })
    .select('userId', k.raw('substr(??,1,131) AS ??', ['activeStorage', 'activeStorage']))
    .limit(2)
  if (users.length > 1) invalid()
  if (users.length === 0) return // A genuine fresh restore has no enrolled profile.
  const user = users[0],
    value = await row(storage, k, user.userId)
  if (value === undefined) return
  const epochs: Array<{ epoch: string }> = await k('snapshot_sync_primary_epochs')
    .where({ userId: user.userId })
    .select(k.raw('CAST(epoch AS TEXT) AS epoch'))
    .limit(2)
  if (epochs.length > 1) invalid()
  await validate(storage, k, value, snapshotJournalRevision(epochs[0]?.epoch ?? '0'), user.activeStorage)
  if ((value.side === 'source' && value.phase === 'retired') || (value.side === 'target' && value.phase === 'prepared'))
    throw new WERR_NOT_ACTIVE('Restore financial writes defer while primary cutover is pending')
}
