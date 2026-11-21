import { utf16CodeUnitAt } from '../../utility/utf16CodeUnitAt'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import type { StorageIdb } from '../StorageIdb'
import { getPackedIdbConnection, type PackedIdbConnection } from '../idbPackedConnection'
import type { PackedIdbStagedField } from '../idbPackedStaging'
import type { Brc38WorkingAllocation } from '../portable/Brc38WorkingAllocation'
import { brc38Utf16Chunks } from '../portable/Brc38Utf16Chunks'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import type { PreparedPackedIdbSnapshotField } from './preparePackedIdbSnapshotField'

/** Measure and replay actual provisional JSON output to one issued stage.
 * Both complete passes use the same original source/index owners. Persisted
 * finish hashes independently. This never installs rows or authorizes them. */
export async function stageIdbSnapshotSyncText(
  storage: StorageIdb,
  working: Brc38WorkingAllocation,
  expiresAt: number,
  check: () => void,
  measure: () => AsyncIterable<Uint8Array>,
  replay: () => AsyncIterable<Uint8Array>,
  signal?: AbortSignal
): Promise<PreparedPackedIdbSnapshotField> {
  return await stage(
    storage,
    working,
    expiresAt,
    check,
    () => brc38Utf16Chunks(measure(), 1000000000, working, signal),
    () => brc38Utf16Chunks(replay(), 1000000000, working, signal),
    signal
  )
}

/** Inline metadata is already detached immutable string DATA. Preserve its
 * original UTF-16 code units (including unpaired surrogates) in fixed windows. */
export async function stageIdbSnapshotSyncInlineText(
  storage: StorageIdb,
  value: string,
  working: Brc38WorkingAllocation,
  expiresAt: number,
  check: () => void,
  signal?: AbortSignal
): Promise<PreparedPackedIdbSnapshotField> {
  if (typeof value !== 'string' || value.length > 131072)
    throw new Error('Inline request metadata exceeds its original field-page bound')
  const chunks = async function* (): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < value.length;) {
      check()
      const count = Math.min(32768, value.length - offset),
        bytes = new Uint8Array(count * 2)
      for (let index = 0; index < count; index++) {
        const unit = utf16CodeUnitAt(value, offset + index)
        bytes[index * 2] = unit & 255
        bytes[index * 2 + 1] = unit >>> 8
      }
      try {
        yield Promise.resolve(bytes)
        check()
        offset += count
      } finally {
        bytes.fill(0)
      }
    }
  }
  return await stage(storage, working, expiresAt, check, chunks, chunks, signal)
}
async function stage(
  storage: StorageIdb,
  working: Brc38WorkingAllocation,
  expiresAt: number,
  check: () => void,
  measure: () => AsyncIterable<Uint8Array>,
  replay: () => AsyncIterable<Uint8Array>,
  signal?: AbortSignal
): Promise<PreparedPackedIdbSnapshotField> {
  const allowance = working.claim(16384 + 12 * 65536)
  let staged: PackedIdbStagedField | undefined,
    owner: PackedIdbConnection | undefined,
    closed = false,
    closing: Promise<void> | undefined
  const native = (): void => {
      if (
        owner !== undefined &&
        (!owner.isOpen ||
          storage.db !== owner.database ||
          storage.dbName !== owner.database.name ||
          getPackedIdbConnection(owner.database) !== owner)
      )
        throw new Error('Request text stage original issuer changed')
    },
    fresh = (): void => {
      signal?.throwIfAborted()
      check()
      native()
      if (closed) throw new Error('Request text stage closed')
    },
    cleanup = async (): Promise<void> => {
      closed = true
      if (staged !== undefined) {
        native()
        await staged.close()
      }
      allowance.close()
    }
  try {
    fresh()
    owner = getPackedIdbConnection(await storage.verifyDB())
    if (owner === undefined) throw new Error('Request text stage needs the actual packed provider')
    fresh()
    const first = new SHA256()
    let bytes = 0
    for await (const chunk of measure()) {
      try {
        fresh()
        if (
          !(chunk instanceof Uint8Array) ||
          chunk.length < 1 ||
          chunk.length > 65536 ||
          chunk.length % 2 !== 0 ||
          chunk.length > 1000000000 - bytes
        )
          throw new Error('Request text measurement exceeds its original UTF-16 window')
        first.update(chunk)
        bytes += chunk.length
      } finally {
        if (chunk instanceof Uint8Array) chunk.fill(0)
      }
    }
    fresh()
    const sha256 = first.digestHex()
    staged = await storage.beginPackedStorageField({
      kind: 'utf16',
      bytes,
      sha256,
      expiresAt,
      lifetimeMs: Math.min(3600000, Math.max(1, expiresAt - Date.now())),
      signal
    })
    fresh()
    const second = new SHA256()
    let written = 0
    for await (const chunk of replay()) {
      try {
        fresh()
        if (!(chunk instanceof Uint8Array) || chunk.length !== Math.min(65536, bytes - written) || chunk.length < 1)
          throw new Error('Request text replay differs from measured windows')
        second.update(chunk)
        await staged.append(written, chunk)
        written += chunk.length
        fresh()
      } finally {
        if (chunk instanceof Uint8Array) chunk.fill(0)
      }
    }
    if (written !== bytes || second.digestHex() !== sha256)
      throw new Error('Request text replay differs from complete measured content')
    const actual = await staged.finish()
    fresh()
    if (actual.kind !== 'utf16' || actual.bytes !== bytes || actual.sha256 !== sha256)
      throw new Error('Request text persisted stage differs')
    // Both generators and all write windows have drained. The issued content
    // remains owned, but no transfer scratch stays charged through final apply.
    allowance.resize(4096)
    return Object.freeze({
      staged,
      close: async () => {
        if (closing !== undefined) return await closing
        closing = cleanup()
        try {
          await closing
        } catch (cause) {
          closing = undefined
          throw cause
        }
      }
    })
  } catch (cause) {
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Request text retains its actual stage and original allocation',
        cleanup
      )
    }
    throw cause
  }
}
