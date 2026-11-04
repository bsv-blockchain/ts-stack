import { promiseFromSync } from '../../utility/promiseFromSync'
import type { SyncMap } from '../schema/entities/EntityBase'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import { ownedNativeRootIdentity } from '../schema/ownedNativeSqliteConnectionsNode'
import { Brc38WorkingAllocation, type Brc38WorkingCharge } from '../portable/Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import { prepareBrc38NativePackedTextWalletWrite } from '../portable/Brc38NativePackedTextWalletNode'
import { planTransactionMerge } from '../schema/entities/EntityTransaction'
import { planOutputMerge } from '../schema/entities/EntityOutput'
import type { KnexSnapshotSyncDestination } from './KnexSnapshotSyncDestination'
import { copySnapshotCursor } from './SnapshotCursor'
import {
  snapshotSyncTables,
  type SnapshotSyncCheckpoint,
  type SnapshotSyncFieldPreparation,
  type SnapshotSyncCommit
} from './SnapshotSync'
import type { WalletReadSnapshot, WalletSnapshotFieldMetadataPage } from './WalletReadSnapshot'
import { detachSnapshotSyncFieldPage, type DetachedSnapshotSyncFieldRow } from './SnapshotSyncFieldRows'
import {
  preparePackedNativeSnapshotField,
  type PreparedPackedNativeSnapshotField
} from './preparePackedNativeSnapshotFieldNode'
import {
  transactionPayloadFields,
  outputPayloadFields,
  transactionScalarTextFields,
  outputScalarTextFields,
  snapshotSyncTransactionMetadata,
  snapshotSyncOutputMetadata
} from './SnapshotSyncActionMetadata'
import {
  readNativeSnapshotSyncActionCurrent,
  requireSameNativeSnapshotSyncActionCurrent,
  nativeSnapshotUnresolvedReclaim,
  nativeSnapshotQuarantineReclaim,
  type NativeSnapshotSyncAction,
  type NativeSnapshotSyncActionCurrent
} from './NativeSnapshotSyncActionsCurrentNode'
import { snapshotSyncSmallText } from './SnapshotSyncSmallText'
import { writeNativeSnapshotSyncRow } from './writeNativeSnapshotSyncRowNode'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'

export interface PreparedNativeSnapshotAction {
  readonly action: NativeSnapshotSyncAction
  readonly metadata: Readonly<Pick<DetachedSnapshotSyncFieldRow, 'fields'>>
  readonly current: NativeSnapshotSyncActionCurrent
  readonly stages: Readonly<Record<string, PreparedPackedNativeSnapshotField>>
  readonly inline: ReturnType<typeof prepareBrc38NativePackedTextWalletWrite>
}
function invalid(): never {
  throw new Error('Native action original source, current row, parents or checkpoint differs')
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid()
  return value
}
const value = (row: object, name: string): unknown => Object.getOwnPropertyDescriptor(row, name)?.value as unknown
/** Complete native transaction/output components. Source payload I/O and
 * genuine staging finish before final writer admission. Shared original merge
 * policies run on fresh current postimages, original mapped parents and actual
 * BRC-177 quarantine. Kept current payloads remain on their same live row; a
 * copied descriptor never grants attachment authority. Atomic row/maps/ACK use
 * the original producer, complete journal epoch and current session/primary. */
