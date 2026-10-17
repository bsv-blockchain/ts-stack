import { MerklePath } from '@bsv/sdk'
import { ReaderUint8Array } from '@bsv/sdk/primitives/ReaderUint8Array'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { toHex } from '@bsv/sdk/primitives/utils'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { StaleSyncProofError } from '../methods/SyncProofErrors'
import type { SyncProofValidationStorage } from '../methods/validateSyncProof'
import type { Brc38JsonStreamedField, Brc38JsonStreamedRow } from './Brc38JsonBinaryFields'
import { inspectBrc38RawTransactionStream } from './Brc38RawTransactionStream'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { Brc38OwnedPreparation } from './Brc38OwnedPreparation'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

export interface Brc38AuthenticatedStreamedProofPolicy {
  readonly maximumRawBytes: number
  readonly maximumChunks: number
  /** The SDK Merkle oracle is materialized only within these fixed bounds. */
  readonly maximumMerkleBytes: number
  readonly maximumDecodedMerkleBytes: number
  /** Optional original aggregate reservation shared with source/controller. */
  readonly workingAllocation?: Brc38WorkingAllocation
  readonly maximumChunkBytes?: number
  readonly maximumNetworkMilliseconds?: number
  readonly cleanupMilliseconds?: number
  readonly signal?: AbortSignal
}
/** Fresh inspection DATA only, never replacement/native/profile authority. */
export interface Brc38AuthenticatedStreamedProofInspection {
  readonly txid: string
  readonly height: number
  readonly index: number
  readonly merkleRoot: string
  readonly blockHash: string
  readonly rawBytes: number
  readonly rawSha256: string
  readonly merkleBytes: number
  readonly merkleSha256: string
}
function invalid(message: string): never {
  throw new WERR_INVALID_PARAMETER('provenTx', `a server-verified proof. ${message}`)
}
function hex(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) invalid('invalid proof identifier')
  return value.toLowerCase()
}
/** Preflight the complete SDK BUMP framing before allocating its path arrays,
 * legal-offset sets and root caches. Preserve ignored flag bits/trailing bytes
 * accepted by MerklePath.fromBinary; SDK remains the independent root oracle. */
function preflightMerkle(bytes: Uint8Array, maximum: number, check: () => void): void {
  const reader = new ReaderUint8Array(bytes)
  reader.readVarIntNumStrict(false)
  const levels = reader.readUInt8()
  if (levels < 1 || levels > 54) invalid('Merkle Path must contain between 1 and 54 levels')
  let remaining = maximum - bytes.byteLength * 2 - 4096
  for (let height = 0; height < levels; height++) {
    check()
    const count = reader.readVarIntNumStrict(false),
      charge = 1024 + 256 * levels
    if (count > Math.floor(Math.max(0, remaining) / charge))
      throw new SnapshotResourceLimitError('Streamed proof decoded Merkle policy reached')
    remaining -= count * charge
    // Native byte bound precedes a count-controlled loop, without path arrays.
    if (count > Math.floor((bytes.byteLength - reader.pos) / 2)) invalid('truncated Merkle path')
    for (let leaf = 0; leaf < count; leaf++) {
      if (leaf % 64 === 0) check()
      reader.readVarIntNumStrict(false)
      const flags = reader.readUInt8()
      if ((flags & 1) === 0) reader.readView(32)
    }
  }
}
/** Host-owned current source reads. Neither a callback nor its returned
 * descriptor/hash grants source authentication, schema or destination authority. */
export interface Brc38StreamedProofReader {
  readonly row: (table: 'provenTxs', index: number) => Promise<Brc38JsonStreamedRow | undefined>
  readonly chunks: (
    table: 'provenTxs',
    index: number,
    field: Readonly<Brc38JsonStreamedField>
  ) => AsyncIterable<Uint8Array>
}

/** Complete raw framing/hash, SDK Merkle and current active-header checks;
 * all source/network reads finish before acquiring a destination writer. The
 * actual caller must retain original source/crypto/profile/expiry owners.
 * Inspection is fresh DATA, never a cached authentication/semantic grant. */
