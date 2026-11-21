import { promiseFromSync } from '../../utility/promiseFromSync'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import {
  Brc38NativeLocalBaselineSource,
  type Brc38NativeLocalBaselineField
} from './Brc38NativeLocalBaselineSourceNode'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { admissionCopy } from './Brc38ImportJournalCore'
import { readBrc38PrivateMergeRecovery } from './Brc38PrivateMergeRecoverySchemaNode'
import { inspectBrc38PrivateMergePages } from './Brc38PrivateMergePagesNode'
import { inspectBrc38PrivateProofInventory } from './Brc38PrivateProofInventoryNode'
import { brc38ImportTableOrder } from './Brc38ImportForms'
import { nextBrc38PrivateMergeTargetAlias } from './Brc38PrivateMergeTargetsNode'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import { decodePortableRow, type PortableRow } from './Brc38PortableRows'
import { readBrc38SqlBinaryDescriptors } from './Brc38SqlBinaryStaging'
import { readBrc38SqlStructuredDescriptors } from './Brc38SqlStructuredStaging'
import {
  inspectBrc38PrivateSelectedField,
  type Brc38PrivateSelectedField as Field
} from './Brc38PrivateSelectedFieldInventoryNode'
import { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'
import { compareBrc38PrivateDerivedText } from './Brc38PrivateDerivedTextComparisonNode'
import { prepareBrc38PrivateReconstructedHistoryText } from './Brc38PrivateOccupiedHistoryTextNode'
import { prepareBrc38PrivateReconstructedNotifyText } from './Brc38PrivateOccupiedNotifyTextNode'
import { prepareBrc38PrivateReconstructedNewRequestText } from './Brc38PrivateNewRequestTextNode'
import type { Brc38PrivateRequestReconstruction } from './Brc38PrivateOccupiedRequestSourcesNode'
import type { Brc38PrivateCurrentStructuredPolicy } from './Brc38PrivateCurrentStructuredSourceNode'
import type { Brc38StreamedHistoryProjectionPolicy } from './Brc38StreamedHistoryProjection'
import { collectBrc38NativePackedContent } from './Brc38NativePackedTextFieldsNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import {
  brc38ImportRequestIdentity,
  brc38ImportRequestMetadata,
  snapshotSyncRequestColumns
} from '../snapshot/SnapshotSyncRequestMetadata'
import { planProvenTxReqMergeMetadata, type ProvenTxReqMergeRow } from '../schema/entities/EntityProvenTxReq'
import type { WalletSnapshotFieldDescriptor } from '../snapshot/WalletReadSnapshot'
import { readSnapshotJournalSqliteGeneration } from '../snapshot/journal/SnapshotJournalSqliteGeneration'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import {
  snapshotJournalReceiptPolicy,
  type SnapshotJournalReceiptPolicy
} from '../snapshot/journal/SnapshotJournalReceipt'

