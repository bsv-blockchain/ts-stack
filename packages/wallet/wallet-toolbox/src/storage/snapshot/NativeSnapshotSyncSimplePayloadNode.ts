import type { StorageKnex } from '../StorageKnex'
import { ownedNativeRootIdentity } from '../schema/ownedNativeSqliteConnectionsNode'
import { Brc38WorkingAllocation, type Brc38WorkingCharge } from '../portable/Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import { nativePackedTextSource } from '../portable/Brc38NativePackedTextSources'
import { prepareBrc38NativePackedTextWalletWrite } from '../portable/Brc38NativePackedTextWalletNode'
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
  readNativeSimpleCurrent,
  requireSameNativeSimpleCurrent,
  type NativeSimpleCurrent
} from './NativeSnapshotSyncSimpleCurrentNode'
import {
  nativeSimplePayloadRow,
  nativeSimplePayloadMerge,
  nativeSimplePayloadMetadata,
  nativeSimplePayloadFields,
  nativeSimplePositive,
  type NativeSimplePayloadRow
} from './NativeSnapshotSyncSimpleRows'
import { writeNativeSnapshotSyncRow, type NativeSimplePayloadTable } from './writeNativeSnapshotSyncRowNode'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'

interface PreparedRow {
  readonly incoming: NativeSimplePayloadRow
  readonly metadata: Readonly<DetachedSnapshotSyncFieldRow>
  readonly current: NativeSimpleCurrent
  readonly stages: Readonly<Record<string, PreparedPackedNativeSnapshotField>>
  readonly inline: ReturnType<typeof prepareBrc38NativePackedTextWalletWrite>
}
function invalid(): never {
  throw new Error('Native payload component differs from original source, current row, parents or checkpoint')
}
/** Complete certificate/certificate-field/commission components. All source
 * extent I/O and inline copies precede final writer admission. Actual current
 * rows/journal revisions and parent maps are freshly inspected before effects;
 * original shared entity policies run again on each preceding writer postimage.
 * This building block does not advertise incomplete all-table field support. */