export async function prepareNativeSnapshotSyncActions(
  storage: StorageKnex,
  destination: KnexSnapshotSyncDestination,
  input: SnapshotSyncCheckpoint,
  selectedPage: WalletSnapshotFieldMetadataPage<'transactions' | 'outputs'>,
  source: WalletReadSnapshot,
  signal?: AbortSignal
): Promise<SnapshotSyncFieldPreparation> {
  const expected = { ...input, cursor: copySnapshotCursor(input.cursor) },
    table = snapshotSyncTables[expected.tableIndex],
    selectedRows = Object.getOwnPropertyDescriptor(selectedPage, 'rows')
  if (
    (table !== 'transactions' && table !== 'outputs') ||
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
      userId: source.user.userId,
      identityKey: source.user.identityKey,
      sourceStorageIdentityKey: source.sourceStorage.storageIdentityKey,
      chain: source.sourceStorage.chain,
      expiresAt: source.expiresAt
    }),
    working = new Brc38WorkingAllocation(16777216),
    retained = working.claim(16384 + 16 * detached.allocationBytes),
    allocations: Brc38WorkingCharge[] = [],
    stages: PreparedPackedNativeSnapshotField[] = [],
    rows: PreparedNativeSnapshotAction[] = [],
    failures = new Set<Brc38StagingCleanupError>(),
    scalarNames: readonly string[] = table === 'transactions' ? transactionScalarTextFields : outputScalarTextFields,
    payloadNames: readonly string[] = table === 'transactions' ? transactionPayloadFields : outputPayloadFields
  let expiresAt = binding.expiresAt,
    deadline = performance.now() + expiresAt - Date.now(),
    journalEpoch: string | undefined,
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
        source.user.userId !== binding.userId ||
        source.user.identityKey !== binding.identityKey ||
        source.sourceStorage.storageIdentityKey !== binding.sourceStorageIdentityKey ||
        source.sourceStorage.chain !== binding.chain ||
        source.expiresAt !== binding.expiresAt ||
        binding.snapshotId !== expected.snapshotId ||
        binding.identityKey !== expected.identityKey ||
        binding.sourceStorageIdentityKey !== expected.sourceStorageIdentityKey ||
        binding.chain !== storage.chain ||
        !Number.isSafeInteger(binding.expiresAt) ||
        binding.expiresAt > Date.now() + 3600000
      )
        invalid()
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new SnapshotResourceLimitError('Native action preparation reached its original source/session deadline')
    },
    cleanup = async (): Promise<void> => {
      closed = true
      if (applying !== undefined) await applying.catch(() => undefined)
      const causes: unknown[] = []
      for (const stage of stages)
        try {
          await stage.close()
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
          'Native action retains original stages until actual drainage',
          cleanup
        )
      for (const row of rows) for (const field of row.inline.fields) field.bytes.fill(0)
      for (const allocation of allocations) allocation.close()
      allocations.length = 0
      rows.length = 0
      stages.length = 0
      retained.close()
    }
  try {
    check()
    await destination.inspectNativeFieldSession(expected, signal, read => {
      return promiseFromSync(() => {
        check()
        if (read.sourceUserId !== binding.userId) invalid()
        journalEpoch = read.journalEpoch
        expiresAt = Math.min(expiresAt, read.expiresAt)
        deadline = Math.min(deadline, performance.now() + expiresAt - Date.now())
      })
    })
    for (const metadata of detached.rows) {
      const fields: Record<string, unknown> = { ...metadata.fields },
        extents = { ...metadata.extents }
      for (const name of scalarNames)
        if (extents[name] !== undefined) {
          const allowance = working.claim(8192 + 16 * extents[name].bytes)
          try {
            fields[name] = await snapshotSyncSmallText(
              source,
              table,
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
      const action: NativeSnapshotSyncAction =
        table === 'transactions'
          ? { table, row: snapshotSyncTransactionMetadata(fields, extents) }
          : { table, row: snapshotSyncOutputMetadata(fields, extents) }
      if (action.row.userId !== binding.userId) invalid()
      const allowance = working.claim(8192 + 16 * 65536)
      let current: NativeSnapshotSyncActionCurrent
      try {
        current = await destination.inspectNativeFieldSession(expected, signal, async read => {
          check()
          if (read.sourceUserId !== binding.userId || read.journalEpoch !== journalEpoch) invalid()
          const map = await read.loadFieldMappings(table, [metadata.fields])
          return await readNativeSnapshotSyncActionCurrent(
            storage,
            read.transaction,
            read.user.userId,
            action,
            map,
            signal
          )
        })
        allowance.resize(8192 + 16 * current.field.allocationBytes)
        allocations.push(allowance)
      } catch (cause) {
        allowance.close()
        throw cause
      }
      const text: Record<string, string> = {},
        rowStages: Record<string, PreparedPackedNativeSnapshotField> = {}
      let inlineBytes = 0
      for (const name of payloadNames) {
        const cell = value(action.row, name)
        if (typeof cell === 'string') {
          text[name] = cell
          inlineBytes += Buffer.byteLength(cell, 'utf8')
        }
      }
      allocations.push(working.claim(16384 + 16 * inlineBytes))
      const inline = prepareBrc38NativePackedTextWalletWrite(table, text)
      // Cleanup owns copied inline cells before the first asynchronous stage.
      rows.push({ action, metadata, current, stages: rowStages, inline })
      for (const name of payloadNames)
        if (extents[name] !== undefined) {
          check()
          const stage = await preparePackedNativeSnapshotField(
            storage,
            source,
            table,
            metadata.cursor,
            name,
            extents[name],
            { workingAllocation: working, maximumFieldBytes: 1000000000, maximumReadBytes: 16384, expiresAt, signal }
          )
          stages.push(stage)
          rowStages[name] = stage
          check()
        }
      Object.freeze(rowStages)
    }
    check()
    return Object.freeze({
      apply: async () => {
        check()
        if (consumed) invalid()
        consumed = true
        const writerAllocation = working.claim(32768 + 16 * 65536),
          page: WalletSnapshotFieldMetadataPage<'transactions' | 'outputs'> = {
            rows: detached.rows.map(row => ({ fields: row.fields, extents: row.extents, cursor: row.cursor })),
            payloadBytes: detached.allocationBytes,
            done: detached.nextTable !== expected.tableIndex,
            cursor: detached.rows.length === 0 ? expected.cursor : detached.rows[detached.rows.length - 1].cursor
          }
        applying = destination.commitNativeFieldPage(expected, page, signal, async writer => {
          check()
          if (writer.sourceUserId !== binding.userId || writer.journalEpoch !== journalEpoch) invalid()
          const loaded = await writer.loadFieldMappings(
            table,
            rows.map(row => row.metadata.fields)
          )
          const result = await applyPreparedNativeSnapshotActions(
            storage,
            writer.transaction,
            writer.user.userId,
            table,
            rows,
            loaded.map,
            check,
            signal
          )
          await loaded.persist()
          check()
          return result
        })
        try {
          const result = await applying
          check()
          return result
        } finally {
          applying = undefined
          writerAllocation.close()
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
      throw new Brc38StagingCleanupError([cause, error_], 'Native action failed with retained cleanup', cleanup)
    }
    throw cause
  }
}

/** Shared financial action effect for genuine prepared native fields. The
 * caller retains its original actual destination/session or journal window,
 * identity maps, source checks and atomic ACK. A descriptor never replaces a
 * producer: the original writer verifies each real prepared attachment. */
export async function applyPreparedNativeSnapshotActions(
  storage: StorageKnex,
  trx: Knex.Transaction,
  userId: number,
  table: 'transactions' | 'outputs',
  rows: readonly PreparedNativeSnapshotAction[],
  map: SyncMap,
  check: () => void,
  signal?: AbortSignal
): Promise<{ inserts: number; updates: number }> {
  const payloadNames: readonly string[] = table === 'transactions' ? transactionPayloadFields : outputPayloadFields
  if (rows.some(row => row.action.table !== table)) invalid()
  for (const row of rows) {
    check()
    requireSameNativeSnapshotSyncActionCurrent(
      row.current,
      await readNativeSnapshotSyncActionCurrent(storage, trx, userId, row.action, map, signal)
    )
  }
  let inserts = 0,
    updates = 0
  for (const row of rows) {
    check()
    const actual = await readNativeSnapshotSyncActionCurrent(storage, trx, userId, row.action, map, signal),
      current = actual.action
    // Earlier rows may deliberately become this row's local identity;
    // rerun original policies on that real postimage, never cached choices.
    let selected: NativeSnapshotSyncAction | undefined, quarantineTxid: string | undefined
    if (row.action.table === 'transactions') {
      if (current !== undefined && current.table !== 'transactions') invalid()
      const policy = current === undefined ? undefined : planTransactionMerge(current.row, row.action.row, map)
      selected =
        current === undefined
          ? {
              table: 'transactions',
              row: { ...row.action.row, userId: userId, provenTxId: actual.parentIds.provenTxId }
            }
          : policy === undefined
            ? undefined
            : { table: 'transactions', row: policy.row }
      quarantineTxid = policy?.quarantineReclaimTxid
    } else {
      if (current !== undefined && current.table !== 'outputs') invalid()
      const policy = current === undefined ? undefined : planOutputMerge(current.row, row.action.row, map)
      selected =
        current === undefined
          ? {
              table: 'outputs',
              row: {
                ...row.action.row,
                userId: userId,
                transactionId: actual.parentIds.transactionId,
                basketId: actual.parentIds.basketId,
                spentBy: actual.parentIds.spentBy
              }
            }
          : policy === undefined
            ? undefined
            : { table: 'outputs', row: policy }
      if (
        selected?.table === 'outputs' &&
        selected.row.spendable &&
        selected.row.txid !== undefined &&
        (await nativeSnapshotUnresolvedReclaim(trx, userId, selected.row.txid, signal))
      )
        selected.row.spendable = false
    }
    const entity = table === 'transactions' ? 'transaction' : 'output',
      idName = table === 'transactions' ? 'transactionId' : 'outputId',
      incomingId = positive(row.metadata.fields[idName])
    if (selected === undefined) {
      if (actual.field.metadata === undefined) invalid()
      map[entity].idMap[incomingId] = positive(actual.field.metadata[idName])
      continue
    }
    const fields: Record<string, unknown> = { ...selected.row },
      attachments: Record<string, PreparedPackedNativeSnapshotField> = {},
      inlineNames = new Set<string>()
    for (const name of payloadNames) {
      const cell = fields[name]
      if (cell === undefined) continue
      if (typeof cell === 'string') {
        if (cell !== value(row.action.row, name) || !row.inline.fields.some(field => field.field === name)) invalid()
        inlineNames.add(name)
        continue
      }
      delete fields[name]
      if (
        current !== undefined &&
        cell === value(current.row, name) &&
        (actual.field.binaries[name] !== undefined || actual.field.texts?.[name] !== undefined)
      )
        continue
      if (cell !== value(row.action.row, name) || row.stages[name] === undefined) invalid()
      attachments[name] = row.stages[name]
    }
    const currentId = actual.field.metadata === undefined ? undefined : positive(actual.field.metadata[idName]),
      id = await writeNativeSnapshotSyncRow(
        storage,
        trx,
        table,
        fields,
        { row: row.inline.row, fields: row.inline.fields.filter(field => inlineNames.has(field.field)) },
        attachments,
        currentId
      )
    if (currentId !== undefined && id !== currentId) invalid()
    map[entity].idMap[incomingId] = id
    if (quarantineTxid !== undefined)
      await nativeSnapshotQuarantineReclaim(storage, trx, userId, quarantineTxid, signal)
    check()
    if (currentId === undefined) inserts++
    else updates++
  }
  check()
  return { inserts, updates }
}