export async function inspectBrc38StreamedProofReader(
  reader: Readonly<Brc38StreamedProofReader>,
  storage: SyncProofValidationStorage,
  index: number,
  input: Brc38AuthenticatedStreamedProofPolicy,
  expiresAt: number,
  originalDeadline = performance.now() + Math.max(0, expiresAt - Date.now())
): Promise<Readonly<Brc38AuthenticatedStreamedProofInspection>> {
  const policy = Object.freeze({
      ...input,
      workingAllocation: brc38WorkingAllocation(input.workingAllocation),
      maximumChunkBytes: input.maximumChunkBytes ?? 65536
    }),
    deadline = Math.min(originalDeadline, performance.now() + Math.max(0, expiresAt - Date.now()))
  for (const value of [
    policy.maximumRawBytes,
    policy.maximumChunks,
    policy.maximumMerkleBytes,
    policy.maximumDecodedMerkleBytes
  ])
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid streamed proof inspection policy')
  if (
    !Number.isSafeInteger(expiresAt) ||
    !Number.isFinite(deadline) ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    policy.maximumRawBytes < 10 ||
    policy.maximumMerkleBytes > 1048576 ||
    policy.maximumDecodedMerkleBytes > 16777216 ||
    !Number.isSafeInteger(policy.maximumChunkBytes) ||
    policy.maximumChunkBytes < 1 ||
    policy.maximumChunkBytes > 65536
  )
    throw new RangeError('Invalid streamed proof inspection bounds')
  for (const value of [policy.maximumNetworkMilliseconds ?? 30000, policy.cleanupMilliseconds ?? 30000])
    if (!Number.isSafeInteger(value) || value < 1 || value > 30000)
      throw new RangeError('Invalid streamed proof network bounds')
  const check = (): void => {
    policy.signal?.throwIfAborted()
    if (Date.now() >= expiresAt || performance.now() >= deadline)
      throw new SnapshotResourceLimitError('Streamed proof source expired')
  }

  check()
  const row = await reader.row('provenTxs', index)
  check()
  if (row === undefined) invalid('raw transaction and Merkle path are required')
  const rawField = row.binaries.rawTx === undefined ? undefined : Object.freeze({ ...row.binaries.rawTx }),
    merkleField = row.binaries.merklePath === undefined ? undefined : Object.freeze({ ...row.binaries.merklePath }),
    txid = hex(row.fields.txid),
    blockHash = hex(row.fields.blockHash),
    root = hex(row.fields.merkleRoot),
    height = row.fields.height,
    position = row.fields.index
  if (
    typeof height !== 'number' ||
    !Number.isSafeInteger(height) ||
    height < 0 ||
    typeof position !== 'number' ||
    !Number.isSafeInteger(position) ||
    position < 0
  )
    invalid('height and index must be non-negative safe integers')
  if (
    rawField === undefined ||
    merkleField === undefined ||
    rawField.encoding !== 'base64' ||
    merkleField.encoding !== 'base64' ||
    rawField.bytes === 0 ||
    merkleField.bytes === 0
  )
    invalid('raw transaction and Merkle path are required')
  if (merkleField.bytes > policy.maximumMerkleBytes || merkleField.bytes * 2 + 4096 > policy.maximumDecodedMerkleBytes)
    throw new SnapshotResourceLimitError('Streamed proof Merkle byte policy reached')
  async function* chunks(field: Brc38JsonStreamedField): AsyncGenerator<Uint8Array, void, void> {
    let offset = 0,
      count = 0
    for await (const bytes of reader.chunks('provenTxs', index, field)) {
      check()
      if (++count > policy.maximumChunks) throw new SnapshotResourceLimitError('Streamed proof chunk policy reached')
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength === 0 ||
        bytes.byteLength > Math.min(policy.maximumChunkBytes, field.bytes - offset)
      )
        invalid('source field changed')
      offset += bytes.byteLength
      yield bytes
    }
    check()
    if (offset !== field.bytes) invalid('source field changed')
  }
  const rawAllowance = policy.workingAllocation?.claim(4096 + 12 * policy.maximumChunkBytes)
  let raw: Awaited<ReturnType<typeof inspectBrc38RawTransactionStream>>
  try {
    raw = await inspectBrc38RawTransactionStream(chunks(rawField), {
      bytes: rawField.bytes,
      sha256: rawField.sha256,
      maximumBytes: policy.maximumRawBytes,
      maximumChunks: policy.maximumChunks,
      expiresAt,
      signal: policy.signal
    })
  } finally {
    rawAllowance?.close()
  }
  if (raw.txid !== txid) invalid('raw transaction hash does not match txid')
  const merkleAllowance = policy.workingAllocation?.claim(
    policy.maximumDecodedMerkleBytes + 4096 + 12 * policy.maximumChunkBytes
  )
  let merkle: Uint8Array | undefined,
    retained = false,
    network: Brc38OwnedPreparation | undefined
  try {
    merkle = new Uint8Array(merkleField.bytes)
    const hash = new SHA256()
    let offset = 0
    for await (const bytes of chunks(merkleField)) {
      hash.update(bytes)
      merkle.set(bytes, offset)
      offset += bytes.byteLength
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    if (offset !== merkle.byteLength || toHex(hash.digest()) !== merkleField.sha256) invalid('Merkle content changed')
    check()
    try {
      preflightMerkle(merkle, policy.maximumDecodedMerkleBytes, check)
      const proof = MerklePath.fromBinary(merkle)
      if (proof.blockHeight !== height) invalid('Merkle path height does not match the record')
      const leaf = proof.path[0]?.find(value => value.txid === true && value.hash === txid)
      if (leaf?.offset !== position) invalid('Merkle path does not contain the transaction at the recorded index')
      if (proof.computeRoot(txid) !== root) invalid('computed Merkle root does not match the record')
      check()
      network = new Brc38OwnedPreparation(
        expiresAt,
        policy.maximumNetworkMilliseconds,
        policy.cleanupMilliseconds,
        policy.signal,
        deadline
      )
      const services = storage.getServices(),
        chain = await network.run(async () => await services.getChainTracker())
      check()
      if ((await network.run(async () => await chain.isValidRootForHeight(root, height))) !== true)
        throw new StaleSyncProofError()
      check()
      const header = await network.run(async () => await services.getHeaderForHeight(height))
      check()
      if (header.length !== 80) invalid('active block header must be 80 bytes')
      const headerHash = toHex(new SHA256().update(new SHA256().update(header).digest()).digest().reverse()),
        headerRoot = toHex(header.slice(36, 68).reverse())
      if (headerHash !== blockHash || headerRoot !== root) invalid('block metadata does not match the active header')
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) throw cause
      policy.signal?.throwIfAborted()
      if (cause instanceof WERR_INVALID_PARAMETER || cause instanceof SnapshotResourceLimitError) throw cause
      invalid('transaction, Merkle path, or active header could not be validated')
    }
    // Fresh native source access after network checks rejects expiry/changed
    // authentication/source lifetime rather than returning a stale inspection.
    const current = await reader.row('provenTxs', index)
    check()
    if (
      current === undefined ||
      current.binaries.rawTx?.sha256 !== raw.sha256 ||
      current.binaries.rawTx?.bytes !== raw.bytes ||
      current.binaries.rawTx?.encoding !== 'base64' ||
      current.binaries.merklePath?.sha256 !== merkleField.sha256 ||
      current.binaries.merklePath?.bytes !== merkleField.bytes ||
      current.binaries.merklePath?.encoding !== 'base64' ||
      hex(current.fields.txid) !== txid ||
      hex(current.fields.blockHash) !== blockHash ||
      hex(current.fields.merkleRoot) !== root ||
      current.fields.height !== height ||
      current.fields.index !== position
    )
      invalid('source proof changed after chain validation')
    return Object.freeze({
      txid,
      height,
      index: position,
      merkleRoot: root,
      blockHash,
      rawBytes: raw.bytes,
      rawSha256: raw.sha256,
      merkleBytes: merkle.byteLength,
      merkleSha256: merkleField.sha256
    })
  } catch (cause) {
    if (cause instanceof Brc38StagingCleanupError) {
      retained = true
      throw new Brc38StagingCleanupError(
        [cause],
        'Streamed proof retains actual network work and original Merkle allocation',
        async () => {
          await cause.retryCleanup()
          await network?.close()
          merkle?.fill(0)
          merkle = undefined
          merkleAllowance?.close()
        }
      )
    }
    throw cause
  } finally {
    if (!retained) {
      await network?.close()
      merkle?.fill(0)
      merkleAllowance?.close()
    }
  }
}
