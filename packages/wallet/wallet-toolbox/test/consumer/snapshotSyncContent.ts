import type {
  SnapshotSyncContentPosition,
  SnapshotSyncContentRevision,
  SnapshotSyncContentReceipt,
  SyncSessionResult,
  WalletReadSnapshot
} from '@bsv/wallet-toolbox'

/** Declaration consumer: the provider still owns the actual retained source.
 * Returned comparison DATA does not renew it or authorize a later data copy. */
export async function observeRetainedSnapshotContent(
  view: WalletReadSnapshot,
  since?: SnapshotSyncContentPosition
): Promise<Readonly<SnapshotSyncContentRevision> | undefined> {
  return await view.readContentRevision?.(since)
}

/** An unchanged result names the previous durable copy, not a new copy ACK. */
export function completedSnapshotContent(result: SyncSessionResult): SnapshotSyncContentReceipt | undefined {
  return result.status === 'completed' ? result.noChangeReceipt : undefined
}
