import {
  hasBrc38NativeIncomingIdReservationSchema,
  installBrc38NativeIncomingIdReservationSchema
} from './Brc38NativeIncomingIdReservationSchemaNode'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import {
  brc38DestinationSelection,
  withBrc38KnexImportDestination,
  type Brc38DestinationSelection
} from './Brc38KnexDestinationFence'
import { requireBrc38NativeProfileTransaction } from './Brc38PublishedProfileNode'
import { ownedNativeRootIdentity } from '../schema/ownedNativeSqliteConnectionsNode'
import { lockSnapshotJournalMaintenanceOwner } from '../snapshot/journal/SnapshotJournalMaintenanceFence'
import { migrateSnapshotJournalSqliteSourceAddition } from '../snapshot/journal/SnapshotJournalSqliteGeneration'
import {
  snapshotJournalReceiptPolicy,
  type SnapshotJournalReceiptPolicy
} from '../snapshot/journal/SnapshotJournalReceipt'
import { snapshotJournalRevision, type SnapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import {
  hasBrc38NativeLocalBaselineGenerationSchema,
  installBrc38NativeLocalBaselineGeneration,
  copyBrc38NativeLocalBaselineBootstrapPage,
  readBrc38NativeLocalBaselineGeneration,
  beginBrc38NativeLocalBaselineEpochRecovery,
  retireBrc38NativeLocalBaselineEpochPage,
  activateBrc38NativeLocalBaselineRecoveredEpoch,
  type Brc38NativeLocalBaselineGeneration
} from './Brc38NativeLocalBaselineGenerationNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'

export interface Brc38NativeLocalCapturePolicy {
  readonly maximumRows: number
  readonly ceiling: SnapshotJournalRevision
  readonly maximumPageRows: number
  readonly expiresAt: number
  readonly workingAllocation: Brc38WorkingAllocation
  readonly signal?: AbortSignal
}
function invalid(): never {
  throw new Error(
    'Native local capture differs from its actual source/profile/schema owner and original finite admission'
  )
}
function capturePolicy(selected: Brc38NativeLocalCapturePolicy): Readonly<Brc38NativeLocalCapturePolicy> {
  const policy = Object.freeze({
    maximumRows: selected.maximumRows,
    ceiling: snapshotJournalRevision(selected.ceiling),
    maximumPageRows: selected.maximumPageRows,
    expiresAt: selected.expiresAt,
    workingAllocation: brc38WorkingAllocation(selected.workingAllocation),
    signal: selected.signal
  })
  if (
    policy.workingAllocation === undefined ||
    !Number.isSafeInteger(policy.maximumRows) ||
    policy.maximumRows < 1 ||
    policy.maximumRows > 10000000 ||
    policy.ceiling === '0' ||
    !Number.isSafeInteger(policy.maximumPageRows) ||
    policy.maximumPageRows < 1 ||
    policy.maximumPageRows > 128 ||
    !Number.isSafeInteger(policy.expiresAt) ||
    policy.expiresAt <= Date.now()
  )
    invalid()
  return Object.freeze({ ...policy, workingAllocation: policy.workingAllocation })
}
/** One actual bounded maintenance writer on the enrolled published native
 * source. A fresh source/profile/primary fence is read before and after work.
 * Schema/epoch markers and policy objects never grant a source capability. */
async function withCaptureWriter<T>(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  selected: Brc38NativeLocalCapturePolicy,
  work: (trx: Knex.Transaction, check: () => void) => Promise<T>
): Promise<T> {
  const policy = capturePolicy(selected),
    destination = brc38DestinationSelection(selection),
    retention = Object.freeze({ ...snapshotJournalReceiptPolicy(receiptPolicy) }),
    deadline = performance.now() + Math.max(0, policy.expiresAt - Date.now()),
    charge = policy.workingAllocation.claim(2097152)
  const check = (): void => {
    policy.signal?.throwIfAborted()
    if (Date.now() >= policy.expiresAt || performance.now() >= deadline) invalid()
  }
  if (destination.mode !== 'merge') {
    charge.close()
    invalid()
  }
  try {
    check()
    return await withBrc38KnexImportDestination(storage, destination, retention, async (trx, read) => {
      const owned = (): void => {
        check()
        requireBrc38NativeProfileTransaction(trx)
        if (ownedNativeRootIdentity(trx)?.slot !== 0 || trx.isCompleted()) invalid()
      }
      owned()
      await lockSnapshotJournalMaintenanceOwner(trx, storage.knex.client.config.migrations)
      const before = await read()
      if (before.userId === null) invalid()
      const result = await work(trx, owned),
        after = await read()
      if (
        before.backendSha256 !== after.backendSha256 ||
        before.userId !== after.userId ||
        before.identityKey !== after.identityKey ||
        before.chain !== after.chain ||
        before.targetStorageIdentityKey !== after.targetStorageIdentityKey ||
        before.activeStorage !== after.activeStorage ||
        before.primaryEpoch !== after.primaryEpoch ||
        before.revision !== after.revision
      )
        invalid()
      owned()
      return result
    })
  } finally {
    charge.close()
  }
}
function original(state: Readonly<Brc38NativeLocalBaselineGeneration>, policy: Brc38NativeLocalCapturePolicy): void {
  if (state.maximumRows !== policy.maximumRows || state.ceiling !== snapshotJournalRevision(policy.ceiling)) invalid()
}
/** Explicit installation only. The existing snapshot source-addition migration
 * preserves its own definitions and refuses live capture receipts before the
 * new all29 observers change the source schema and mint its fresh epoch.
 * Ordinary source reads do not install observers, DDL or generations. */
export async function beginBrc38NativeLocalCapture(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  selected: Brc38NativeLocalCapturePolicy
): Promise<Readonly<Brc38NativeLocalBaselineGeneration>> {
  const policy = capturePolicy(selected)
  return await withCaptureWriter(storage, selection, receiptPolicy, policy, async (trx, check) => {
    const local = await hasBrc38NativeLocalBaselineGenerationSchema(trx),
      reservations = await hasBrc38NativeIncomingIdReservationSchema(trx)
    if (!local || !reservations)
      await migrateSnapshotJournalSqliteSourceAddition(
        trx,
        async () => {
          check()
          if (!local) await installBrc38NativeLocalBaselineGeneration(trx, policy)
          original(await readBrc38NativeLocalBaselineGeneration(trx), policy)
          if (!reservations) await installBrc38NativeIncomingIdReservationSchema(trx, policy.maximumRows)
          check()
        },
        storage.knex.client.config.migrations
      )
    const state = await readBrc38NativeLocalBaselineGeneration(trx)
    original(state, policy)
    check()
    return state
  })
}
export async function bootstrapBrc38NativeLocalCapturePage(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  selected: Brc38NativeLocalCapturePolicy
): Promise<Readonly<Brc38NativeLocalBaselineGeneration>> {
  const policy = capturePolicy(selected)
  return await withCaptureWriter(storage, selection, receiptPolicy, policy, async (trx, check) => {
    original(await readBrc38NativeLocalBaselineGeneration(trx), policy)
    check()
    const state = await copyBrc38NativeLocalBaselineBootstrapPage(trx, policy.maximumPageRows)
    original(state, policy)
    check()
    return state
  })
}
/** Explicit bounded recovery episode. Expected disabled epoch and immutable
 * next capacity/ceiling are replay DATA checked against the actual old epoch;
 * no existing candidate/source actor survives the new local epoch. */
export async function beginBrc38NativeLocalCaptureRecovery(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  selected: Brc38NativeLocalCapturePolicy,
  expectedEpoch: string
): Promise<void> {
  const policy = capturePolicy(selected),
    epoch = expectedEpoch
  await withCaptureWriter(storage, selection, receiptPolicy, policy, async (trx, check) => {
    check()
    await beginBrc38NativeLocalBaselineEpochRecovery(trx, {
      expectedEpoch: epoch,
      maximumRows: policy.maximumRows,
      ceiling: policy.ceiling
    })
    check()
  })
}
export async function retireBrc38NativeLocalCapturePage(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  selected: Brc38NativeLocalCapturePolicy,
  expectedEpoch: string
): Promise<Readonly<{ remaining: number; ready: boolean; newEpoch: string }>> {
  const policy = capturePolicy(selected),
    epoch = expectedEpoch
  return await withCaptureWriter(storage, selection, receiptPolicy, policy, async (trx, check) => {
    check()
    const progress = await retireBrc38NativeLocalBaselineEpochPage(trx, epoch, policy.maximumPageRows)
    check()
    return progress
  })
}
export async function activateBrc38NativeLocalCaptureRecovery(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  selected: Brc38NativeLocalCapturePolicy,
  expectedEpoch: string
): Promise<Readonly<Brc38NativeLocalBaselineGeneration>> {
  const policy = capturePolicy(selected),
    epoch = expectedEpoch
  return await withCaptureWriter(storage, selection, receiptPolicy, policy, async (trx, check) => {
    check()
    const state = await activateBrc38NativeLocalBaselineRecoveredEpoch(trx, epoch)
    original(state, policy)
    check()
    return state
  })
}
