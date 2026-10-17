import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { TableSettings } from '../schema/tables'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import {
  Brc38NativeLocalBaselineSource,
  type Brc38NativeLocalBaselineField
} from './Brc38NativeLocalBaselineSourceNode'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { admissionCopy } from './Brc38ImportJournalCore'
import { readBrc38PrivateMergeRecovery } from './Brc38PrivateMergeRecoverySchemaNode'
import { inspectBrc38PrivateMergePages, brc38PrivateMergePagesTable } from './Brc38PrivateMergePagesNode'
import { brc38PrivateCheckpointData, brc38PrivateCheckpointMaterializationCursor } from './Brc38PrivateCheckpointData'
import { brc38ImportTableOrder, brc38ImportRowForm } from './Brc38ImportForms'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import { decodePortableRow, type PortableRow } from './Brc38PortableRows'
import { stepCopy } from './Brc38ImportJournalContract'
import {
  inspectBrc38PrivateSelectedField,
  type Brc38PrivateSelectedField as Field
} from './Brc38PrivateSelectedFieldInventoryNode'
import { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'
import {
  prepareBrc38PrivateInitialCheckpointText,
  prepareBrc38PrivateReconstructedCheckpointText
} from './Brc38PrivateReconstructedCheckpointTextNode'
import type { Brc38PrivateCurrentStructuredPolicy } from './Brc38PrivateCurrentStructuredSourceNode'
import type { Brc38CheckpointSyncMapDelta } from './Brc38CheckpointSyncMap'
import { collectBrc38NativePackedContent } from './Brc38NativePackedTextFieldsNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { readSnapshotJournalSqliteGeneration } from '../snapshot/journal/SnapshotJournalSqliteGeneration'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import {
  snapshotJournalReceiptPolicy,
  type SnapshotJournalReceiptPolicy
} from '../snapshot/journal/SnapshotJournalReceipt'

const payloads = Object.freeze(['syncMap', 'errorLocal', 'errorOther'] as const)
type Local = Readonly<{
  rowId: number
  metadata: Readonly<Record<string, unknown>>
  fields: readonly Readonly<Brc38NativeLocalBaselineField>[]
}>
function invalid(): never {
  throw new Error(
    'Private checkpoint inventory differs from its original map, complete page deltas or stored postimages'
  )
}
function integer(value: unknown, nonnegative = false): number {
  const result = typeof value === 'bigint' ? Number(value) : value
  if (
    typeof result !== 'number' ||
    !Number.isSafeInteger(result) ||
    (typeof value === 'bigint' && BigInt(result) !== value) ||
    (nonnegative && result < 0)
  )
    invalid()
  return result
}
function date(value: unknown): Date {
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') invalid()
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(result.getTime())) invalid()
  return result
}
function localFields(row: Local): Readonly<Record<string, Field>> {
  if (
    row.fields.length !== payloads.length ||
    payloads.some(name => row.fields.filter(field => field.field === name && field.kind === 'text').length !== 1)
  )
    invalid()
  return Object.freeze(
    Object.fromEntries(
      row.fields.map(field => [
        field.field,
        Object.freeze({ origin: 'local' as const, sourceRowId: row.rowId, bytes: field.bytes })
      ])
    )
  )
}
/** Full original/current operational checkpoint keysets, independent streamed
 * map reconstruction from original data and every actual committed page, and
 * full scalar/three-field comparison. Archived operational rows are inert.
 * Generated values are bounded same-writer DATA, never an inventory verdict.
 * Fresh actual generation/clock/receipt checks surround reads and producers. */
