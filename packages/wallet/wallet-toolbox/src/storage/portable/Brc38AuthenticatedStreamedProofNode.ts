import type { SyncProofValidationStorage } from '../methods/validateSyncProof'
import type { KnexBrc38StagingStore, Brc38AuthenticatedStreamedImportReader } from './KnexBrc38StagingStore'
import type { Brc38JsonStreamedField } from './Brc38JsonBinaryFields'
import {
  inspectBrc38StreamedProofReader,
  type Brc38StreamedProofReader,
  type Brc38AuthenticatedStreamedProofPolicy,
  type Brc38AuthenticatedStreamedProofInspection
} from './Brc38StreamedProof'
export type {
  Brc38AuthenticatedStreamedProofPolicy,
  Brc38AuthenticatedStreamedProofInspection
} from './Brc38StreamedProof'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'

/** Complete original active-chain proof checks with raw framing/hash streamed
 * under the real authenticated private owner. Network checks occur before any
 * destination writer. No source/chain/schema verdict is persisted or reused.
 * An oversized Merkle path refuses explicitly; it is never partially validated. */
export async function inspectBrc38AuthenticatedStreamedProof(
  store: KnexBrc38StagingStore,
  storage: SyncProofValidationStorage,
  index: number,
  input: Brc38AuthenticatedStreamedProofPolicy
): Promise<Readonly<Brc38AuthenticatedStreamedProofInspection>> {
  const policy = Object.freeze({
    maximumRawBytes: input.maximumRawBytes,
    maximumChunks: input.maximumChunks,
    maximumMerkleBytes: input.maximumMerkleBytes,
    maximumDecodedMerkleBytes: input.maximumDecodedMerkleBytes,
    signal: input.signal,
    workingAllocation: input.workingAllocation,
    maximumChunkBytes: input.maximumChunkBytes,
    maximumNetworkMilliseconds: input.maximumNetworkMilliseconds,
    cleanupMilliseconds: input.cleanupMilliseconds
  })
  for (const value of [
    policy.maximumRawBytes,
    policy.maximumChunks,
    policy.maximumMerkleBytes,
    policy.maximumDecodedMerkleBytes
  ])
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid streamed proof inspection policy')
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    policy.maximumRawBytes < 10 ||
    policy.maximumMerkleBytes > 1048576 ||
    policy.maximumDecodedMerkleBytes > 16777216
  )
    throw new RangeError('Invalid streamed proof inspection bounds')
  const expiresAt = store.limits.expiresAt,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  const check = (): void => {
    policy.signal?.throwIfAborted()
    if (Date.now() >= expiresAt || performance.now() >= deadline)
      throw new SnapshotResourceLimitError('Streamed proof source expired')
  }
  check()
  const result = await store.withAuthenticatedStreamedImportRead(
    async (_json, _metadata, reader) =>
      await inspectBrc38AuthenticatedStreamedProofReader(reader, storage, index, policy, expiresAt, deadline)
  )
  check()
  return result
}

/** Actual native reader adapter. Preserve current scoped row/chunk checks;
 * all portable inspection results remain DATA and grant no native effects. */
export async function inspectBrc38AuthenticatedStreamedProofReader(
  reader: Readonly<Brc38AuthenticatedStreamedImportReader>,
  storage: SyncProofValidationStorage,
  index: number,
  input: Brc38AuthenticatedStreamedProofPolicy,
  expiresAt: number,
  originalDeadline = performance.now() + Math.max(0, expiresAt - Date.now())
): Promise<Readonly<Brc38AuthenticatedStreamedProofInspection>> {
  const signal = input.signal
  const adapted: Brc38StreamedProofReader = Object.freeze({
    row: (table: 'provenTxs', position: number) => reader.row(table, position),
    chunks: async function* (table: 'provenTxs', position: number, selected: Readonly<Brc38JsonStreamedField>) {
      const field = Object.freeze({ ...selected })
      for (let offset = 0; offset < field.bytes;) {
        signal?.throwIfAborted()
        const actual = await reader.chunk(table, position, field.field, offset)
        if (
          actual === undefined ||
          actual.offset !== offset ||
          actual.descriptor.bytes !== field.bytes ||
          actual.descriptor.sha256 !== field.sha256 ||
          actual.bytes.byteLength === 0 ||
          actual.bytes.byteLength > Math.min(65536, field.bytes - offset)
        )
          throw new WERR_INVALID_PARAMETER('provenTx', 'a server-verified proof. source field changed')
        offset += actual.bytes.byteLength
        yield actual.bytes
      }
    }
  })
  return await inspectBrc38StreamedProofReader(adapted, storage, index, input, expiresAt, originalDeadline)
}
