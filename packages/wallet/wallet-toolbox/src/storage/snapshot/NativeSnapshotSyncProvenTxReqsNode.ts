import type { StorageKnex } from '../StorageKnex'
import { ownedNativeRootIdentity } from '../schema/ownedNativeSqliteConnectionsNode'
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
import type { KnexSnapshotSyncDestination } from './KnexSnapshotSyncDestination'
import { copySnapshotCursor } from './SnapshotCursor'
import {
  snapshotSyncTables,
  type SnapshotSyncCheckpoint,
  type SnapshotSyncFieldPreparation,
  type SnapshotSyncCommit
} from './SnapshotSync'
import { detachSnapshotSyncFieldPage, type DetachedSnapshotSyncFieldRow } from './SnapshotSyncFieldRows'
import { snapshotSyncRequestMetadata, type SnapshotSyncRequestRow } from './SnapshotSyncRequestMetadata'
import { prepareSnapshotSyncNormalizedNotify } from './SnapshotSyncNormalizedNotify'
import {
  preparePackedNativeSnapshotField,
  stageNativeSnapshotSyncText,
  stageNativeSnapshotSyncInlineText,
  type PreparedPackedNativeSnapshotField
} from './preparePackedNativeSnapshotFieldNode'
import { NativeSnapshotSyncStructuredSource } from './NativeSnapshotSyncStructuredSourceNode'
import { NativeSnapshotSyncStructuredWorkspace } from './NativeSnapshotSyncStructuredWorkspaceNode'
import {
  readNativeSnapshotSyncRequestCurrent,
  requireSameNativeSnapshotSyncRequestCurrent,
  readNativeSnapshotSyncRequestCurrentExtent,
  readNativeSnapshotTransactionMembershipRevision,
  readNativeSnapshotNotificationMappings,
  type NativeSnapshotSyncRequestCurrent
} from './NativeSnapshotSyncRequestsCurrentNode'
import { readNativeSnapshotSyncMappingRevision } from './NativeSnapshotSyncMappingSchemaNode'
import { snapshotSyncSmallText } from './SnapshotSyncSmallText'
import { writeNativeSnapshotSyncRow } from './writeNativeSnapshotSyncRowNode'
import type { WalletReadSnapshot, WalletSnapshotFieldMetadataPage } from './WalletReadSnapshot'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'

