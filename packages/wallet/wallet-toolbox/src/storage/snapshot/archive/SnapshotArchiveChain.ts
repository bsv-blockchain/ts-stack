/** Version-one archive peers bind the literal network; TTN is never relabelled
 * as testnet. Other networks remain unavailable until their archive path is qualified. */
export type SnapshotArchiveChain = 'main' | 'test' | 'ttn'

export function isSnapshotArchiveChain(chain: unknown): chain is SnapshotArchiveChain {
  return chain === 'main' || chain === 'test' || chain === 'ttn'
}
