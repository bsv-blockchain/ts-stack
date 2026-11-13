import { SHA256 } from '@bsv/sdk/primitives/Hash'
import type { StorageIdb } from '../StorageIdb'
import { packedIdbCurrentMetadataEqual, type PackedIdbCurrentMetadata } from '../idbPackedCurrentMetadata'
import type { PackedIdbMergeIdentity } from '../idbPackedMergeLookup'
import type { PackedIdbStagedField } from '../idbPackedStaging'
import { packedIdbPositive } from '../idbPackedFields'
import { Brc38WorkingAllocation, type Brc38WorkingCharge } from '../portable/Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import type { SyncMap } from '../schema/entities/EntityBase'
import { planTransactionMerge } from '../schema/entities/EntityTransaction'
import { planOutputMerge } from '../schema/entities/EntityOutput'
import {
  IdbSnapshotSyncJournal,
  captureIdbSnapshotSyncCheckpoint,
  type IdbSnapshotSyncRead,
  type IdbSnapshotSyncWriter
} from './IdbSnapshotSyncJournal'
import { detachSnapshotSyncFieldPage, type DetachedSnapshotSyncFieldRow } from './SnapshotSyncFieldRows'
import { preparePackedIdbSnapshotField, type PreparedPackedIdbSnapshotField } from './preparePackedIdbSnapshotField'
import { snapshotSyncTables, type SnapshotSyncCheckpoint, type SnapshotSyncFieldPreparation } from './SnapshotSync'
import { snapshotSyncSmallText } from './SnapshotSyncSmallText'
import {
  transactionPayloadFields,
  outputPayloadFields,
  transactionScalarTextFields,
  outputScalarTextFields,
  snapshotSyncTransactionMetadata,
  snapshotSyncOutputMetadata,
  type SnapshotSyncTransactionRow,
  type SnapshotSyncOutputRow
} from './SnapshotSyncActionMetadata'
import type {
  WalletReadSnapshot,
  WalletSnapshotFieldDescriptor,
  WalletSnapshotFieldMetadataPage
} from './WalletReadSnapshot'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'

type Action =
  | { readonly table: 'transactions'; readonly row: SnapshotSyncTransactionRow }
  | { readonly table: 'outputs'; readonly row: SnapshotSyncOutputRow }