export async function prepareNativeSnapshotSyncSimplePayload(
  storage: StorageKnex,
  destination: KnexSnapshotSyncDestination,
  table: NativeSimplePayloadTable,
  input: SnapshotSyncCheckpoint,
  selectedPage: WalletSnapshotFieldMetadataPage<NativeSimplePayloadTable>,
  source: WalletReadSnapshot,
  signal?: AbortSignal
): Promise<SnapshotSyncFieldPreparation> {
  const expected = { ...input, cursor: copySnapshotCursor(input.cursor) },
    originalRows = Object.getOwnPropertyDescriptor(selectedPage, 'rows')
  if (
    originalRows === undefined ||
    !Object.hasOwn(originalRows, 'value') ||
    !Array.isArray(originalRows.value) ||
    originalRows.value.length > 128 ||
    snapshotSyncTables[expected.tableIndex] !== table
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
    incoming: NativeSimplePayloadRow[] = [],
    allocations: Brc38WorkingCharge[] = [],
    stages: PreparedPackedNativeSnapshotField[] = [],
    failures = new Set<Brc38StagingCleanupError>(),
    rows: PreparedRow[] = []
  let expiresAt = binding.expiresAt,
    deadline = performance.now() + expiresAt - Date.now(),
    consumed = false,
    closed = false,
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
        throw new SnapshotResourceLimitError('Native payload preparation reached its original source/session deadline')
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
          'Native payload page retains original content/lifetimes until actual retirement',
          cleanup
        )
      for (const row of rows) for (const field of row.inline.fields) field.bytes.fill(0)
      for (const allocation of allocations) allocation.close()
      allocations.length = 0
      rows.length = 0
      stages.length = 0
      incoming.length = 0
      retained.close()
    }
  try {
    check()
    for (const row of detached.rows) incoming.push(nativeSimplePayloadRow(table, row.fields, row.extents))
    const inspected = await destination.inspectNativeFieldSession(expected, signal, async read => {
      check()
      if (read.sourceUserId !== binding.userId) invalid()
      const map = await read.loadFieldMappings(
          table,
          detached.rows.map(row => row.fields)
        ),
        current: NativeSimpleCurrent[] = []
      for (const row of incoming) {
        if (row.value.userId !== binding.userId) invalid()
        const allocation = working.claim(8192 + 16 * 65536)
        try {
          const actual = await readNativeSimpleCurrent(storage, read.transaction, read.user.userId, row, map, signal)
          allocation.resize(8192 + 16 * actual.field.allocationBytes)
          allocations.push(allocation)
          current.push(actual)
        } catch (cause) {
          allocation.close()
          throw cause
        }
      }
      return { current, userId: read.user.userId, expiresAt: read.expiresAt, journalEpoch: read.journalEpoch }
    })
    expiresAt = Math.min(expiresAt, inspected.expiresAt)
    deadline = Math.min(deadline, performance.now() + expiresAt - Date.now())
    check()
    for (const [index, row] of incoming.entries()) {
      const current = inspected.current[index],
        selected = nativeSimplePayloadMerge(current.row, row, inspected.userId, current.parent),
        prepared: Record<string, PreparedPackedNativeSnapshotField> = {},
        scalar = selected === undefined ? {} : nativeSimplePayloadMetadata(selected, current.row !== undefined),
        inlineBytes = nativeSimplePayloadFields[table].reduce(
          (bytes, name) =>
            bytes + (typeof scalar[name] === 'string' ? Buffer.byteLength(scalar[name] as string, 'utf8') : 0),
          0
        ),
        inlineAllocation = working.claim(16384 + 16 * inlineBytes)
      allocations.push(inlineAllocation)
      const inline = prepareBrc38NativePackedTextWalletWrite(nativePackedTextSource(table).sql, scalar)
      // Enroll owned inline bytes in cleanup before any field-stage await.
      rows.push({ incoming: row, metadata: detached.rows[index], current, stages: prepared, inline })
      if (selected !== undefined && !(table === 'commissions' && current.row !== undefined)) {
        for (const name of nativeSimplePayloadFields[table]) {
          const extent = detached.rows[index].extents[name]
          if (extent === undefined) continue
          check()
          const stage = await preparePackedNativeSnapshotField(
            storage,
            source,
            table,
            detached.rows[index].cursor,
            name,
            extent,
            { workingAllocation: working, maximumFieldBytes: 1000000000, maximumReadBytes: 16384, expiresAt, signal }
          )
          stages.push(stage)
          prepared[name] = stage
          check()
        }
      }
      Object.freeze(prepared)
    }
    check()
    return Object.freeze({
      apply: async () => {
        check()
        if (consumed) invalid()
        consumed = true
        const writerAllocation = working.claim(16384 + 16 * 65536)
        applying = destination.commitNativeFieldPage(
          expected,
          selectedPageFromDetached(detached, expected),
          signal,
          async writer => {
            check()
            if (writer.sourceUserId !== binding.userId || writer.journalEpoch !== inspected.journalEpoch) invalid()
            const loaded = await writer.loadFieldMappings(
              table,
              rows.map(row => row.metadata.fields)
            )
            for (const row of rows) {
              check()
              requireSameNativeSimpleCurrent(
                row.current,
                await readNativeSimpleCurrent(
                  storage,
                  writer.transaction,
                  writer.user.userId,
                  row.incoming,
                  loaded.map,
                  signal
                )
              )
            }
            let inserts = 0,
              updates = 0
            for (const row of rows) {
              check()
              const actual = await readNativeSimpleCurrent(
                  storage,
                  writer.transaction,
                  writer.user.userId,
                  row.incoming,
                  loaded.map,
                  signal
                ),
                selected = nativeSimplePayloadMerge(actual.row, row.incoming, writer.user.userId, actual.parent)
              if (selected === undefined) {
                if (actual.row === undefined) invalid()
                if (row.incoming.table === 'certificates' && actual.row.table === 'certificates')
                  loaded.map.certificate.idMap[row.incoming.value.certificateId] = actual.row.value.certificateId
                if (row.incoming.table === 'commissions' && actual.row.table === 'commissions')
                  loaded.map.commission.idMap[row.incoming.value.commissionId] = actual.row.value.commissionId
                continue
              }
              const fields = nativeSimplePayloadMetadata(selected, actual.row !== undefined),
                currentId =
                  actual.row === undefined
                    ? undefined
                    : table === 'certificateFields'
                      ? actual.field.textRowId
                      : actual.row.table === 'certificates'
                        ? actual.row.value.certificateId
                        : actual.row.table === 'commissions'
                          ? actual.row.value.commissionId
                          : invalid(),
                retainedCommission = table === 'commissions' && actual.row !== undefined,
                id = await writeNativeSnapshotSyncRow(
                  storage,
                  writer.transaction,
                  table,
                  fields,
                  retainedCommission ? prepareBrc38NativePackedTextWalletWrite('commissions', {}) : row.inline,
                  retainedCommission ? {} : row.stages,
                  currentId
                )
              if (row.incoming.table === 'certificates')
                loaded.map.certificate.idMap[row.incoming.value.certificateId] = nativeSimplePositive(id)
              if (row.incoming.table === 'commissions')
                loaded.map.commission.idMap[row.incoming.value.commissionId] = nativeSimplePositive(id)
              if (actual.row === undefined) inserts++
              else updates++
            }
            await loaded.persist()
            check()
            return { inserts, updates }
          }
        )
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
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Native payload preparation failed with retained cleanup',
        cleanup
      )
    }
    throw cause
  }
}
function selectedPageFromDetached(
  detached: ReturnType<typeof detachSnapshotSyncFieldPage>,
  expected: SnapshotSyncCheckpoint
): WalletSnapshotFieldMetadataPage<NativeSimplePayloadTable> {
  return {
    rows: detached.rows.map(row => ({ fields: row.fields, extents: row.extents, cursor: row.cursor })),
    payloadBytes: detached.allocationBytes,
    done: detached.nextTable !== expected.tableIndex,
    cursor: detached.rows.length === 0 ? expected.cursor : detached.rows[detached.rows.length - 1].cursor
  }
}
