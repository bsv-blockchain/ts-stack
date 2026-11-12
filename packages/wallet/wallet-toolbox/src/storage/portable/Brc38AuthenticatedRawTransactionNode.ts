import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { inspectBrc38RawTransactionStream, type Brc38RawTransactionSummary } from './Brc38RawTransactionStream'
import type { Brc38StageTable } from './Brc38SemanticStage'

export interface Brc38AuthenticatedRawTransactionOptions {
  readonly maximumBytes: number
  readonly maximumChunks: number
  readonly signal?: AbortSignal
}
/** Full raw framing/hash verification under the actual authenticated source
 * owner, before destination writer acquisition. The returned summary is DATA;
 * current Merkle/header/profile and receiver admission are still required. */
export async function inspectBrc38AuthenticatedRawTransaction(
  store: KnexBrc38StagingStore,
  table: Extract<Brc38StageTable, 'provenTxs' | 'provenTxReqs' | 'transactions'>,
  index: number,
  input: Brc38AuthenticatedRawTransactionOptions
): Promise<Brc38RawTransactionSummary> {
  const maximumBytes = input.maximumBytes,
    maximumChunks = input.maximumChunks,
    signal = input.signal
  if (
    !['provenTxs', 'provenTxReqs', 'transactions'].includes(table) ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 10 ||
    !Number.isSafeInteger(maximumChunks) ||
    maximumChunks < 1
  )
    throw new TypeError('Invalid authenticated raw transaction source policy')
  signal?.throwIfAborted()
  return await store.withAuthenticatedStreamedImportRead(async (_json, _metadata, reader) => {
    const row = await reader.row(table, index),
      selected = row?.binaries.rawTx
    if (selected === undefined || selected.encoding !== 'base64')
      throw new TypeError('Authenticated raw transaction has no admitted binary field')
    const field = Object.freeze({ ...selected })
    async function* chunks(): AsyncGenerator<Uint8Array, void, void> {
      for (let offset = 0; offset < field.bytes;) {
        signal?.throwIfAborted()
        const actual = await reader.chunk(table, index, 'rawTx', offset)
        if (
          actual === undefined ||
          actual.descriptor.bytes !== field.bytes ||
          actual.descriptor.sha256 !== field.sha256 ||
          actual.offset !== offset
        )
          throw new TypeError('Authenticated raw transaction source field changed')
        offset += actual.bytes.byteLength
        yield actual.bytes
      }
    }
    return await inspectBrc38RawTransactionStream(chunks(), {
      bytes: field.bytes,
      sha256: field.sha256,
      maximumBytes,
      maximumChunks,
      expiresAt: store.limits.expiresAt,
      signal
    })
  })
}
