import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38PrivateCurrentStructuredPolicy } from './Brc38PrivateCurrentStructuredSourceNode'
import {
  Brc38StreamedHistoryProjection,
  type Brc38StreamedHistoryProjectionPolicy
} from './Brc38StreamedHistoryProjection'
import { withBrc38PrivateOccupiedRequestSources } from './Brc38PrivateOccupiedRequestSourcesNode'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

interface Descriptor {
  readonly bytes: number
  readonly sha256: string
}
export interface Brc38PrivateOccupiedHistory {
  readonly prior: Readonly<Descriptor>
  readonly original: Readonly<Descriptor>
  readonly addedNotes: number
  measureChunks(width?: number): AsyncIterable<Uint8Array>
  chunks(width?: number): AsyncIterable<Uint8Array>
}

/** Actual same-owner original/current history union. Both sources share one
 * enrolled query-only facade, with drained reads before derived staging writes.
 * The shared legacy asymmetric note selection, ordering and spelling policy
 * supplies provisional bytes only. Final effects still own current metadata,
 * parent/source/pointer/journal/primary checks and atomic row/receipt admission. */
export async function withBrc38PrivateOccupiedHistory<T>(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  sourcePosition: number,
  currentRequestId: number,
  txid: string,
  sourcePolicy: Brc38PrivateCurrentStructuredPolicy,
  projectionPolicy: Brc38StreamedHistoryProjectionPolicy,
  work: (history: Readonly<Brc38PrivateOccupiedHistory>) => Promise<T>
): Promise<T> {
  const selectedSource = Object.freeze({ ...sourcePolicy }),
    selectedProjection = Object.freeze({ ...projectionPolicy })
  return await withBrc38PrivateOccupiedRequestSources(
    store,
    storage,
    sourcePosition,
    currentRequestId,
    txid,
    'history',
    selectedSource,
    selectedProjection,
    async sources => {
      const field = await Brc38StreamedHistoryProjection.prepareField(
        sources.owners,
        sources.incoming,
        selectedProjection,
        sources.current,
        sources.incomingUpdatedAt
      )
      let live = true,
        result!: T,
        failed = false,
        failure: unknown
      const check = (): void => {
        sources.owners.check()
        if (!live) throw new Error('Private occupied history callback ended')
      }
      try {
        result = await work(
          Object.freeze<Brc38PrivateOccupiedHistory>({
            prior: sources.prior,
            original: sources.original,
            addedNotes: field.addedNotes,
            measureChunks: width => {
              check()
              return field.measureChunks(width)
            },
            chunks: width => {
              check()
              return field.chunks(width)
            }
          })
        )
      } catch (cause) {
        failed = true
        failure = cause
      }
      live = false
      try {
        await field.close()
      } catch (cause) {
        throw new Brc38StagingCleanupError(
          failed ? [failure, cause] : [cause],
          'Private occupied history retains actual field cleanup',
          async () => {
            await field.close()
          }
        )
      }
      if (failed) throw failure
      return result
    }
  )
}
