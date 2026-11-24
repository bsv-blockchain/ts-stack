import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { createHash } from 'node:crypto'
import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38PrivateCurrentStructuredPolicy } from './Brc38PrivateCurrentStructuredSourceNode'
import {
  Brc38StreamedHistoryProjection,
  type Brc38StreamedHistoryProjectionPolicy
} from './Brc38StreamedHistoryProjection'
import type { Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
import {
  withBrc38PrivateOccupiedRequestSources,
  withBrc38PrivateReconstructedRequestSources,
  type Brc38PrivateOccupiedRequestSources,
  type Brc38PrivateRequestReconstruction
} from './Brc38PrivateOccupiedRequestSourcesNode'
import {
  withBrc38PrivateDerivedTextVersion,
  type Brc38PrivateDerivedTextDescriptor
} from './Brc38PrivateDerivedTextVersionNode'
import { stringifyBrc38StructuredJsonSpan } from './Brc38StructuredJson'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import type { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'

/** Actual occupied history baseline and union. Complete measurement and replay
 * use the same source actor and selected note/span/timestamp DATA. The legacy
 * JSON.stringify baseline preserves member ordering and spelling. One finite
 * scratch frame is reused for two separately charged versions. Descriptors
 * remain comparison DATA, with no row, source, journal or primary admission. */
export async function prepareBrc38PrivateOccupiedHistoryText(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  sourcePosition: number,
  currentRequestId: number,
  txid: string,
  sourcePolicy: Brc38PrivateCurrentStructuredPolicy,
  projectionPolicy: Brc38StreamedHistoryProjectionPolicy,
  budget: Brc38ImportDecodedBudget,
  lifetimes?: Brc38PrivateDerivedTextLifetimes
): Promise<
  Readonly<{
    prior: Readonly<Brc38PrivateDerivedTextDescriptor>
    original: Readonly<Brc38PrivateDerivedTextDescriptor>
    normalizedCurrent: Readonly<Brc38PrivateDerivedTextDescriptor>
    output: Readonly<Brc38PrivateDerivedTextDescriptor>
    addedNotes: number
  }>
> {
  return await prepareHistory(
    store,
    sourcePolicy,
    projectionPolicy,
    budget,
    async work =>
      await withBrc38PrivateOccupiedRequestSources(
        store,
        storage,
        sourcePosition,
        currentRequestId,
        txid,
        'history',
        sourcePolicy,
        projectionPolicy,
        work
      ),
    lifetimes
  )
}

/** The same legacy projection using independent original/reconstructed DATA.
 * Complete actual source, receipt and target checks belong to its concrete
 * reconstruction source factory; no candidate postimage is an expected row. */
export async function prepareBrc38PrivateReconstructedHistoryText(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  sourcePosition: number,
  currentRequestId: number,
  txid: string,
  admission: Readonly<Brc38ImportJournalAdmission>,
  reconstruction: Readonly<Brc38PrivateRequestReconstruction>,
  sourcePolicy: Brc38PrivateCurrentStructuredPolicy,
  projectionPolicy: Brc38StreamedHistoryProjectionPolicy,
  budget: Brc38ImportDecodedBudget,
  lifetimes?: Brc38PrivateDerivedTextLifetimes
): Promise<
  Readonly<{
    prior: Readonly<Brc38PrivateDerivedTextDescriptor>
    original: Readonly<Brc38PrivateDerivedTextDescriptor>
    normalizedCurrent: Readonly<Brc38PrivateDerivedTextDescriptor>
    output: Readonly<Brc38PrivateDerivedTextDescriptor>
    addedNotes: number
  }>
> {
  if (reconstruction.current === undefined)
    throw new Error('Occupied request reconstruction has no original current source')
  return await prepareHistory(
    store,
    sourcePolicy,
    projectionPolicy,
    budget,
    async work =>
      await withBrc38PrivateReconstructedRequestSources(
        store,
        storage,
        sourcePosition,
        currentRequestId,
        txid,
        'history',
        admission,
        reconstruction,
        sourcePolicy,
        projectionPolicy,
        async sources => {
          if (sources.current === undefined || sources.prior === undefined)
            throw new Error('Occupied reconstruction sources are incomplete')
          return await work(Object.freeze({ ...sources, current: sources.current, prior: sources.prior }))
        }
      ),
    lifetimes
  )
}

async function prepareHistory(
  store: KnexBrc38StagingStore,
  sourcePolicy: Brc38PrivateCurrentStructuredPolicy,
  projectionPolicy: Brc38StreamedHistoryProjectionPolicy,
  budget: Brc38ImportDecodedBudget,
  withSources: <T>(work: (sources: Readonly<Brc38PrivateOccupiedRequestSources>) => Promise<T>) => Promise<T>,
  lifetimes?: Brc38PrivateDerivedTextLifetimes
): Promise<
  Readonly<{
    prior: Readonly<Brc38PrivateDerivedTextDescriptor>
    original: Readonly<Brc38PrivateDerivedTextDescriptor>
    normalizedCurrent: Readonly<Brc38PrivateDerivedTextDescriptor>
    output: Readonly<Brc38PrivateDerivedTextDescriptor>
    addedNotes: number
  }>
> {
  const selectedSource = Object.freeze({ ...sourcePolicy }),
    selectedProjection = Object.freeze({ ...projectionPolicy })
  return await withSources(
    async sources =>
      await withBrc38PrivateDerivedTextVersion(
        store,
        {
          expiresAt: selectedProjection.expiresAt,
          maximumBytes: selectedProjection.maximumOutputBytes,
          maximumVersions: 2,
          workingAllocation: selectedProjection.workingAllocation,
          signal: selectedProjection.signal
        },
        budget,
        async version => {
          const stage = async (
              measure: () => AsyncIterable<Uint8Array>,
              replay: () => AsyncIterable<Uint8Array>
            ): Promise<Readonly<Brc38PrivateDerivedTextDescriptor>> => {
              const digest = createHash('sha256'),
                decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
              let bytes = 0
              for await (const chunk of measure()) {
                try {
                  sources.owners.check()
                  if (
                    !(chunk instanceof Uint8Array) ||
                    chunk.length < 1 ||
                    chunk.length > selectedProjection.maximumReadBytes ||
                    chunk.length > selectedProjection.maximumOutputBytes - bytes
                  )
                    throw new Error('Private history measurement differs')
                  digest.update(chunk)
                  decoder.decode(chunk, { stream: true })
                  bytes += chunk.length
                } finally {
                  if (chunk instanceof Uint8Array) chunk.fill(0)
                }
              }
              decoder.decode()
              await version.begin({ bytes, sha256: digest.digest('hex') })
              let offset = 0
              for await (const chunk of replay()) {
                try {
                  sources.owners.check()
                  await version.append(offset, chunk)
                  offset += chunk.length
                } finally {
                  if (chunk instanceof Uint8Array) chunk.fill(0)
                }
              }
              if (offset !== bytes) throw new Error('Private history replay length differs')
              return await version.finish()
            },
            textPolicy = Object.freeze({
              maximumInputBytes: Math.max(selectedSource.maximumStructuredBytes, selectedSource.maximumCanonicalBytes),
              maximumOutputBytes: selectedProjection.maximumOutputBytes,
              maximumChunkBytes: selectedProjection.maximumReadBytes,
              maximumAllocationBytes: selectedProjection.maximumGrammarAllocationBytes,
              workingAllocation: selectedProjection.workingAllocation,
              signal: selectedProjection.signal
            }),
            spelling = (): AsyncIterable<Uint8Array> =>
              stringifyBrc38StructuredJsonSpan(sources.current, { start: 0, end: sources.current.length }, textPolicy),
            normalizedCurrent = await stage(spelling, spelling),
            field = await Brc38StreamedHistoryProjection.prepareField(
              sources.owners,
              sources.incoming,
              selectedProjection,
              sources.current,
              sources.incomingUpdatedAt
            )
          let output!: Readonly<Brc38PrivateDerivedTextDescriptor>,
            failed = false,
            failure: unknown
          try {
            output = await stage(
              () => field.measureChunks(selectedProjection.maximumReadBytes),
              () => field.chunks(selectedProjection.maximumReadBytes)
            )
          } catch (cause) {
            failed = true
            failure = cause
          }
          try {
            await field.close()
          } catch (cause) {
            throw new Brc38StagingCleanupError(
              failed ? [failure, cause] : [cause],
              'Private history retains actual field cleanup',
              async () => {
                await field.close()
              }
            )
          }
          if (failed) throw failure
          return Object.freeze({
            prior: sources.prior,
            original: sources.original,
            normalizedCurrent,
            output,
            addedNotes: field.addedNotes
          })
        },
        sources.database,
        lifetimes
      )
  )
}
