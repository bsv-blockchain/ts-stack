import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { Brc38NativeTextRead } from './Brc38NativeBlobProtocol'
import { brc38JsonTextField } from './Brc38JsonTextFields'
import { readBrc38SqlTextDescriptors, readBrc38SqlTextRange } from './Brc38SqlTextStaging'
import { readBrc38NativePackedTextDescriptor, readBrc38NativePackedTextExtent } from './Brc38NativePackedTextFieldsNode'
import { requireBrc38StructuredProjectionRead } from './Brc38PublishedStructuredSourceNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { nativePackedTextSource } from './Brc38NativePackedTextSources'
import type { Brc38WorkingAllocation } from './Brc38WorkingAllocation'

function invalid(): never {
  throw new Error('Independent scalar TEXT native postimage differs')
}
/** Original string bytes and actual native postimages are compared directly in
 * the caller's coherent, genuinely owned read-only view. A matching persisted
 * digest alone is insufficient. All13 relationships, receipts and provenance
 * are independently checked by the enclosing inventory; this grants no actor,
 * source, publication or activation authority. */
export async function inspectBrc38TextNativeField(
  k: Knex.Transaction,
  selected: Pick<Brc38NativeTextRead, 'table' | 'field' | 'rowId'> & { readonly sourceIndex: number },
  working: Brc38WorkingAllocation,
  maximumReadBytes: number,
  active: () => void
): Promise<Readonly<{ bytes: number; sha256: string }>> {
  const coordinate = Object.freeze({
      table: selected.table,
      field: selected.field,
      rowId: selected.rowId,
      sourceIndex: selected.sourceIndex
    }),
    check = (): void => {
      active()
      requireBrc38StructuredProjectionRead(k)
    }
  check()
  if (
    !brc38JsonTextField(coordinate.table, coordinate.field) ||
    !Number.isSafeInteger(coordinate.rowId) ||
    !Number.isSafeInteger(coordinate.sourceIndex) ||
    coordinate.sourceIndex < 0 ||
    !Number.isSafeInteger(maximumReadBytes) ||
    maximumReadBytes < 1 ||
    maximumReadBytes > 16384
  )
    invalid()
  const reservation = working.claim(8192 + 32 * maximumReadBytes)
  try {
    await verifyBrc38AuthenticatedSourceSeal(k)
    const original = (await readBrc38SqlTextDescriptors(k, coordinate.table, coordinate.sourceIndex))[coordinate.field],
      postimage = await readBrc38NativePackedTextDescriptor(k, coordinate),
      spec = nativePackedTextSource(coordinate.table),
      marker = (await k(spec.sql)
        .where({ [spec.key]: coordinate.rowId })
        .first(k.raw('typeof(??) AS kind,length(CAST(?? AS BLOB)) AS bytes', [coordinate.field, coordinate.field]))) as
        { kind: string; bytes: number } | undefined
    if (
      original === undefined ||
      postimage === undefined ||
      original.bytes !== postimage.bytes ||
      original.sha256 !== postimage.sha256 ||
      marker?.kind !== 'text' ||
      marker.bytes !== 0
    )
      invalid()
    const digest = createHash('sha256'),
      actualDigest = createHash('sha256'),
      decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    for (let offset = 0; offset < original.bytes;) {
      check()
      const length = Math.min(maximumReadBytes, original.bytes - offset),
        bytes = await readBrc38SqlTextRange(
          k,
          coordinate.table,
          coordinate.sourceIndex,
          coordinate.field,
          offset,
          length,
          original,
          maximumReadBytes,
          check
        )
      let actual: Uint8Array | undefined
      try {
        check()
        actual = await readBrc38NativePackedTextExtent(k, { ...coordinate, offset, length, totalBytes: original.bytes })
        if (bytes.byteLength !== length || actual.byteLength !== length) invalid()
        for (let index = 0; index < length; index++) if (bytes[index] !== actual[index]) invalid()
        decoder.decode(bytes, { stream: true })
        digest.update(bytes)
        actualDigest.update(actual)
        offset += length
      } finally {
        bytes.fill(0)
        actual?.fill(0)
      }
      check()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    if (original.bytes === 0) {
      const empty = await readBrc38SqlTextRange(
        k,
        coordinate.table,
        coordinate.sourceIndex,
        coordinate.field,
        0,
        0,
        original,
        maximumReadBytes,
        check
      )
      if (empty.byteLength !== 0) invalid()
    }
    decoder.decode()
    check()
    if (
      digest.digest('hex') !== original.sha256 ||
      actualDigest.digest('hex') !== original.sha256 ||
      JSON.stringify(
        (await readBrc38SqlTextDescriptors(k, coordinate.table, coordinate.sourceIndex))[coordinate.field]
      ) !== JSON.stringify(original) ||
      JSON.stringify(await readBrc38NativePackedTextDescriptor(k, coordinate)) !== JSON.stringify(postimage)
    )
      invalid()
    await verifyBrc38AuthenticatedSourceSeal(k)
    check()
    return Object.freeze({ bytes: original.bytes, sha256: original.sha256 })
  } finally {
    reservation.close()
  }
}
