import { mapAwaitFromSync } from '../../utility/promiseFromSync'
import { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import {
  inspectBrc38StreamedProofReader,
  type Brc38StreamedProofReader,
  type Brc38AuthenticatedStreamedProofPolicy,
  type Brc38AuthenticatedStreamedProofInspection
} from './Brc38StreamedProof'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { SyncProofValidationStorage } from '../methods/validateSyncProof'
import type { Brc38JsonStreamedField } from './Brc38JsonBinaryFields'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

export interface Brc38IdbStreamedProofPolicy extends Omit<
  Brc38AuthenticatedStreamedProofPolicy,
  'workingAllocation' | 'maximumChunkBytes'
> {
  readonly workingAllocation: Brc38WorkingAllocation
}

/** Fresh current chain proof preparation using actual private browser reads.
 * No source/chain/schema verdict is persisted or reused. The enclosing source
 * owner must independently complete encrypted authentication/semantic replay;
 * this inspection grants no row effects, checkpoint, replacement or activation.
 * All source reads and network checks precede a destination writer. Original
 * resource reservations cover retained rows, native source metadata, transfer
 * windows and bounded SDK Merkle materialization through actual disposal. */
export async function inspectBrc38PrivateIdbStreamedProof(
  source: Brc38PrivateIdbStage,
  storage: SyncProofValidationStorage,
  index: number,
  selected: Brc38IdbStreamedProofPolicy,
  expiresAt = source.limits.expiresAt
): Promise<Readonly<Brc38AuthenticatedStreamedProofInspection>> {
  const working = brc38WorkingAllocation(selected.workingAllocation),
    policy = Object.freeze({
      maximumRawBytes: selected.maximumRawBytes,
      maximumChunks: selected.maximumChunks,
      maximumMerkleBytes: selected.maximumMerkleBytes,
      maximumDecodedMerkleBytes: selected.maximumDecodedMerkleBytes,
      maximumNetworkMilliseconds: selected.maximumNetworkMilliseconds,
      cleanupMilliseconds: selected.cleanupMilliseconds,
      workingAllocation: working,
      maximumChunkBytes: Math.min(65536, Math.floor((source.limits.maximumRowAllocationBytes - 4096) / 32)),
      signal: selected.signal
    }),
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    working === undefined ||
    working.maximum > source.limits.maximumRowAllocationBytes ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt > source.limits.expiresAt
  )
    throw new RangeError('Browser proof requires its original source lifetime and shared allocation')
  const check = () => {
      policy.signal?.throwIfAborted()
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new SnapshotResourceLimitError('Browser proof original source expired')
    },
    rows: Array<Awaited<ReturnType<Brc38PrivateIdbStage['ownedStreamedRow']>>> = []
  const reader: Brc38StreamedProofReader = Object.freeze({
    row: async (table: 'provenTxs', position: number) => {
      check()
      const owned = await source.ownedStreamedRow(table, position, working)
      rows.push(owned)
      check()
      return owned.row
    },
    chunks: async function* (table: 'provenTxs', position: number, field: Readonly<Brc38JsonStreamedField>) {
      check()
      const native = working.claim(8192 + 3 * source.limits.maximumRowBytes)
      try {
        for await (const bytes of source.readBinaryFieldChunks(table, position, field)) {
          try {
            check()
            yield bytes
            check()
          } finally {
            bytes.fill(0)
          }
        }
        check()
      } finally {
        native.close()
      }
    }
  })
  let retained = false
  const release = () => {
    for (const owned of rows) owned.close()
    rows.length = 0
  }
  try {
    check()
    return await inspectBrc38StreamedProofReader(reader, storage, index, policy, expiresAt, deadline)
  } catch (cause) {
    if (cause instanceof Brc38StagingCleanupError) {
      retained = true
      throw new Brc38StagingCleanupError(
        [cause],
        'Browser proof retains its original source-row allocation through actual network drainage',
        () =>
          mapAwaitFromSync(
            () => cause.retryCleanup(),
            () => {
              release()
            }
          )
      )
    }
    throw cause
  } finally {
    if (!retained) release()
  }
}