export async function inspectBrc38PrivateCheckpointInventory(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  source: Brc38NativeLocalBaselineSource,
  selected: Readonly<{
    admission: Brc38ImportJournalAdmission
    maximumRows: number
    maximumReadBytes: number
    workingAllocation: Brc38WorkingAllocation
    receiptPolicy: SnapshotJournalReceiptPolicy
    sourcePolicy: Brc38PrivateCurrentStructuredPolicy
    signal?: AbortSignal
  }>
): Promise<Readonly<{ rows: number; pages: number; logicalBytes: string }>> {
  const admission = admissionCopy(selected.admission),
    receiptPolicy = snapshotJournalReceiptPolicy(selected.receiptPolicy),
    binding = store.binding,
    root = storage.toDb(),
    working = brc38WorkingAllocation(selected.workingAllocation),
    maximumRows = integer(selected.maximumRows, true),
    width = integer(selected.maximumReadBytes, true),
    sourcePolicy = Object.freeze({ ...selected.sourcePolicy }),
    signal = selected.signal,
    deadline = performance.now() + Math.max(0, store.operationExpiresAt - Date.now())
  if (
    binding === undefined ||
    working === undefined ||
    root !== store.knex ||
    maximumRows < 1 ||
    maximumRows > 10000000 ||
    width < 1 ||
    width > 16384 ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    sourcePolicy.workingAllocation !== working ||
    sourcePolicy.signal !== signal ||
    sourcePolicy.expiresAt !== store.operationExpiresAt ||
    admission.expiresAt !== store.limits.expiresAt ||
    admission.originalLimitsJson !== binding.limitsJson ||
    admission.scope.bindingSha256 !== binding.digest ||
    admission.scope.archiveSha256 !== binding.binding.archiveSha256
  )
    invalid()
  const frame = working.claim(2097152),
    check = (): void => {
      signal?.throwIfAborted()
      if (
        store.binding !== binding ||
        storage.toDb() !== root ||
        Date.now() >= store.operationExpiresAt ||
        performance.now() >= deadline
      )
        invalid()
      store.assertPrivateNativeDestination(root)
      Brc38NativeLocalBaselineSource.assertSharedWorking(source, working)
      const fence = source.fence
      if (
        fence.mode !== 'merge' ||
        fence.identityKey !== binding.binding.identityKey ||
        fence.chain !== binding.binding.chain ||
        fence.targetStorageIdentityKey !== binding.binding.targetStorageIdentityKey ||
        fence.userId !== admission.scope.userId
      )
        invalid()
    }
  let originalFence: string | undefined,
    rows = 0,
    pages = 0,
    logicalBytes = 0n,
    original: Local | undefined,
    originalCharge: Brc38WorkingCharge | undefined,
    headerCharge: Brc38WorkingCharge | undefined,
    batchCharge: Brc38WorkingCharge | undefined
  const fence = async (k: Knex.Transaction): Promise<void> => {
      check()
      store.assertPrivateNativeReadTransaction(k)
      await verifyBrc38AuthenticatedSourceSeal(k)
      const recovery = await readBrc38PrivateMergeRecovery(k),
        receipt = await readBrc38ImportJournal(k, admission, working),
        generation = await readSnapshotJournalSqliteGeneration(k, receiptPolicy),
        clocks = (await k('snapshot_journal_clock')
          .where({ id: 1 })
          .select(
            'enabled',
            'reason',
            k.raw("CASE WHEN typeof(revision)='integer' AND revision>=0 THEN CAST(revision AS TEXT) END AS revision"),
            k.raw("CASE WHEN typeof(ceiling)='integer' AND ceiling>=revision THEN CAST(ceiling AS TEXT) END AS ceiling")
          )
          .limit(2)) as Array<{ enabled: number; reason: unknown; revision: unknown; ceiling: unknown }>
      if (
        recovery?.phase !== 'IMPORT' ||
        recovery.activeImportId !== admission.scope.importId ||
        recovery.bindingSha256 !== binding.digest ||
        receipt.state !== 'COMPLETE' ||
        receipt.nextRow !== admission.totalRows ||
        !generation.complete ||
        !generation.enabled ||
        clocks.length !== 1 ||
        clocks[0].enabled !== 1 ||
        clocks[0].reason !== null
      )
        invalid()
      const actual = JSON.stringify({
        recovery,
        receipt,
        generation,
        revision: snapshotJournalRevision(clocks[0].revision),
        ceiling: snapshotJournalRevision(clocks[0].ceiling)
      })
      if (originalFence !== undefined && originalFence !== actual) invalid()
      originalFence = actual
      check()
    },
    read = async <T>(operation: (k: Knex.Transaction) => Promise<T>): Promise<T> =>
      await store.withPrivateNativeDatabase(
        true,
        async database =>
          await database.transaction(async k => {
            await fence(k)
            const value = await operation(k)
            await fence(k)
            return value
          })
      ),
    budget = () => ({ maximum: working.maximum, remaining: working.maximum, signal }),
    collect = async (): Promise<void> => {
      for (let page = 0n; ; page++) {
        check()
        if (page > BigInt(store.limits.maximumLogicalBytes) / 512n) invalid()
        const result = await store.withPrivateNativeDatabase(
          false,
          async database =>
            await database.transaction(async k => {
              store.assertPrivateNativeWriteTransaction(k)
              await verifyBrc38AuthenticatedSourceSeal(k)
              const before = (await k('brc38_native_binary_budget')
                .where({ slot: 1 })
                .select('reservedBytes')
                .limit(2)) as Array<{ reservedBytes: unknown }>
              if (before.length !== 1) invalid()
              const prior = integer(before[0].reservedBytes, true),
                collected = await collectBrc38NativePackedContent(k, 32, signal),
                after = (await k('brc38_native_binary_budget')
                  .where({ slot: 1 })
                  .select('reservedBytes')
                  .limit(2)) as Array<{ reservedBytes: unknown }>
              if (after.length !== 1 || (!collected.complete && integer(after[0].reservedBytes, true) >= prior))
                invalid()
              store.assertPrivateNativeWriteTransaction(k)
              return collected
            })
        )
        if (result.complete) break
      }
    }
  try {
    const layout = await read(async k => {
      await inspectBrc38PrivateMergePages(store, k, admission, { workingAllocation: working, signal })
      const sizes = (await k('metadata')
        .where({ slot: 1 })
        .select(
          k.raw("CASE WHEN state='sealed' AND typeof(header)='text' THEN length(CAST(header AS BLOB)) END AS bytes")
        )
        .limit(2)) as Array<{ bytes: unknown }>
      if (sizes.length !== 1) invalid()
      const bytes = integer(sizes[0].bytes, true)
      if (bytes < 1 || bytes > store.limits.maximumRowBytes) invalid()
      headerCharge = working.claim(131072 + 64 * bytes)
      const headers = (await k('metadata').where({ slot: 1 }).select('header').limit(2)) as Array<{ header: unknown }>
      if (
        headers.length !== 1 ||
        typeof headers[0].header !== 'string' ||
        Buffer.byteLength(headers[0].header) !== bytes
      )
        invalid()
      const header = JSON.parse(headers[0].header) as { user: PortableRow; sourceStorage: PortableRow },
        settings = decodePortableRow<TableSettings>('settings', header.sourceStorage),
        offsets = new Map<string, number>(),
        counts = new Map<string, number>()
      if (
        header.user.identityKey !== binding.binding.identityKey ||
        settings.chain !== binding.binding.chain ||
        typeof settings.storageIdentityKey !== 'string' ||
        Buffer.byteLength(settings.storageIdentityKey) > 4096 ||
        typeof settings.storageName !== 'string' ||
        Buffer.byteLength(settings.storageName) > 4096
      )
        invalid()
      let offset = 1
      for (const table of brc38ImportTableOrder) {
        const values = (await k('table_counts').where({ tableName: table }).select('rows').limit(2)) as Array<{
          rows: unknown
        }>
        if (values.length !== 1) invalid()
        const count = integer(values[0].rows, true)
        if (count > store.limits.maximumRows) invalid()
        offsets.set(table, offset)
        counts.set(table, count)
        offset += count
        if (!Number.isSafeInteger(offset) || offset > admission.totalRows) invalid()
      }
      if (offset !== admission.totalRows) invalid()
      return Object.freeze({ settings, offsets, counts })
    })
    let sourceCursor: number | null = null,
      scanned = 0
    for (;;) {
      check()
      const keys = await Brc38NativeLocalBaselineSource.ownedPage(source, 'sync_states', sourceCursor, 1)
      if (keys.length === 0) break
      const rowId = keys[0]
      if (++scanned > maximumRows) invalid()
      await Brc38NativeLocalBaselineSource.withOwnedRow(source, 'sync_states', rowId, async row => {
        if (
          integer(row.metadata.userId) === admission.scope.userId &&
          row.metadata.storageIdentityKey === layout.settings.storageIdentityKey
        ) {
          if (
            original !== undefined ||
            integer(row.metadata.syncStateId) !== rowId ||
            typeof row.metadata.storageName !== 'string'
          )
            invalid()
          const bytes = Object.values(row.metadata).reduce<number>(
            (total, value) => total + (typeof value === 'string' ? Buffer.byteLength(value) : 16),
            0
          )
          originalCharge = working.claim(131072 + 32 * bytes)
          original = Object.freeze({
            rowId,
            metadata: Object.freeze({ ...row.metadata }),
            fields: Object.freeze(row.fields.map(field => Object.freeze({ ...field })))
          })
        }
      })
      sourceCursor = rowId
    }
    const originalFields = original === undefined ? undefined : localFields(original)
    let expected: Record<string, unknown> | undefined = original === undefined ? undefined : { ...original.metadata },
      fields: Readonly<Record<string, Field>> | undefined = originalFields,
      syncStateId: number | undefined,
      afterPage = -1,
      materializedNextRow = 0,
      incrementalCheckpoint = false
    await Brc38PrivateDerivedTextLifetimes.with(
      store,
      { expiresAt: store.operationExpiresAt, workingAllocation: working, signal },
      async lifetimes => {
        // The journal remains the independent source of every delta. Retain
        // only a charged finite window, never a cached source/activation verdict.
        const pending: Brc38CheckpointSyncMapDelta[] = []
        let pendingMappings = 0
        batchCharge = working.claim(0)
        const flush = async (): Promise<string | undefined> => {
          if (pending.length === 0) return undefined
          const current = fields?.syncMap
          if (
            current === undefined ||
            (current.origin !== 'local' && current.origin !== 'version') ||
            current.bytes === null
          )
            invalid()
          const reconstructed = await prepareBrc38PrivateReconstructedCheckpointText(
            store,
            storage,
            source,
            current.origin === 'local'
              ? { localRowId: current.sourceRowId }
              : { version: { bytes: current.bytes, sha256: current.sha256 } },
            sourcePolicy,
            pending,
            budget(),
            lifetimes
          )
          fields = Object.freeze({ ...fields, syncMap: Object.freeze({ origin: 'version', ...reconstructed.output }) })
          pending.length = 0
          pendingMappings = 0
          batchCharge!.resize(0)
          await read(async () => undefined)
          await lifetimes.releaseExcept([{ family: 'text', sha256: reconstructed.output.sha256 }])
          await collect()
          await read(async () => undefined)
          return reconstructed.maximumUpdatedAt
        }
        for (;;) {
          const records = await read(
            async k =>
              (await k(brc38PrivateMergePagesTable)
                .where({ importId: admission.scope.importId })
                .where('fromRow', '>', afterPage)
                .orderBy('fromRow')
                .select('fromRow', 'tableName', 'stepJson', 'checkpointJson', 'writerFinishedAt')
                .limit(1)) as Array<{
                fromRow: number
                tableName: string
                stepJson: string
                checkpointJson: string | null
                writerFinishedAt: number
              }>
          )
          if (records.length === 0) break
          const page = records[0],
            step = stepCopy(JSON.parse(page.stepJson), admission)
          if (page.fromRow !== step.fromRow || page.checkpointJson === null || ++pages > admission.totalRows) invalid()
          const observation = brc38PrivateCheckpointData(JSON.parse(page.checkpointJson))
          if (
            JSON.stringify(observation) !== page.checkpointJson ||
            observation.preparedAt > page.writerFinishedAt ||
            observation.preparedAt >= admission.expiresAt
          )
            invalid()
          if (syncStateId === undefined) syncStateId = observation.syncStateId
          if (observation.protocol === 'brc38-private-checkpoint-data/v2') {
            materializedNextRow = brc38PrivateCheckpointMaterializationCursor(
              observation,
              page.fromRow,
              page.fromRow + step.rows,
              materializedNextRow
            )
            incrementalCheckpoint = true
          } else {
            if (incrementalCheckpoint && materializedNextRow !== page.fromRow) invalid()
            materializedNextRow = page.fromRow + step.rows
          }
          if (observation.syncStateId !== syncStateId || (original !== undefined && original.rowId !== syncStateId))
            invalid()
          const header = page.fromRow === 0,
            name = header
              ? undefined
              : brc38ImportTableOrder.find(
                  table =>
                    page.fromRow >= layout.offsets.get(table)! &&
                    page.fromRow < layout.offsets.get(table)! + layout.counts.get(table)!
                )
          if (page.tableName !== (name ?? 'header') || (!header && name === undefined)) invalid()
          const position = header ? 0 : page.fromRow - layout.offsets.get(name!)!,
            skip = name === 'syncStates' && position > 0,
            done =
              page.fromRow + step.rows === admission.totalRows ||
              name === 'syncStates' ||
              (header &&
                brc38ImportTableOrder
                  .filter(table => table !== 'syncStates')
                  .every(table => layout.counts.get(table) === 0))
          if (skip) {
            if (observation.mode !== 'SKIP' || expected === undefined || fields === undefined) invalid()
            afterPage = page.fromRow
            continue
          }
          if (
            observation.mode === 'SKIP' ||
            (observation.mode === 'NEW') !== (header && original === undefined) ||
            (observation.mode === 'UPDATE' && expected === undefined)
          )
            invalid()
          const form = name === undefined ? undefined : brc38ImportRowForm(name),
            entity =
              form?.entity ??
              (name === 'txLabelMaps'
                ? 'txLabelMap'
                : name === 'outputTagMaps'
                  ? 'outputTagMap'
                  : name === 'certificateFields'
                    ? 'certificateField'
                    : undefined),
            deltaCharge = working.claim(32768 + 4096 * step.rows),
            mappings: Array<Readonly<{ incomingId: number; localId: number }>> = []
          let maximum: Date | undefined,
            importedWhen: Date | undefined,
            timestamp = new Date(observation.preparedAt)
          try {
            if (name !== undefined)
              for (let index = position; index < position + step.rows; index++)
                await read(async k => {
                  const sizes = (await k('rows')
                    .where({ tableName: name, position: index })
                    .select(
                      'bytes',
                      k.raw("CASE WHEN typeof(payload)='text' THEN length(CAST(payload AS BLOB)) END AS actualBytes")
                    )
                    .limit(2)) as Array<{ bytes: unknown; actualBytes: unknown }>
                  if (sizes.length !== 1) invalid()
                  const bytes = integer(sizes[0].bytes, true)
                  if (bytes < 1 || bytes > store.limits.maximumRowBytes || sizes[0].actualBytes !== bytes) invalid()
                  const charge = working.claim(131072 + 64 * bytes)
                  try {
                    const values = (await k('rows')
                      .where({ tableName: name, position: index })
                      .select('payload')
                      .limit(2)) as Array<{ payload: unknown }>
                    if (
                      values.length !== 1 ||
                      typeof values[0].payload !== 'string' ||
                      Buffer.byteLength(values[0].payload) !== bytes
                    )
                      invalid()
                    const incoming = decodePortableRow<Record<string, unknown>>(
                      form!.kind,
                      JSON.parse(values[0].payload) as PortableRow
                    )
                    if (entity !== undefined) {
                      const updated = date(incoming.updated_at)
                      if (maximum === undefined || updated > maximum) maximum = updated
                    }
                    if (form!.entity !== undefined) {
                      const incomingId = integer(incoming[form!.id!]),
                        map = await loadBrc38ImportIdMap(k, admission.scope, [
                          { entity: form!.entity, incomingId, required: true }
                        ]),
                        localId = integer(map.map[form!.entity].idMap[incomingId])
                      if (localId < 1) invalid()
                      mappings.push(Object.freeze({ incomingId, localId }))
                    }
                    if (
                      name === 'syncStates' &&
                      incoming.storageIdentityKey === layout.settings.storageIdentityKey &&
                      incoming.storageName === layout.settings.storageName
                    ) {
                      timestamp = date(incoming.updated_at)
                      importedWhen = incoming.when === undefined ? undefined : date(incoming.when)
                    }
                  } finally {
                    charge.close()
                  }
                })
            if (timestamp.toISOString() !== observation.timestamp) invalid()
            if (observation.mode === 'NEW') {
              expected = {
                created_at: observation.timestamp,
                updated_at: observation.timestamp,
                syncStateId: BigInt(observation.syncStateId),
                userId: BigInt(admission.scope.userId),
                storageIdentityKey: layout.settings.storageIdentityKey,
                storageName: layout.settings.storageName,
                status: 'unknown',
                init: 0n,
                refNum: observation.refNum,
                when: null,
                satoshis: null
              }
              const initial = await prepareBrc38PrivateInitialCheckpointText(store, sourcePolicy, budget(), lifetimes)
              fields = Object.freeze({
                syncMap: Object.freeze({ origin: 'version', ...initial }),
                errorLocal: Object.freeze({ origin: 'null' }),
                errorOther: Object.freeze({ origin: 'null' })
              })
            } else {
              const delta: Brc38CheckpointSyncMapDelta = Object.freeze({
                entity,
                count: entity === undefined ? 0 : step.rows,
                mappings: Object.freeze(mappings),
                maximumUpdatedAt: maximum,
                done
              })
              // A single existing page may contain up to 4,000 mappings; keep
              // that contract, but flush it alone. Ordinary inventory batches
              // retain at most 128 mappings/pages within the same working cap.
              const retainedBytes = (pages: number, ids: number): number => 8192 + 4096 * pages + 4096 * ids,
                retained = pending.length === 0 ? 0 : retainedBytes(pending.length, pendingMappings),
                allowance = Math.floor((working.maximum - working.used + retained) / 4)
              if (
                pending.length >= 128 ||
                pendingMappings + mappings.length > 128 ||
                retainedBytes(pending.length + 1, pendingMappings + mappings.length) > allowance
              )
                await flush()
              // A larger single page is already retained by deltaCharge until
              // its immediate flush; do not charge that same array twice. A
              // tighter existing working budget also falls back to one page.
              const immediate =
                mappings.length > 128 ||
                retainedBytes(1, mappings.length) > Math.floor((working.maximum - working.used) / 4)
              batchCharge!.resize(immediate ? 0 : retainedBytes(pending.length + 1, pendingMappings + mappings.length))
              pending.push(delta)
              pendingMappings += mappings.length
              const maximumUpdatedAt = done || immediate || pendingMappings >= 128 ? await flush() : undefined
              const originalInit = typeof expected!.init === 'bigint' ? integer(expected!.init) : expected!.init
              expected = {
                ...expected,
                created_at: date(expected!.created_at).toISOString(),
                when:
                  expected!.when === null || expected!.when === undefined ? null : date(expected!.when).toISOString(),
                init:
                  originalInit !== 0 && originalInit !== null && originalInit !== undefined && originalInit !== false
                    ? 1n
                    : 0n,
                storageName: layout.settings.storageName,
                updated_at: observation.timestamp
              }
              if (done) expected.when = importedWhen?.toISOString() ?? maximumUpdatedAt ?? null
            }
            await read(async () => undefined)
            if (observation.mode === 'NEW') {
              const map = fields?.syncMap
              await lifetimes.releaseExcept(map?.origin === 'version' ? [{ family: 'text', sha256: map.sha256 }] : [])
              await collect()
            }
            await read(async () => undefined)
          } finally {
            deltaCharge.close()
          }
          afterPage = page.fromRow
        }
        await flush()
        if (incrementalCheckpoint && materializedNextRow !== admission.totalRows) invalid()
        if (expected === undefined || fields === undefined || syncStateId === undefined || pages < 1) invalid()
        let afterSource: number | null = null,
          afterActual: number | null = null,
          targetRows = 0
        for (;;) {
          check()
          const sourceKeys = await Brc38NativeLocalBaselineSource.ownedPage(source, 'sync_states', afterSource, 1),
            keys = await read(async k => {
              const query = k('sync_states').select(k.raw('rowid AS physical')).orderBy('rowid').limit(1)
              if (afterActual !== null) query.whereRaw('rowid > CAST(? AS INTEGER)', [BigInt(afterActual).toString()])
              return (await query.options({ safeIntegers: true })) as Array<{ physical: unknown }>
            })
          if (keys.length === 0) {
            if (sourceKeys.length !== 0) invalid()
            break
          }
          if (keys.length !== 1 || typeof keys[0].physical !== 'bigint') invalid()
          const rowId = integer(keys[0].physical),
            baseline = sourceKeys.length === 1 && sourceKeys[0] === rowId
          if (
            sourceKeys.length > 1 ||
            (sourceKeys.length === 1 && sourceKeys[0] < rowId) ||
            ++rows > maximumRows ||
            (!baseline && (rowId !== syncStateId || original !== undefined))
          )
            invalid()
          const compare = async (local?: Local): Promise<void> => {
            const target = rowId === syncStateId,
              scalar = target ? expected! : local?.metadata,
              selectedFields = target ? fields! : local === undefined ? invalid() : localFields(local)
            if (scalar === undefined || (target && ++targetRows !== 1)) invalid()
            await read(async k => {
              const names = Object.keys(scalar),
                columns = (await k.raw(
                  'SELECT CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name FROM pragma_table_info(?) ORDER BY cid LIMIT 16',
                  ['sync_states']
                )) as Array<{ name: string | null }>
              if (
                names.length !== 11 ||
                columns.length !== 14 ||
                columns.some(
                  column =>
                    column.name === null ||
                    (!Object.hasOwn(scalar, column.name) && !(payloads as readonly string[]).includes(column.name))
                )
              )
                invalid()
              const sizes = (await k('sync_states')
                .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(rowId).toString()])
                .select(
                  k.raw(
                    '(' +
                      names
                        .map(
                          () =>
                            "CASE WHEN typeof(??) IN ('integer','real','null') THEN 8 ELSE coalesce(length(CAST(?? AS BLOB)),0) END"
                        )
                        .join('+') +
                      ') AS bytes',
                    names.flatMap(name => [name, name])
                  )
                )
                .limit(2)) as Array<{ bytes: unknown }>
              if (sizes.length !== 1) invalid()
              const bytes = integer(sizes[0].bytes, true)
              if (bytes > 131072) invalid()
              const charge = working.claim(131072 + 32 * bytes)
              try {
                const actual = (await k('sync_states')
                  .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(rowId).toString()])
                  .select(names)
                  .limit(2)
                  .options({ safeIntegers: true })) as Array<Record<string, unknown>>
                if (actual.length !== 1 || names.some(name => !Object.is(actual[0][name], scalar[name]))) invalid()
              } finally {
                charge.close()
              }
              for (const name of payloads)
                logicalBytes += BigInt(
                  await inspectBrc38PrivateSelectedField(store, source, k, {
                    table: 'syncStates',
                    rowId,
                    field: name,
                    kind: 'text',
                    expected: selectedFields[name],
                    maximumReadBytes: width,
                    workingAllocation: working,
                    signal
                  })
                )
            })
          }
          if (baseline && rowId !== syncStateId) {
            let local: Local | undefined, charge: Brc38WorkingCharge | undefined
            try {
              await Brc38NativeLocalBaselineSource.withOwnedRow(source, 'sync_states', rowId, async row => {
                const bytes = Object.values(row.metadata).reduce<number>(
                  (total, value) => total + (typeof value === 'string' ? Buffer.byteLength(value) : 16),
                  0
                )
                charge = working.claim(131072 + 32 * bytes)
                local = Object.freeze({
                  rowId,
                  metadata: Object.freeze({ ...row.metadata }),
                  fields: Object.freeze(row.fields.map(field => Object.freeze({ ...field })))
                })
              })
              await compare(local)
            } finally {
              charge?.close()
            }
          } else await compare()
          afterActual = rowId
          if (baseline) afterSource = rowId
        }
        if (targetRows !== 1) invalid()
        await read(async k => {
          await inspectBrc38PrivateMergePages(store, k, admission, { workingAllocation: working, signal })
        })
      }
    )
    check()
    return Object.freeze({ rows, pages, logicalBytes: logicalBytes.toString() })
  } finally {
    batchCharge?.close()
    originalCharge?.close()
    headerCharge?.close()
    frame.close()
  }
}
