import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import { ownedNativeRootIdentity } from '../../schema/ownedNativeSqliteConnectionsNode'
import { knex as createKnex, type Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  prepareSnapshotJournalCaptureBackend,
  prepareSnapshotJournalSqliteWriter,
  bindSnapshotJournalDestinationBackend,
  closeSnapshotJournalCapturePool
} from './SnapshotJournalCaptureBackend'
import { SnapshotJournalConnectionCleanupError } from './SnapshotJournalConnections'

const activeWriters = new WeakMap<Knex, { root: Knex; backend: string }>()
/** Live CODE-issued actual writer only. A copied transaction, configured path,
 * backend string or persisted row cannot acquire this operation-scoped grant. */
export function requireSnapshotJournalOwnedWriter(trx: Knex, root: Knex, backend: string): void {
  const actual = activeWriters.get(trx)
  if (!trx.isTransaction || actual?.root !== root || actual.backend !== backend)
    throw new WERR_INVALID_OPERATION('Actual current journal writer operation required')
}
/** Inspect an already admitted operation; this cannot register a transaction. */
export function currentSnapshotJournalOwnedWriter(trx: Knex): Readonly<{ root: Knex; backend: string }> {
  const actual = activeWriters.get(trx)
  if (actual === undefined) throw new WERR_INVALID_OPERATION('Actual current journal writer operation required')
  requireSnapshotJournalOwnedWriter(trx, actual.root, actual.backend)
  return Object.freeze({ ...actual })
}
/** Propagate only through a real child created by the actual parent's Knex
 * transaction API. There is deliberately no API to enroll a supplied child. */
export async function withSnapshotJournalOwnedSavepoint<T>(
  parent: Knex,
  operation: (child: Knex) => Promise<T>
): Promise<T> {
  const actual = activeWriters.get(parent)
  if (actual !== undefined) requireSnapshotJournalOwnedWriter(parent, actual.root, actual.backend)
  return await parent.transaction(async child => {
    if (actual !== undefined) {
      requireSnapshotJournalOwnedWriter(parent, actual.root, actual.backend)
      if (!child.isTransaction) throw new WERR_INVALID_OPERATION('Actual child journal transaction required')
      activeWriters.set(child, actual)
    }
    try {
      return await operation(child)
    } finally {
      activeWriters.delete(child)
    }
  })
}

/** One fresh native writer per admitted bounded destination operation. SQLite
 * file identity is observed before opening, and the ACTUAL native connection is
 * checked before and after its transaction. No old pooled handle or configured
 * pathname establishes inode continuity. The owner must retain queue admission
 * until this function has awaited physical pool/socket closure.
 */
export async function withSnapshotJournalOwnedWriter<T>(
  input: Knex.Config,
  assertActive: () => void,
  apply: (trx: Knex, backend: string) => Promise<T>,
  expectedBackend?: string,
  actualNativeRoot?: Knex
): Promise<T> {
  assertActive()
  const expected = await prepareSnapshotJournalCaptureBackend(input, actualNativeRoot)
  assertActive()
  const connectionConfig = input.connection as object
  const config: Knex.Config = {
    ...input,
    connection: Object.create(
      Object.getPrototypeOf(connectionConfig),
      Object.getOwnPropertyDescriptors(connectionConfig)
    ),
    pool: { ...input.pool, min: 0, max: 1 },
    acquireConnectionTimeout: Math.min(input.acquireConnectionTimeout ?? 5000, 5000)
  }
  const borrowed = actualNativeRoot !== undefined && isOwnedNativeSqlite(actualNativeRoot)
  if (borrowed && ownedNativeRootIdentity(actualNativeRoot!)?.slot !== 0)
    throw new WERR_INVALID_OPERATION('Journal destination requires the actual native writer')
  const k = borrowed ? actualNativeRoot! : createKnex(config)
  let connection: unknown
  let trx: Knex.Transaction | undefined
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    connection = await k.client.acquireConnection()
    assertActive()
    if (expected.kind === 'sqlite') await prepareSnapshotJournalSqliteWriter(k, connection)
    else {
      await k.raw('SET SESSION innodb_lock_wait_timeout=1').connection(connection)
      await k.raw('SET SESSION lock_wait_timeout=1').connection(connection)
    }
    const backend = await bindSnapshotJournalDestinationBackend(k, connection, expected)
    if (expectedBackend !== undefined && backend !== expectedBackend)
      throw new WERR_INVALID_OPERATION('Destination physical backend changed before journal write')
    trx = await k.transaction({ connection })
    void trx.executionPromise.catch(() => undefined)
    assertActive()
    if (actualNativeRoot !== undefined) activeWriters.set(trx, { root: actualNativeRoot, backend })
    let value: T
    try {
      value = await apply(trx, backend)
    } finally {
      activeWriters.delete(trx)
    }
    assertActive()
    if ((await bindSnapshotJournalDestinationBackend(k, connection, expected)) !== backend)
      throw new WERR_INVALID_OPERATION('Destination physical backend changed during journal write')
    await trx.commit()
    await trx.executionPromise
    outcome = { ok: true, value }
  } catch (error) {
    outcome = { ok: false, error }
    if (trx !== undefined && !trx.isCompleted()) {
      const rollback = await Promise.allSettled([trx.rollback(), trx.executionPromise])
      const failed = rollback.filter(value => value.status === 'rejected')
      if (failed.length) {
        const failure = new AggregateError(
          [error, ...failed.map(value => value.reason)],
          'Journal transaction rollback did not settle'
        )
        outcome = { ok: false, error: borrowed ? new SnapshotJournalConnectionCleanupError(failure) : failure }
      }
    }
  }
  try {
    if (borrowed) {
      if (connection !== undefined) await k.client.releaseConnection(connection)
    } else if (connection === undefined) await k.destroy()
    else await closeSnapshotJournalCapturePool(k, connection)
  } catch (error) {
    throw new SnapshotJournalConnectionCleanupError(
      new AggregateError(
        [...(outcome.ok ? [] : [outcome.error]), error],
        'Journal destination native writer did not drain'
      )
    )
  }
  if (!outcome.ok) throw outcome.error
  return outcome.value
}
