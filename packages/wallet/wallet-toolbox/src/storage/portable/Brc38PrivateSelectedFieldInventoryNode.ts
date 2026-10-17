import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import type { Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'
import type { Brc38StageTable } from './Brc38SemanticStage'
import { brc38ImportTargetIndexes } from './Brc38ImportTargetIndexes'
import { readBrc38SqlBinaryDescriptors, readBrc38SqlBinaryWindow } from './Brc38SqlBinaryStaging'
import { readBrc38SqlTextDescriptors, readBrc38SqlTextRange } from './Brc38SqlTextStaging'
import { readBrc38NativePackedDescriptor, readBrc38NativePackedExtent } from './Brc38NativePackedFieldsNode'
import {
  readBrc38NativePackedTextDescriptor,
  readBrc38NativePackedTextExtent,
  readBrc38NativePackedTextVersionDescriptor,
  readBrc38NativePackedTextVersionExtent
} from './Brc38NativePackedTextFieldsNode'
import type {
  Brc38NativePackedBinaryCoordinate,
  Brc38NativePackedTextCoordinate
} from './Brc38NativeLocalPackedCoordinate'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'

/** Selection DATA, never a fabricated field reader or source authority. Local
 * bytes are opened through the actual retained source actor; incoming bytes
 * are opened through this actual authenticated private SQL view. */
export type Brc38PrivateSelectedField =
  | Readonly<{ origin: 'local'; sourceRowId: number; bytes: number | null }>
  | Readonly<{ origin: 'incoming'; sourcePosition: number; bytes: number }>
  | Readonly<{ origin: 'inline'; value: string | Uint8Array }>
  | Readonly<{ origin: 'version'; bytes: number; sha256: string }>
  | Readonly<{ origin: 'null' }>
function invalid(): never {
  throw new Error('Private selected field differs from its actual original/local bytes or destination pointer')
}
function size(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1000000000) invalid()
  return value
}
/** Full byte equality plus independently recomputed full field hashes. A
 * matching stored descriptor alone is never accepted. Null and empty content
 * remain distinct; all detached windows are wiped on success and failure. */
