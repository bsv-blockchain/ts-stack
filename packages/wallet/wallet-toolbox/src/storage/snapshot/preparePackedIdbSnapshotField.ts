import { SHA256 } from '@bsv/sdk/primitives/Hash'
import type { StorageIdb } from '../StorageIdb'
import { getPackedIdbConnection, type PackedIdbConnection } from '../idbPackedConnection'
import { packedIdbChunkBytes } from '../idbPackedFields'
import type { PackedIdbStagedField } from '../idbPackedStaging'
import { brc38Utf16Chunks } from '../portable/Brc38Utf16Chunks'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from '../portable/Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import type {
  WalletReadSnapshot,
  WalletSnapshotCursor,
  WalletSnapshotFieldDescriptor,
  WalletSnapshotTable
} from './WalletReadSnapshot'

export interface PackedIdbSnapshotFieldPolicy {
  readonly workingAllocation: Brc38WorkingAllocation
  readonly maximumFieldBytes: number
  readonly maximumReadBytes: number
  readonly expiresAt: number
  readonly signal?: AbortSignal
}
export interface PreparedPackedIdbSnapshotField {
  readonly staged: PackedIdbStagedField
  /** Actual staged-content retirement/drain before resource release. */
  close(): Promise<void>
}
function invalid(): never {
  throw new Error('Snapshot field differs from its original retained source or packed destination')
}

/** One source field, two bounded passes, one genuine destination content stage.
 * Complete source bytes are independently hashed before allocating a stage;
 * its actual persisted chunks independently hash at finish. UTF8 is streamed
 * into UTF16LE for browser text. No complete field/string or page queue is
 * retained. This component does not authenticate a source, decide merge policy,
 * install a row/checkpoint or activate a profile. The enclosing destination
 * must attach this actual stage in its final currently fenced writer. */
