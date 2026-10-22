import { promiseFromSync } from '../../utility/promiseFromSync'
import type { StorageIdb } from '../StorageIdb'
import { packedIdbCurrentMetadataEqual, type PackedIdbCurrentMetadata } from '../idbPackedCurrentMetadata'
import { packedIdbPositive } from '../idbPackedFields'
import type { PackedIdbStagedField } from '../idbPackedStaging'
import { Brc38WorkingAllocation, type Brc38WorkingCharge } from '../portable/Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import { Brc38StreamedHistoryProjection } from '../portable/Brc38StreamedHistoryProjection'
import { Brc38StreamedNotifyProjection } from '../portable/Brc38StreamedNotifyProjection'
import { prepareBrc38StreamedNotifyField } from '../portable/Brc38StreamedNotifyField'
import {
  stringifyBrc38StructuredJsonSpan,
  type Brc38StreamedStructured,
  type Brc38StructuredJsonPolicy
} from '../portable/Brc38StructuredJson'
import type { Brc38StructuredProjectionOwners } from '../portable/Brc38StructuredProjectionOwners'
import { planProvenTxReqMergeMetadata } from '../schema/entities/EntityProvenTxReq'
import { snapshotSyncTables, type SnapshotSyncCheckpoint, type SnapshotSyncFieldPreparation } from './SnapshotSync'
import { IdbSnapshotSyncJournal, captureIdbSnapshotSyncCheckpoint } from './IdbSnapshotSyncJournal'
import { IdbSnapshotSyncStructuredWorkspace } from './IdbSnapshotSyncStructuredWorkspace'
import { detachSnapshotSyncFieldPage, type DetachedSnapshotSyncFieldRow } from './SnapshotSyncFieldRows'
import { snapshotSyncRequestMetadata, type SnapshotSyncRequestRow } from './SnapshotSyncRequestMetadata'
import { prepareSnapshotSyncNormalizedNotify } from './SnapshotSyncNormalizedNotify'
import { preparePackedIdbSnapshotField, type PreparedPackedIdbSnapshotField } from './preparePackedIdbSnapshotField'
import { stageIdbSnapshotSyncInlineText, stageIdbSnapshotSyncText } from './stageIdbSnapshotSyncText'
import type {
  WalletReadSnapshot,
  WalletSnapshotFieldDescriptor,
  WalletSnapshotFieldMetadataPage
} from './WalletReadSnapshot'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'

interface PreparedRow {
  readonly metadata: Readonly<DetachedSnapshotSyncFieldRow>
  readonly incoming: SnapshotSyncRequestRow
  readonly current?: Readonly<PackedIdbCurrentMetadata>
  readonly history: PackedIdbStagedField
  readonly notify: PackedIdbStagedField
  readonly rawTx?: PackedIdbStagedField
  readonly inputBEEF?: PackedIdbStagedField
  /** Exact provisional postimage comparisons, usable only by this concrete
   * one-use preparation with the original current row/revision below. */
  readonly historyEqual: boolean
  readonly notifyEqual: boolean
  readonly notifiedReset: boolean
}
function invalid(): never {
  throw new Error('Prepared request differs from its original source, current mappings, row or checkpoint')
}
function sameCurrent(
  previous: Readonly<PackedIdbCurrentMetadata> | undefined,
  actual: Readonly<PackedIdbCurrentMetadata> | undefined
): void {
  if (!packedIdbCurrentMetadataEqual(previous, actual)) invalid()
}
function currentRow(current: Readonly<PackedIdbCurrentMetadata>): SnapshotSyncRequestRow {
  const extents: Record<string, Readonly<WalletSnapshotFieldDescriptor>> = Object.create(null)
  for (const [name, extent] of Object.entries(current.extents))
    extents[name] = Object.freeze({
      kind: extent.kind === 'utf16' ? 'utf16le' : 'binary',
      bytes: extent.bytes,
      sha256: extent.sha256
    })
  return snapshotSyncRequestMetadata(current.fields, extents)
}
async function sameStagedBytes(
  first: PackedIdbStagedField,
  second: PackedIdbStagedField,
  working: Brc38WorkingAllocation,
  check: () => void
): Promise<boolean> {
  check()
  const left = first.descriptor,
    right = second.descriptor
  if (left.kind !== right.kind || left.bytes !== right.bytes || left.sha256 !== right.sha256) return false
  // A digest is only an early inequality check. Read both actual sealed stages
  // in independently owned bounded windows for the equality used by legacy.
  const allowance = working.claim(16384 + 64 * 65536 + 8 * 16384)
  try {
    for (let offset = 0; offset < left.bytes;) {
      check()
      const length = Math.min(16384, left.bytes - offset),
        a = await first.read(offset, length)
      let b: Uint8Array | undefined
      try {
        check()
        b = await second.read(offset, length)
        check()
        if (a.length !== length || b.length !== length) invalid()
        for (let index = 0; index < length; index++) if (a[index] !== b[index]) return false
      } finally {
        a.fill(0)
        b?.fill(0)
      }
      offset += length
    }
    check()
    return true
  } finally {
    allowance.close()
  }
}