interface PreparedAction {
  readonly action: Action
  readonly metadata: Readonly<DetachedSnapshotSyncFieldRow>
  readonly identity: PackedIdbMergeIdentity
  readonly current?: Readonly<PackedIdbCurrentMetadata>
  readonly parents: Readonly<Record<string, number>>
  readonly stages: Readonly<Record<string, PackedIdbStagedField>>
}
function invalid(): never {
  throw new Error('Prepared action differs from current source, parents, destination or checkpoint')
}
function sameCurrent(
  previous: Readonly<PackedIdbCurrentMetadata> | undefined,
  actual: Readonly<PackedIdbCurrentMetadata> | undefined
): void {
  if (!packedIdbCurrentMetadataEqual(previous, actual)) invalid()
}
function parents(action: Action, map: SyncMap): Readonly<Record<string, number>> {
  const result: Record<string, number> = Object.create(null)
  if (action.table === 'transactions') {
    if (action.row.provenTxId !== undefined)
      result.provenTxId = packedIdbPositive(map.provenTx.idMap[action.row.provenTxId])
  } else {
    result.transactionId = packedIdbPositive(map.transaction.idMap[action.row.transactionId])
    if (action.row.basketId !== undefined)
      result.basketId = packedIdbPositive(map.outputBasket.idMap[action.row.basketId])
    if (action.row.spentBy !== undefined) result.spentBy = packedIdbPositive(map.transaction.idMap[action.row.spentBy])
  }
  // Keep only actual parent-ID DATA, never a parent existence/admission verdict.
  return Object.freeze(result)
}
function sameParents(previous: Readonly<Record<string, number>>, current: Readonly<Record<string, number>>): void {
  if (JSON.stringify(previous) !== JSON.stringify(current)) invalid()
}
async function currentAction(
  table: 'transactions' | 'outputs',
  metadata: Readonly<PackedIdbCurrentMetadata>,
  identity: PackedIdbMergeIdentity,
  map: SyncMap,
  read: IdbSnapshotSyncRead | IdbSnapshotSyncWriter,
  working: Brc38WorkingAllocation,
  check: () => void,
  signal?: AbortSignal
): Promise<Action> {
  const fields: Record<string, unknown> = { ...metadata.fields },
    extents: Record<string, Readonly<WalletSnapshotFieldDescriptor>> = Object.create(null),
    scalarNames: readonly string[] = table === 'transactions' ? transactionScalarTextFields : outputScalarTextFields
  for (const [name, extent] of Object.entries(metadata.extents)) {
    if (!scalarNames.includes(name)) {
      extents[name] = Object.freeze({
        kind: extent.kind === 'utf16' ? 'utf16le' : 'binary',
        bytes: extent.bytes,
        sha256: extent.sha256
      })
      continue
    }
    if (extent.kind !== 'utf16' || extent.bytes > 8192 || extent.bytes % 2 !== 0) invalid()
    check()
    const loan = await read.readCurrentExtent(identity, map, metadata, name, 0, extent.bytes, working, signal)
    try {
      check()
      if (new SHA256().update(loan.bytes).digestHex() !== extent.sha256) invalid()
      let value = ''
      for (let index = 0; index < loan.bytes.length; index += 2)
        value += String.fromCodePoint(loan.bytes[index] | (loan.bytes[index + 1] << 8))
      fields[name] = value
    } finally {
      loan.close()
    }
  }
  return table === 'transactions'
    ? { table, row: snapshotSyncTransactionMetadata(fields, extents) }
    : { table, row: snapshotSyncOutputMetadata(fields, extents) }
}

/** Complete transaction/output field components. All incoming field I/O and
 * genuine content staging drain before write admission. Inside the final
 * native writer, shared entity policies run on fresh current metadata, actual
 * parent mappings and BRC-177 quarantine; row/maps/checkpoint commit together.
 * No descriptor, prepared choice or copied current metadata authorizes a write. */
