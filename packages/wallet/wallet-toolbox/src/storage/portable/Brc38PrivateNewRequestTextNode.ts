import { promiseFromSync } from '../../utility/promiseFromSync'
import { createHash } from 'node:crypto'
import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import type { Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
import {
  withBrc38PrivateNewRequestSources,
  withBrc38PrivateReconstructedRequestSources,
  type Brc38PrivateRequestSources,
  type Brc38PrivateRequestReconstruction
} from './Brc38PrivateOccupiedRequestSourcesNode'
import {
  withBrc38PrivateCurrentStructuredDatabaseSource,
  type Brc38PrivateCurrentStructuredPolicy
} from './Brc38PrivateCurrentStructuredSourceNode'
import {
  withBrc38PrivateDerivedTextVersion,
  type Brc38PrivateDerivedTextDescriptor
} from './Brc38PrivateDerivedTextVersionNode'
import type { Brc38StreamedHistoryProjectionPolicy } from './Brc38StreamedHistoryProjection'
import { stringifyBrc38StructuredJsonSpan } from './Brc38StructuredJson'
import { prepareSnapshotSyncNormalizedNotify } from '../snapshot/SnapshotSyncNormalizedNotify'
import { Brc38StreamedNotifyProjection } from './Brc38StreamedNotifyProjection'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import type { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'

/** Incoming-only history spelling and normalized/mapped notification. Actual
 * source, absent natural key, import receipt and transaction membership remain
 * freshly fenced by the source factory. Output is separately charged immutable
 * content DATA; it grants no row, proof, checkpoint or primary authority. */
export async function prepareBrc38PrivateNewRequestText(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  sourcePosition: number,
  txid: string,
  admission: Readonly<Brc38ImportJournalAdmission>,
  sourcePolicy: Brc38PrivateCurrentStructuredPolicy,
  projectionPolicy: Brc38StreamedHistoryProjectionPolicy,
  budget: Brc38ImportDecodedBudget,
  lifetimes?: Brc38PrivateDerivedTextLifetimes
): Promise<
  Readonly<{
    history: Readonly<Brc38PrivateDerivedTextDescriptor>
    notify: Readonly<Brc38PrivateDerivedTextDescriptor>
    originalHistory: Readonly<Brc38PrivateDerivedTextDescriptor>
    originalNotify: Readonly<Brc38PrivateDerivedTextDescriptor>
    notifiedReset: boolean
    unmappedIds: number
    transactionMembershipRevision: string
  }>
> {
  return await prepareNew(
    store,
    storage,
    sourcePolicy,
    projectionPolicy,
    budget,
    async (field, work) =>
      await withBrc38PrivateNewRequestSources(
        store,
        storage,
        sourcePosition,
        txid,
        field,
        admission,
        sourcePolicy,
        projectionPolicy,
        work
      ),
    lifetimes
  )
}

/** New expected row from actual archived fields while the final candidate
 * already exists. The completed receipt/alias is checked by the reconstruction
 * factory; an absent candidate is never manufactured for this comparison. */
export async function prepareBrc38PrivateReconstructedNewRequestText(
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
    history: Readonly<Brc38PrivateDerivedTextDescriptor>
    notify: Readonly<Brc38PrivateDerivedTextDescriptor>
    originalHistory: Readonly<Brc38PrivateDerivedTextDescriptor>
    originalNotify: Readonly<Brc38PrivateDerivedTextDescriptor>
    notifiedReset: boolean
    unmappedIds: number
    transactionMembershipRevision: string
  }>
> {
  if (reconstruction.current !== undefined)
    throw new Error('New request reconstruction already has an original current source')
  return await prepareNew(
    store,
    storage,
    sourcePolicy,
    projectionPolicy,
    budget,
    async (field, work) =>
      await withBrc38PrivateReconstructedRequestSources(
        store,
        storage,
        sourcePosition,
        currentRequestId,
        txid,
        field,
        admission,
        reconstruction,
        sourcePolicy,
        projectionPolicy,
        work
      ),
    lifetimes
  )
}

async function prepareNew(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  sourcePolicy: Brc38PrivateCurrentStructuredPolicy,
  projectionPolicy: Brc38StreamedHistoryProjectionPolicy,
  budget: Brc38ImportDecodedBudget,
  withSources: <T>(
    field: 'history' | 'notify',
    work: (sources: Readonly<Brc38PrivateRequestSources>) => Promise<T>
  ) => Promise<T>,
  lifetimes?: Brc38PrivateDerivedTextLifetimes
): Promise<
  Readonly<{
    history: Readonly<Brc38PrivateDerivedTextDescriptor>
    notify: Readonly<Brc38PrivateDerivedTextDescriptor>
    originalHistory: Readonly<Brc38PrivateDerivedTextDescriptor>
    originalNotify: Readonly<Brc38PrivateDerivedTextDescriptor>
    notifiedReset: boolean
    unmappedIds: number
    transactionMembershipRevision: string
  }>
> {
  const source = Object.freeze({ ...sourcePolicy }),
    projection = Object.freeze({ ...projectionPolicy, legacyNormalizedIntegers: true }),
    textPolicy = Object.freeze({
      maximumInputBytes: Math.max(source.maximumStructuredBytes, source.maximumCanonicalBytes),
      maximumOutputBytes: projection.maximumOutputBytes,
      maximumChunkBytes: projection.maximumReadBytes,
      maximumAllocationBytes: projection.maximumGrammarAllocationBytes,
      workingAllocation: projection.workingAllocation,
      signal: projection.signal
    })
  const prepare = async (field: 'history' | 'notify') =>
    await withSources(
      field,
      async sources =>
        await withBrc38PrivateDerivedTextVersion(
          store,
          {
            expiresAt: projection.expiresAt,
            maximumBytes: projection.maximumOutputBytes,
            maximumVersions: field === 'history' ? 1 : 2,
            workingAllocation: projection.workingAllocation,
            signal: projection.signal
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
                    chunk.length > projection.maximumReadBytes ||
                    chunk.length > projection.maximumOutputBytes - bytes
                  )
                    throw new Error('Private new request text measurement differs')
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
              if (offset !== bytes) throw new Error('Private new request text replay differs')
              return await version.finish()
            }
            if (sources.transactionMembershipRevision === undefined)
              throw new Error('Private new request membership fence is missing')
            if (field === 'history') {
              const spelling = () =>
                stringifyBrc38StructuredJsonSpan(
                  sources.incoming,
                  { start: 0, end: sources.incoming.length },
                  textPolicy
                )
              return Object.freeze({
                original: sources.original,
                output: await stage(spelling, spelling),
                notifiedReset: false,
                unmappedIds: 0,
                transactionMembershipRevision: sources.transactionMembershipRevision
              })
            }
            const normalized = await prepareSnapshotSyncNormalizedNotify(sources.incoming, sources.owners, textPolicy, {
              sourceBytes: sources.incoming.length,
              maximumTemporaryIndexBytes: Math.floor(projection.maximumTemporaryIndexBytes / 2),
              maximumTemporaryPhysicalBytes: Math.floor(projection.maximumTemporaryIndexBytes / 2),
              maximumMembers: projection.maximumMembers,
              maximumAllocationBytes: projection.maximumIndexAllocationBytes,
              workingAllocation: projection.workingAllocation,
              expiresAt: projection.expiresAt,
              signal: projection.signal
            })
            let normalizedDescriptor!: Readonly<Brc38PrivateDerivedTextDescriptor>,
              failed = false,
              failure: unknown
            try {
              normalizedDescriptor = await stage(
                () => normalized.measureChunks(),
                () => normalized.chunks()
              )
            } catch (cause) {
              failed = true
              failure = cause
            }
            try {
              await normalized.close()
            } catch (cause) {
              throw new Brc38StagingCleanupError(
                failed ? [failure, cause] : [cause],
                'Private new request retains normalization cleanup',
                async () => {
                  await normalized.close()
                }
              )
            }
            if (failed) throw failure
            return await withBrc38PrivateCurrentStructuredDatabaseSource(
              store,
              storage,
              sources.database,
              { version: normalizedDescriptor },
              { ...source, maximumOpenIndexes: 2, maximumStructuredBytes: textPolicy.maximumInputBytes },
              async incoming => {
                const mapped = await Brc38StreamedNotifyProjection.prepare(sources.owners, incoming, projection),
                  spelling = (measurement: boolean) =>
                    stringifyBrc38StructuredJsonSpan(
                      incoming,
                      { start: 0, end: incoming.length },
                      textPolicy,
                      undefined,
                      {
                        member: 'transactionIds',
                        check: sources.owners.check,
                        chunks: width => (measurement ? mapped.measureChunks(width) : mapped.chunks(width)),
                        close: () => promiseFromSync(() => undefined)
                      }
                    )
                let output!: Readonly<Brc38PrivateDerivedTextDescriptor>,
                  failed = false,
                  failure: unknown
                try {
                  output = await stage(
                    () => spelling(true),
                    () => spelling(false)
                  )
                } catch (cause) {
                  failed = true
                  failure = cause
                }
                try {
                  await mapped.close()
                } catch (cause) {
                  throw new Brc38StagingCleanupError(
                    failed ? [failure, cause] : [cause],
                    'Private new request retains mapping projection cleanup',
                    async () => {
                      await mapped.close()
                    }
                  )
                }
                if (failed) throw failure
                return Object.freeze({
                  original: sources.original,
                  output,
                  notifiedReset: mapped.mappedIncomingIds > 0,
                  unmappedIds: mapped.unmappedIds,
                  transactionMembershipRevision: sources.transactionMembershipRevision!
                })
              },
              source.maximumTemporaryIndexBytes + projection.maximumTemporaryIndexBytes
            )
          },
          sources.database,
          lifetimes
        )
    )
  const history = await prepare('history'),
    notify = await prepare('notify')
  if (history.transactionMembershipRevision !== notify.transactionMembershipRevision)
    throw new Error('Private new request transaction membership changed between fields')
  return Object.freeze({
    history: history.output,
    notify: notify.output,
    originalHistory: history.original,
    originalNotify: notify.original,
    notifiedReset: notify.notifiedReset,
    unmappedIds: notify.unmappedIds,
    transactionMembershipRevision: notify.transactionMembershipRevision
  })
}
