import type { StorageKnex } from '../StorageKnex'
import type { BRC38WalletData } from './index'
import { openBrc38KnexSource } from './Brc38KnexSource'
import { createBrc38Stream } from './Brc38Stream'
import { nativePackedTextSources } from './Brc38NativePackedTextSources'

/** Unrun finite integration case. The original controller supplies the actual
 * native profile and an independently authored complete thirteen-table portable
 * document. It must include nonempty values for all twenty-two logical TEXT
 * cells, including the five structured objects in original portable form. */
export async function verifyBrc38NativeSourcePayloadText(
  storage: StorageKnex,
  fixture: Readonly<{
    expected: Readonly<BRC38WalletData>
    privateIndexParent: string
    expiresAt: number
    onMode?: (mode: string, phase: 'started' | 'completed') => void
  }>
): Promise<void> {
  const expected = fixture.expected,
    expiresAt = fixture.expiresAt,
    deadline = performance.now() + expiresAt - Date.now(),
    encoded = JSON.stringify(expected)
  if (
    Buffer.byteLength(encoded, 'utf8') > 131072 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 360000
  )
    throw new Error('Independent complete bounded native portable fixture required')
  let modeExpiresAt = expiresAt,
    modeDeadline = deadline
  const check = (): void => {
    if (
      Date.now() >= expiresAt ||
      performance.now() >= deadline ||
      Date.now() >= modeExpiresAt ||
      performance.now() >= modeDeadline
    )
      throw new Error('Native portable logical TEXT case reached its original deadline')
  }
  for (const source of nativePackedTextSources)
    for (const field of source.fields) {
      const rows = expected.tables[source.table] as readonly Readonly<Record<string, unknown>>[]
      if (
        !rows.some(
          row =>
            Object.hasOwn(row, field) &&
            (typeof row[field] === 'string'
              ? (row[field] as string).length > 0
              : typeof row[field] === 'object' && row[field] !== null)
        )
      )
        throw new Error('Native portable fixture omitted an independent logical TEXT oracle')
    }
  if (typeof expected.user.identityKey !== 'string') throw new Error('Native fixture user identity differs')
  for (const mode of ['ordinary', 'structured', 'text']) {
    const structured = mode !== 'ordinary'
    modeExpiresAt = Math.min(expiresAt, Date.now() + 120000)
    modeDeadline = performance.now() + modeExpiresAt - Date.now()
    check()
    fixture.onMode?.(mode, 'started')
    const source = await openBrc38KnexSource(storage, expected.user.identityKey, {
        lifetimeMs: modeExpiresAt - Date.now(),
        maximumPageRows: 2,
        maximumPageBytes: 2097152,
        maximumRowAllocationBytes: 2097152,
        maximumCertificateGroupBytes: 2097152,
        ...(structured
          ? {
              streamedBinary: { maximumBinaryBytes: 131072, maximumExtentBytes: 16384 },
              streamedStructured: {
                maximumStructuredBytes: 131072,
                privateIndexParent: fixture.privateIndexParent,
                maximumTemporaryIndexBytes: 4194304,
                maximumIndexMembers: 10000
              },
              ...(mode === 'text' ? { streamedText: { maximumTextBytes: 131072 } } : {})
            }
          : {})
      }),
      output = new Uint8Array(262144)
    let used = 0
    try {
      const stream = await createBrc38Stream(source, {
        exportedAt: expected.exportedAt,
        maximumArchiveBytes: output.length,
        maximumRowBytes: 131072,
        maximumMetadataBytes: 65536,
        maximumChunkBytes: 4096,
        ...(structured
          ? {
              streamedRows: {
                maximumBinaryBytes: 131072,
                maximumStructuredBytes: 131072,
                maximumTextBytes: 131072,
                maximumMetadataAllocationBytes: 2097152,
                maximumRowBytes: 131072
              }
            }
          : {})
      })
      try {
        for await (const chunk of stream.chunks) {
          check()
          if (chunk.length > 4096 || chunk.length > output.length - used)
            throw new Error('Native portable source exceeded its independent finite output admission')
          output.set(chunk, used)
          used += chunk.length
        }
        await stream.validateCompleted()
        check()
        const actual = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(0, used))) as unknown
        // Whole-document comparison includes original IDs, complete tables,
        // tombstones, structured histories, relations, metadata and policy.
        // Compare JSON values, since canonical portable property order differs
        // from the independently authored fixture's construction order.
        const ordered = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(ordered)
          if (value === null || typeof value !== 'object') return value
          return Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, child]) => [key, ordered(child)])
          )
        }
        if (JSON.stringify(ordered(actual)) !== JSON.stringify(ordered(expected)))
          throw new Error('Native portable export lost original logical TEXT or complete archive provenance')
      } finally {
        await stream.close()
      }
    } finally {
      try {
        await source.release()
      } finally {
        output.fill(0)
      }
    }
    fixture.onMode?.(mode, 'completed')
  }
}