const payloads = Object.freeze(['rawTx', 'inputBEEF', 'history', 'notify'] as const)
type Model = ProvenTxReqMergeRow<Field, Field>
type Local = Readonly<{
  metadata: Readonly<Record<string, unknown>>
  fields: readonly Readonly<Brc38NativeLocalBaselineField>[]
}>
function invalid(): never {
  throw new Error('Private request inventory differs from its complete original ordered policies or stored postimages')
}
function integer(value: unknown, nonnegative = false): number {
  const number = typeof value === 'bigint' ? Number(value) : value
  if (
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    (typeof value === 'bigint' && BigInt(number) !== value) ||
    (nonnegative && number < 0)
  )
    invalid()
  return number
}
function extent(field: Field): number {
  return field.origin === 'null'
    ? invalid()
    : field.origin === 'inline'
      ? typeof field.value === 'string'
        ? Buffer.byteLength(field.value)
        : field.value.length
      : field.bytes === null
        ? invalid()
        : field.bytes
}
function model(data: Readonly<Record<string, unknown>>, fields: Readonly<Record<string, Field>>): Model {
  const scalar: Record<string, unknown> = {},
    extents: Record<string, Readonly<WalletSnapshotFieldDescriptor>> = {}
  for (const [name, value] of Object.entries(data)) {
    if ((payloads as readonly string[]).includes(name)) continue
    scalar[name] =
      name === 'created_at' || name === 'updated_at'
        ? value instanceof Date
          ? new Date(value.getTime())
          : typeof value === 'string' || typeof value === 'number'
            ? new Date(value)
            : invalid()
        : value === null
          ? undefined
          : ['notified', 'wasBroadcast'].includes(name)
            ? typeof value === 'boolean'
              ? value
              : typeof value === 'bigint' || (typeof value === 'number' && Number.isFinite(value))
                ? value !== 0 && value !== 0n
                : invalid()
            : typeof value === 'bigint'
              ? integer(value)
              : value
  }
  for (const [name, field] of Object.entries(fields))
    extents[name] = Object.freeze({
      kind: name === 'rawTx' || name === 'inputBEEF' ? 'binary' : 'utf8',
      bytes: extent(field)
    })
  const parsed = brc38ImportRequestMetadata(scalar, extents)
  if (fields.rawTx === undefined || fields.history === undefined || fields.notify === undefined) invalid()
  return { ...parsed, rawTx: fields.rawTx, inputBEEF: fields.inputBEEF, history: fields.history, notify: fields.notify }
}
export function brc38PrivateRequestPostimageMetadata(row: Model): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(row)) {
    if ((payloads as readonly string[]).includes(name)) continue
    // Missing legacy counters use the existing nonnull SQL insert defaults.
    // Reconstruction compares the actual complete stored scalar postimage.
    if (value === undefined && (name === 'wasBroadcast' || name === 'rebroadcastAttempts')) {
      result[name] = 0n
      continue
    }
    result[name] =
      value instanceof Date
        ? value.toISOString()
        : typeof value === 'boolean'
          ? value
            ? 1n
            : 0n
          : typeof value === 'number' && Number.isInteger(value)
            ? BigInt(value)
            : value === undefined
              ? null
              : value
  }
  return Object.freeze(result)
}
function currentSource(field: Field): NonNullable<Brc38PrivateRequestReconstruction['current']> {
  if (field.origin === 'local' && field.bytes !== null) return Object.freeze({ localRowId: field.sourceRowId })
  if (field.origin === 'version')
    return Object.freeze({ version: Object.freeze({ bytes: field.bytes, sha256: field.sha256 }) })
  invalid()
}

/** Full original/candidate request keysets and ordered archived aliases.
 * Concrete original/version source factories independently reconstruct both
 * structured fields, using unchanged legacy merge policies. Short query-only
 * transactions drain before derived writers. The actual enabled generation and
 * monotone wallet clock are re-read around every comparison operation; scratch
 * version writes do not change wallet rows or advance that clock. This returns
 * statistics only, never a reusable semantic verdict or primary admission. */
