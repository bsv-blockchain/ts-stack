import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { requireBrc38PackedRead } from './Brc38NativePackedSchemaNode'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'

function invalid(): never {
  throw new Error('Packed native bounded hash window differs from its current owned content')
}

/** Actual retained-view hashing without transferring a whole physical chunk
 * to JavaScript. SQLite's internal buffers require separate native admission.
 * Namespace and SHA select DATA only; actual native read ownership is checked
 * around every query. The caller verifies the exact family/version schema and
 * before/after version metadata. Every complete chunk hash and the whole-field
 * hash are recomputed; a previous match never supplies the verdict. */
export async function hashBrc38NativePackedChunkWindows(
  k: Knex.Transaction,
  table: 'brc38_native_binary_chunks' | 'brc38_native_text_chunks',
  sha256: string,
  bytes: number,
  maximumReadBytes: number,
  check: () => void,
  selectedWorkingAllocation?: Brc38WorkingAllocation
): Promise<Readonly<{ sha256: string; chunks: number }>> {
  requireBrc38PackedRead(k)
  if (
    !['brc38_native_binary_chunks', 'brc38_native_text_chunks'].includes(table) ||
    typeof sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > 1000000000 ||
    !Number.isSafeInteger(maximumReadBytes) ||
    maximumReadBytes < 1 ||
    maximumReadBytes > 65536
  )
    invalid()
  const working = brc38WorkingAllocation(selectedWorkingAllocation)
  const result = createHash('sha256')
  let offset = 0,
    chunks = 0
  while (offset < bytes) {
    check()
    requireBrc38PackedRead(k)
    const extent = (await k(table)
      .where({ sha256, offset })
      .first('bytes', 'chunkSha256', k.raw('typeof(payload) AS kind,length(payload) AS actualBytes'))) as
      { bytes: number; actualBytes: number; chunkSha256: string; kind: string } | undefined
    if (
      extent === undefined ||
      !Number.isSafeInteger(extent.bytes) ||
      extent.bytes < 1 ||
      extent.bytes > Math.min(65536, bytes - offset) ||
      extent.actualBytes !== extent.bytes ||
      extent.kind !== 'blob' ||
      typeof extent.chunkSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(extent.chunkSha256)
    )
      invalid()
    const chunkHash = createHash('sha256')
    for (let within = 0; within < extent.bytes;) {
      check()
      requireBrc38PackedRead(k)
      const amount = Math.min(maximumReadBytes, extent.bytes - within),
        scratch = working?.claim(2048 + 4 * amount)
      let owned: Uint8Array | undefined, row: { payload: Uint8Array } | undefined
      try {
        row = (await k(table)
          .where({ sha256, offset })
          .first(k.raw('substr(payload,?,?) AS payload', [within + 1, amount]))) as { payload: Uint8Array } | undefined
        if (row === undefined) invalid()
        check()
        requireBrc38PackedRead(k)
        owned = detachBrc38PrivateChunk(row.payload, amount)
        if (owned.byteLength !== amount) invalid()
        chunkHash.update(owned)
        result.update(owned)
        within += amount
      } finally {
        owned?.fill(0)
        if (row?.payload instanceof Uint8Array) Reflect.apply(Uint8Array.prototype.fill, row.payload, [0])
        scratch?.close()
      }
      check()
      requireBrc38PackedRead(k)
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    if (chunkHash.digest('hex') !== extent.chunkSha256) invalid()
    offset += extent.bytes
    chunks++
  }
  check()
  requireBrc38PackedRead(k)
  return Object.freeze({ sha256: result.digest('hex'), chunks })
}
