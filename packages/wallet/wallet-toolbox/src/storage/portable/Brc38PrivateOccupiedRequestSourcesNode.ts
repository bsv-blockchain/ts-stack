import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { privateNativeDatabaseIdentity } from './Brc38PrivateNativeOwnershipNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { readBrc38SqlStructuredDescriptors } from './Brc38SqlStructuredStaging'
import { readBrc38NativePackedTextDescriptor } from './Brc38NativePackedTextFieldsNode'
import {
  withBrc38PrivateCurrentStructuredDatabaseSource,
  type Brc38PrivateCurrentStructuredPolicy
} from './Brc38PrivateCurrentStructuredSourceNode'
import { brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'
import type { Brc38StreamedHistoryProjectionPolicy } from './Brc38StreamedHistoryProjection'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { readBrc38ImportJournal } from './Brc38ImportJournal'
import { admissionCopy } from './Brc38ImportJournalCore'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import { readNativeSnapshotTransactionMembershipRevision } from '../snapshot/NativeSnapshotSyncRequestsCurrentNode'
import { readNativeSnapshotParentFences } from '../snapshot/NativeSnapshotSyncParentFencesNode'
import type { Brc38StreamedStructured } from './Brc38StructuredJson'
import type { Brc38StructuredProjectionOwners } from './Brc38StructuredProjectionOwners'
import type { Brc38JsonMemberIndex } from './Brc38StructuredJson'
import { Brc38NodeJsonIndex } from './Brc38NodeJsonIndex'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { measureBrc38StructuredFilesystem } from './Brc38StructuredFilesystemNode'
import { brc38ImportTargetIndexName, verifyBrc38ImportTargetIndexes } from './Brc38ImportTargetIndexes'
import { assertIsoDate } from './Brc38PortableRows'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { withBrc38NativeLocalStructuredDatabaseSource } from './Brc38NativeLocalStructuredSourceNode'
import { readBrc38PrivateMergeRecovery } from './Brc38PrivateMergeRecoverySchemaNode'
import { brc38PrivateMergeTargetsTable } from './Brc38PrivateMergeTargetsNode'
import { brc38ImportTableOrder } from './Brc38ImportForms'

interface Descriptor {
  readonly bytes: number
  readonly sha256: string
}
export interface Brc38PrivateRequestSources {
  /** Actual callback-owned enrolled read facade; never retained after return. */
  readonly database: Knex
  readonly prior?: Readonly<Descriptor>
  readonly original: Readonly<Descriptor>
  readonly incoming: Readonly<Brc38StreamedStructured>
  readonly incomingUpdatedAt: string
  readonly current?: Readonly<Brc38StreamedStructured>
  readonly owners: Readonly<Brc38StructuredProjectionOwners>
  readonly transactionMembershipRevision?: string
}
export interface Brc38PrivateOccupiedRequestSources extends Brc38PrivateRequestSources {
  readonly prior: Readonly<Descriptor>
  readonly current: Readonly<Brc38StreamedStructured>
}
function invalid(): never {
  throw new Error(
    'Private occupied request sources differs from its actual source/current request or resource admission'
  )
}

export function brc38PrivateRequestTxidAccepted(txid: string): boolean {
  return txid.length === 64 && /^[0-9a-f]{64}$/i.test(txid)
}

export async function withBrc38PrivateOccupiedRequestSources<T>(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  sourcePosition: number,
  currentRequestId: number,
  txid: string,
  field: 'history' | 'notify',
  source: Brc38PrivateCurrentStructuredPolicy,
  projection: Brc38StreamedHistoryProjectionPolicy,
  work: (sources: Readonly<Brc38PrivateOccupiedRequestSources>) => Promise<T>,
  admission?: Readonly<Brc38ImportJournalAdmission>
): Promise<T> {
  if (!Number.isSafeInteger(currentRequestId) || currentRequestId < 1) invalid()
  return await withBrc38PrivateRequestSources(
    store,
    storage,
    sourcePosition,
    currentRequestId,
    txid,
    field,
    source,
    projection,
    async sources => {
      if (sources.current === undefined || sources.prior === undefined) invalid()
      return await work(Object.freeze({ ...sources, current: sources.current, prior: sources.prior }))
    },
    admission
  )
}

/** Incoming-only actual source with an indexed absent natural-key fence.
 * It never manufactures a current request or an empty payload substitute. */
export async function withBrc38PrivateNewRequestSources<T>(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  sourcePosition: number,
  txid: string,
  field: 'history' | 'notify',
  admission: Readonly<Brc38ImportJournalAdmission>,
  source: Brc38PrivateCurrentStructuredPolicy,
  projection: Brc38StreamedHistoryProjectionPolicy,
  work: (sources: Readonly<Brc38PrivateRequestSources>) => Promise<T>
): Promise<T> {
  return await withBrc38PrivateRequestSources(
    store,
    storage,
    sourcePosition,
    undefined,
    txid,
    field,
    source,
    projection,
    work,
    admission
  )
}

/** Coordinates of independently reconstructed DATA. The original source is
 * the genuine retained actor; a version coordinate is re-opened and checked
 * against actual sealed stored content. Neither is a candidate-row verdict. */
export interface Brc38PrivateRequestReconstruction {
  readonly source: Brc38NativeLocalBaselineSource
  readonly current?: Readonly<{ localRowId: number }> | Readonly<{ version: Readonly<Descriptor> }>
}

/** Sources for post-import reconstruction. Unlike ordinary preparation, the
 * actual destination key exists and the receipt MUST be complete. An occupied
 * reconstruction reads the genuine original row or a prior reconstructed
 * version; it never reads the candidate as its expected merge baseline. */
export async function withBrc38PrivateReconstructedRequestSources<T>(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  sourcePosition: number,
  currentRequestId: number,
  txid: string,
  field: 'history' | 'notify',
  admission: Readonly<Brc38ImportJournalAdmission>,
  reconstruction: Readonly<Brc38PrivateRequestReconstruction>,
  source: Brc38PrivateCurrentStructuredPolicy,
  projection: Brc38StreamedHistoryProjectionPolicy,
  work: (sources: Readonly<Brc38PrivateRequestSources>) => Promise<T>
): Promise<T> {
  if (!Number.isSafeInteger(currentRequestId) || currentRequestId < 1) invalid()
  const current = reconstruction.current,
    selected = Object.freeze({
      source: reconstruction.source,
      ...(current === undefined
        ? {}
        : {
            current:
              'localRowId' in current
                ? Object.freeze({ localRowId: current.localRowId })
                : Object.freeze({
                    version: Object.freeze({ bytes: current.version.bytes, sha256: current.version.sha256 })
                  })
          })
    })
  return await withBrc38PrivateRequestSources(
    store,
    storage,
    sourcePosition,
    currentRequestId,
    txid,
    field,
    source,
    projection,
    work,
    admission,
    selected
  )
}

/** Actual original/current request fields sharing one enrolled query-only
 * facade. Every transaction drains before callback-owned derived writers.
 * Sources/indexes/finite mappings are bound to the current actual private
 * source, row pointer, optional import receipt and transaction membership.
 * This issues no row effect, producer verdict, receipt or primary admission. */
async function withBrc38PrivateRequestSources<T>(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  sourcePosition: number,
  currentRequestId: number | undefined,
  selectedTxid: string,
  selectedField: 'history' | 'notify',
  selectedSource: Brc38PrivateCurrentStructuredPolicy,
  selectedProjection: Brc38StreamedHistoryProjectionPolicy,
  work: (sources: Readonly<Brc38PrivateRequestSources>) => Promise<T>,
  admission?: Readonly<Brc38ImportJournalAdmission>,
  reconstruction?: Readonly<Brc38PrivateRequestReconstruction>
): Promise<T> {
  const root = storage.toDb(),
    origin = privateNativeDatabaseIdentity(root),
    txid = selectedTxid,
    field = selectedField,
    sourcePolicy = Object.freeze({
      ...brc38PrivateStructuredPolicy({ ...selectedSource, maximumOpenIndexes: 2 }, store.directory),
      expiresAt: selectedSource.expiresAt,
      maximumCombinedTemporaryBytes: selectedSource.maximumCombinedTemporaryBytes
    }),
    projectionPolicy = Object.freeze({ ...selectedProjection }),
    working = brc38WorkingAllocation(projectionPolicy.workingAllocation),
    coordinate =
      currentRequestId === undefined || reconstruction !== undefined
        ? undefined
        : Object.freeze({ table: 'provenTxReqs' as const, field, rowId: currentRequestId }),
    deadline = performance.now() + Math.max(0, sourcePolicy.expiresAt - Date.now()),
    indexes = new Set<Brc38NodeJsonIndex>(),
    retained = new Set<Brc38StagingCleanupError>(),
    io = new Brc38OwnedImportReads()
  if (
    root !== store.knex ||
    origin?.slot !== 0 ||
    working === undefined ||
    working !== sourcePolicy.workingAllocation ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    !Number.isSafeInteger(sourcePosition) ||
    sourcePosition < 0 ||
    sourcePosition >= store.limits.maximumRows ||
    (currentRequestId !== undefined && (!Number.isSafeInteger(currentRequestId) || currentRequestId < 1)) ||
    !brc38PrivateRequestTxidAccepted(txid) ||
    projectionPolicy.expiresAt !== store.limits.expiresAt ||
    sourcePolicy.expiresAt !== store.limits.expiresAt ||
    projectionPolicy.signal !== sourcePolicy.signal ||
    projectionPolicy.maximumReadBytes > (sourcePolicy.maximumReadBytes ?? 65536) ||
    projectionPolicy.maximumOutputBytes > sourcePolicy.maximumCanonicalBytes ||
    projectionPolicy.maximumMembers > sourcePolicy.maximumIndexMembers ||
    projectionPolicy.maximumTemporaryIndexBytes < 2097152 ||
    2 * sourcePolicy.maximumTemporaryIndexBytes + projectionPolicy.maximumTemporaryIndexBytes >
      sourcePolicy.maximumCombinedTemporaryBytes ||
    sourcePolicy.maximumCombinedTemporaryBytes > store.limits.maximumPhysicalBytes
  )
    invalid()
  if (field !== 'history' && field !== 'notify') invalid()
  if (
    admission !== undefined &&
    (admission.scope.bindingSha256 !== store.binding?.digest ||
      admission.scope.archiveSha256 !== store.binding?.binding.archiveSha256 ||
      admission.originalLimitsJson !== store.binding?.limitsJson ||
      admission.expiresAt !== store.limits.expiresAt)
  )
    invalid()
  if (reconstruction !== undefined) {
    if (admission === undefined || currentRequestId === undefined) invalid()
    Brc38NativeLocalBaselineSource.assertSharedWorking(reconstruction.source, working)
    const current = reconstruction.current
    if (
      current !== undefined &&
      'localRowId' in current &&
      (!Number.isSafeInteger(current.localRowId) || current.localRowId !== currentRequestId)
    )
      invalid()
  }
  const selectedAdmission = admission === undefined ? undefined : admissionCopy(admission),
    reservation = working.claim(65536)
  let live = true,
    indexBytes = 0,
    receipt: string | undefined,
    membership: string | undefined,
    incomingUpdatedAt: string | undefined
  const actor = (): void => {
      sourcePolicy.signal?.throwIfAborted()
      if (
        !live ||
        storage.toDb() !== root ||
        privateNativeDatabaseIdentity(root)?.token !== origin.token ||
        Date.now() >= sourcePolicy.expiresAt ||
        performance.now() >= deadline
      )
        invalid()
      store.assertPrivateNativeDestination(root)
      if (reconstruction !== undefined) {
        Brc38NativeLocalBaselineSource.assertSharedWorking(reconstruction.source, working)
        const fence = reconstruction.source.fence
        if (
          fence.mode !== 'merge' ||
          fence.identityKey !== store.binding?.binding.identityKey ||
          fence.chain !== store.binding?.binding.chain ||
          fence.targetStorageIdentityKey !== store.binding?.binding.targetStorageIdentityKey ||
          fence.userId !== selectedAdmission?.scope.userId
        )
          invalid()
      }
    },
    cleanup = async (): Promise<void> => {
      const failures: unknown[] = []
      for (const index of indexes)
        try {
          await index.close()
          indexes.delete(index)
        } catch (cause) {
          failures.push(cause)
        }
      for (const failure of retained)
        try {
          await failure.retryCleanup()
          retained.delete(failure)
        } catch (cause) {
          failures.push(cause)
        }
      if (failures.length !== 0)
        throw new Brc38StagingCleanupError(
          failures,
          'Private occupied request sources retains actual projection/source cleanup',
          cleanup
        )
      reservation.close()
    }
  let value!: T,
    failed = false,
    failure: unknown
  try {
    actor()
    value = await store.withPrivateNativeDatabase(
      true,
      async database =>
        await store.withPrivateStructuredFieldDatabaseSource(
          database,
          'provenTxReqs',
          sourcePosition,
          field,
          sourcePolicy,
          async (incoming, original) => {
            const consume = async (
              current?: Readonly<Brc38StreamedStructured>,
              prior?: Readonly<Descriptor>
            ): Promise<T> => {
              const probe = async (): Promise<void> => {
                actor()
                await database.transaction(async trx => {
                  store.assertPrivateNativeReadTransaction(trx)
                  await verifyBrc38AuthenticatedSourceSeal(trx)
                  await verifyBrc38ImportTargetIndexes(trx)
                  const incomingDescriptor = (
                      await readBrc38SqlStructuredDescriptors(trx, 'provenTxReqs', sourcePosition)
                    )[field],
                    currentDescriptor =
                      coordinate === undefined ? undefined : await readBrc38NativePackedTextDescriptor(trx, coordinate),
                    sourceRows = await trx('rows')
                      .where({ tableName: 'provenTxReqs', position: sourcePosition })
                      .whereRaw("lower(json_extract(payload,'$.txid'))=?", [txid.toLowerCase()])
                      .select(
                        'position',
                        trx.raw(
                          "CASE WHEN typeof(json_extract(payload,'$.updated_at'))='text' AND length(CAST(json_extract(payload,'$.updated_at') AS BLOB))=24 THEN json_extract(payload,'$.updated_at') END AS updatedAt"
                        )
                      )
                      .limit(2),
                    currentRows = await trx
                      .from(
                        trx.raw('?? INDEXED BY ??', ['proven_tx_reqs', brc38ImportTargetIndexName('provenTxReqs', trx)])
                      )
                      .where({ txid })
                      .select('provenTxReqId')
                      .limit(2)
                  if (
                    incomingDescriptor?.bytes !== original.bytes ||
                    incomingDescriptor.sha256 !== original.sha256 ||
                    sourceRows.length !== 1 ||
                    (reconstruction !== undefined
                      ? currentRows.length !== 1 || currentRows[0].provenTxReqId !== currentRequestId
                      : coordinate === undefined
                        ? currentRows.length !== 0
                        : prior === undefined ||
                          currentDescriptor?.bytes !== prior.bytes ||
                          currentDescriptor.sha256 !== prior.sha256 ||
                          currentRows.length !== 1 ||
                          currentRows[0].provenTxReqId !== currentRequestId)
                  )
                    invalid()
                  assertIsoDate(sourceRows[0].updatedAt, 'original request updated_at')
                  if (incomingUpdatedAt !== undefined && incomingUpdatedAt !== sourceRows[0].updatedAt) invalid()
                  incomingUpdatedAt = sourceRows[0].updatedAt
                  if (selectedAdmission !== undefined) {
                    const actual = await readBrc38ImportJournal(trx, selectedAdmission),
                      serialized = JSON.stringify(actual),
                      revision = await readNativeSnapshotTransactionMembershipRevision(trx)
                    if (
                      (reconstruction === undefined
                        ? actual.state === 'COMPLETE' || actual.state === 'EXPIRED'
                        : actual.state !== 'COMPLETE' || actual.nextRow !== selectedAdmission.totalRows) ||
                      (receipt !== undefined && receipt !== serialized) ||
                      (membership !== undefined && membership !== revision)
                    )
                      invalid()
                    if (reconstruction !== undefined) {
                      const recovery = await readBrc38PrivateMergeRecovery(trx),
                        preceding = brc38ImportTableOrder.slice(0, brc38ImportTableOrder.indexOf('provenTxReqs')),
                        totals = (await trx('table_counts')
                          .whereIn('tableName', preceding)
                          .select(trx.raw('count(*) AS tables,coalesce(sum(rows),0) AS rows'))
                          .limit(2)) as Array<{ tables: number; rows: number }>
                      if (
                        totals.length !== 1 ||
                        totals[0].tables !== preceding.length ||
                        !Number.isSafeInteger(totals[0].rows) ||
                        totals[0].rows < 0 ||
                        !Number.isSafeInteger(1 + totals[0].rows + sourcePosition)
                      )
                        invalid()
                      const target = await trx(brc38PrivateMergeTargetsTable)
                        .where({
                          importId: selectedAdmission.scope.importId,
                          tableName: 'provenTxReqs',
                          sourceRow: 1 + totals[0].rows + sourcePosition
                        })
                        .select('targetRowid')
                        .limit(2)
                      if (
                        recovery?.phase !== 'IMPORT' ||
                        recovery.activeImportId !== selectedAdmission.scope.importId ||
                        recovery.bindingSha256 !== store.binding?.digest ||
                        target.length !== 1 ||
                        target[0].targetRowid !== currentRequestId
                      )
                        invalid()
                    }
                    receipt = serialized
                    membership = revision
                  }
                  store.assertPrivateNativeReadTransaction(trx)
                })
                await measureBrc38StructuredFilesystem(
                  store.directory,
                  ['stage.sqlite', 'stage.sqlite-journal', 'brc38-owner.sqlite', 'brc38-owner.sqlite-journal'],
                  store.limits.maximumPhysicalBytes,
                  sourcePolicy.maximumCombinedTemporaryBytes,
                  sourcePolicy.signal
                )
                actor()
              }
              const owners: Brc38StructuredProjectionOwners = Object.freeze<Brc38StructuredProjectionOwners>({
                check: actor,
                readMappings: (entity, incomingIds) =>
                  io.run(async () => {
                    if (
                      selectedAdmission === undefined ||
                      entity !== 'transaction' ||
                      !Array.isArray(incomingIds) ||
                      incomingIds.length > 128
                    )
                      invalid()
                    await probe()
                    const allowance = working.claim(32768 + 2048 * incomingIds.length)
                    try {
                      const result = await database.transaction(async trx => {
                        store.assertPrivateNativeReadTransaction(trx)
                        const loaded = await loadBrc38ImportIdMap(
                            trx,
                            selectedAdmission.scope,
                            incomingIds.map(incomingId => ({ entity, incomingId, required: false }))
                          ),
                          mapped = incomingIds.map(id =>
                            Object.hasOwn(loaded.map.transaction.idMap, id)
                              ? loaded.map.transaction.idMap[id]
                              : undefined
                          )
                        for (const id of mapped)
                          if (id !== undefined && (!Number.isSafeInteger(id) || id < 1)) invalid()
                        await readNativeSnapshotParentFences(
                          trx,
                          selectedAdmission.scope.userId,
                          [...new Set(mapped.filter((id): id is number => id !== undefined))].map(id => ({
                            entity: 'transaction',
                            id
                          })),
                          sourcePolicy.signal
                        )
                        store.assertPrivateNativeReadTransaction(trx)
                        return Object.freeze(mapped)
                      })
                      await probe()
                      return result
                    } finally {
                      allowance.close()
                    }
                  }),
                openIndex: policy =>
                  io.run(async () => {
                    await probe()
                    if (
                      policy.workingAllocation !== working ||
                      policy.expiresAt !== projectionPolicy.expiresAt ||
                      policy.signal !== projectionPolicy.signal ||
                      !Number.isSafeInteger(policy.maximumTemporaryPhysicalBytes) ||
                      policy.maximumTemporaryPhysicalBytes < 1048576 ||
                      policy.maximumTemporaryPhysicalBytes > projectionPolicy.maximumTemporaryIndexBytes - indexBytes ||
                      !Number.isSafeInteger(policy.maximumTemporaryIndexBytes) ||
                      policy.maximumTemporaryIndexBytes < 1048576 ||
                      policy.maximumTemporaryIndexBytes > policy.maximumTemporaryPhysicalBytes ||
                      policy.maximumTemporaryIndexBytes > projectionPolicy.maximumTemporaryIndexBytes ||
                      !Number.isSafeInteger(policy.maximumMembers) ||
                      policy.maximumMembers < 1 ||
                      policy.maximumMembers > projectionPolicy.maximumMembers ||
                      !Number.isSafeInteger(policy.sourceBytes) ||
                      policy.sourceBytes < 1 ||
                      policy.sourceBytes >
                        Math.max(32, sourcePolicy.maximumStructuredBytes, sourcePolicy.maximumCanonicalBytes) ||
                      (policy.maximumAllocationBytes !== undefined &&
                        (!Number.isSafeInteger(policy.maximumAllocationBytes) ||
                          policy.maximumAllocationBytes < 4096 ||
                          policy.maximumAllocationBytes > working.maximum))
                    )
                      invalid()
                    const reserved = policy.maximumTemporaryPhysicalBytes
                    let index: Brc38NodeJsonIndex
                    try {
                      index = await Brc38NodeJsonIndex.open({
                        ...policy,
                        privateParent: sourcePolicy.privateIndexParent,
                        maximumTemporaryFileBytes: policy.maximumTemporaryIndexBytes
                      })
                    } catch (cause) {
                      if (cause instanceof Brc38StagingCleanupError) retained.add(cause)
                      throw cause
                    }
                    indexBytes += reserved
                    indexes.add(index)
                    await probe()
                    return Object.freeze({
                      put: (object, member) =>
                        io.run(async () => {
                          await probe()
                          await index.put(object, member)
                          await probe()
                        }),
                      seal: () =>
                        io.run(async () => {
                          await probe()
                          await index.seal()
                          await probe()
                        }),
                      lookup: (object, key) =>
                        io.run(async () => {
                          await probe()
                          const result = await index.lookup(object, key)
                          await probe()
                          return result
                        }),
                      entries: async function* (object) {
                        const iterator = index.entries(object)
                        try {
                          for (;;) {
                            const result = await io.run(async () => {
                              await probe()
                              const result = await iterator.next()
                              await probe()
                              return result
                            })
                            if (result.done) return
                            yield result.value
                          }
                        } finally {
                          await iterator.return(undefined)
                        }
                      },
                      close: async () => {
                        await index.close()
                        if (indexes.delete(index)) indexBytes -= reserved
                      }
                    } satisfies Brc38JsonMemberIndex)
                  })
              })
              await probe()
              return await io.retain(async () => {
                const result = await work(
                  Object.freeze({
                    database,
                    ...(prior === undefined ? {} : { prior: Object.freeze({ ...prior }) }),
                    original: Object.freeze({ bytes: original.bytes, sha256: original.sha256 }),
                    incoming,
                    incomingUpdatedAt: incomingUpdatedAt === undefined ? invalid() : incomingUpdatedAt,
                    ...(current === undefined ? {} : { current }),
                    owners,
                    ...(membership === undefined ? {} : { transactionMembershipRevision: membership })
                  })
                )
                await probe()
                return result
              })
            }
            const extra = sourcePolicy.maximumTemporaryIndexBytes + projectionPolicy.maximumTemporaryIndexBytes
            if (reconstruction !== undefined) {
              const current = reconstruction.current
              if (current === undefined) return await consume()
              if ('localRowId' in current)
                return await withBrc38NativeLocalStructuredDatabaseSource(
                  store,
                  reconstruction.source,
                  database,
                  current.localRowId,
                  field,
                  sourcePolicy,
                  consume,
                  extra
                )
              return await withBrc38PrivateCurrentStructuredDatabaseSource(
                store,
                storage,
                database,
                { version: current.version },
                {
                  ...sourcePolicy,
                  maximumStructuredBytes: Math.max(
                    sourcePolicy.maximumStructuredBytes,
                    sourcePolicy.maximumCanonicalBytes
                  )
                },
                consume,
                extra
              )
            }
            return coordinate === undefined
              ? await consume()
              : await withBrc38PrivateCurrentStructuredDatabaseSource(
                  store,
                  storage,
                  database,
                  coordinate,
                  sourcePolicy,
                  consume,
                  extra
                )
          },
          sourcePolicy.maximumTemporaryIndexBytes + projectionPolicy.maximumTemporaryIndexBytes
        )
    )
  } catch (cause) {
    failed = true
    failure = cause
    if (cause instanceof Brc38StagingCleanupError) retained.add(cause)
  }
  live = false
  try {
    await cleanup()
  } catch (cause) {
    throw new Brc38StagingCleanupError(
      failed ? [failure, cause] : [cause],
      'Private occupied request sources callback retains concrete cleanup',
      cleanup
    )
  }
  if (failed) throw failure
  return value
}
