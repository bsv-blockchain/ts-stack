import { createHash } from 'node:crypto'
import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import type { Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
import {
  withBrc38PrivateCurrentStructuredDatabaseSource,
  type Brc38PrivateCurrentStructuredPolicy
} from './Brc38PrivateCurrentStructuredSourceNode'
import type { Brc38StreamedHistoryProjectionPolicy } from './Brc38StreamedHistoryProjection'
import type { Brc38StreamedStructured } from './Brc38StructuredJson'
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
import { prepareSnapshotSyncNormalizedNotify } from '../snapshot/SnapshotSyncNormalizedNotify'
import { prepareBrc38StreamedNotifyField } from './Brc38StreamedNotifyField'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import type { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'

interface Output {
  measureChunks(width?: number): AsyncIterable<Uint8Array>
  chunks(width?: number): AsyncIterable<Uint8Array>
  close(): Promise<void>
}

/** Complete occupied private notification selection, with actual current/
 * original reads, legacy normalization, finite import-ID/transaction-parent
 * lookup and original/current receipt/membership fences. Normalization stages
 * and final union are measured/replayed into actual charged sealed versions.
 * The same borrowed native reader avoids a second slot3 lease; each source or
 * stored-hash transaction drains before a short writer.
 *
 * This installs no row or checkpoint. Descriptors, reset choice, missing count
 * and membership revision are DATA: final effects must freshly compare the
 * full current row/proof, original source and receipt/mappings/membership,
 * independently check staged postimages, and apply the legacy persisted-row
 * condition before resetting notified or replacing any pointer. */
export async function prepareBrc38PrivateOccupiedNotifyText(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  sourcePosition: number,
  currentRequestId: number,
  txid: string,
  admission: Readonly<Brc38ImportJournalAdmission>,
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
    notifiedReset: boolean
    unmappedIds: number
    transactionMembershipRevision: string
  }>
> {
  return await prepareNotify(
    store,
    storage,
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
        'notify',
        sourcePolicy,
        projectionPolicy,
        work,
        admission
      ),
    lifetimes
  )
}

/** The same legacy projection using independent original/reconstructed DATA.
 * Complete actual source, receipt and target checks belong to its concrete
 * reconstruction source factory; no candidate postimage is an expected row. */
export async function prepareBrc38PrivateReconstructedNotifyText(
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
    notifiedReset: boolean
    unmappedIds: number
    transactionMembershipRevision: string
  }>
> {
  if (reconstruction.current === undefined)
    throw new Error('Occupied request reconstruction has no original current source')
  return await prepareNotify(
    store,
    storage,
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
        'notify',
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

async function prepareNotify(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
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
    notifiedReset: boolean
    unmappedIds: number
    transactionMembershipRevision: string
  }>
> {
  const selectedSource = Object.freeze({ ...sourcePolicy }),
    selectedProjection = Object.freeze({ ...projectionPolicy, legacyNormalizedIntegers: true }),
    derivedPolicy = Object.freeze({
      ...selectedSource,
      maximumOpenIndexes: 2 as const,
      maximumStructuredBytes: Math.max(selectedSource.maximumStructuredBytes, selectedSource.maximumCanonicalBytes)
    })
  return await withSources(
    async sources =>
      await withBrc38PrivateDerivedTextVersion(
        store,
        {
          expiresAt: selectedProjection.expiresAt,
          maximumBytes: selectedProjection.maximumOutputBytes,
          maximumVersions: 3,
          workingAllocation: selectedProjection.workingAllocation,
          signal: selectedProjection.signal
        },
        budget,
        async version => {
          const textPolicy = Object.freeze({
              maximumInputBytes: derivedPolicy.maximumStructuredBytes,
              maximumOutputBytes: selectedProjection.maximumOutputBytes,
              maximumChunkBytes: selectedProjection.maximumReadBytes,
              maximumAllocationBytes: selectedProjection.maximumGrammarAllocationBytes,
              workingAllocation: selectedProjection.workingAllocation,
              signal: selectedProjection.signal
            }),
            indexPolicy = Object.freeze({
              sourceBytes: Math.max(sources.incoming.length, sources.current.length),
              maximumTemporaryIndexBytes: Math.floor(selectedProjection.maximumTemporaryIndexBytes / 2),
              maximumTemporaryPhysicalBytes: Math.floor(selectedProjection.maximumTemporaryIndexBytes / 2),
              maximumMembers: selectedProjection.maximumMembers,
              maximumAllocationBytes: selectedProjection.maximumIndexAllocationBytes,
              workingAllocation: selectedProjection.workingAllocation,
              expiresAt: selectedProjection.expiresAt,
              signal: selectedProjection.signal
            }),
            stage = async (field: Output): Promise<Readonly<Brc38PrivateDerivedTextDescriptor>> => {
              let value!: Readonly<Brc38PrivateDerivedTextDescriptor>,
                failed = false,
                failure: unknown
              try {
                const digest = createHash('sha256')
                let bytes = 0
                for await (const chunk of field.measureChunks(selectedProjection.maximumReadBytes)) {
                  try {
                    sources.owners.check()
                    if (
                      !(chunk instanceof Uint8Array) ||
                      chunk.length < 1 ||
                      chunk.length > selectedProjection.maximumReadBytes ||
                      chunk.length > selectedProjection.maximumOutputBytes - bytes
                    )
                      throw new Error('Private notify measurement differs')
                    digest.update(chunk)
                    bytes += chunk.length
                  } finally {
                    if (chunk instanceof Uint8Array) chunk.fill(0)
                  }
                }
                await version.begin({ bytes, sha256: digest.digest('hex') })
                let offset = 0
                for await (const chunk of field.chunks(selectedProjection.maximumReadBytes)) {
                  try {
                    sources.owners.check()
                    await version.append(offset, chunk)
                    offset += chunk.length
                  } finally {
                    if (chunk instanceof Uint8Array) chunk.fill(0)
                  }
                }
                if (offset !== bytes) throw new Error('Private notify replay length differs')
                value = await version.finish()
              } catch (cause) {
                failed = true
                failure = cause
              }
              try {
                await field.close()
              } catch (cause) {
                throw new Brc38StagingCleanupError(
                  failed ? [failure, cause] : [cause],
                  'Private occupied notify retains actual field cleanup',
                  async () => {
                    await field.close()
                  }
                )
              }
              if (failed) throw failure
              return value
            },
            normalize = async (source: Readonly<Brc38StreamedStructured>) =>
              await stage(await prepareSnapshotSyncNormalizedNotify(source, sources.owners, textPolicy, indexPolicy)),
            incoming = await normalize(sources.incoming),
            normalizedCurrent = await normalize(sources.current),
            extra = selectedSource.maximumTemporaryIndexBytes + selectedProjection.maximumTemporaryIndexBytes
          return await withBrc38PrivateCurrentStructuredDatabaseSource(
            store,
            storage,
            sources.database,
            { version: incoming },
            derivedPolicy,
            async incomingSource =>
              await withBrc38PrivateCurrentStructuredDatabaseSource(
                store,
                storage,
                sources.database,
                { version: normalizedCurrent },
                derivedPolicy,
                async currentSource => {
                  const union = await prepareBrc38StreamedNotifyField(
                      sources.owners,
                      incomingSource,
                      selectedProjection,
                      currentSource
                    ),
                    notifiedReset = union.notifiedReset,
                    unmappedIds = union.unmappedIds,
                    output = await stage(union)
                  if (sources.transactionMembershipRevision === undefined)
                    throw new Error('Private notify actual transaction membership is unavailable')
                  return Object.freeze({
                    prior: sources.prior,
                    original: sources.original,
                    normalizedCurrent,
                    output,
                    notifiedReset,
                    unmappedIds,
                    transactionMembershipRevision: sources.transactionMembershipRevision
                  })
                },
                extra
              ),
            extra
          )
        },
        sources.database,
        lifetimes
      )
  )
}
