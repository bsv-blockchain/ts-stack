import type { StorageIdb } from '../StorageIdb'
import { packedIdbCurrentMetadataEqual, type PackedIdbCurrentMetadata } from '../idbPackedCurrentMetadata'
import type { PackedIdbStagedField } from '../idbPackedStaging'
import { packedIdbPositive } from '../idbPackedFields'
import { Brc38WorkingAllocation, type Brc38WorkingCharge } from '../portable/Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import { planCertificateFieldMerge, type CertificateFieldMergeRow } from '../schema/entities/EntityCertificateField'
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
  readonly incoming: CertificateFieldMergeRow<Cell>
  readonly metadata: Readonly<DetachedSnapshotSyncFieldRow>
  readonly current?: Readonly<PackedIdbCurrentMetadata>
  readonly parent: number
  readonly stages: Readonly<Record<string, PackedIdbStagedField>>
}
function invalid(): never {
  throw new Error('Prepared certificate field differs from current source, parent, destination or checkpoint')
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) invalid()
  return value
}
function date(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(Date.prototype.getTime.call(value))) invalid()
  return new Date(Date.prototype.getTime.call(value))
}
function incomingRow(metadata: Readonly<DetachedSnapshotSyncFieldRow>): CertificateFieldMergeRow<Cell> {
  const fields = metadata.fields,
    cell = (name: 'fieldValue' | 'masterKey'): Cell => {
      const extent = metadata.extents[name]
      if (extent !== undefined) {
        if (extent.kind === 'binary') invalid()
        return extent
      }
      if (typeof fields[name] !== 'string') invalid()
      return fields[name]
    }
  if (
    Object.keys(fields).some(
      name =>
        !['created_at', 'updated_at', 'userId', 'certificateId', 'fieldName', 'fieldValue', 'masterKey'].includes(name)
    ) ||
    Object.keys(metadata.extents).some(name => !['fieldValue', 'masterKey'].includes(name))
  )
    invalid()
  return {
    created_at: date(fields.created_at),
    updated_at: date(fields.updated_at),
    userId: packedIdbPositive(fields.userId),
    certificateId: packedIdbPositive(fields.certificateId),
    fieldName: text(fields.fieldName),
    fieldValue: cell('fieldValue'),
    masterKey: cell('masterKey')
  }
}
function currentRow(metadata: Readonly<PackedIdbCurrentMetadata>): CertificateFieldMergeRow<Cell> {
  const cell = (name: 'fieldValue' | 'masterKey'): Cell => {
      const extent = metadata.extents[name]
      if (extent !== undefined) {
        if (extent.kind !== 'utf16') invalid()
        return Object.freeze({ kind: 'utf16le', bytes: extent.bytes, sha256: extent.sha256 })
      }
      if (typeof metadata.fields[name] !== 'string') invalid()
      return metadata.fields[name]
    },
    fields = metadata.fields
  return {
    created_at: date(fields.created_at),
    updated_at: date(fields.updated_at),
    userId: packedIdbPositive(fields.userId),
    certificateId: packedIdbPositive(fields.certificateId),
    fieldName: text(fields.fieldName),
    fieldValue: cell('fieldValue'),
    masterKey: cell('masterKey')
  }
}
function unchanged(
  previous: Readonly<PackedIdbCurrentMetadata> | undefined,
  actual: Readonly<PackedIdbCurrentMetadata> | undefined
): void {
  if (!packedIdbCurrentMetadataEqual(previous, actual)) invalid()
}

/** Complete certificate-field page component. Source reads/hashes/transcoding
 * and genuine stage finish drain before write admission. The final journal
 * writer re-reads mappings, profile/primary/checkpoint and exact current rows,
 * repeats the shared legacy timestamp policy, then attaches the real stages
 * and ACK in one native transaction. It does not advertise all-table support,
 * authenticate a portable archive, or promote a restored profile. */
