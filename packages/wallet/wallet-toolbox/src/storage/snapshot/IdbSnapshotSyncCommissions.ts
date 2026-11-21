import type { StorageIdb } from '../StorageIdb'
import { packedIdbCurrentMetadataEqual, type PackedIdbCurrentMetadata } from '../idbPackedCurrentMetadata'
import type { PackedIdbStagedField } from '../idbPackedStaging'
import { packedIdbPositive } from '../idbPackedFields'
import { Brc38WorkingAllocation, type Brc38WorkingCharge } from '../portable/Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import { planCommissionMerge, type CommissionMergeRow } from '../schema/entities/EntityCommission'
import { IdbSnapshotSyncJournal, captureIdbSnapshotSyncCheckpoint } from './IdbSnapshotSyncJournal'
import type { SnapshotSyncFieldPreparation } from './SnapshotSync'
import { snapshotSyncTables, type SnapshotSyncCheckpoint } from './SnapshotSync'
import { detachSnapshotSyncFieldPage, type DetachedSnapshotSyncFieldRow } from './SnapshotSyncFieldRows'
import { preparePackedIdbSnapshotField, type PreparedPackedIdbSnapshotField } from './preparePackedIdbSnapshotField'
import type {
  WalletReadSnapshot,
  WalletSnapshotFieldDescriptor,
  WalletSnapshotFieldMetadataPage
} from './WalletReadSnapshot'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'

// These references identify selected DATA only. Genuine content stages and
// same-owner/native row inspection decide which effects may be installed.
type Cell = string | Readonly<WalletSnapshotFieldDescriptor>
interface Row {
  readonly incoming: CommissionMergeRow<Readonly<WalletSnapshotFieldDescriptor>, Cell>
  readonly metadata: Readonly<DetachedSnapshotSyncFieldRow>
  readonly current?: Readonly<PackedIdbCurrentMetadata>
  readonly parent: number
  readonly stages: Readonly<Record<string, PackedIdbStagedField>>
}
function invalid(): never {
  throw new Error('Prepared commission differs from current source, parent, destination or checkpoint')
}
function date(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(Date.prototype.getTime.call(value))) invalid()
  return new Date(Date.prototype.getTime.call(value))
}
function incomingRow(
  metadata: Readonly<DetachedSnapshotSyncFieldRow>
): CommissionMergeRow<Readonly<WalletSnapshotFieldDescriptor>, Cell> {
  const fields = metadata.fields,
    lockingScript = metadata.extents.lockingScript,
    key = metadata.extents.keyOffset
  if (
    lockingScript === undefined ||
    lockingScript.kind !== 'binary' ||
    (key !== undefined && key.kind === 'binary') ||
    (key === undefined && typeof fields.keyOffset !== 'string') ||
    typeof fields.isRedeemed !== 'boolean' ||
    typeof fields.satoshis !== 'number' ||
    !Number.isFinite(fields.satoshis) ||
    Object.keys(fields).some(
      name =>
        ![
          'created_at',
          'updated_at',
          'userId',
          'commissionId',
          'transactionId',
          'isRedeemed',
          'satoshis',
          'keyOffset'
        ].includes(name)
    ) ||
    Object.keys(metadata.extents).some(name => !['lockingScript', 'keyOffset'].includes(name))
  )
    invalid()
  return {
    created_at: date(fields.created_at),
    updated_at: date(fields.updated_at),
    userId: packedIdbPositive(fields.userId),
    commissionId: packedIdbPositive(fields.commissionId),
    transactionId: packedIdbPositive(fields.transactionId),
    isRedeemed: fields.isRedeemed,
    satoshis: fields.satoshis,
    lockingScript,
    keyOffset: key === undefined ? (fields.keyOffset as string) : key
  }
}
function currentRow(
  metadata: Readonly<PackedIdbCurrentMetadata>
): CommissionMergeRow<Readonly<WalletSnapshotFieldDescriptor>, Cell> {
  const fields = metadata.fields,
    script = metadata.extents.lockingScript,
    key = metadata.extents.keyOffset
  if (
    script === undefined ||
    !['array', 'typed'].includes(script.kind) ||
    (key !== undefined && key.kind !== 'utf16') ||
    (key === undefined && typeof fields.keyOffset !== 'string') ||
    typeof fields.isRedeemed !== 'boolean' ||
    typeof fields.satoshis !== 'number' ||
    !Number.isFinite(fields.satoshis) ||
    Object.keys(metadata.extents).some(name => !['lockingScript', 'keyOffset'].includes(name))
  )
    invalid()
  return {
    created_at: date(fields.created_at),
    updated_at: date(fields.updated_at),
    userId: packedIdbPositive(fields.userId),
    commissionId: packedIdbPositive(fields.commissionId),
    transactionId: packedIdbPositive(fields.transactionId),
    isRedeemed: fields.isRedeemed,
    satoshis: fields.satoshis,
    lockingScript: Object.freeze({ kind: 'binary', bytes: script.bytes, sha256: script.sha256 }),
    keyOffset:
      key === undefined
        ? (fields.keyOffset as string)
        : Object.freeze({ kind: 'utf16le', bytes: key.bytes, sha256: key.sha256 })
  }
}
function unchanged(
  previous: Readonly<PackedIdbCurrentMetadata> | undefined,
  actual: Readonly<PackedIdbCurrentMetadata> | undefined
): void {
  if (!packedIdbCurrentMetadataEqual(previous, actual)) invalid()
}

