import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { parseBRC38Json, type BRC38Tables, type BRC38WalletData } from './index'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

type Table = keyof BRC38Tables
type Row = BRC38Tables[Table][number]
export interface Brc38StreamSource {
  sourceStorage: BRC38WalletData['sourceStorage']
  user: BRC38WalletData['user']
  /** Host-owned coherent portable rows, in the standard table's original sort
   * order. Normalize dates, native binary and historical optional JSON fields
   * before yielding. No replica checkpoint or staging metadata belongs here. */
  rows: (table: Table) => AsyncIterable<Row>
  /** Independently verify complete schema, relational closure and original
   * source provenance in the owned coherent view. The encoder checks JSON
   * spelling and bounds; it cannot prove those source guarantees itself. */
  validateCompleted: () => Promise<void>
  /** Idempotent release, waiting for all owned source I/O to settle. */
  release: () => Promise<void>
}
export interface Brc38StreamOptions {
  exportedAt: string
  maximumArchiveBytes: number
  maximumRowBytes: number
  /** Metadata alone may be materialized within this fixed bound, <=65,536. */
  maximumMetadataBytes?: number
  maximumChunkBytes?: number
  signal?: AbortSignal
}
export interface Brc38Stream {
  chunks: AsyncIterable<Uint8Array>
  validateCompleted: () => Promise<void>
  close: () => Promise<void>
}
const tables = Object.freeze([
  'certificateFields',
  'certificates',
  'commissions',
  'outputBaskets',
  'outputTagMaps',
  'outputTags',
  'outputs',
  'provenTxReqs',
  'provenTxs',
  'syncStates',
  'transactions',
  'txLabelMaps',
  'txLabels'
] as const satisfies readonly Table[])