export async function prepareIdbSnapshotSyncActions(
  storage: StorageIdb,
  input: SnapshotSyncCheckpoint,
  selectedPage: WalletSnapshotFieldMetadataPage<'transactions' | 'outputs'>,
  source: WalletReadSnapshot,
  signal?: AbortSignal
): Promise<SnapshotSyncFieldPreparation> {
  const expected = captureIdbSnapshotSyncCheckpoint(input),
    detached = detachSnapshotSyncFieldPage(expected, selectedPage),
    table = snapshotSyncTables[expected.tableIndex],
    binding = Object.freeze({
      snapshotId: source.snapshotId,
      identityKey: source.user.identityKey,
      userId: source.user.userId,
      chain: source.sourceStorage.chain,
      storageIdentityKey: source.sourceStorage.storageIdentityKey,
      expiresAt: source.expiresAt
    }),
    working = new Brc38WorkingAllocation(16777216),
    retained = working.claim(16384 + 8 * detached.allocationBytes)
  if (
    (table !== 'transactions' && table !== 'outputs') ||
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
  const allocations: Brc38WorkingCharge[] = [],
    stages: PreparedPackedIdbSnapshotField[] = [],
    failures = new Set<Brc38StagingCleanupError>(),
    rows: PreparedAction[] = []
  let journal: IdbSnapshotSyncJournal | undefined,
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
        throw new SnapshotResourceLimitError('Action preparation original source/session admission ended')
    },
    cleanup = async (): Promise<void> => {
      closed = true
      if (applying !== undefined)
        try {
          await applying
        } catch {
          /* Apply caller owns its original failure. */
        }
      const causes: unknown[] = []
      for (const stage of stages)
        try {
          journal?.requireStorage(storage)
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
          'Action preparation retains original stages/allocations until retirement',
          cleanup
        )
      for (const allocation of allocations) allocation.close()
      allocations.length = 0
      rows.length = 0
      stages.length = 0
      retained.close()
    }
  try {
    check()
    journal = await IdbSnapshotSyncJournal.open(storage)
    check()
    const scalarNames: readonly string[] =
        table === 'transactions' ? transactionScalarTextFields : outputScalarTextFields,
      payloadNames: readonly string[] = table === 'transactions' ? transactionPayloadFields : outputPayloadFields
    for (const metadata of detached.rows) {
      const fields: Record<string, unknown> = { ...metadata.fields },
        extents = { ...metadata.extents }
      for (const name of scalarNames)
        if (extents[name] !== undefined) {
          const scalarAllocation = working.claim(8192 + 8 * extents[name].bytes)
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
            allocations.push(scalarAllocation)
            delete extents[name]
          } catch (cause) {
            scalarAllocation.close()
            throw cause
          }
        }
      check()
      const action: Action =
          table === 'transactions'
            ? { table, row: snapshotSyncTransactionMetadata(fields, extents) }
            : { table, row: snapshotSyncOutputMetadata(fields, extents) },
        identity: PackedIdbMergeIdentity =
          action.table === 'transactions'
            ? { table: action.table, txid: action.row.txid, reference: action.row.reference }
            : { table: action.table, transactionId: action.row.transactionId, vout: action.row.vout },
        allowance = working.claim(8192 + 8 * 65536)
      let previous: { current?: Readonly<PackedIdbCurrentMetadata>; parents: Readonly<Record<string, number>> }
      try {
        previous = await journal.inspect(expected, async read => {
          check()
          if (read.sourceUserId !== binding.userId) invalid()
          const map = await read.loadFieldMappings(table, [metadata.fields]),
            current = await read.findCurrentRow(identity, map, 65536, signal)
          expiresAt = Math.min(expiresAt, read.expiresAt)
          deadline = Math.min(deadline, performance.now() + expiresAt - Date.now())
          return { current, parents: parents(action, map) }
        })
        allowance.resize(8192 + 8 * (previous.current?.allocationBytes ?? 0))
        allocations.push(allowance)
      } catch (cause) {
        allowance.close()
        throw cause
      }
      const rowStages: Record<string, PackedIdbStagedField> = Object.create(null)
      // Stage incoming payloads before the writer. Later rows may resolve to a
      // preceding row's local identity, so no earlier choice is cached as policy.
      for (const name of payloadNames)
        if (extents[name] !== undefined) {
          check()
          const stage = await preparePackedIdbSnapshotField(
            storage,
            source,
            table,
            metadata.cursor,
            name,
            extents[name],
            { workingAllocation: working, maximumFieldBytes: 1000000000, maximumReadBytes: 16384, expiresAt, signal }
          )
          stages.push(stage)
          rowStages[name] = stage.staged
          check()
        }
      rows.push(Object.freeze({ action, metadata, identity, ...previous, stages: Object.freeze(rowStages) }))
    }
    check()
    return Object.freeze({
      apply: async () => {
        check()
        if (consumed) throw new Error('Action preparation already consumed; read its durable checkpoint')
        consumed = true
        if (journal === undefined) invalid()
        const writerAllocation = working.claim(32768 + 16 * 65536)
        const effect = journal.commit(expected, detached.nextTable, detached.nextCursor, async writer => {
          check()
          if (writer.sourceUserId !== binding.userId) invalid()
          const loaded = await writer.loadFieldMappings(
            table,
            rows.map(row => row.metadata.fields)
          )
          for (const row of rows) {
            check()
            sameParents(row.parents, parents(row.action, loaded.map))
            sameCurrent(row.current, await writer.findCurrentRow(row.identity, loaded.map, 65536, signal))
          }
          let inserts = 0,
            updates = 0
          for (const row of rows) {
            check()
            const actual = await writer.findCurrentRow(row.identity, loaded.map, 65536, signal),
              current =
                actual === undefined
                  ? undefined
                  : await currentAction(table, actual, row.identity, loaded.map, writer, working, check, signal)
            let selected: Action | undefined, quarantineTxid: string | undefined
            if (row.action.table === 'transactions') {
              if (current !== undefined && current.table !== 'transactions') invalid()
              const policy =
                current === undefined ? undefined : planTransactionMerge(current.row, row.action.row, loaded.map)
              selected =
                actual === undefined
                  ? {
                      table: 'transactions',
                      row: {
                        ...row.action.row,
                        userId: writer.user.userId,
                        provenTxId: row.action.row.provenTxId === undefined ? undefined : row.parents.provenTxId
                      }
                    }
                  : policy === undefined
                    ? undefined
                    : { table: 'transactions', row: policy.row }
              quarantineTxid = policy?.quarantineReclaimTxid
            } else {
              if (current !== undefined && current.table !== 'outputs') invalid()
              const policy =
                current === undefined ? undefined : planOutputMerge(current.row, row.action.row, loaded.map)
              selected =
                actual === undefined
                  ? {
                      table: 'outputs',
                      row: {
                        ...row.action.row,
                        userId: writer.user.userId,
                        transactionId: row.parents.transactionId,
                        basketId: row.parents.basketId,
                        spentBy: row.parents.spentBy
                      }
                    }
                  : policy === undefined
                    ? undefined
                    : { table: 'outputs', row: policy }
              if (
                selected !== undefined &&
                selected.table === 'outputs' &&
                selected.row.spendable &&
                selected.row.txid !== undefined &&
                (await writer.unresolvedReclaim(selected.row.txid, signal))
              )
                selected.row.spendable = false
            }
            const entity = table === 'transactions' ? 'transaction' : 'output',
              idName = table === 'transactions' ? 'transactionId' : 'outputId',
              incomingId = packedIdbPositive(row.metadata.fields[idName])
            if (selected === undefined) {
              if (actual === undefined) invalid()
              loaded.map[entity].idMap[incomingId] = packedIdbPositive(actual.fields[idName])
              continue
            }
            const fields: Record<string, unknown> = { ...selected.row },
              attachments: Record<string, PackedIdbStagedField> = Object.create(null),
              retainedNames: string[] = []
            if (actual === undefined) delete fields[idName]
            for (const name of payloadNames) {
              const value = fields[name]
              if (value === undefined || typeof value === 'string') continue
              delete fields[name]
              if (
                current !== undefined &&
                value === Object.getOwnPropertyDescriptor(current.row, name)?.value &&
                actual?.extents[name] !== undefined
              )
                retainedNames.push(name)
              else {
                if (
                  value !== Object.getOwnPropertyDescriptor(row.action.row, name)?.value ||
                  row.stages[name] === undefined
                )
                  invalid()
                attachments[name] = row.stages[name]
              }
            }
            const key = await storage.writeStagedStorageRow(
                table,
                fields,
                attachments,
                actual === undefined ? 'add' : 'put',
                writer.transaction,
                retainedNames.length === 0 || actual === undefined
                  ? undefined
                  : { revision: actual.revision, names: retainedNames }
              ),
              localId = packedIdbPositive(key)
            if (actual !== undefined && localId !== packedIdbPositive(actual.fields[idName])) invalid()
            loaded.map[entity].idMap[incomingId] = localId
            if (quarantineTxid !== undefined) await writer.quarantineReclaim(quarantineTxid, signal)
            check()
            if (actual === undefined) inserts++
            else updates++
          }
          await loaded.persist()
          check()
          return { inserts, updates }
        })
        applying = effect
        try {
          return await effect
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
      throw new Brc38StagingCleanupError([cause, error_], 'Action preparation failed with retained cleanup', cleanup)
    }
    throw cause
  }
}