export async function inspectBrc38PrivateSelectedField(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  k: Knex.Transaction,
  selected: Readonly<{
    table: Brc38StageTable
    rowId: number
    field: string
    kind: 'blob' | 'text'
    expected: Brc38PrivateSelectedField
    maximumReadBytes: number
    workingAllocation: Brc38WorkingAllocation
    signal?: AbortSignal
  }>
): Promise<number> {
  const working = brc38WorkingAllocation(selected.workingAllocation),
    table = selected.table,
    rowId = selected.rowId,
    field = selected.field,
    kind = selected.kind,
    expected = Object.freeze({ ...selected.expected }),
    width = selected.maximumReadBytes,
    signal = selected.signal,
    binding = store.binding,
    expiresAt = store.operationExpiresAt,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    working === undefined ||
    binding === undefined ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    !Number.isSafeInteger(rowId) ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > 16384 ||
    (table === 'syncStates' &&
      (kind !== 'text' ||
        !['syncMap', 'errorLocal', 'errorOther'].includes(field) ||
        (expected.origin !== 'local' && expected.origin !== 'version' && expected.origin !== 'null')))
  )
    invalid()
  const [sql] = brc38ImportTargetIndexes[table],
    coordinate = { table, rowId, field },
    check = (): void => {
      signal?.throwIfAborted()
      if (store.binding !== binding || Date.now() >= expiresAt || performance.now() >= deadline) invalid()
      store.assertPrivateNativeReadTransaction(k)
      Brc38NativeLocalBaselineSource.assertSharedWorking(source, working)
    },
    frame = working.claim(1048576)
  let inline: Uint8Array | undefined, inlineCharge: ReturnType<Brc38WorkingAllocation['claim']> | undefined
  try {
    check()
    await verifyBrc38AuthenticatedSourceSeal(k)
    const actual =
        kind === 'blob'
          ? await readBrc38NativePackedDescriptor(k, coordinate as Brc38NativePackedBinaryCoordinate)
          : await readBrc38NativePackedTextDescriptor(k, coordinate as Brc38NativePackedTextCoordinate),
      markers = (await k(sql)
        .whereRaw('rowid=?', [rowId])
        .select(k.raw('typeof(??) AS kind,length(CAST(?? AS BLOB)) AS bytes', [field, field]))
        .limit(2)) as Array<{ kind: string; bytes: unknown }>
    if (markers.length !== 1) invalid()
    const absent = (): void => {
        check()
        if (actual !== undefined || markers[0].kind !== 'null' || markers[0].bytes !== null) invalid()
      },
      compare = async (
        bytes: number,
        read: (offset: number, length: number, work: (original: Uint8Array) => Promise<void>) => Promise<void>,
        sourceSha256?: string
      ): Promise<number> => {
        size(bytes)
        if (actual === undefined || actual.bytes !== bytes || markers[0].kind !== kind || markers[0].bytes !== 0)
          invalid()
        const hash = createHash('sha256')
        for (let offset = 0; offset < bytes;) {
          check()
          const length = Math.min(width, bytes - offset),
            allocation = working.claim(1048576 + 64 * length)
          let destination: Uint8Array | undefined
          try {
            destination =
              kind === 'blob'
                ? await readBrc38NativePackedExtent(
                    k,
                    { ...(coordinate as Brc38NativePackedBinaryCoordinate), offset, length, totalBytes: bytes },
                    signal
                  )
                : await readBrc38NativePackedTextExtent(
                    k,
                    { ...(coordinate as Brc38NativePackedTextCoordinate), offset, length, totalBytes: bytes },
                    signal
                  )
            const current = destination
            await read(offset, length, async original => {
              check()
              if (
                original.length !== length ||
                current!.length !== length ||
                !original.every((value, index) => value === current![index])
              )
                invalid()
              hash.update(current!)
            })
          } finally {
            destination?.fill(0)
            allocation.close()
          }
          offset += length
        }
        const sha256 = hash.digest('hex')
        if (sha256 !== actual.sha256 || (sourceSha256 !== undefined && sha256 !== sourceSha256)) invalid()
        check()
        return bytes
      }
    switch (expected.origin) {
      case 'null':
        absent()
        return 0
      case 'version': {
        // A reconstructed immutable version is DATA in this actual private
        // receiver. Check its sealed catalog and compare every stored byte;
        // matching producer digests alone never establish the postimage.
        if (kind !== 'text' || typeof expected.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expected.sha256)) invalid()
        size(expected.bytes)
        const descriptor = await readBrc38NativePackedTextVersionDescriptor(k, expected.sha256)
        if (descriptor.bytes !== expected.bytes || descriptor.sha256 !== expected.sha256) invalid()
        return await compare(
          expected.bytes,
          async (offset, length, work) => {
            check()
            const bytes = await readBrc38NativePackedTextVersionExtent(
              k,
              { sha256: expected.sha256, totalBytes: expected.bytes, offset, length },
              signal
            )
            try {
              await work(bytes)
              check()
            } finally {
              bytes.fill(0)
            }
          },
          expected.sha256
        )
      }
      case 'local': {
        if (!Number.isSafeInteger(expected.sourceRowId)) invalid()
        if (expected.bytes !== null) size(expected.bytes)
        return await Brc38NativeLocalBaselineSource.withOwnedRow(
          source,
          sql as Brc38NativeLocalBaselineTable,
          expected.sourceRowId,
          async row => {
            check()
            const original = row.fields.find(value => value.field === field)
            if (original === undefined || original.kind !== kind || original.bytes !== expected.bytes) invalid()
            if (original.bytes === null) {
              absent()
              return 0
            }
            return await compare(
              original.bytes,
              async (offset, length, work) => await row.withFieldExtent(field, offset, length, work)
            )
          }
        )
      }
      case 'incoming': {
        size(expected.sourcePosition)
        size(expected.bytes)
        const descriptor =
          kind === 'blob'
            ? (await readBrc38SqlBinaryDescriptors(k, table, expected.sourcePosition))[field]
            : (await readBrc38SqlTextDescriptors(k, table, expected.sourcePosition))?.[field]
        if (descriptor === undefined || descriptor.bytes !== expected.bytes) invalid()
        return await compare(
          descriptor.bytes,
          async (offset, length, work) => {
            const buffer = new Uint8Array(length)
            try {
              if (kind === 'text') {
                const bytes = await readBrc38SqlTextRange(
                  k,
                  table,
                  expected.sourcePosition,
                  field,
                  offset,
                  length,
                  { field, encoding: 'utf8', bytes: descriptor.bytes, sha256: descriptor.sha256 },
                  width,
                  check
                )
                try {
                  if (bytes.length !== length) invalid()
                  buffer.set(bytes)
                } finally {
                  bytes.fill(0)
                }
              } else
                for (let used = 0; used < length;) {
                  check()
                  const window = await readBrc38SqlBinaryWindow(
                    k,
                    table,
                    expected.sourcePosition,
                    field,
                    offset + used,
                    length - used
                  )
                  if (window === undefined) invalid()
                  try {
                    if (
                      window.offset !== offset + used ||
                      window.descriptor.bytes !== descriptor.bytes ||
                      window.descriptor.sha256 !== descriptor.sha256 ||
                      window.bytes.length < 1 ||
                      window.bytes.length > length - used
                    )
                      invalid()
                    buffer.set(window.bytes, used)
                    used += window.bytes.length
                  } finally {
                    window.bytes.fill(0)
                  }
                }
              await work(buffer)
            } finally {
              buffer.fill(0)
            }
          },
          descriptor.sha256
        )
      }
      case 'inline': {
        const value = expected.value
        if (kind === 'text' ? typeof value !== 'string' : !(value instanceof Uint8Array)) invalid()
        if (typeof value === 'string')
          for (let index = 0; index < value.length; index++) {
            const unit = value.charCodeAt(index)
            if (unit >= 0xd800 && unit <= 0xdbff) {
              const low = value.charCodeAt(++index)
              if (!(low >= 0xdc00 && low <= 0xdfff)) invalid()
            } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid()
          }
        const bytes = typeof value === 'string' ? Buffer.byteLength(value) : value.length
        size(bytes)
        inlineCharge = working.claim(131072 + 4 * bytes)
        inline = typeof value === 'string' ? Buffer.from(value, 'utf8') : Uint8Array.from(value)
        return await compare(bytes, async (offset, length, work) => {
          await work(inline!.subarray(offset, offset + length))
        })
      }
    }
    return invalid()
  } finally {
    inline?.fill(0)
    inlineCharge?.close()
    frame.close()
  }
}