function boundedInteger(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`)
}
function objectRow(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('BRC-38 requires portable object rows')
}
function metadata(source: Brc38StreamSource, options: Readonly<Brc38StreamOptions>): BRC38WalletData {
  const maximum = options.maximumMetadataBytes ?? 65536
  const empty: BRC38Tables = {
    provenTxs: [],
    provenTxReqs: [],
    outputBaskets: [],
    transactions: [],
    commissions: [],
    outputs: [],
    outputTags: [],
    outputTagMaps: [],
    txLabels: [],
    txLabelMaps: [],
    certificates: [],
    certificateFields: [],
    syncStates: []
  }
  const value: BRC38WalletData = {
    brc: 38,
    title: 'User Wallet Data Format',
    formatVersion: 1,
    exportedAt: options.exportedAt,
    sourceStorage: source.sourceStorage,
    user: source.user,
    tables: empty
  }
  const buffer = new Uint8Array(maximum)
  let used = 0
  for (const bytes of canonicalPortableChunks(value, {
    maximumValueBytes: maximum,
    maximumChunkBytes: options.maximumChunkBytes,
    signal: options.signal
  })) {
    if (bytes.length > maximum - used)
      throw new SnapshotResourceLimitError('BRC-38 metadata exceeds the selected byte policy')
    buffer.set(bytes, used)
    used += bytes.length
  }
  // This bounded header validation is not validation of the streamed tables.
  return parseBRC38Json(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used)))
}

/** All-thirteen-table canonical JSON encoder, not a source adapter or
 * a streaming import validator. Only bounded metadata and one detached row are
 * retained. Arrays remain incrementally consumed, with original source IDs and
 * the host's standard row ordering preserved. Source validation and release
 * must both succeed before validateCompleted or an encryption tag can succeed.
 * All chunks are private provisional output until that completion. */
export async function createBrc38Stream(source: Brc38StreamSource, selected: Brc38StreamOptions): Promise<Brc38Stream> {
  const releaseSource = source.release.bind(source)
  let released: Promise<void> | undefined
  const release = (): Promise<void> => {
    released ??= Promise.resolve().then(releaseSource)
    return released
  }
  try {
    const options = Object.freeze({ ...selected })
    const { signal, maximumArchiveBytes, maximumRowBytes, maximumChunkBytes = 65536 } = options
    boundedInteger(maximumArchiveBytes, Number.MAX_SAFE_INTEGER, 'maximumArchiveBytes')
    boundedInteger(maximumRowBytes, 16777216, 'maximumRowBytes')
    boundedInteger(options.maximumMetadataBytes ?? 65536, 65536, 'maximumMetadataBytes')
    if (!Number.isSafeInteger(maximumChunkBytes) || maximumChunkBytes < 64 || maximumChunkBytes > 65536)
      throw new RangeError('maximumChunkBytes must be an integer from 64 to 65536')
    signal?.throwIfAborted()
    const header = metadata(source, options)
    const rows = source.rows.bind(source)
    const validate = source.validateCompleted.bind(source)
    const encoder = new TextEncoder()
    const rowPolicy = { maximumValueBytes: maximumRowBytes, maximumChunkBytes, signal }
    const headerPolicy = { ...rowPolicy, maximumValueBytes: options.maximumMetadataBytes ?? 65536 }
    let completed = false
    function* literal(text: string) {
      const bytes = encoder.encode(text)
      for (let offset = 0; offset < bytes.length; offset += maximumChunkBytes) {
        signal?.throwIfAborted()
        yield bytes.slice(offset, offset + maximumChunkBytes)
      }
    }
    async function* tableChunks(index: number, table: Table) {
      yield* literal(`${index === 0 ? '' : ','}${JSON.stringify(table)}:[`)
      let first = true
      for await (const row of rows(table)) {
        signal?.throwIfAborted()
        objectRow(row)
        if (!first) yield* literal(',')
        first = false
        yield* canonicalPortableChunks(row, rowPolicy)
      }
      yield* literal(']')
    }
    async function* body() {
      let failure: { error: unknown } | undefined
      try {
        yield* literal(`{"brc":38,"exportedAt":${JSON.stringify(header.exportedAt)},"formatVersion":1,"sourceStorage":`)
        yield* canonicalPortableChunks(header.sourceStorage, headerPolicy)
        yield* literal(',"tables":{')
        for (const [index, table] of tables.entries()) yield* tableChunks(index, table)
        yield* literal('},"title":"User Wallet Data Format","user":')
        yield* canonicalPortableChunks(header.user, headerPolicy)
        yield* literal('}')
        signal?.throwIfAborted()
        await validate()
        signal?.throwIfAborted()
      } catch (error) {
        failure = { error }
      } finally {
        try {
          await release()
        } catch (error_) {
          failure = {
            error:
              failure === undefined
                ? error_
                : new AggregateError([failure.error, error_], 'BRC-38 source processing and cleanup failed', {
                    cause: failure.error
                  })
          }
        }
      }
      if (failure !== undefined) throw failure.error
    }
    async function* chunks() {
      let used = 0
      for await (const bytes of body()) {
        signal?.throwIfAborted()
        if (bytes.length > maximumArchiveBytes - used)
          throw new SnapshotResourceLimitError('BRC-38 archive exceeds the selected byte policy')
        used += bytes.length
        yield bytes
      }
      completed = true
    }
    const iterator = chunks()
    return Object.freeze({
      chunks: iterator,
      validateCompleted() {
        return completed ? Promise.resolve() : Promise.reject(new Error('BRC-38 source stream did not complete'))
      },
      async close() {
        let failure: { error: unknown } | undefined
        try {
          await iterator.return(undefined)
        } catch (error) {
          failure = { error }
        }
        try {
          await release()
        } catch (error_) {
          if (failure === undefined) failure = { error: error_ }
          else if (failure.error !== error_)
            failure = {
              error: new AggregateError([failure.error, error_], 'BRC-38 iterator and source cleanup failed', {
                cause: failure.error
              })
            }
        }
        if (failure !== undefined) throw failure.error
      }
    })
  } catch (error) {
    try {
      await release()
    } catch (error_) {
      throw new AggregateError([error, error_], 'BRC-38 preparation and source cleanup failed', { cause: error })
    }
    throw error
  }
}
