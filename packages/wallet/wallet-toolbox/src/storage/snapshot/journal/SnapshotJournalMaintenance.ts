import { knex as createKnex, type Knex } from 'knex'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import { createOwnedNativeReadDatabase, ownedNativeRootIdentity } from '../../schema/ownedNativeSqliteConnectionsNode'
import { hasBrc38NativePackedSchema } from '../../portable/Brc38NativePackedSchemaNode'
import { collectBrc38NativePackedContent } from '../../portable/Brc38NativePackedTextFieldsNode'
import { WERR_INVALID_OPERATION, WERR_NOT_IMPLEMENTED } from '../../../sdk/WERR_errors'
import {
  advanceSnapshotJournalFloor,
  retainSnapshotJournalEvents,
  snapshotJournalReceiptPolicy,
  type SnapshotJournalReceiptPolicy
} from './SnapshotJournalReceipt'
import {
  collectSnapshotJournalTombstones,
  snapshotJournalCollectionRequest,
  type SnapshotJournalCollectionRequest
} from './SnapshotJournalCollection'
import { snapshotJournalRevision, type SnapshotJournalRevision } from './SnapshotJournalRevision'
import { readSnapshotJournalSqliteGeneration } from './SnapshotJournalSqliteGeneration'
import { readSnapshotJournalMysqlGeneration } from './SnapshotJournalMysqlGeneration'
import { withSnapshotJournalConnections, SnapshotJournalConnectionCleanupError } from './SnapshotJournalConnections'
import {
  prepareSnapshotJournalCaptureBackend,
  prepareSnapshotJournalSqliteWriter,
  bindSnapshotJournalCaptureBackend,
  closeSnapshotJournalCapturePool
} from './SnapshotJournalCaptureBackend'
import { lockSnapshotJournalMaintenanceOwner } from './SnapshotJournalMaintenanceFence'
import {
  runSnapshotJournalMaintenanceTask,
  type SnapshotJournalMaintenanceOptions,
  type SnapshotJournalMaintenanceTask
} from './SnapshotJournalMaintenanceTask'

type Operation =
  | { kind: 'floor'; floor: SnapshotJournalRevision }
  | { kind: 'collect'; page: SnapshotJournalCollectionRequest }
  | { kind: 'retention'; events: SnapshotJournalRevision }
export interface SnapshotJournalMaintenanceRequest {
  epoch: string
  ceiling: SnapshotJournalRevision
  receiptPolicy: SnapshotJournalReceiptPolicy
  operation: Operation
}
export type SnapshotJournalMaintenanceResult =
  | { kind: 'retention'; value: Awaited<ReturnType<typeof retainSnapshotJournalEvents>> }
  | {
      kind: 'floor'
      value: Awaited<ReturnType<typeof advanceSnapshotJournalFloor>>
    }
  | {
      kind: 'collect'
      value: Awaited<ReturnType<typeof collectSnapshotJournalTombstones>>
    }

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Snapshot journal maintenance generation is unavailable or changed')
}
function request(input: SnapshotJournalMaintenanceRequest): SnapshotJournalMaintenanceRequest {
  const epoch = input.epoch,
    ceiling = snapshotJournalRevision(input.ceiling),
    receiptPolicy = snapshotJournalReceiptPolicy(input.receiptPolicy)
  if (
    typeof epoch !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(epoch) ||
    ceiling === '0'
  )
    return invalid()
  const operation = input.operation
  if (operation.kind === 'floor')
    return {
      epoch,
      ceiling,
      receiptPolicy,
      operation: {
        kind: 'floor',
        floor: snapshotJournalRevision(operation.floor)
      }
    }
  if (operation.kind === 'retention')
    return {
      epoch,
      ceiling,
      receiptPolicy,
      operation: { kind: 'retention', events: snapshotJournalRevision(operation.events) }
    }
  if (operation.kind !== 'collect') return invalid()
  const page = snapshotJournalCollectionRequest(operation.page)
  if (page.epoch !== epoch) return invalid()
  return {
    epoch,
    ceiling,
    receiptPolicy,
    operation: { kind: 'collect', page }
  }
}
function ownedConfig(config: Knex.Config): Knex.Config {
  const connection = config.connection as object
  return {
    ...config,
    connection: Object.create(Object.getPrototypeOf(connection), Object.getOwnPropertyDescriptors(connection)),
    pool: { ...config.pool, min: 0, max: 1 },
    acquireConnectionTimeout: Math.min(config.acquireConnectionTimeout ?? 5000, 5000)
  }
}
async function operation(k: Knex, input: SnapshotJournalMaintenanceRequest): Promise<SnapshotJournalMaintenanceResult> {
  if (input.operation.kind === 'retention')
    return { kind: 'retention', value: await retainSnapshotJournalEvents(k, input.operation.events) }
  if (input.operation.kind === 'floor')
    return {
      kind: 'floor',
      value: await advanceSnapshotJournalFloor(k, input.operation.floor)
    }
  return {
    kind: 'collect',
    value: await collectSnapshotJournalTombstones(k, input.operation.page)
  }
}

