import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { StorageKnex } from '../StorageKnex'
import type { Brc38DestinationSelection } from './Brc38KnexDestinationFence'
import type { SnapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import type { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { reserveBrc38NativeIncomingIds, brc38NativeIncomingIdTables } from './Brc38NativeIncomingIdReservationNode'

interface ActualController {
  readonly storage: StorageKnex
  readonly selection: Brc38DestinationSelection
  readonly receiptPolicy: SnapshotJournalReceiptPolicy
  readonly store: KnexBrc38StagingStore
  readonly working: Brc38WorkingAllocation
  /** Independently read actual counters; no range result or metadata hash. */
  readCounters(): Promise<Readonly<Record<string, number>>>
  /** Normal real foreground inserts return their actual AUTOINCREMENT IDs. */
  insertForegroundRows(): Promise<Readonly<Record<string, number>>>
  changePrimaryAwayAndBack(): Promise<void>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Independent incoming ID reservation case differs')
}
/** UNRUN genuine enrolled published source + authenticated private archive.
 * Fixture has independently authored effective four-episode reservation counts (including the operational sync-state row), a deleted high ID and
 * existing rows in every numeric family. Reservations retry without changing
 * floors; actual ordinary foreground inserts remain outside reserved space. */
export async function verifyBrc38NativeIncomingIdReservations(
  controller: ActualController,
  reservedCounts: Readonly<Record<(typeof brc38NativeIncomingIdTables)[number], number>>
): Promise<void> {
  const used = controller.working.used,
    before = await controller.readCounters()
  requireCase(
    brc38NativeIncomingIdTables.every(
      table =>
        Number.isSafeInteger(before[table]) &&
        before[table] >= 0 &&
        Number.isSafeInteger(reservedCounts[table]) &&
        reservedCounts[table] >= 1 &&
        reservedCounts[table] <= 128
    )
  )
  const reserve = async () =>
    await reserveBrc38NativeIncomingIds(
      controller.storage,
      controller.selection,
      controller.receiptPolicy,
      controller.store,
      { workingAllocation: controller.working }
    )
  const first = await reserve(),
    after = await controller.readCounters()
  requireCase(first.ranges.length === 10)
  for (const range of first.ranges)
    requireCase(
      range.first === before[range.table] + 1 &&
        range.count === reservedCounts[range.table] &&
        after[range.table] === range.first + range.count - 1
    )
  controller.check()
  const replay = await reserve(),
    replayCounters = await controller.readCounters()
  requireCase(
    JSON.stringify(replay) === JSON.stringify(first) && JSON.stringify(replayCounters) === JSON.stringify(after)
  )
  const foreground = await controller.insertForegroundRows()
  for (const range of first.ranges) requireCase(foreground[range.table] > range.first + range.count - 1)
  requireCase(JSON.stringify(await reserve()) === JSON.stringify(first) && controller.working.used === used)
  await controller.changePrimaryAwayAndBack()
  let refused = false
  try {
    await reserve()
  } catch {
    refused = true
  }
  requireCase(refused && controller.working.used === used)
}