export async function preparePackedIdbSnapshotField(
  storage: StorageIdb,
  source: WalletReadSnapshot,
  table: WalletSnapshotTable,
  selectedCursor: WalletSnapshotCursor,
  field: string,
  selectedDescriptor: Readonly<WalletSnapshotFieldDescriptor>,
  selectedPolicy: PackedIdbSnapshotFieldPolicy
): Promise<Readonly<PreparedPackedIdbSnapshotField>> {
  const policy = Object.freeze({ ...selectedPolicy }),
    working = brc38WorkingAllocation(policy.workingAllocation),
    reader = source.fieldReader
  if (
    working === undefined ||
    reader === undefined ||
    typeof field !== 'string' ||
    field.length < 1 ||
    field.length > 128 ||
    selectedCursor.version !== 1 ||
    selectedCursor.snapshotId !== source.snapshotId ||
    selectedCursor.table !== table ||
    selectedCursor.archivePosition !== undefined ||
    !Array.isArray(selectedCursor.after) ||
    selectedCursor.after.length < 1 ||
    selectedCursor.after.length > 3 ||
    selectedCursor.after.some(value =>
      typeof value === 'number'
        ? !Number.isSafeInteger(value) || value < 1
        : typeof value !== 'string' || value.length < 1 || value.length > 4096
    ) ||
    !['binary', 'utf8', 'utf16le'].includes(selectedDescriptor.kind) ||
    !Number.isSafeInteger(selectedDescriptor.bytes) ||
    selectedDescriptor.bytes < 0 ||
    selectedDescriptor.bytes > policy.maximumFieldBytes ||
    (selectedDescriptor.kind === 'utf16le' && selectedDescriptor.bytes % 2 !== 0) ||
    (selectedDescriptor.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(selectedDescriptor.sha256)) ||
    !Number.isSafeInteger(policy.maximumFieldBytes) ||
    policy.maximumFieldBytes < 0 ||
    policy.maximumFieldBytes > 1000000000 ||
    !Number.isSafeInteger(policy.maximumReadBytes) ||
    policy.maximumReadBytes < 64 ||
    policy.maximumReadBytes > 65536 ||
    !Number.isSafeInteger(policy.expiresAt) ||
    policy.expiresAt > source.expiresAt
  )
    invalid()
  // Reserve before copying source coordinates or creating transfer buffers.
  // The transcoder separately reserves its simultaneous decoder/output space
  // against this SAME original resource owner. This is allocation, not RSS.
  const allowance = working.claim(16384 + 12 * packedIdbChunkBytes + 4 * policy.maximumReadBytes),
    cursor: WalletSnapshotCursor = {
      version: 1,
      snapshotId: selectedCursor.snapshotId,
      table,
      after: [...selectedCursor.after]
    },
    descriptor = Object.freeze({
      kind: selectedDescriptor.kind,
      bytes: selectedDescriptor.bytes,
      ...(selectedDescriptor.sha256 === undefined ? {} : { sha256: selectedDescriptor.sha256 })
    }),
    monotonicDeadline = performance.now() + Math.max(0, policy.expiresAt - Date.now())
  let staged: PackedIdbStagedField | undefined,
    buffer: Uint8Array | undefined,
    closed = false,
    closing: Promise<void> | undefined
  let owner: PackedIdbConnection | undefined
  const check = () => {
    policy.signal?.throwIfAborted()
    if (closed || !source.isOpen || Date.now() >= policy.expiresAt || performance.now() >= monotonicDeadline)
      throw new SnapshotResourceLimitError('Snapshot field original source/resource admission ended')
    if (
      owner !== undefined &&
      (storage.db === undefined ||
        getPackedIdbConnection(storage.db) !== owner ||
        !owner.isOpen ||
        storage.dbName !== owner.database.name)
    )
      invalid()
  }
  const cleanup = (): Promise<void> => {
    if (closing !== undefined) return closing
    closed = true
    closing = (async () => {
      buffer?.fill(0)
      buffer = undefined
      if (staged !== undefined) await staged.close()
      allowance.close()
    })()
    void closing.catch(() => {
      closing = undefined
    })
    return closing
  }
  const raw = async function* (hash: SHA256): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < descriptor.bytes;) {
      check()
      const length = Math.min(policy.maximumReadBytes, descriptor.bytes - offset),
        bytes = await reader.readFieldExtent(table, cursor, field, offset, length, descriptor)
      try {
        check()
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) invalid()
        hash.update(bytes)
        offset += length
        yield bytes
      } finally {
        if (bytes instanceof Uint8Array) bytes.fill(0)
      }
    }
    // An empty cell still requires an actual coordinate/current-value read.
    if (descriptor.bytes === 0) {
      check()
      const bytes = await reader.readFieldExtent(table, cursor, field, 0, 0, descriptor)
      try {
        check()
        if (!(bytes instanceof Uint8Array) || bytes.length !== 0) invalid()
      } finally {
        if (bytes instanceof Uint8Array) bytes.fill(0)
      }
    }
    check()
  }
  const encoded = (hash: SHA256): AsyncIterable<Uint8Array> =>
    descriptor.kind === 'utf8'
      ? brc38Utf16Chunks(raw(hash), policy.maximumFieldBytes, working, policy.signal)
      : raw(hash)
  try {
    check()
    owner = getPackedIdbConnection(await storage.verifyDB())
    if (owner === undefined || !owner.isOpen) invalid()
    check()
    const original = new SHA256(),
      target = new SHA256()
    let bytes = 0
    for await (const chunk of encoded(original)) {
      try {
        check()
        bytes += chunk.length
        if (bytes > policy.maximumFieldBytes)
          throw new SnapshotResourceLimitError('Snapshot staged field exceeds its original byte ceiling')
        target.update(chunk)
      } finally {
        chunk.fill(0)
      }
    }
    const originalSha = original.digestHex(),
      sha256 = target.digestHex()
    if (descriptor.sha256 !== undefined && descriptor.sha256 !== originalSha) invalid()
    staged = await storage.beginPackedStorageField({
      kind: descriptor.kind === 'binary' ? 'typed' : 'utf16',
      bytes,
      sha256,
      expiresAt: policy.expiresAt,
      lifetimeMs: Math.min(3600000, Math.max(1, policy.expiresAt - Date.now())),
      signal: policy.signal
    })
    check()
    buffer = new Uint8Array(packedIdbChunkBytes)
    const replayHash = new SHA256()
    let filled = 0,
      offset = 0
    for await (const chunk of encoded(replayHash)) {
      try {
        check()
        for (let used = 0; used < chunk.length;) {
          const count = Math.min(buffer.length - filled, chunk.length - used)
          buffer.set(chunk.subarray(used, used + count), filled)
          used += count
          filled += count
          if (filled === buffer.length) {
            await staged.append(offset, buffer)
            check()
            offset += filled
            filled = 0
            buffer.fill(0)
          }
        }
      } finally {
        chunk.fill(0)
      }
    }
    if (filled !== 0) {
      await staged.append(offset, buffer.subarray(0, filled))
      check()
      offset += filled
    }
    if (offset !== bytes || replayHash.digestHex() !== originalSha) invalid()
    const actual = await staged.finish()
    check()
    if (
      actual.bytes !== bytes ||
      actual.sha256 !== sha256 ||
      actual.kind !== (descriptor.kind === 'binary' ? 'typed' : 'utf16')
    )
      invalid()
    buffer.fill(0)
    buffer = undefined
    allowance.resize(4096)
    return Object.freeze({ staged, close: cleanup })
  } catch (cause) {
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Snapshot field retains its original content stage and working allocation until drainage',
        cleanup
      )
    }
    throw cause
  }
}