/** Complete commission page component. Source reads/hashes/transcoding
 * and genuine stage finish drain before write admission. The final journal
 * writer re-reads mappings, profile/primary/checkpoint and exact current rows,
 * repeats the shared legacy timestamp policy, then attaches the real stages
 * and ACK in one native transaction. It does not advertise all-table support,
 * authenticate a portable archive, or promote a restored profile. */
export async function prepareIdbSnapshotSyncCommissions(
  storage: StorageIdb,
  input: SnapshotSyncCheckpoint,
  selectedPage: WalletSnapshotFieldMetadataPage<'commissions'>,
  source: WalletReadSnapshot,
  signal?: AbortSignal
): Promise<SnapshotSyncFieldPreparation> {
  const expected = captureIdbSnapshotSyncCheckpoint(input),
    detached = detachSnapshotSyncFieldPage(expected, selectedPage),
    incoming = detached.rows.map(incomingRow),
    sourceBinding = Object.freeze({
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
    snapshotSyncTables[expected.tableIndex] !== 'commissions' ||
    source.fieldReader === undefined ||
    sourceBinding.snapshotId !== expected.snapshotId ||
    sourceBinding.identityKey !== expected.identityKey ||
    sourceBinding.storageIdentityKey !== expected.sourceStorageIdentityKey ||
    sourceBinding.chain !== storage.chain ||
    !Number.isSafeInteger(sourceBinding.expiresAt)
  ) {
    retained.close()
    invalid()
  }
  const currentAllocations: Brc38WorkingCharge[] = []
  const stages: PreparedPackedIdbSnapshotField[] = [],
    failures = new Set<Brc38StagingCleanupError>(),
    rows: Row[] = []
  let journal: IdbSnapshotSyncJournal | undefined
  let expiresAt = sourceBinding.expiresAt,
    deadline = performance.now() + expiresAt - Date.now(),
    consumed = false,
    closed = false,
    closing: Promise<void> | undefined,
    applying: Promise<unknown> | undefined
  const check = (): void => {
      signal?.throwIfAborted()
      journal?.requireStorage(storage)
      if (
        closed ||
        !source.isOpen ||
        source.snapshotId !== sourceBinding.snapshotId ||
        source.expiresAt !== sourceBinding.expiresAt ||
        source.user.identityKey !== sourceBinding.identityKey ||
        source.user.userId !== sourceBinding.userId ||
        source.sourceStorage.storageIdentityKey !== sourceBinding.storageIdentityKey ||
        source.sourceStorage.chain !== sourceBinding.chain
      )
        invalid()
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new SnapshotResourceLimitError('Commission preparation reached its original source/session deadline')
    },
    cleanup = async (): Promise<void> => {
      closed = true
      // Closing during an effect waits for the actual commit/abort and drainage;
      // no preparation allocation/content retirement races the native writer.
      if (applying !== undefined)
        try {
          await applying
        } catch {
          /* The apply caller owns its original failure. */
        }
      const causes: unknown[] = []
      for (const stage of stages)
        try {
          if (journal === undefined) invalid()
          journal.requireStorage(storage)
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
          'Commission page retains original stages/allocations until actual retirement',
          cleanup
        )
      for (const allocation of currentAllocations) allocation.close()
      currentAllocations.length = 0
      rows.length = 0
      stages.length = 0
      incoming.length = 0
      retained.close()
    }
  try {
    check()
    journal = await IdbSnapshotSyncJournal.open(storage)
    check()
    const current = await journal.inspect(expected, async read => {
      if (read.sourceUserId !== sourceBinding.userId) invalid()
      const map = await read.loadFieldMappings(
          'commissions',
          detached.rows.map(row => row.fields)
        ),
        result: Array<{ parent: number; current?: Readonly<PackedIdbCurrentMetadata> }> = []
      for (const row of incoming) {
        const parent = packedIdbPositive(map.transaction.idMap[row.transactionId]),
          allocation = working.claim(8192 + 8 * 65536)
        try {
          const metadata = await read.findCurrentRow(
            { table: 'commissions', transactionId: row.transactionId },
            map,
            65536,
            signal
          )
          allocation.resize(8192 + 8 * (metadata?.allocationBytes ?? 0))
          currentAllocations.push(allocation)
          result.push({ parent, current: metadata })
        } catch (cause) {
          allocation.close()
          throw cause
        }
      }
      return { expiresAt: read.expiresAt, rows: result }
    })
    expiresAt = Math.min(expiresAt, current.expiresAt)
    deadline = Math.min(deadline, performance.now() + expiresAt - Date.now())
    check()
    for (let index = 0; index < incoming.length; index++) {
      const row = incoming[index],
        previous = current.rows[index],
        rowStages: Record<string, PackedIdbStagedField> = Object.create(null)
      if (previous.current === undefined)
        for (const name of ['lockingScript', 'keyOffset'] as const) {
          const extent = detached.rows[index].extents[name]
          if (extent !== undefined) {
            check()
            const stage = await preparePackedIdbSnapshotField(
              storage,
              source,
              'commissions',
              detached.rows[index].cursor,
              name,
              extent,
              { workingAllocation: working, maximumFieldBytes: 1000000000, maximumReadBytes: 16384, expiresAt, signal }
            )
            stages.push(stage)
            rowStages[name] = stage.staged
            check()
          }
        }
      rows.push(
        Object.freeze({ incoming: row, metadata: detached.rows[index], ...previous, stages: Object.freeze(rowStages) })
      )
    }
    check()
    return Object.freeze({
      apply: async () => {
        check()
        if (consumed) throw new Error('Commission preparation already consumed; read its durable checkpoint')
        consumed = true
        if (journal === undefined) invalid()
        const writerAllocation = working.claim(16384 + 8 * 65536)
        const effect = journal.commit(expected, detached.nextTable, detached.nextCursor, async writer => {
          check()
          if (writer.sourceUserId !== sourceBinding.userId) invalid()
          const loaded = await writer.loadFieldMappings(
            'commissions',
            rows.map(row => row.metadata.fields)
          )
          // Check every prepared postimage against the pre-effect current view.
          // Distinct source transactions can map to one local transaction;
          // their commissions merge sequentially under the actual legacy policy.
          // The second pass re-reads the writer's own preceding effects instead
          // of mistaking an in-transaction change for an external stale source.
          for (const row of rows) {
            check()
            if (loaded.map.transaction.idMap[row.incoming.transactionId] !== row.parent) invalid()
            unchanged(
              row.current,
              await writer.findCurrentRow(
                { table: 'commissions', transactionId: row.incoming.transactionId },
                loaded.map,
                65536,
                signal
              )
            )
          }
          let inserts = 0,
            updates = 0
          for (const row of rows) {
            check()
            const actual = await writer.findCurrentRow(
              { table: 'commissions', transactionId: row.incoming.transactionId },
              loaded.map,
              65536,
              signal
            )
            // Recompute policy on actual current metadata in this writer. The
            // preparation's earlier choice is never a semantic/write grant.
            const selected =
              actual === undefined
                ? { ...row.incoming, userId: writer.user.userId, transactionId: row.parent }
                : planCommissionMerge(currentRow(actual), row.incoming)
            if (selected === undefined) {
              if (actual === undefined) invalid()
              loaded.map.commission.idMap[row.incoming.commissionId] = packedIdbPositive(actual.fields.commissionId)
              continue
            }
            const fields: Record<string, unknown> = {
              created_at: selected.created_at,
              updated_at: selected.updated_at,
              userId: selected.userId,
              transactionId: selected.transactionId,
              satoshis: selected.satoshis,
              isRedeemed: selected.isRedeemed
            }
            if (actual !== undefined) fields.commissionId = selected.commissionId
            if (typeof selected.keyOffset === 'string') fields.keyOffset = selected.keyOffset
            const retainedNames = actual === undefined ? [] : Object.keys(actual.extents)
            if (
              actual === undefined &&
              (!Object.hasOwn(row.stages, 'lockingScript') ||
                (typeof selected.keyOffset !== 'string' && !Object.hasOwn(row.stages, 'keyOffset')))
            )
              invalid()
            // Existing commission scripts/key offsets are immutable under the
            // original entity policy. Retain their exact actual current-row
            // pointers in this SAME native writer; hashes alone cannot attach.
            const key = await storage.writeStagedStorageRow(
              'commissions',
              fields,
              actual === undefined ? row.stages : {},
              actual === undefined ? 'add' : 'put',
              writer.transaction,
              actual === undefined || retainedNames.length === 0
                ? undefined
                : { revision: actual.revision, names: retainedNames }
            )
            const localId = packedIdbPositive(key)
            if (actual !== undefined && localId !== packedIdbPositive(actual.fields.commissionId)) invalid()
            loaded.map.commission.idMap[row.incoming.commissionId] = localId
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
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Commission preparation failed with retained cleanup',
        cleanup
      )
    }
    throw cause
  }
}