/** Ordinary local replica requests. Legacy status/attempts/proof/raw payload
 * remain immutable for occupied rows. Histories/notifications prepare outside
 * the writer, on actual issued stages and leased native indexes. The final
 * writer rechecks current rows and original transaction-membership generation, recomputes
 * scalar policy and commits native IDs, mappings and checkpoint atomically.
 * No partial wallet DTO, source I/O or JSON parsing enters that writer. */
export async function prepareIdbSnapshotSyncProvenTxReqs(
  storage: StorageIdb,
  input: SnapshotSyncCheckpoint,
  selectedPage: WalletSnapshotFieldMetadataPage<'provenTxReqs'>,
  source: WalletReadSnapshot,
  signal?: AbortSignal
): Promise<SnapshotSyncFieldPreparation> {
  const expected = captureIdbSnapshotSyncCheckpoint(input),
    detached = detachSnapshotSyncFieldPage(expected, selectedPage),
    binding = Object.freeze({
      snapshotId: source.snapshotId,
      identityKey: source.user.identityKey,
      userId: source.user.userId,
      storageIdentityKey: source.sourceStorage.storageIdentityKey,
      chain: source.sourceStorage.chain,
      expiresAt: source.expiresAt
    }),
    working = new Brc38WorkingAllocation(16777216),
    retained = working.claim(16384 + 8 * detached.allocationBytes),
    stages = new Set<PreparedPackedIdbSnapshotField>(),
    allocations: Brc38WorkingCharge[] = [],
    rows: PreparedRow[] = [],
    workspaces = new Set<IdbSnapshotSyncStructuredWorkspace>(),
    temporary = new Set<{ close(): Promise<void> }>(),
    failures = new Set<Brc38StagingCleanupError>(),
    txids = new Set<string>()
  if (
    snapshotSyncTables[expected.tableIndex] !== 'provenTxReqs' ||
    source.fieldReader === undefined ||
    binding.snapshotId !== expected.snapshotId ||
    binding.identityKey !== expected.identityKey ||
    binding.storageIdentityKey !== expected.sourceStorageIdentityKey ||
    binding.chain !== storage.chain ||
    !Number.isSafeInteger(binding.expiresAt)
  ) {
    retained.close()
    invalid()
  }
  let journal: IdbSnapshotSyncJournal | undefined,
    transactionMembershipRevision: number | undefined,
    expiresAt = binding.expiresAt,
    deadline = performance.now() + expiresAt - Date.now(),
    closed = false,
    consumed = false,
    closing: Promise<void> | undefined,
    applying: Promise<unknown> | undefined
  const check = (): void => {
      signal?.throwIfAborted()
      journal?.requireStorage(storage)
      if (
        closed ||
        !source.isOpen ||
        source.snapshotId !== binding.snapshotId ||
        source.expiresAt !== binding.expiresAt ||
        source.user.identityKey !== binding.identityKey ||
        source.user.userId !== binding.userId ||
        source.sourceStorage.storageIdentityKey !== binding.storageIdentityKey ||
        source.sourceStorage.chain !== binding.chain
      )
        invalid()
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new SnapshotResourceLimitError('Request preparation reached its original source/session deadline')
    },
    cleanup = async (): Promise<void> => {
      closed = true
      if (applying !== undefined)
        try {
          await applying
        } catch {
          /* Caller retains its original outcome. */
        }
      const causes: unknown[] = []
      for (const item of temporary)
        try {
          await item.close()
          temporary.delete(item)
        } catch (cause) {
          causes.push(cause)
        }
      for (const workspace of workspaces)
        try {
          await workspace.close()
          workspaces.delete(workspace)
        } catch (cause) {
          causes.push(cause)
        }
      for (const stage of stages)
        try {
          journal?.requireStorage(storage)
          await stage.close()
          stages.delete(stage)
        } catch (cause) {
          causes.push(cause)
        }
      for (const failure of failures)
        try {
          await failure.retryCleanup()
          failures.delete(failure)
        } catch (cause) {
          causes.push(cause)
        }
      if (causes.length !== 0)
        throw new Brc38StagingCleanupError(
          causes,
          'Request preparation retains original stage/index/lease drainage',
          cleanup
        )
      for (const allocation of allocations) allocation.close()
      allocations.length = 0
      rows.length = 0
      txids.clear()
      retained.close()
    },
    retain = (stage: PreparedPackedIdbSnapshotField): PreparedPackedIdbSnapshotField => {
      stages.add(stage)
      check()
      return stage
    },
    retire = async (stage: PreparedPackedIdbSnapshotField): Promise<void> => {
      journal?.requireStorage(storage)
      await stage.close()
      stages.delete(stage)
    }
  try {
    check()
    journal = await IdbSnapshotSyncJournal.open(storage)
    await journal.inspect(expected, read => {
      return promiseFromSync(() => {
        check()
        if (read.sourceUserId !== binding.userId) invalid()
        transactionMembershipRevision = read.transactionMembershipRevision
        expiresAt = Math.min(expiresAt, read.expiresAt)
        deadline = Math.min(deadline, performance.now() + expiresAt - Date.now())
      })
    })
    for (const metadata of detached.rows) {
      check()
      const incoming = snapshotSyncRequestMetadata(metadata.fields, metadata.extents)
      if (txids.has(incoming.txid)) invalid()
      txids.add(incoming.txid)
      const allocation = working.claim(8192 + 8 * 65536)
      let current: Readonly<PackedIdbCurrentMetadata> | undefined
      try {
        current = await journal.inspect(expected, async read => {
          check()
          if (
            read.transactionMembershipRevision !== transactionMembershipRevision ||
            read.sourceUserId !== binding.userId
          )
            invalid()
          const map = await read.loadFieldMappings('provenTxReqs', [metadata.fields])
          return await read.findCurrentRow({ table: 'provenTxReqs', txid: incoming.txid }, map, 65536, signal)
        })
        allocation.resize(8192 + 8 * (current?.allocationBytes ?? 0))
        allocations.push(allocation)
      } catch (cause) {
        allocation.close()
        throw cause
      }
      if (current !== undefined) planProvenTxReqMergeMetadata(currentRow(current), incoming)
      const workspace = await IdbSnapshotSyncStructuredWorkspace.open(
        storage,
        journal,
        expected,
        working,
        expiresAt,
        check,
        signal
      )
      workspaces.add(workspace)
      const drained = async function* (chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
          try {
            yield* chunks
          } finally {
            workspace.releaseReadWindows()
          }
        },
        originalStages: PreparedPackedIdbSnapshotField[] = [],
        textPolicy: Brc38StructuredJsonPolicy = {
          maximumInputBytes: 1000000000,
          maximumOutputBytes: 1000000000,
          maximumChunkBytes: 16384,
          maximumAllocationBytes: working.maximum,
          workingAllocation: working,
          signal
        },
        projectionPolicy = {
          maximumTemporaryIndexBytes: 16777216,
          maximumMembers: 1000000,
          maximumOutputBytes: 1000000000,
          maximumReadBytes: 16384,
          maximumIndexAllocationBytes: working.maximum,
          maximumGrammarAllocationBytes: working.maximum,
          workingAllocation: working,
          expiresAt,
          signal,
          legacyNormalizedIntegers: true
        },
        sourceCell = async (
          name: 'history' | 'notify' | 'rawTx' | 'inputBEEF'
        ): Promise<PreparedPackedIdbSnapshotField | undefined> => {
          const value = incoming[name]
          if (value === undefined) return undefined
          const stage = retain(
            typeof value === 'string'
              ? await stageIdbSnapshotSyncInlineText(storage, value, working, expiresAt, check, signal)
              : await preparePackedIdbSnapshotField(storage, source, 'provenTxReqs', metadata.cursor, name, value, {
                  workingAllocation: working,
                  maximumFieldBytes: 1000000000,
                  maximumReadBytes: 16384,
                  expiresAt,
                  signal
                })
          )
          originalStages.push(stage)
          return stage
        },
        historyInput = await sourceCell('history'),
        notifyInput = await sourceCell('notify')
      if (historyInput === undefined || notifyInput === undefined) invalid()
      const incomingHistory = workspace.stagedSource(historyInput.staged),
        owners: Brc38StructuredProjectionOwners = {
          check: workspace.check,
          openIndex: async policy => await workspace.openIndex(policy, historyInput.staged.descriptor),
          readMappings: async (entity, incomingIds) => {
            check()
            if (entity !== 'transaction') invalid()
            // Projection mapping starts after both source visitors reach EOF.
            // Release their last native read loans before reserving this batch.
            workspace.releaseReadWindows()
            const allowance = working.claim(16384 + 8 * 1048576)
            try {
              await journal!.inspect(expected, read => {
                return promiseFromSync(() => {
                  if (read.transactionMembershipRevision !== transactionMembershipRevision) invalid()
                })
              })
              const mapped = await journal!.readNotificationMappings(expected, incomingIds, 1048576, signal)
              await journal!.inspect(expected, read => {
                return promiseFromSync(() => {
                  if (read.transactionMembershipRevision !== transactionMembershipRevision) invalid()
                })
              })
              check()
              return mapped
            } finally {
              allowance.close()
            }
          }
        },
        jsonStage = async (value: Brc38StreamedStructured): Promise<PreparedPackedIdbSnapshotField> =>
          retain(
            await stageIdbSnapshotSyncText(
              storage,
              working,
              expiresAt,
              check,
              () => drained(stringifyBrc38StructuredJsonSpan(value, { start: 0, end: value.length }, textPolicy)),
              () => drained(stringifyBrc38StructuredJsonSpan(value, { start: 0, end: value.length }, textPolicy)),
              signal
            )
          ),
        normalize = async (value: Brc38StreamedStructured): Promise<PreparedPackedIdbSnapshotField> => {
          const normalized = await prepareSnapshotSyncNormalizedNotify(value, owners, textPolicy)
          temporary.add(normalized)
          const stage = retain(
            await stageIdbSnapshotSyncText(
              storage,
              working,
              expiresAt,
              check,
              () => drained(normalized.measureChunks()),
              () => drained(normalized.chunks()),
              signal
            )
          )
          await normalized.close()
          temporary.delete(normalized)
          return stage
        },
        normalizedIncoming = await normalize(workspace.stagedSource(notifyInput.staged))
      originalStages.push(normalizedIncoming)
      let history: PreparedPackedIdbSnapshotField,
        notify: PreparedPackedIdbSnapshotField,
        historyEqual = false,
        notifyEqual = false,
        notifiedReset = false,
        rawTx: PreparedPackedIdbSnapshotField | undefined,
        inputBEEF: PreparedPackedIdbSnapshotField | undefined
      if (current === undefined) {
        history = await jsonStage(incomingHistory)
        const normalizedSource = workspace.stagedSource(normalizedIncoming.staged),
          projection = await Brc38StreamedNotifyProjection.prepare(owners, normalizedSource, projectionPolicy)
        temporary.add(projection)
        notifiedReset = projection.mappedIncomingIds > 0
        const spelling = (measurement: boolean): AsyncIterable<Uint8Array> =>
          stringifyBrc38StructuredJsonSpan(
            normalizedSource,
            { start: 0, end: normalizedSource.length },
            textPolicy,
            undefined,
            {
              member: 'transactionIds',
              check: workspace.check,
              chunks: width => (measurement ? projection.measureChunks(width) : projection.chunks(width)),
              close: () => promiseFromSync(() => undefined)
            }
          )
        notify = retain(
          await stageIdbSnapshotSyncText(
            storage,
            working,
            expiresAt,
            check,
            () => drained(spelling(true)),
            () => drained(spelling(false)),
            signal
          )
        )
        await projection.close()
        temporary.delete(projection)
        rawTx = await sourceCell('rawTx')
        inputBEEF = await sourceCell('inputBEEF')
        // Raw/input payload stages are final row attachments, not temporary.
        for (const stage of [rawTx, inputBEEF])
          if (stage !== undefined) originalStages.splice(originalStages.indexOf(stage), 1)
      } else {
        const currentCell = async (name: 'history' | 'notify'): Promise<Brc38StreamedStructured> => {
            const extent = current!.extents[name]
            if (extent === undefined) {
              const value = current!.fields[name]
              if (typeof value !== 'string') invalid()
              const stage = retain(
                await stageIdbSnapshotSyncInlineText(storage, value, working, expiresAt, check, signal)
              )
              originalStages.push(stage)
              return workspace.stagedSource(stage.staged)
            }
            if (extent.kind !== 'utf16') invalid()
            return workspace.source(
              extent,
              async (offset, length) =>
                await journal!.inspect(expected, async read => {
                  check()
                  const map = await read.loadFieldMappings('provenTxReqs', [metadata.fields])
                  return await read.readCurrentExtent(
                    { table: 'provenTxReqs', txid: incoming.txid },
                    map,
                    current!,
                    name,
                    offset,
                    length,
                    working,
                    signal
                  )
                })
            )
          },
          currentHistory = await currentCell('history'),
          currentNotify = await currentCell('notify'),
          historyBaseline = await jsonStage(currentHistory),
          notifyBaseline = await normalize(currentNotify)
        originalStages.push(historyBaseline, notifyBaseline)
        const selectedHistory = await Brc38StreamedHistoryProjection.prepareField(
          owners,
          incomingHistory,
          projectionPolicy,
          currentHistory
        )
        temporary.add(selectedHistory)
        workspace.releaseReadWindows()
        history = retain(
          await stageIdbSnapshotSyncText(
            storage,
            working,
            expiresAt,
            check,
            () => drained(selectedHistory.measureChunks(16384)),
            () => drained(selectedHistory.chunks(16384)),
            signal
          )
        )
        await selectedHistory.close()
        temporary.delete(selectedHistory)
        const selectedNotify = await prepareBrc38StreamedNotifyField(
          owners,
          workspace.stagedSource(normalizedIncoming.staged),
          projectionPolicy,
          workspace.stagedSource(notifyBaseline.staged)
        )
        temporary.add(selectedNotify)
        notifiedReset = selectedNotify.notifiedReset
        workspace.releaseReadWindows()
        notify = retain(
          await stageIdbSnapshotSyncText(
            storage,
            working,
            expiresAt,
            check,
            () => drained(selectedNotify.measureChunks(16384)),
            () => drained(selectedNotify.chunks(16384)),
            signal
          )
        )
        await selectedNotify.close()
        temporary.delete(selectedNotify)
        historyEqual = await sameStagedBytes(historyBaseline.staged, history.staged, working, check)
        notifyEqual = await sameStagedBytes(notifyBaseline.staged, notify.staged, working, check)
      }
      // End all preparation-only read leases, indexes and input stages before
      // write admission. Final issued stages keep their own genuine issuer.
      await workspace.close()
      workspaces.delete(workspace)
      for (const stage of originalStages) await retire(stage)
      rows.push(
        Object.freeze({
          metadata,
          incoming,
          current,
          history: history.staged,
          notify: notify.staged,
          rawTx: rawTx?.staged,
          inputBEEF: inputBEEF?.staged,
          historyEqual,
          notifyEqual,
          notifiedReset
        })
      )
    }
    check()
    return Object.freeze({
      apply: async () => {
        check()
        if (consumed) throw new Error('Request preparation already consumed; read its durable checkpoint')
        consumed = true
        if (journal === undefined) invalid()
        const allowance = working.claim(16384 + 8 * 65536),
          effect = journal.commit(expected, detached.nextTable, detached.nextCursor, async writer => {
            check()
            if (
              writer.sourceUserId !== binding.userId ||
              writer.transactionMembershipRevision !== transactionMembershipRevision
            )
              invalid()
            const loaded = await writer.loadFieldMappings(
              'provenTxReqs',
              rows.map(row => row.metadata.fields)
            )
            for (const row of rows) {
              check()
              sameCurrent(
                row.current,
                await writer.findCurrentRow(
                  { table: 'provenTxReqs', txid: row.incoming.txid },
                  loaded.map,
                  65536,
                  signal
                )
              )
            }
            let inserts = 0
            for (const row of rows) {
              check()
              const actual = await writer.findCurrentRow(
                { table: 'provenTxReqs', txid: row.incoming.txid },
                loaded.map,
                65536,
                signal
              )
              sameCurrent(row.current, actual)
              const prior = actual === undefined ? undefined : currentRow(actual),
                selected = prior === undefined ? row.incoming : planProvenTxReqMergeMetadata(prior, row.incoming)
              if (
                prior !== undefined &&
                selected.batch === prior.batch &&
                selected.updated_at.getTime() === prior.updated_at.getTime() &&
                row.historyEqual &&
                row.notifyEqual
              ) {
                // addNotifyTransactionId resets memory state, but legacy persists
                // it only when a compared field changes. Keep that write condition.
                loaded.map.provenTxReq.idMap[row.incoming.provenTxReqId] = prior.provenTxReqId
                continue
              }
              const fields: Record<string, unknown> = { ...selected },
                attached: Record<string, PackedIdbStagedField> = {
                  history: row.history,
                  notify: row.notify
                },
                retainedNames: string[] = []
              for (const name of ['rawTx', 'inputBEEF', 'history', 'notify']) delete fields[name]
              if (row.notifiedReset) fields.notified = false
              if (actual === undefined) {
                delete fields.provenTxReqId
                if (row.incoming.provenTxId !== undefined)
                  fields.provenTxId = packedIdbPositive(loaded.map.provenTx.idMap[row.incoming.provenTxId])
                if (row.rawTx === undefined) invalid()
                attached.rawTx = row.rawTx
                if (row.inputBEEF !== undefined) attached.inputBEEF = row.inputBEEF
              } else
                for (const name of Object.keys(actual.extents)) {
                  if (name !== 'history' && name !== 'notify') retainedNames.push(name)
                }
              const key = await storage.writeStagedStorageRow(
                  'proven_tx_reqs',
                  fields,
                  attached,
                  actual === undefined ? 'add' : 'put',
                  writer.transaction,
                  actual === undefined || retainedNames.length === 0
                    ? undefined
                    : { revision: actual.revision, names: retainedNames }
                ),
                localId = packedIdbPositive(key)
              if (prior !== undefined && localId !== prior.provenTxReqId) invalid()
              loaded.map.provenTxReq.idMap[row.incoming.provenTxReqId] = localId
              if (actual === undefined) inserts++
              check()
            }
            await loaded.persist()
            check()
            // Original EntityProvenTxReq.mergeExisting returns false even when it
            // writes. Preserve externally visible update counts exactly.
            return { inserts, updates: 0 }
          })
        applying = effect
        try {
          return await effect
        } finally {
          applying = undefined
          allowance.close()
        }
      },
      close: async () => {
        if (closing !== undefined) return await closing
        closing = cleanup()
        try {
          await closing
        } catch (cause) {
          closing = undefined
          throw cause
        }
      }
    })
  } catch (cause) {
    if (cause instanceof Brc38StagingCleanupError) failures.add(cause)
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError([cause, error_], 'Request preparation failed with retained cleanup', cleanup)
    }
    throw cause
  }
}
