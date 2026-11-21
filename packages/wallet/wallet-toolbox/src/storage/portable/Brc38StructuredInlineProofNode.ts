import { createHash } from 'node:crypto'
import type { Brc38AuthenticatedStreamedImportReader } from './KnexBrc38StagingStore'
import type { Brc38JsonStreamedRow, Brc38JsonStreamedField } from './Brc38JsonBinaryFields'
import { assertBase64 } from './Brc38PortableRows'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

/** Bounded representation adaptation only. Each call consumes the actual
 * authenticated reader anew; no source, proof or ownership verdict is kept. */
export function brc38StructuredInlineProofFields(
  source: Brc38JsonStreamedRow,
  maximumAllocationBytes: number
): Readonly<{ row: Brc38JsonStreamedRow; inline: Readonly<Record<string, Uint8Array>> }> {
  if (
    !Number.isSafeInteger(maximumAllocationBytes) ||
    maximumAllocationBytes < 1024 ||
    maximumAllocationBytes > 16777216
  )
    throw new RangeError('Invalid inline proof allocation')
  const fields = { ...source.fields },
    binaries: Record<string, Brc38JsonStreamedField> = { ...source.binaries },
    inline: Record<string, Uint8Array> = Object.create(null)
  let allocation = 1024
  // Preflight both values before allocating either decoded byte buffer.
  for (const field of ['rawTx', 'merklePath']) {
    if (!Object.hasOwn(fields, field)) continue
    if (Object.hasOwn(binaries, field)) throw new Error('Inline proof overlaps its streamed field')
    const value = fields[field]
    assertBase64(value, `provenTx.${field}`)
    allocation += 512 + 16 * (value as string).length
    if (!Number.isSafeInteger(allocation) || allocation > maximumAllocationBytes)
      throw new SnapshotResourceLimitError('Inline proof exceeds its admitted allocation')
  }
  for (const field of ['rawTx', 'merklePath']) {
    if (!Object.hasOwn(fields, field)) continue
    const bytes = Buffer.from(fields[field] as string, 'base64')
    inline[field] = bytes
    binaries[field] = Object.freeze({
      field,
      encoding: 'base64',
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
    delete fields[field]
  }
  return Object.freeze({
    row: Object.freeze({ ...source, fields: Object.freeze(fields), binaries: Object.freeze(binaries) }),
    inline: Object.freeze(inline)
  })
}

/** Explicit structured-only adapter preserves the ordinary streamed reader
 * contract. Bytes remain bounded DATA and never grant an authenticated actor. */
export function brc38StructuredInlineProofReader(
  reader: Readonly<Brc38AuthenticatedStreamedImportReader>,
  maximumAllocationBytes: number,
  signal?: AbortSignal
): Readonly<Brc38AuthenticatedStreamedImportReader> {
  return Object.freeze({
    header: reader.header,
    count: reader.count,
    row: async (table, index) => {
      signal?.throwIfAborted()
      const source = await reader.row(table, index)
      signal?.throwIfAborted()
      return source === undefined || table !== 'provenTxs'
        ? source
        : brc38StructuredInlineProofFields(source, maximumAllocationBytes).row
    },
    chunk: async (table, index, field, offset) => {
      signal?.throwIfAborted()
      if (table !== 'provenTxs' || !['rawTx', 'merklePath'].includes(field))
        return await reader.chunk(table, index, field, offset)
      const source = await reader.row(table, index)
      signal?.throwIfAborted()
      if (source === undefined) throw new Error('Inline proof source disappeared')
      if (!Object.hasOwn(source.fields, field)) return await reader.chunk(table, index, field, offset)
      const actual = brc38StructuredInlineProofFields(source, maximumAllocationBytes),
        bytes = actual.inline[field]
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength)
        throw new RangeError('Invalid inline proof extent')
      if (offset === bytes.byteLength) return undefined
      return Object.freeze({
        descriptor: actual.row.binaries[field],
        offset,
        bytes: bytes.slice(offset, Math.min(offset + 65536, bytes.byteLength))
      })
    }
  } satisfies Brc38AuthenticatedStreamedImportReader)
}
