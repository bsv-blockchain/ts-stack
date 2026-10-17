import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { readBrc38SqlBinaryDescriptors, readBrc38SqlBinaryWindow } from './Brc38SqlBinaryStaging'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'

/** Coordinates in actual retained source/stage DATA. These are not issued
 * readers, producers, proof verdicts or grants to activate a candidate. */
export type Brc38PrivateProofOriginalField =
  | Readonly<{ origin: 'local'; sourceRowId: number; bytes: number }>
  | Readonly<{ origin: 'incoming'; sourcePosition: number; bytes: number }>
function invalid(): never {
  throw new Error('Private proof original field differs from its actual coherent source or authenticated stage')
}
function extent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 1000000000) invalid()
  return value
}
/** Compare original proof selections without consulting the final candidate.
 * This is necessary to reconstruct alias-by-alias changes: a later alias can
 * replace an earlier imported field before final inventory. Local row leases
 * open and drain serially, avoiding a nested lease on the same source actor.
 * Equal descriptors never substitute for complete byte equality. */
export async function equalBrc38PrivateProofOriginalFields(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  k: Knex.Transaction,
  selected: Readonly<{
    field: 'rawTx' | 'merklePath'
    left: Brc38PrivateProofOriginalField
    right: Brc38PrivateProofOriginalField
    maximumReadBytes: number
    workingAllocation: Brc38WorkingAllocation
    signal?: AbortSignal
  }>
): Promise<boolean> {
  const working = brc38WorkingAllocation(selected.workingAllocation),
    binding = store.binding,
    left = Object.freeze({ ...selected.left }),
    right = Object.freeze({ ...selected.right }),
    field = selected.field,
    width = selected.maximumReadBytes,
    signal = selected.signal,
    expiresAt = store.limits.expiresAt,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    working === undefined ||
    binding === undefined ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > 16384 ||
    !['rawTx', 'merklePath'].includes(field)
  )
    invalid()
  const frame = working.claim(1048576),
    check = (): void => {
      signal?.throwIfAborted()
      if (store.binding !== binding || Date.now() >= expiresAt || performance.now() >= deadline) invalid()
      store.assertPrivateNativeReadTransaction(k)
      Brc38NativeLocalBaselineSource.assertSharedWorking(source, working)
    }
  try {
    check()
    await verifyBrc38AuthenticatedSourceSeal(k)
    const metadata = async (ref: Brc38PrivateProofOriginalField): Promise<string | undefined> => {
        extent(ref.bytes)
        if (ref.origin === 'local') {
          if (!Number.isSafeInteger(ref.sourceRowId)) invalid()
          await Brc38NativeLocalBaselineSource.withOwnedRow(source, 'proven_txs', ref.sourceRowId, async row => {
            check()
            const value = row.fields.find(value => value.field === field)
            if (value?.kind !== 'blob' || value.bytes !== ref.bytes) invalid()
          })
          return undefined
        }
        if (!Number.isSafeInteger(ref.sourcePosition) || ref.sourcePosition < 0) invalid()
        const descriptor = (await readBrc38SqlBinaryDescriptors(k, 'provenTxs', ref.sourcePosition))[field]
        if (descriptor === undefined || descriptor.bytes !== ref.bytes || !/^[0-9a-f]{64}$/.test(descriptor.sha256))
          invalid()
        return descriptor.sha256
      },
      leftSha = await metadata(left),
      rightSha = await metadata(right)
    // A different length is sufficient to prove a change. Both coordinates
    // above must still refer to genuine original fields.
    if (left.bytes !== right.bytes) return false
    const read = async (
        ref: Brc38PrivateProofOriginalField,
        sha256: string | undefined,
        offset: number,
        target: Uint8Array
      ): Promise<void> => {
        check()
        if (ref.origin === 'local') {
          await Brc38NativeLocalBaselineSource.withOwnedRow(source, 'proven_txs', ref.sourceRowId, async row => {
            check()
            const value = row.fields.find(value => value.field === field)
            if (value?.kind !== 'blob' || value.bytes !== ref.bytes) invalid()
            await row.withFieldExtent(field, offset, target.length, async bytes => {
              check()
              if (bytes.length !== target.length) invalid()
              target.set(bytes)
            })
          })
        } else
          for (let used = 0; used < target.length;) {
            check()
            const window = await readBrc38SqlBinaryWindow(
              k,
              'provenTxs',
              ref.sourcePosition,
              field,
              offset + used,
              target.length - used
            )
            if (window === undefined) invalid()
            try {
              if (
                window.offset !== offset + used ||
                window.descriptor.bytes !== ref.bytes ||
                window.descriptor.sha256 !== sha256 ||
                window.bytes.length < 1 ||
                window.bytes.length > target.length - used
              )
                invalid()
              target.set(window.bytes, used)
              used += window.bytes.length
            } finally {
              window.bytes.fill(0)
            }
          }
        check()
      },
      leftHash = createHash('sha256'),
      rightHash = createHash('sha256')
    for (let offset = 0; offset < left.bytes;) {
      check()
      const length = Math.min(width, left.bytes - offset),
        charge = working.claim(1048576 + 128 * length)
      let a: Uint8Array | undefined, b: Uint8Array | undefined
      try {
        a = new Uint8Array(length)
        b = new Uint8Array(length)
        await read(left, leftSha, offset, a)
        await read(right, rightSha, offset, b)
        if (!a.every((value, index) => value === b![index])) return false
        leftHash.update(a)
        rightHash.update(b)
      } finally {
        a?.fill(0)
        b?.fill(0)
        charge.close()
      }
      offset += length
    }
    const a = leftHash.digest('hex'),
      b = rightHash.digest('hex')
    if (a !== b || (leftSha !== undefined && a !== leftSha) || (rightSha !== undefined && b !== rightSha)) invalid()
    check()
    return true
  } finally {
    frame.close()
  }
}