/** One global, bounded internal maintenance operation on a complete owned generation.
 * No source rows or physical files are removed. Cancellation rejects the result
 * promptly; closed owns all native cleanup and determines provider admission.
 * Raw operator DDL is outside the configured Knex migration-owner contract.
 * This neither registers a journal nor advertises an incremental capability.
 */
export function maintainSnapshotJournal(
  resolveConfig: () => Promise<Knex.Config | undefined>,
  input: SnapshotJournalMaintenanceRequest,
  options: SnapshotJournalMaintenanceOptions = {},
  actualNativeRoot?: Knex
): SnapshotJournalMaintenanceTask<SnapshotJournalMaintenanceResult> {
  const detached = request(input)
  return runSnapshotJournalMaintenanceTask(async assertActive => {
    let writer: Knex | undefined,
      verifier: Knex | undefined,
      result: SnapshotJournalMaintenanceResult | undefined,
      borrowedWriter = false
    let failure: { error: unknown } | undefined
    try {
      const config = await resolveConfig()
      assertActive()
      if (config === undefined)
        throw new WERR_NOT_IMPLEMENTED('Snapshot journal maintenance requires file-backed SQLite WAL or static MySQL')
      const expected = await prepareSnapshotJournalCaptureBackend(config, actualNativeRoot)
      assertActive()
      if (actualNativeRoot !== undefined && isOwnedNativeSqlite(actualNativeRoot)) {
        if (actualNativeRoot.isTransaction || ownedNativeRootIdentity(actualNativeRoot)?.slot !== 0) return invalid()
        writer = actualNativeRoot
        borrowedWriter = true
        verifier = createOwnedNativeReadDatabase(writer)
      } else {
        writer = createKnex(ownedConfig(config))
        verifier = createKnex(ownedConfig(config))
      }
      result = await withSnapshotJournalConnections(
        writer,
        verifier,
        assertActive,
        async (write, read) => {
          await bindSnapshotJournalCaptureBackend(writer!, write, verifier!, read, expected)
          assertActive()
          if (expected.kind === 'sqlite') await prepareSnapshotJournalSqliteWriter(writer!, write)
          const trx = await writer!.transaction({ connection: write })
          let operationFailure: { error: unknown } | undefined
          let value: SnapshotJournalMaintenanceResult | undefined
          void trx.executionPromise.catch(() => undefined)
          try {
            assertActive()
            await lockSnapshotJournalMaintenanceOwner(trx, config.migrations)
            assertActive()
            const generation =
              expected.kind === 'sqlite'
                ? await readSnapshotJournalSqliteGeneration(trx, detached.receiptPolicy, config.migrations)
                : await readSnapshotJournalMysqlGeneration(
                    trx,
                    detached.ceiling,
                    detached.receiptPolicy,
                    config.migrations
                  )
            if (!generation.complete || generation.epoch !== detached.epoch || generation.ceiling !== detached.ceiling)
              return invalid()
            assertActive()
            value = await operation(trx, detached)
            // A source-owned generation collection page also advances one
            // indexed packed-content retirement page, under the same current
            // writer. It never scans every retained version or removes bytes
            // still referenced by a current field.
            if (
              detached.operation.kind === 'collect' &&
              isOwnedNativeSqlite(trx) &&
              (await hasBrc38NativePackedSchema(trx))
            ) {
              assertActive()
              await collectBrc38NativePackedContent(trx, 256, options.signal)
            }
            assertActive()
            await trx.commit()
            await trx.executionPromise
          } catch (error) {
            operationFailure = { error }
          }
          if (!trx.isCompleted()) {
            try {
              await trx.rollback()
              await trx.executionPromise
            } catch (error) {
              throw new SnapshotJournalConnectionCleanupError(
                new AggregateError(
                  [...(operationFailure === undefined ? [] : [operationFailure.error]), error],
                  'Snapshot journal maintenance transaction did not drain'
                )
              )
            }
          }
          if (operationFailure !== undefined) throw operationFailure.error
          return value
        },
        async (owner, connection) => {
          if (borrowedWriter && owner === writer) await owner.client.releaseConnection(connection)
          else await closeSnapshotJournalCapturePool(owner, connection)
        }
      )
    } catch (error) {
      failure = { error }
    }
    const settled = await Promise.allSettled([borrowedWriter ? undefined : writer?.destroy(), verifier?.destroy()])
    const failed = settled.filter(value => value.status === 'rejected')
    if (failed.length)
      throw new SnapshotJournalConnectionCleanupError(
        new AggregateError(
          [...(failure === undefined ? [] : [failure.error]), ...failed.map(value => value.reason)],
          'Snapshot journal maintenance owned pools did not close'
        )
      )
    if (failure !== undefined) throw failure.error
    if (result === undefined) return invalid()
    return result
  }, options)
}