interface PreparedRow {
  readonly metadata: Readonly<DetachedSnapshotSyncFieldRow>
  readonly incoming: SnapshotSyncRequestRow
  readonly current: NativeSnapshotSyncRequestCurrent
  readonly history: PreparedPackedNativeSnapshotField
  readonly notify: PreparedPackedNativeSnapshotField
  readonly rawTx?: PreparedPackedNativeSnapshotField
  readonly inputBEEF?: PreparedPackedNativeSnapshotField
  readonly historyEqual: boolean
  readonly notifyEqual: boolean
  readonly notifiedReset: boolean
}
function invalid(): never {
  throw new Error('Native request preparation differs from its original source, current mappings, rows or checkpoint')
}
async function sameStagedBytes(
  first: PreparedPackedNativeSnapshotField,
  second: PreparedPackedNativeSnapshotField,
  working: Brc38WorkingAllocation,
  check: () => void
): Promise<boolean> {
  check()
  const left = first.descriptor,
    right = second.descriptor
  if (left.kind !== right.kind || left.bytes !== right.bytes || left.sha256 !== right.sha256) return false
  const allowance = working.claim(16384 + 32 * 65536 + 8 * 16384)
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
/** Complete native local-replica request component. Original occupied status,
 * attempts/proof/raw/input remain unchanged; histories/notifications normalize
 * and merge on actual finite index/byte actors before the writer opens. Its
 * single effect freshly checks the original session/primary/journal, current
 * request/proof generations, actual mapping and transaction event fences,
 * then commits genuine pointer attachments, ID maps and ACK atomically. */
export async function prepareNativeSnapshotSyncProvenTxReqs(
  storage: StorageKnex,
  destination: KnexSnapshotSyncDestination,
  input: SnapshotSyncCheckpoint,
  selectedPage: WalletSnapshotFieldMetadataPage<'provenTxReqs'>,
  source: WalletReadSnapshot,
  signal?: AbortSignal
): Promise<SnapshotSyncFieldPreparation> {
  const expected = { ...input, cursor: copySnapshotCursor(input.cursor) },
    selectedRows = Object.getOwnPropertyDescriptor(selectedPage, 'rows')
  if (
    snapshotSyncTables[expected.tableIndex] !== 'provenTxReqs' ||
    selectedRows === undefined ||
    !Object.hasOwn(selectedRows, 'value') ||
    !Array.isArray(selectedRows.value) ||
    selectedRows.value.length > 128
  )
    invalid()
  const detached = detachSnapshotSyncFieldPage(expected, selectedPage),
    root = storage.knex,
    origin = ownedNativeRootIdentity(root),
    binding = Object.freeze({
      snapshotId: source.snapshotId,
      identityKey: source.user.identityKey,
      userId: source.user.userId,
      storageIdentityKey: source.sourceStorage.storageIdentityKey,
      chain: source.sourceStorage.chain,
      expiresAt: source.expiresAt
    }),
    working = new Brc38WorkingAllocation(16777216),
    retained = working.claim(16384 + 16 * detached.allocationBytes),
    stages = new Set<PreparedPackedNativeSnapshotField>(),
    allocations: Brc38WorkingCharge[] = [],
    rows: PreparedRow[] = [],
    workspaces = new Set<NativeSnapshotSyncStructuredWorkspace>(),
    temporary = new Set<{ close(): Promise<void> }>(),
    failures = new Set<Brc38StagingCleanupError>(),
    txids = new Set<string>()
  let journalEpoch: string | undefined,
    transactionMembershipRevision: string | undefined,
    mappingRevision: string | undefined,
    expiresAt = binding.expiresAt,
    deadline = performance.now() + expiresAt - Date.now(),
    closed = false,
    consumed = false,
    closing: Promise<void> | undefined,
    applying: Promise<SnapshotSyncCommit> | undefined
  const check = (): void => {
      signal?.throwIfAborted()
      if (
        closed ||
        origin?.slot !== 0 ||
        storage.knex !== root ||
        ownedNativeRootIdentity(root)?.token !== origin.token ||
        !source.isOpen ||
        source.fieldReader === undefined ||
        source.snapshotId !== binding.snapshotId ||
        source.expiresAt !== binding.expiresAt ||
        source.user.identityKey !== binding.identityKey ||
        source.user.userId !== binding.userId ||
        source.sourceStorage.storageIdentityKey !== binding.storageIdentityKey ||
        source.sourceStorage.chain !== binding.chain ||
        binding.snapshotId !== expected.snapshotId ||
        binding.identityKey !== expected.identityKey ||
        binding.storageIdentityKey !== expected.sourceStorageIdentityKey ||
        binding.chain !== storage.chain ||
        !Number.isSafeInteger(binding.expiresAt) ||
        binding.expiresAt > Date.now() + 3600000
      )
        invalid()
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new SnapshotResourceLimitError('Native request preparation reached its original deadline')
    },
    cleanup = async (): Promise<void> => {
      closed = true
      if (applying !== undefined) await applying.catch(() => undefined)
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
        throw new Brc38StagingCleanupError(causes, 'Native request retains original stage/index/read drainage', cleanup)
      for (const allocation of allocations) allocation.close()
      allocations.length = 0
      rows.length = 0
      txids.clear()
      retained.close()
    },
    retain = (stage: PreparedPackedNativeSnapshotField): PreparedPackedNativeSnapshotField => {
      stages.add(stage)
      check()
      return stage
    },
    retire = async (stage: PreparedPackedNativeSnapshotField): Promise<void> => {
      await stage.close()
      stages.delete(stage)
    }
  try {
    check()
    await destination.inspectNativeFieldSession(expected, signal, async read => {
      check()
      if (read.sourceUserId !== binding.userId) invalid()
      journalEpoch = read.journalEpoch
      mappingRevision = await readNativeSnapshotSyncMappingRevision(read.transaction)
      transactionMembershipRevision = await readNativeSnapshotTransactionMembershipRevision(read.transaction)
      expiresAt = Math.min(expiresAt, read.expiresAt)
      deadline = Math.min(deadline, performance.now() + expiresAt - Date.now())
    })
    const owner = await NativeSnapshotSyncStructuredSource.open(
      storage,
      destination,
      source,
      expected,
      working,
      expiresAt,
      check,
      signal
    )
    for (const metadata of detached.rows) {
      check()
      const fields: Record<string, unknown> = { ...metadata.fields },
        extents = { ...metadata.extents }
      for (const name of ['status', 'txid', 'batch'])
        if (extents[name] !== undefined) {
          const allowance = working.claim(8192 + 16 * extents[name].bytes)
          try {
            fields[name] = await snapshotSyncSmallText(
              source,
              'provenTxReqs',
              metadata.cursor,
              name,
              extents[name],
              working,
              check
            )
            allocations.push(allowance)
          } catch (cause) {
            allowance.close()
            throw cause
          }
          delete extents[name]
        }
      const incoming = snapshotSyncRequestMetadata(fields, extents)
      if (txids.has(incoming.txid)) invalid()
      txids.add(incoming.txid)
      const allocation = working.claim(16384 + 16 * 65536)
      let current: NativeSnapshotSyncRequestCurrent
      try {
        current = await destination.inspectNativeFieldSession(expected, signal, async read => {
          check()
          if (
            read.sourceUserId !== binding.userId ||
            read.journalEpoch !== journalEpoch ||
            (await readNativeSnapshotSyncMappingRevision(read.transaction)) !== mappingRevision ||
            (await readNativeSnapshotTransactionMembershipRevision(read.transaction)) !== transactionMembershipRevision
          )
            invalid()
          const map = await read.loadFieldMappings('provenTxReqs', [metadata.fields])
          return await readNativeSnapshotSyncRequestCurrent(
            storage,
            read.transaction,
            read.user.userId,
            incoming,
            map,
            signal
          )
        })
        allocation.resize(16384 + 16 * current.field.allocationBytes)
        allocations.push(allocation)
      } catch (cause) {
        allocation.close()
        throw cause
      }
      if (current.row !== undefined) planProvenTxReqMergeMetadata(current.row, incoming)
      const workspace = await NativeSnapshotSyncStructuredWorkspace.open(owner)
      workspaces.add(workspace)
      const drained = async function* (chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
          try {
            yield* chunks
          } finally {
            workspace.releaseReadWindows()
          }
        },
        originalStages: PreparedPackedNativeSnapshotField[] = [],
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
        ): Promise<PreparedPackedNativeSnapshotField | undefined> => {
          const cell = incoming[name]
          if (cell === undefined) return undefined
          let stage: PreparedPackedNativeSnapshotField
          if (typeof cell === 'string') {
            if (name !== 'history' && name !== 'notify') invalid()
            stage = retain(await stageNativeSnapshotSyncInlineText(owner, name, cell))
          } else
            stage = retain(
              await preparePackedNativeSnapshotField(storage, source, 'provenTxReqs', metadata.cursor, name, cell, {
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
      const incomingHistory = workspace.stagedSource(historyInput, 'history'),
        owners: Brc38StructuredProjectionOwners = {
          check: workspace.check,
          openIndex: workspace.openIndex,
          readMappings: async (entity, incomingIds) => {
            check()
            if (entity !== 'transaction') invalid()
            workspace.releaseReadWindows()
            const allowance = working.claim(16384 + 8 * 1048576)
            try {
              return await destination.inspectNativeFieldSession(expected, signal, async read => {
                check()
                if (
                  read.sourceUserId !== binding.userId ||
                  read.journalEpoch !== journalEpoch ||
                  (await readNativeSnapshotSyncMappingRevision(read.transaction)) !== mappingRevision ||
                  (await readNativeSnapshotTransactionMembershipRevision(read.transaction)) !==
                    transactionMembershipRevision
                )
                  invalid()
                const mapped = await readNativeSnapshotNotificationMappings(
                  read.transaction,
                  read.user.userId,
                  expected.sourceStorageIdentityKey,
                  incomingIds,
                  signal
                )
                check()
                return mapped
              })
            } finally {
              allowance.close()
            }
          }
        },
        jsonStage = async (cell: Brc38StreamedStructured): Promise<PreparedPackedNativeSnapshotField> =>
          retain(
            await stageNativeSnapshotSyncText(
              owner,
              'history',
              () => drained(stringifyBrc38StructuredJsonSpan(cell, { start: 0, end: cell.length }, textPolicy)),
              () => drained(stringifyBrc38StructuredJsonSpan(cell, { start: 0, end: cell.length }, textPolicy))
            )
          ),
        normalize = async (cell: Brc38StreamedStructured): Promise<PreparedPackedNativeSnapshotField> => {
          const normalized = await prepareSnapshotSyncNormalizedNotify(cell, owners, textPolicy)
          temporary.add(normalized)
          const stage = retain(
            await stageNativeSnapshotSyncText(
              owner,
              'notify',
              () => drained(normalized.measureChunks()),
              () => drained(normalized.chunks())
            )
          )
          await normalized.close()
          temporary.delete(normalized)
          return stage
        },
        normalizedIncoming = await normalize(workspace.stagedSource(notifyInput, 'notify'))
      originalStages.push(normalizedIncoming)
      let history: PreparedPackedNativeSnapshotField,
        notify: PreparedPackedNativeSnapshotField,
        historyEqual = false,
        notifyEqual = false,
        notifiedReset = false,
        rawTx: PreparedPackedNativeSnapshotField | undefined,
        inputBEEF: PreparedPackedNativeSnapshotField | undefined
      if (current.row === undefined) {
        history = await jsonStage(incomingHistory)
        const normalizedSource = workspace.stagedSource(normalizedIncoming, 'notify'),
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
              close: async () => undefined
            }
          )
        notify = retain(
          await stageNativeSnapshotSyncText(
            owner,
            'notify',
            () => drained(spelling(true)),
            () => drained(spelling(false))
          )
        )
        await projection.close()
        temporary.delete(projection)
        rawTx = await sourceCell('rawTx')
        inputBEEF = await sourceCell('inputBEEF')
        for (const stage of [rawTx, inputBEEF])
          if (stage !== undefined) originalStages.splice(originalStages.indexOf(stage), 1)
      } else {
        const currentCell = async (name: 'history' | 'notify'): Promise<Brc38StreamedStructured> => {
            const extent = current.field.texts?.[name]
            if (extent === undefined) invalid()
            return await workspace.currentSource(extent, async (offset, length) => {
              const allowance = working.claim(16384 + 8 * 65536 + 4 * length)
              let bytes: Uint8Array | undefined
              try {
                bytes = await destination.inspectNativeFieldSession(expected, signal, async read => {
                  check()
                  if (read.sourceUserId !== binding.userId || read.journalEpoch !== journalEpoch) invalid()
                  const map = await read.loadFieldMappings('provenTxReqs', [metadata.fields])
                  return await readNativeSnapshotSyncRequestCurrentExtent(
                    storage,
                    read.transaction,
                    read.user.userId,
                    incoming,
                    map,
                    current,
                    name,
                    offset,
                    length,
                    signal
                  )
                })
                return {
                  bytes,
                  close: () => {
                    bytes?.fill(0)
                    allowance.close()
                  }
                }
              } catch (cause) {
                bytes?.fill(0)
                allowance.close()
                throw cause
              }
            })
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
          await stageNativeSnapshotSyncText(
            owner,
            'history',
            () => drained(selectedHistory.measureChunks(16384)),
            () => drained(selectedHistory.chunks(16384))
          )
        )
        await selectedHistory.close()
        temporary.delete(selectedHistory)
        const selectedNotify = await prepareBrc38StreamedNotifyField(
          owners,
          workspace.stagedSource(normalizedIncoming, 'notify'),
          projectionPolicy,
          workspace.stagedSource(notifyBaseline, 'notify')
        )
        temporary.add(selectedNotify)
        notifiedReset = selectedNotify.notifiedReset
        workspace.releaseReadWindows()
        notify = retain(
          await stageNativeSnapshotSyncText(
            owner,
            'notify',
            () => drained(selectedNotify.measureChunks(16384)),
            () => drained(selectedNotify.chunks(16384))
          )
        )
        await selectedNotify.close()
        temporary.delete(selectedNotify)
        historyEqual = await sameStagedBytes(historyBaseline, history, working, check)
        notifyEqual = await sameStagedBytes(notifyBaseline, notify, working, check)
      }
      await workspace.close()
      workspaces.delete(workspace)
      for (const stage of originalStages) await retire(stage)
      rows.push(
        Object.freeze({
          metadata,
          incoming,
          current,
          history,
          notify,
          rawTx,
          inputBEEF,
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
        if (consumed) invalid()
        consumed = true
        const allowance = working.claim(32768 + 16 * 65536),
          page: WalletSnapshotFieldMetadataPage<'provenTxReqs'> = {
            rows: detached.rows.map(row => ({ fields: row.fields, extents: row.extents, cursor: row.cursor })),
            payloadBytes: detached.allocationBytes,
            done: detached.nextTable !== expected.tableIndex,
            cursor: detached.rows.length === 0 ? expected.cursor : detached.rows[detached.rows.length - 1].cursor
          }
        applying = destination.commitNativeFieldPage(expected, page, signal, async writer => {
          check()
          if (
            writer.sourceUserId !== binding.userId ||
            writer.journalEpoch !== journalEpoch ||
            (await readNativeSnapshotSyncMappingRevision(writer.transaction)) !== mappingRevision ||
            (await readNativeSnapshotTransactionMembershipRevision(writer.transaction)) !==
              transactionMembershipRevision
          )
            invalid()
          const loaded = await writer.loadFieldMappings(
            'provenTxReqs',
            rows.map(row => row.metadata.fields)
          )
          for (const row of rows) {
            check()
            requireSameNativeSnapshotSyncRequestCurrent(
              row.current,
              await readNativeSnapshotSyncRequestCurrent(
                storage,
                writer.transaction,
                writer.user.userId,
                row.incoming,
                loaded.map,
                signal
              )
            )
          }
          let inserts = 0
          for (const row of rows) {
            check()
            const actual = await readNativeSnapshotSyncRequestCurrent(
              storage,
              writer.transaction,
              writer.user.userId,
              row.incoming,
              loaded.map,
              signal
            )
            requireSameNativeSnapshotSyncRequestCurrent(row.current, actual)
            const prior = actual.row,
              selected = prior === undefined ? row.incoming : planProvenTxReqMergeMetadata(prior, row.incoming)
            if (
              prior !== undefined &&
              selected.batch === prior.batch &&
              selected.updated_at.getTime() === prior.updated_at.getTime() &&
              row.historyEqual &&
              row.notifyEqual
            ) {
              loaded.map.provenTxReq.idMap[row.incoming.provenTxReqId] = prior.provenTxReqId
              continue
            }
            const fields: Record<string, unknown> = { ...selected },
              attached: Record<string, PreparedPackedNativeSnapshotField> = { history: row.history, notify: row.notify }
            for (const name of ['rawTx', 'inputBEEF', 'history', 'notify']) delete fields[name]
            if (row.notifiedReset) fields.notified = false
            if (prior === undefined) {
              delete fields.provenTxReqId
              fields.provenTxId = actual.incomingProvenTxId
              if (row.rawTx === undefined) invalid()
              attached.rawTx = row.rawTx
              if (row.inputBEEF !== undefined) attached.inputBEEF = row.inputBEEF
            }
            const localId = await writeNativeSnapshotSyncRow(
              storage,
              writer.transaction,
              'provenTxReqs',
              fields,
              { row: {}, fields: [] },
              attached,
              prior?.provenTxReqId
            )
            if (prior !== undefined && localId !== prior.provenTxReqId) invalid()
            loaded.map.provenTxReq.idMap[row.incoming.provenTxReqId] = localId
            if (prior === undefined) inserts++
            check()
          }
          await loaded.persist()
          check()
          return { inserts, updates: 0 }
        })
        try {
          const result = await applying
          check()
          return result
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
      throw new Brc38StagingCleanupError([cause, error_], 'Native request failed with retained cleanup', cleanup)
    }
    throw cause
  }
}