export async function inspectBrc38PrivateRequestInventory(
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
    projectionPolicy: Brc38StreamedHistoryProjectionPolicy
    signal?: AbortSignal
  }>
): Promise<Readonly<{ rows: number; aliases: number; logicalBytes: string }>> {
  const admission = admissionCopy(selected.admission),
    receiptPolicy = Object.freeze({ ...snapshotJournalReceiptPolicy(selected.receiptPolicy) }),
    binding = store.binding,
    root = storage.toDb(),
    working = brc38WorkingAllocation(selected.workingAllocation),
    maximumRows = integer(selected.maximumRows, true),
    width = integer(selected.maximumReadBytes, true),
    sourcePolicy = Object.freeze({ ...selected.sourcePolicy }),
    projection = Object.freeze({ ...selected.projectionPolicy }),
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
    projection.workingAllocation !== working ||
    sourcePolicy.signal !== signal ||
    projection.signal !== signal ||
    sourcePolicy.expiresAt !== store.operationExpiresAt ||
    projection.expiresAt !== store.operationExpiresAt ||
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
    aliases = 0,
    logicalBytes = 0n
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
      const revision = snapshotJournalRevision(clocks[0].revision),
        ceiling = snapshotJournalRevision(clocks[0].ceiling),
        actual = JSON.stringify({ recovery, receipt, generation, revision, ceiling })
      if (originalFence !== undefined && actual !== originalFence) invalid()
      originalFence = actual
      check()
      store.assertPrivateNativeReadTransaction(k)
    },
    read = async <T>(work: (k: Knex.Transaction) => Promise<T>): Promise<T> =>
      await store.withPrivateNativeDatabase(
        true,
        async database =>
          await database.transaction(async k => {
            await fence(k)
            const result = await work(k)
            await fence(k)
            return result
          })
      ),
    budget = () => ({ maximum: working.maximum, remaining: working.maximum, signal })
  try {
    const layout = await read(async k => {
      await inspectBrc38PrivateMergePages(store, k, admission, { workingAllocation: working, signal })
      // Independently reconstruct the complete mapped proof table in this same
      // view. The fresh global clock fence rejects subsequent proof changes;
      // no saved proof verdict becomes a source or parent admission token.
      await inspectBrc38PrivateProofInventory(store, source, k, {
        admission,
        maximumRows,
        maximumReadBytes: width,
        workingAllocation: working,
        signal
      })
      let offset = 1,
        requestOffset = 0,
        count = 0
      for (const table of brc38ImportTableOrder) {
        const values = (await k('table_counts').where({ tableName: table }).select('rows').limit(2)) as Array<{
          rows: unknown
        }>
        if (values.length !== 1) invalid()
        const n = integer(values[0].rows, true)
        if (n > store.limits.maximumRows) invalid()
        if (table === 'provenTxReqs') {
          requestOffset = offset
          count = n
        }
        offset += n
        if (!Number.isSafeInteger(offset) || offset > admission.totalRows) invalid()
      }
      if (offset !== admission.totalRows || requestOffset < 1) invalid()
      return Object.freeze({ offset: requestOffset, count })
    })
    let afterSource: number | null = null,
      afterActual: number | null = null
    for (;;) {
      check()
      const sourceKeys = await Brc38NativeLocalBaselineSource.ownedPage(source, 'proven_tx_reqs', afterSource, 1),
        actualKeys = await read(async k => {
          const query = k('proven_tx_reqs').select(k.raw('rowid AS physical')).orderBy('rowid').limit(1)
          if (afterActual !== null) query.whereRaw('rowid > CAST(? AS INTEGER)', [BigInt(afterActual).toString()])
          return (await query.options({ safeIntegers: true })) as Array<{ physical: bigint }>
        })
      if (actualKeys.length === 0) {
        if (sourceKeys.length !== 0) invalid()
        break
      }
      if (typeof actualKeys[0].physical !== 'bigint') invalid()
      const rowId = integer(actualKeys[0].physical),
        baseline = sourceKeys.length === 1 && sourceKeys[0] === rowId
      if (sourceKeys.length > 1 || (sourceKeys.length === 1 && sourceKeys[0] < rowId) || ++rows > maximumRows) invalid()
      let local: Local | undefined,
        localCharge: Brc38WorkingCharge | undefined,
        retained: Brc38WorkingCharge | undefined,
        retainedBuffers: Uint8Array[] = []
      try {
        if (baseline)
          local = await Brc38NativeLocalBaselineSource.withOwnedRow(source, 'proven_tx_reqs', rowId, row => {
            return promiseFromSync(() => {
              check()
              const bytes = Object.values(row.metadata).reduce<number>(
                (sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value) : 16),
                0
              )
              if (
                bytes > 131072 ||
                row.fields.length !== 4 ||
                Object.values(row.metadata).some(
                  value => value !== null && !['string', 'number', 'bigint'].includes(typeof value)
                )
              )
                invalid()
              localCharge = working.claim(131072 + 32 * bytes)
              return Object.freeze({
                metadata: Object.freeze({ ...row.metadata }),
                fields: Object.freeze(row.fields.map(field => Object.freeze({ ...field })))
              })
            })
          })
        const fields: Record<string, Field> = {},
          seenFields = new Set<string>()
        if (local !== undefined)
          for (const field of local.fields) {
            if (
              !(payloads as readonly string[]).includes(field.field) ||
              seenFields.has(field.field) ||
              field.kind !== (field.field === 'rawTx' || field.field === 'inputBEEF' ? 'blob' : 'text')
            )
              invalid()
            seenFields.add(field.field)
            fields[field.field] = Object.freeze({ origin: 'local', sourceRowId: rowId, bytes: field.bytes })
          }
        // Untouched legacy NULL fields are preserved as actual original DATA.
        // Only a real incoming alias requires the existing request DTO/JSON
        // contract; it cannot invent '{}' or empty binaries for an invalid cell.
        let current: Model | undefined,
          expectedMetadata = local?.metadata,
          aliasCursor = 0,
          touched = false
        await Brc38PrivateDerivedTextLifetimes.with(store, projection, async lifetimes => {
          for (;;) {
            const next = await read(
              async k => await nextBrc38PrivateMergeTargetAlias(store, k, admission, 'provenTxReqs', rowId, aliasCursor)
            )
            if (next === undefined) break
            const position = next - layout.offset
            if (position < 0 || position >= layout.count || ++aliases > store.limits.maximumRows) invalid()
            if (current === undefined && local !== undefined)
              current = model(
                local.metadata,
                Object.fromEntries(
                  Object.entries(fields).filter(([, field]) => field.origin !== 'local' || field.bytes !== null)
                )
              )
            let allocation: Brc38WorkingCharge | undefined,
              buffers: Uint8Array[] = [],
              keepAllocation = false
            try {
              const incoming = await read(async k => {
                const lengths = (await k('rows')
                  .where({ tableName: 'provenTxReqs', position })
                  .select(
                    'bytes',
                    k.raw("CASE WHEN typeof(payload)='text' THEN length(CAST(payload AS BLOB)) END AS actualBytes")
                  )
                  .limit(2)) as Array<{ bytes: unknown; actualBytes: unknown }>
                if (lengths.length !== 1) invalid()
                const bytes = integer(lengths[0].bytes, true)
                if (bytes < 1 || bytes > store.limits.maximumRowBytes || lengths[0].actualBytes !== bytes) invalid()
                allocation = working.claim(131072 + 64 * bytes)
                const raw = (await k('rows')
                  .where({ tableName: 'provenTxReqs', position })
                  .select('payload')
                  .limit(2)) as Array<{ payload: string }>
                if (
                  raw.length !== 1 ||
                  typeof raw[0].payload !== 'string' ||
                  Buffer.byteLength(raw[0].payload) !== bytes
                )
                  invalid()
                const data = decodePortableRow<Record<string, unknown>>(
                    'provenTxReq',
                    JSON.parse(raw[0].payload) as PortableRow
                  ),
                  binaries = await readBrc38SqlBinaryDescriptors(k, 'provenTxReqs', position),
                  structured = await readBrc38SqlStructuredDescriptors(k, 'provenTxReqs', position),
                  incomingFields: Record<string, Field> = {}
                for (const name of ['rawTx', 'inputBEEF'] as const) {
                  const descriptor = binaries[name]
                  if (descriptor !== undefined)
                    incomingFields[name] = Object.freeze({
                      origin: 'incoming',
                      sourcePosition: position,
                      bytes: descriptor.bytes
                    })
                  else if (data[name] !== undefined && data[name] !== null) {
                    const value = data[name]
                    if (
                      !(value instanceof Uint8Array) &&
                      (!Array.isArray(value) ||
                        value.some(
                          byte => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255
                        ))
                    )
                      invalid()
                    const captured = Uint8Array.from(value)
                    buffers.push(captured)
                    incomingFields[name] = Object.freeze({ origin: 'inline', value: captured })
                  }
                }
                for (const name of ['history', 'notify'] as const) {
                  if (structured[name] === undefined) invalid()
                  incomingFields[name] = Object.freeze({
                    origin: 'incoming',
                    sourcePosition: position,
                    bytes: structured[name].bytes
                  })
                }
                const parsed = model(data, incomingFields)
                if (!/^[0-9a-f]{64}$/i.test(parsed.txid)) invalid()
                const loaded = await loadBrc38ImportIdMap(k, admission.scope, [
                  { entity: 'provenTxReq', incomingId: parsed.provenTxReqId, required: true },
                  ...(parsed.provenTxId === undefined
                    ? []
                    : [{ entity: 'provenTx' as const, incomingId: parsed.provenTxId, required: true }])
                ])
                if (integer(loaded.map.provenTxReq.idMap[parsed.provenTxReqId]) !== rowId) invalid()
                return Object.freeze({
                  row: brc38ImportRequestIdentity(parsed),
                  mappedProof:
                    parsed.provenTxId === undefined ? undefined : integer(loaded.map.provenTx.idMap[parsed.provenTxId])
                })
              })
              if (current === undefined) {
                const text = await prepareBrc38PrivateReconstructedNewRequestText(
                  store,
                  storage,
                  position,
                  rowId,
                  incoming.row.txid,
                  admission,
                  { source },
                  sourcePolicy,
                  projection,
                  budget(),
                  lifetimes
                )
                current = {
                  ...incoming.row,
                  provenTxReqId: rowId,
                  provenTxId: incoming.mappedProof,
                  history: { origin: 'version', ...text.history },
                  notify: { origin: 'version', ...text.notify },
                  notified: text.notifiedReset ? false : incoming.row.notified
                }
                retained = allocation
                retainedBuffers = buffers
                keepAllocation = true
                expectedMetadata = brc38PrivateRequestPostimageMetadata(current)
              } else {
                if (current.txid !== incoming.row.txid) invalid()
                const selectedRow = planProvenTxReqMergeMetadata(current, incoming.row),
                  history = await prepareBrc38PrivateReconstructedHistoryText(
                    store,
                    storage,
                    position,
                    rowId,
                    incoming.row.txid,
                    admission,
                    { source, current: currentSource(current.history) },
                    sourcePolicy,
                    projection,
                    budget(),
                    lifetimes
                  ),
                  notify = await prepareBrc38PrivateReconstructedNotifyText(
                    store,
                    storage,
                    position,
                    rowId,
                    incoming.row.txid,
                    admission,
                    { source, current: currentSource(current.notify) },
                    sourcePolicy,
                    projection,
                    budget(),
                    lifetimes
                  ),
                  comparison = { expiresAt: store.operationExpiresAt, workingAllocation: working, signal },
                  historyEqual = await compareBrc38PrivateDerivedText(
                    store,
                    history.normalizedCurrent,
                    history.output,
                    comparison,
                    budget()
                  ),
                  notifyEqual = await compareBrc38PrivateDerivedText(
                    store,
                    notify.normalizedCurrent,
                    notify.output,
                    comparison,
                    budget()
                  )
                if (
                  selectedRow.batch !== current.batch ||
                  selectedRow.updated_at.getTime() !== current.updated_at.getTime() ||
                  !historyEqual ||
                  !notifyEqual
                ) {
                  current = {
                    ...selectedRow,
                    history: { origin: 'version', ...history.output },
                    notify: { origin: 'version', ...notify.output },
                    notified: notify.notifiedReset ? false : selectedRow.notified
                  }
                  expectedMetadata = brc38PrivateRequestPostimageMetadata(current)
                }
              }
              // Keep at most two selected versions. Digest deduplication can
              // make a temporary version the same content as a retained one.
              const keep = [current.history, current.notify].filter(
                (field): field is Extract<Field, { origin: 'version' }> => field.origin === 'version'
              )
              await lifetimes.releaseExcept(keep.map(field => ({ family: 'text', sha256: field.sha256 })))
              // Release also queues normalized incoming/intermediate versions
              // not returned by the producer. Drain the real shared finite GC,
              // which rechecks every actual pointer and other owner's hold.
              // Each non-final page must release real charged storage; the
              // unchanged original logical ceiling bounds the whole loop.
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
                      if (after.length !== 1) invalid()
                      const currentBytes = integer(after[0].reservedBytes, true)
                      if (!collected.complete && currentBytes >= prior) invalid()
                      store.assertPrivateNativeWriteTransaction(k)
                      return collected
                    })
                )
                if (result.complete) break
              }
              await read(() => promiseFromSync(() => undefined))
              touched = true
              aliasCursor = next
            } finally {
              if (!keepAllocation) {
                for (const bytes of buffers) bytes.fill(0)
                allocation?.close()
              }
            }
          }
          if (expectedMetadata === undefined || (!baseline && !touched)) invalid()
          const selectedFields: Readonly<Record<string, Field | undefined>> =
              current === undefined
                ? fields
                : Object.freeze({
                    rawTx: current.rawTx,
                    inputBEEF: current.inputBEEF,
                    history: current.history,
                    notify: current.notify
                  }),
            scalar = expectedMetadata
          await read(async k => {
            const names = Object.keys(scalar),
              columns = (await k.raw(
                'SELECT CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name FROM pragma_table_info(?) ORDER BY cid LIMIT 17',
                ['proven_tx_reqs']
              )) as Array<{ name: string | null }>
            if (
              columns.length !== snapshotSyncRequestColumns().length ||
              names.length !== columns.length - payloads.length ||
              columns.some(
                column =>
                  column.name === null ||
                  (!Object.hasOwn(scalar, column.name) && !(payloads as readonly string[]).includes(column.name))
              )
            )
              invalid()
            const lengths = (await k('proven_tx_reqs')
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
            if (lengths.length !== 1) invalid()
            const bytes = integer(lengths[0].bytes, true)
            if (bytes > 131072) invalid()
            const charge = working.claim(131072 + 32 * bytes)
            try {
              const actual = (await k('proven_tx_reqs')
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
                  table: 'provenTxReqs',
                  rowId,
                  field: name,
                  kind: name === 'rawTx' || name === 'inputBEEF' ? 'blob' : 'text',
                  expected: selectedFields[name] ?? { origin: 'null' },
                  maximumReadBytes: width,
                  workingAllocation: working,
                  signal
                })
              )
          })
        })
      } finally {
        for (const bytes of retainedBuffers) bytes.fill(0)
        retained?.close()
        localCharge?.close()
      }
      afterActual = rowId
      if (baseline) afterSource = rowId
    }
    if (aliases !== layout.count) invalid()
    await read(() => promiseFromSync(() => undefined))
    check()
    return Object.freeze({ rows, aliases, logicalBytes: logicalBytes.toString() })
  } finally {
    frame.close()
  }
}
