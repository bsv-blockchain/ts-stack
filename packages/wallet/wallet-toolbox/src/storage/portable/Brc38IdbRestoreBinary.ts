import type { StorageIdb } from '../StorageIdb'
import { getPackedIdbConnection } from '../idbPackedConnection'
import { packedIdbChunkBytes } from '../idbPackedFields'
import { PackedIdbStagedField } from '../idbPackedStaging'
import { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import { brc38JsonBinaryField, type Brc38JsonStreamedField } from './Brc38JsonBinaryFields'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { Brc38StageTable } from './Brc38SemanticStage'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc38IdbRestoreBinary {
  readonly field: string
  readonly original: Readonly<Brc38JsonStreamedField>
  readonly staged: PackedIdbStagedField
  /** Actual staged-content retirement/drain before original resource release. */
  close(): Promise<void>
}
function invalid(): never {
  throw new Error('IndexedDB restore binary differs from its original source or private destination')
}

/** Actual private source -> actual isolated packed content staging, before a
 * wallet writer is opened. Source chunks may have arbitrary original bounded
 * widths; at most one fixed native packed chunk is assembled. The entire
 * original field and staged copy independently finish their hash/extent/count
 * checks. These data and stage membership grant no authentication, semantics,
 * proof validation, destination checkpoint or activation. The controller must
 * attach this genuine field through the SAME journal row transaction.
 * The small surviving descriptor reservation remains held through cleanup.
 * Browser physical allocation/eviction/pressure still requires qualification. */
export async function prepareBrc38IdbRestoreBinary(
  source: Brc38PrivateIdbStage,
  storage: StorageIdb,
  table: Brc38StageTable,
  index: number,
  field: string,
  selectedWorking: Brc38WorkingAllocation,
  expiresAt: number,
  signal?: AbortSignal
): Promise<Readonly<Brc38IdbRestoreBinary>> {
  const working = brc38WorkingAllocation(selectedWorking)
  if (
    working === undefined ||
    !brc38JsonBinaryField(table, field) ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt > source.limits.expiresAt ||
    working.maximum > source.limits.maximumRowAllocationBytes
  )
    invalid()
  const deadline = performance.now() + Math.max(0, expiresAt - Date.now()),
    check = () => {
      signal?.throwIfAborted()
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new SnapshotResourceLimitError('IndexedDB restore binary original admission expired')
    }
  check()
  // The fixed current metadata cell and small descriptor are admitted BEFORE
  // their native reads. No complete row/decoded field is loaded in this pass.
  const metadata = working.claim(8192 + 12 * source.limits.maximumRowBytes)
  let original: Readonly<Brc38JsonStreamedField>
  try {
    original = await source.binaryFieldDescriptor(table, index, field)
    check()
  } finally {
    metadata.close()
  }
  const allowance = working.claim(8192 + 12 * packedIdbChunkBytes + 3 * source.limits.maximumRowBytes)
  let staged: PackedIdbStagedField | undefined, buffer: Uint8Array | undefined
  const cleanup = async () => {
    buffer?.fill(0)
    buffer = undefined
    if (staged !== undefined) await staged.close()
    allowance.close()
  }
  try {
    check()
    const owner = getPackedIdbConnection(await storage.verifyDB())
    if (owner === undefined || !/^wallet-toolbox-(main|test)net-restore-v1-[0-9a-f]{32}$/.test(owner.database.name))
      invalid()
    check()
    staged = await storage.beginPackedStorageField({
      kind: 'array',
      bytes: original.bytes,
      sha256: original.sha256,
      lifetimeMs: Math.min(3600000, Math.max(1, expiresAt - Date.now())),
      expiresAt,
      signal
    })
    check()
    buffer = new Uint8Array(packedIdbChunkBytes)
    let filled = 0,
      offset = 0
    for await (const bytes of source.readBinaryFieldChunks(table, index, original)) {
      try {
        check()
        let consumed = 0
        while (consumed < bytes.byteLength) {
          const count = Math.min(buffer.byteLength - filled, bytes.byteLength - consumed)
          buffer.set(bytes.subarray(consumed, consumed + count), filled)
          filled += count
          consumed += count
          if (filled === buffer.byteLength) {
            await staged.append(offset, buffer)
            check()
            offset += filled
            filled = 0
            buffer.fill(0)
          }
        }
      } finally {
        bytes.fill(0)
      }
    }
    check()
    if (filled !== 0) {
      await staged.append(offset, buffer.subarray(0, filled))
      check()
      offset += filled
    }
    if (offset !== original.bytes) invalid()
    const descriptor = await staged.finish()
    check()
    if (descriptor.kind !== 'array' || descriptor.bytes !== original.bytes || descriptor.sha256 !== original.sha256)
      invalid()
    buffer.fill(0)
    buffer = undefined
    allowance.resize(4096)
    return Object.freeze({ field, original, staged, close: cleanup })
  } catch (cause) {
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'IndexedDB binary transfer retains its actual stage cleanup and original allocation',
        cleanup
      )
    }
    throw cause
  }
}