export async function prepareIdbSnapshotSyncCertificateFields(
  storage: StorageIdb,
  input: SnapshotSyncCheckpoint,
  selectedPage: WalletSnapshotFieldMetadataPage<'certificateFields'>,
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
    snapshotSyncTables[expected.tableIndex] !== 'certificateFields' ||
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
        throw new SnapshotResourceLimitError(
          'Certificate field preparation reached its original source/session deadline'
        )
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
          'Certificate field page retains original stages/allocations until actual retirement',
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
          'certificateFields',
          detached.rows.map(row => row.fields)
        ),
        result: Array<{ parent: number; current?: Readonly<PackedIdbCurrentMetadata> }> = []
      for (const row of incoming) {
        const parent = packedIdbPositive(map.certificate.idMap[row.certificateId]),
          allocation = working.claim(8192 + 8 * 65536)
        try {
          const metadata = await read.findCurrentRow(
            { table: 'certificateFields', certificateId: row.certificateId, fieldName: row.fieldName },
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
        selected = previous.current === undefined ? row : planCertificateFieldMerge(currentRow(previous.current), row),
        rowStages: Record<string, PackedIdbStagedField> = Object.create(null)
      if (selected !== undefined)
        for (const name of ['fieldValue', 'masterKey'] as const) {
          const extent = detached.rows[index].extents[name]
          if (extent !== undefined) {
            check()
            const stage = await preparePackedIdbSnapshotField(
              storage,
              source,
              'certificateFields',
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
        if (consumed) throw new Error('Certificate field preparation already consumed; read its durable checkpoint')
        consumed = true
        if (journal === undefined) invalid()
        const writerAllocation = working.claim(16384 + 8 * 65536)
        const effect = journal.commit(expected, detached.nextTable, detached.nextCursor, async writer => {
          check()
          if (writer.sourceUserId !== sourceBinding.userId) invalid()
          const loaded = await writer.loadFieldMappings(
            'certificateFields',
            rows.map(row => row.metadata.fields)
          )
          // Check every prepared postimage against the pre-effect current view.
          // Distinct source certificates can map to one natural local parent;
          // their fields then merge sequentially under the actual legacy policy.
          // The second pass re-reads the writer's own preceding effects instead
          // of mistaking an in-transaction change for an external stale source.
          for (const row of rows) {
            check()
            if (loaded.map.certificate.idMap[row.incoming.certificateId] !== row.parent) invalid()
            unchanged(
              row.current,
              await writer.findCurrentRow(
                {
                  table: 'certificateFields',
                  certificateId: row.incoming.certificateId,
                  fieldName: row.incoming.fieldName
                },
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
              {
                table: 'certificateFields',
                certificateId: row.incoming.certificateId,
                fieldName: row.incoming.fieldName
              },
              loaded.map,
              65536,
              signal
            )
            // Recompute policy on actual current metadata in this writer. The
            // preparation's earlier choice is never a semantic/write grant.
            const selected =
              actual === undefined
                ? { ...row.incoming, userId: writer.user.userId, certificateId: row.parent }
                : planCertificateFieldMerge(currentRow(actual), row.incoming)
            if (selected === undefined) continue
            const fields: Record<string, unknown> = {
              created_at: selected.created_at,
              updated_at: selected.updated_at,
              userId: selected.userId,
              certificateId: selected.certificateId,
              fieldName: selected.fieldName
            }
            for (const name of ['fieldValue', 'masterKey'] as const) {
              if (typeof selected[name] === 'string') fields[name] = selected[name]
              else if (!Object.hasOwn(row.stages, name) || selected[name] !== row.incoming[name]) invalid()
            }
            const key = await storage.writeStagedStorageRow(
              'certificate_fields',
              fields,
              row.stages,
              actual === undefined ? 'add' : 'put',
              writer.transaction
            )
            if (indexedDB.cmp(key, [row.parent, row.incoming.fieldName]) !== 0) invalid()
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
        'Certificate field preparation failed with retained cleanup',
        cleanup
      )
    }
    throw cause
  }
}
