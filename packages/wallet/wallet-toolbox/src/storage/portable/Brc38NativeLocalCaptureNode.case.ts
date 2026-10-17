import type { StorageKnex } from '../StorageKnex'
import type { Brc38DestinationSelection } from './Brc38KnexDestinationFence'
import { captureBrc38KnexDestinationFence } from './Brc38KnexDestinationFence'
import {
  beginBrc38NativeLocalCapture,
  bootstrapBrc38NativeLocalCapturePage,
  type Brc38NativeLocalCapturePolicy
} from './Brc38NativeLocalCaptureNode'
import type { SnapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import { readSnapshotJournalSqliteGeneration } from '../snapshot/journal/SnapshotJournalSqliteGeneration'
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Actual native local capture source-migration case failed')
}
/** UNRUN. Fresh actual enrolled published native wallet with independently
 * populated <=128 operational rows, all29 schema, original receipt policy,
 * WAL/busy0/migration-owner and finite resources. No mock source/owner or schema
 * verdict can supply this operation. Live-receipt refusal uses a separate real
 * fixture so a intentionally rejected actor does not poison this happy path. */
export async function verifyBrc38NativeLocalCaptureInstallation(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  policy: Brc38NativeLocalCapturePolicy,
  check: () => void
): Promise<void> {
  const working = policy.workingAllocation.used,
    before = await captureBrc38KnexDestinationFence(storage, selection, receiptPolicy),
    original = await readSnapshotJournalSqliteGeneration(storage.knex, receiptPolicy)
  check()
  let state = await beginBrc38NativeLocalCapture(storage, selection, receiptPolicy, policy)
  requireCase(!state.complete && state.enabled && state.revision === '0' && state.maximumRows === policy.maximumRows)
  const after = await captureBrc38KnexDestinationFence(storage, selection, receiptPolicy),
    current = await readSnapshotJournalSqliteGeneration(storage.knex, receiptPolicy)
  requireCase(
    after.userId === before.userId &&
      after.activeStorage === before.activeStorage &&
      after.primaryEpoch === before.primaryEpoch &&
      after.revision === before.revision &&
      current.source !== original.source &&
      current.epoch !== original.epoch &&
      current.enabled &&
      current.complete
  )
  requireCase(
    JSON.stringify(await beginBrc38NativeLocalCapture(storage, selection, receiptPolicy, policy)) ===
      JSON.stringify(state)
  )
  for (let pages = 0; !state.complete && pages < 160; pages++) {
    check()
    state = await bootstrapBrc38NativeLocalCapturePage(storage, selection, receiptPolicy, policy)
  }
  requireCase(state.complete && state.enabled && policy.workingAllocation.used === working)
  let refused = false
  try {
    await beginBrc38NativeLocalCapture(storage, selection, receiptPolicy, {
      ...policy,
      maximumRows: policy.maximumRows + 1
    })
  } catch {
    refused = true
  }
  requireCase(refused && policy.workingAllocation.used === working)
  check()
}

/** Fixture retains an actual unexpired snapshot journal capture receipt under
 * the real original schema. Additive local observers must refuse without
 * changing either schema or epoch; the fixture owns cleanup separately. */
export async function verifyBrc38NativeLocalCaptureLiveReceiptRefusal(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  policy: Brc38NativeLocalCapturePolicy,
  check: () => void
): Promise<void> {
  const before = await readSnapshotJournalSqliteGeneration(storage.knex, receiptPolicy)
  let refused = false
  try {
    await beginBrc38NativeLocalCapture(storage, selection, receiptPolicy, policy)
  } catch {
    refused = true
  }
  requireCase(
    refused &&
      JSON.stringify(await readSnapshotJournalSqliteGeneration(storage.knex, receiptPolicy)) ===
        JSON.stringify(before) &&
      !(await storage.knex.schema.hasTable('brc38_local_baseline_clock'))
  )
  check()
}
