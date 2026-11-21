import { promiseFromSync } from '../../utility/promiseFromSync'
import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { readBrc38PrivateMergeRecovery } from './Brc38PrivateMergeRecoverySchemaNode'
import {
  Brc38NativeLocalBaselineSource,
  type Brc38NativeLocalBaselineField
} from './Brc38NativeLocalBaselineSourceNode'
import type { Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'
import { brc38ImportTableOrder, brc38ImportRowForm } from './Brc38ImportForms'
import { brc38ImportTargetIndexes } from './Brc38ImportTargetIndexes'
import { nextBrc38PrivateMergeTargetAlias } from './Brc38PrivateMergeTargetsNode'
import { loadBrc38ImportIdMap, type Brc38ImportIdReference } from './Brc38ImportIdMap'
import { decodePortableRow, type PortableRow } from './Brc38PortableRows'
import { readBrc38SqlBinaryDescriptors } from './Brc38SqlBinaryStaging'
import { readBrc38SqlTextDescriptors } from './Brc38SqlTextStaging'
import {
  inspectBrc38PrivateSelectedField,
  type Brc38PrivateSelectedField as Field
} from './Brc38PrivateSelectedFieldInventoryNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { planCertificateMerge, type CertificateMergeRow } from '../schema/entities/EntityCertificate'
import { planCertificateFieldMerge, type CertificateFieldMergeRow } from '../schema/entities/EntityCertificateField'
import { planCommissionMerge, type CommissionMergeRow } from '../schema/entities/EntityCommission'
import { planTransactionMerge, type TransactionMergeRow } from '../schema/entities/EntityTransaction'
import {
  brc38ImportTransactionMetadata,
  brc38ImportOutputMetadata,
  transactionPayloadFields,
  outputPayloadFields
} from '../snapshot/SnapshotSyncActionMetadata'
import { planOutputMerge, type OutputMergeRow } from '../schema/entities/EntityOutput'
import { nativeSnapshotUnresolvedReclaim } from '../snapshot/NativeSnapshotSyncActionsCurrentNode'
import type { WalletSnapshotFieldDescriptor } from '../snapshot/WalletReadSnapshot'
import type { SyncMap } from '../schema/entities/EntityBase'
import { createHash } from 'node:crypto'
import { assertIsoDate } from './Brc38PortableRows'
import {
  brc38PrivateMergeTargetsTable,
  brc38PrivateMergeQuarantineIndex,
  brc38PrivateMergeQuarantineTxidIndex
} from './Brc38PrivateMergeTargetsNode'
import { brc38PrivateMergePagesTable, inspectBrc38PrivateMergePages } from './Brc38PrivateMergePagesNode'

type Table = 'certificates' | 'certificateFields' | 'commissions' | 'transactions' | 'outputs'
// Detached bounded DATA only. The real source row lease must drain before
// selected-field inspection opens another lease on that same source actor.
type LocalRowData = Readonly<{
  rowId: number
  metadata: Readonly<Record<string, unknown>>
  fields: readonly Readonly<Brc38NativeLocalBaselineField>[]
}>
type Model =
  | { table: 'certificates'; value: CertificateMergeRow<Field> }
  | { table: 'certificateFields'; value: CertificateFieldMergeRow<Field> }
  | { table: 'commissions'; value: CommissionMergeRow<Field, Field> }
  | { table: 'transactions'; value: TransactionMergeRow<Field, Field> }
  | { table: 'outputs'; value: OutputMergeRow<Field, Field> }
const tables: readonly Table[] = Object.freeze(['certificates', 'certificateFields', 'commissions']),
  payloads: Readonly<Record<Table, readonly string[]>> = Object.freeze({
    certificates: ['subject', 'revocationOutpoint', 'signature', 'verifier'],
    certificateFields: ['fieldValue', 'masterKey'],
    commissions: ['lockingScript', 'keyOffset'],
    transactions: transactionPayloadFields,
    outputs: outputPayloadFields
  }),
  requiredFields: Readonly<Record<Table, readonly string[]>> = Object.freeze({
    certificates: ['subject', 'revocationOutpoint', 'signature'],
    certificateFields: ['fieldValue', 'masterKey'],
    commissions: ['lockingScript', 'keyOffset'],
    transactions: ['description'],
    outputs: ['outputDescription', 'type', 'purpose']
  }),
  binaryFields = new Set(['lockingScript', 'rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx'])
function invalid(): never {
  throw new Error(
    'Private simple field inventory differs from its complete local/incoming policies, metadata or selected bytes'
  )
}
function integer(value: unknown, nonnegative = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (nonnegative && value < 0)) invalid()
  return value
}
function number(value: unknown): number {
  if (typeof value === 'bigint') {
    if (value < -9007199254740991n || value > 9007199254740991n) invalid()
    return Number(value)
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid()
  return value
}
function id(value: unknown): number {
  const result = typeof value === 'bigint' ? number(value) : value
  if (typeof result !== 'number' || !Number.isInteger(result)) invalid()
  return result
}
function text(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096) invalid()
  return value
}
function date(value: unknown): Date {
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') invalid()
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(result.getTime())) invalid()
  return result
}
function boolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value !== 0n
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0
  invalid()
}
function model(table: Table, data: Readonly<Record<string, unknown>>, fields: Readonly<Record<string, Field>>): Model {
  const field = (name: string): Field => {
      if (fields[name] === undefined) invalid()
      return fields[name]
    },
    common = { created_at: date(data.created_at), updated_at: date(data.updated_at), userId: id(data.userId) }
  switch (table) {
    case 'transactions':
    case 'outputs': {
      const scalar: Record<string, unknown> = {},
        extents: Record<string, Readonly<WalletSnapshotFieldDescriptor>> = {}
      for (const [name, value] of Object.entries(data)) {
        if (payloads[table].includes(name)) continue
        scalar[name] =
          name === 'created_at' || name === 'updated_at'
            ? date(value)
            : value === null
              ? undefined
              : ['isOutgoing', 'change', 'spendable'].includes(name)
                ? boolean(value)
                : typeof value === 'bigint'
                  ? number(value)
                  : value
      }
      for (const [name, value] of Object.entries(fields)) {
        const bytes =
          value.origin === 'inline'
            ? typeof value.value === 'string'
              ? Buffer.byteLength(value.value)
              : value.value.length
            : value.origin === 'null'
              ? invalid()
              : value.bytes
        if (bytes === null) invalid()
        extents[name] = Object.freeze({ kind: binaryFields.has(name) ? 'binary' : 'utf8', bytes })
      }
      // The complete existing metadata validator checks scalar names/types and
      // optional cells. The actual original-coordinate fields remain DATA for
      // independent full-byte comparison, rather than descriptor hash verdicts.
      if (table === 'transactions') {
        const parsed = brc38ImportTransactionMetadata(scalar, extents)
        return {
          table,
          value: {
            ...parsed,
            description: field('description'),
            rawTx: fields.rawTx,
            inputBEEF: fields.inputBEEF,
            noSendExpiryReclaimRawTx: fields.noSendExpiryReclaimRawTx,
            noSendExpiryReclaimDerivationPrefix: fields.noSendExpiryReclaimDerivationPrefix,
            noSendExpiryReclaimDerivationSuffix: fields.noSendExpiryReclaimDerivationSuffix
          }
        }
      }
      const parsed = brc38ImportOutputMetadata(scalar, extents)
      return {
        table,
        value: {
          ...parsed,
          outputDescription: field('outputDescription'),
          type: field('type'),
          purpose: field('purpose'),
          lockingScript: fields.lockingScript,
          spendingDescription: fields.spendingDescription,
          customInstructions: fields.customInstructions,
          derivationPrefix: fields.derivationPrefix,
          derivationSuffix: fields.derivationSuffix
        }
      }
    }
    case 'certificates':
      return {
        table,
        value: {
          ...common,
          certificateId: id(data.certificateId),
          type: text(data.type),
          certifier: text(data.certifier),
          serialNumber: text(data.serialNumber),
          isDeleted: boolean(data.isDeleted),
          subject: field('subject'),
          revocationOutpoint: field('revocationOutpoint'),
          signature: field('signature'),
          ...(fields.verifier === undefined ? {} : { verifier: fields.verifier })
        }
      }
    case 'certificateFields':
      return {
        table,
        value: {
          ...common,
          certificateId: id(data.certificateId),
          fieldName: text(data.fieldName),
          fieldValue: field('fieldValue'),
          masterKey: field('masterKey')
        }
      }
    case 'commissions':
      return {
        table,
        value: {
          ...common,
          commissionId: id(data.commissionId),
          transactionId: id(data.transactionId),
          isRedeemed: boolean(data.isRedeemed),
          satoshis: number(data.satoshis),
          lockingScript: field('lockingScript'),
          keyOffset: field('keyOffset')
        }
      }
  }
}
function select(
  current: Model | undefined,
  incoming: Model,
  userId: number,
  parent: number | undefined,
  map: SyncMap,
  quarantine?: (txid: string | undefined) => void
): Model | undefined {
  if (current !== undefined && current.table !== incoming.table) invalid()
  switch (incoming.table) {
    case 'outputs': {
      const parents = {
          transactionId: integer(map.transaction.idMap[incoming.value.transactionId]),
          basketId:
            incoming.value.basketId === undefined
              ? undefined
              : integer(map.outputBasket.idMap[incoming.value.basketId]),
          spentBy:
            incoming.value.spentBy === undefined ? undefined : integer(map.transaction.idMap[incoming.value.spentBy])
        },
        value =
          current === undefined
            ? { ...incoming.value, userId, ...parents }
            : current.table === incoming.table
              ? planOutputMerge(current.value, incoming.value, map, parents)
              : invalid()
      return value === undefined ? undefined : { table: incoming.table, value }
    }
    case 'transactions': {
      const policy =
        current === undefined
          ? undefined
          : current.table === incoming.table
            ? planTransactionMerge(current.value, incoming.value, map)
            : invalid()
      quarantine?.(policy?.quarantineReclaimTxid)
      const value =
        current === undefined
          ? {
              ...incoming.value,
              userId,
              provenTxId:
                incoming.value.provenTxId === undefined
                  ? undefined
                  : integer(map.provenTx.idMap[incoming.value.provenTxId])
            }
          : policy?.row
      return value === undefined ? undefined : { table: incoming.table, value }
    }
    case 'certificates': {
      const value =
        current === undefined
          ? { ...incoming.value, userId }
          : current.table === incoming.table
            ? planCertificateMerge(current.value, incoming.value)
            : invalid()
      return value === undefined ? undefined : { table: incoming.table, value }
    }
    case 'certificateFields': {
      const value =
        current === undefined
          ? { ...incoming.value, userId, certificateId: integer(parent) }
          : current.table === incoming.table
            ? planCertificateFieldMerge(current.value, incoming.value)
            : invalid()
      return value === undefined ? undefined : { table: incoming.table, value }
    }
    case 'commissions': {
      const value =
        current === undefined
          ? { ...incoming.value, userId, transactionId: integer(parent) }
          : current.table === incoming.table
            ? planCommissionMerge(current.value, incoming.value)
            : invalid()
      return value === undefined ? undefined : { table: incoming.table, value }
    }
  }
}
function scalarMetadata(current: Model): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(current.value)) {
    if (payloads[current.table].includes(name)) continue
    if (value instanceof Date) result[name] = value.toISOString()
    else if (typeof value === 'boolean') result[name] = value ? 1n : 0n
    else if (typeof value === 'number') result[name] = Number.isInteger(value) ? BigInt(value) : value
    else if (typeof value === 'string' || value === null) result[name] = value
    else if (value === undefined) result[name] = null
    else invalid()
  }
  return Object.freeze(result)
}
/** Reconstruct all certificate, certificate-field and commission postimages
 * from both full keysets and ordered original aliases. The original shared
 * pure policies select fields; complete logical bytes, markers and hashes are
 * compared independently against actual source/stage/candidate owners. */
export async function inspectBrc38PrivateSimpleFieldInventory(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  k: Knex.Transaction,
  selected: Readonly<{
    admission: Brc38ImportJournalAdmission
    maximumRows: number
    maximumReadBytes: number
    workingAllocation: Brc38WorkingAllocation
    signal?: AbortSignal
  }>
): Promise<Readonly<{ rows: number; aliases: number; logicalBytes: string }>> {
  return await inspectFieldRows(store, source, k, selected, tables)
}

/** Complete transaction postimages, including BRC-177 lifecycle selection,
 * retained identity/reference, proof mapping and all six full payloads. Output
 * quarantine side effects require their separate ordered output inventory. */
export async function inspectBrc38PrivateTransactionInventory(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  k: Knex.Transaction,
  selected: Readonly<{
    admission: Brc38ImportJournalAdmission
    maximumRows: number
    maximumReadBytes: number
    workingAllocation: Brc38WorkingAllocation
    signal?: AbortSignal
  }>
): Promise<Readonly<{ rows: number; aliases: number; logicalBytes: string }>> {
  return await inspectFieldRows(store, source, k, selected, ['transactions'])
}

/** Transaction reconstruction and output comparison run in the SAME actual
 * query-only view. The transaction result is never stored as an admission flag.
 * Ordered declared quarantine effects are matched to the complete original
 * output keyset before incoming output aliases select their full postimages. */
export async function inspectBrc38PrivateOutputInventory(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  k: Knex.Transaction,
  selected: Readonly<{
    admission: Brc38ImportJournalAdmission
    maximumRows: number
    maximumReadBytes: number
    workingAllocation: Brc38WorkingAllocation
    signal?: AbortSignal
  }>
): Promise<Readonly<{ rows: number; aliases: number; logicalBytes: string }>> {
  await inspectBrc38PrivateTransactionInventory(store, source, k, selected)
  return await inspectFieldRows(store, source, k, selected, ['outputs'])
}

async function inspectFieldRows(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  k: Knex.Transaction,
  selected: Readonly<{
    admission: Brc38ImportJournalAdmission
    maximumRows: number
    maximumReadBytes: number
    workingAllocation: Brc38WorkingAllocation
    signal?: AbortSignal
  }>,
  selectedTables: readonly Table[]
): Promise<Readonly<{ rows: number; aliases: number; logicalBytes: string }>> {
  const working = brc38WorkingAllocation(selected.workingAllocation),
    admission = selected.admission,
    binding = store.binding,
    maximumRows = integer(selected.maximumRows, true),
    width = selected.maximumReadBytes,
    signal = selected.signal,
    deadline = performance.now() + Math.max(0, store.operationExpiresAt - Date.now())
  if (
    working === undefined ||
    binding === undefined ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    maximumRows < 1 ||
    maximumRows > 10000000 ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > 16384 ||
    admission.expiresAt !== store.limits.expiresAt ||
    admission.originalLimitsJson !== binding.limitsJson ||
    admission.scope.bindingSha256 !== binding.digest ||
    admission.scope.archiveSha256 !== binding.binding.archiveSha256
  )
    invalid()
  const frame = working.claim(2097152),
    offsets = new Map<string, number>(),
    counts = new Map<string, number>(),
    check = (): void => {
      signal?.throwIfAborted()
      if (store.binding !== binding || Date.now() >= store.operationExpiresAt || performance.now() >= deadline)
        invalid()
      store.assertPrivateNativeReadTransaction(k)
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
  let rows = 0,
    aliases = 0,
    logicalBytes = 0n
  try {
    check()
    await verifyBrc38AuthenticatedSourceSeal(k)
    const recovery = await readBrc38PrivateMergeRecovery(k),
      receipt = await readBrc38ImportJournal(k, admission, working)
    if (
      recovery?.phase !== 'IMPORT' ||
      recovery.activeImportId !== admission.scope.importId ||
      recovery.bindingSha256 !== binding.digest ||
      receipt.state !== 'COMPLETE' ||
      receipt.nextRow !== admission.totalRows
    )
      invalid()
    if (selectedTables.includes('transactions'))
      await inspectBrc38PrivateMergePages(store, k, admission, { workingAllocation: working, signal })
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
    for (const table of selectedTables) {
      const [sql] = brc38ImportTargetIndexes[table],
        localTable = sql as Brc38NativeLocalBaselineTable,
        form = brc38ImportRowForm(table)
      const priorAliases = aliases
      let afterSource: number | null = null,
        afterActual: number | null = null
      for (;;) {
        check()
        const sourceKeys = await Brc38NativeLocalBaselineSource.ownedPage(source, localTable, afterSource, 1),
          query = k(sql).select(k.raw('rowid AS physical')).orderBy('rowid').limit(1)
        if (afterActual !== null) query.whereRaw('rowid > CAST(? AS INTEGER)', [BigInt(afterActual).toString()])
        const actualKeys = (await query.options({ safeIntegers: true })) as Array<{ physical: bigint }>
        if (actualKeys.length === 0) {
          if (sourceKeys.length !== 0) invalid()
          break
        }
        const physical = actualKeys[0].physical
        if (
          typeof physical !== 'bigint' ||
          physical < -9007199254740991n ||
          physical > 9007199254740991n ||
          sourceKeys.length > 1 ||
          (sourceKeys.length === 1 && BigInt(sourceKeys[0]) < physical) ||
          ++rows > maximumRows
        )
          invalid()
        const rowId = Number(physical),
          baseline = sourceKeys.length === 1 && sourceKeys[0] === rowId,
          inspect = async (original: LocalRowData | undefined): Promise<void> => {
            const metadataBytes = Object.values(original?.metadata ?? {}).reduce<number>(
              (sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value) : 16),
              0
            )
            let retained: Brc38WorkingCharge = working.claim(131072 + 32 * metadataBytes),
              retainedBuffers: Uint8Array[] = []
            const fieldHolds: Array<{ charge: Brc38WorkingCharge; fields: readonly Field[]; buffers: Uint8Array[] }> =
              []
            try {
              const originalFields: Record<string, Field> = {}
              if (original !== undefined) {
                if (
                  original.fields.length !== payloads[table].length ||
                  original.fields.some(field => !payloads[table].includes(field.field))
                )
                  invalid()
                for (const field of original.fields) {
                  if (field.bytes === null) {
                    if (requiredFields[table].includes(field.field)) invalid()
                    continue
                  }
                  originalFields[field.field] = Object.freeze({
                    origin: 'local',
                    sourceRowId: original.rowId,
                    bytes: field.bytes
                  })
                }
              }
              let current = original === undefined ? undefined : model(table, original.metadata, originalFields),
                expectedMetadata = original?.metadata,
                aliasCursor = 0,
                touched = false
              if (table === 'outputs') {
                const effects = (await k
                  .from(k.raw('?? INDEXED BY ??', [brc38PrivateMergeTargetsTable, brc38PrivateMergeQuarantineIndex]))
                  .where({ importId: admission.scope.importId, quarantineOutputId: rowId })
                  .orderBy('sourceRow')
                  .select('sourceRow', 'quarantineTxidSha256', 'quarantineUpdatedAt')
                  .limit(2)) as Array<{ sourceRow: number; quarantineTxidSha256: string; quarantineUpdatedAt: string }>
                if (effects.length > 1) invalid()
                if (current !== undefined) {
                  if (current.table !== 'outputs' || original === undefined) invalid()
                  const txid = current.value.txid,
                    eligible = current.value.vout === 0 && txid !== undefined,
                    txidSha256 = eligible ? createHash('sha256').update(txid!, 'utf8').digest('hex') : undefined,
                    declarations =
                      txidSha256 === undefined
                        ? []
                        : ((await k
                            .from(
                              k.raw('?? INDEXED BY ??', [
                                brc38PrivateMergeTargetsTable,
                                brc38PrivateMergeQuarantineTxidIndex
                              ])
                            )
                            .where({ importId: admission.scope.importId, quarantineTxidSha256: txidSha256 })
                            .orderBy('sourceRow')
                            .select('sourceRow')
                            .limit(1)) as Array<{ sourceRow: number }>),
                    changed = eligible && current.value.spendable && declarations.length !== 0
                  if (effects.length !== (changed ? 1 : 0)) invalid()
                  if (changed) {
                    const effect = effects[0]
                    if (
                      effect.sourceRow !== declarations[0].sourceRow ||
                      effect.quarantineTxidSha256 !== txidSha256 ||
                      current.value.userId !== admission.scope.userId
                    )
                      invalid()
                    assertIsoDate(effect.quarantineUpdatedAt, 'original output quarantine timestamp')
                    current = {
                      table: 'outputs',
                      value: { ...current.value, spendable: false, updated_at: date(effect.quarantineUpdatedAt) }
                    }
                    expectedMetadata = Object.freeze({
                      ...original.metadata,
                      spendable: 0n,
                      updated_at: effect.quarantineUpdatedAt
                    })
                  }
                } else if (effects.length !== 0) invalid()
              }
              for (;;) {
                check()
                const next = await nextBrc38PrivateMergeTargetAlias(store, k, admission, table, rowId, aliasCursor)
                if (next === undefined) break
                const position = next - offsets.get(table)!
                if (position < 0 || position >= counts.get(table)! || ++aliases > store.limits.maximumRows) invalid()
                const extent = (await k('rows')
                  .where({ tableName: table, position })
                  .select(
                    'bytes',
                    k.raw("CASE WHEN typeof(payload)='text' THEN length(CAST(payload AS BLOB)) END AS actualBytes")
                  )
                  .limit(2)) as Array<{ bytes: unknown; actualBytes: unknown }>
                if (extent.length !== 1) invalid()
                const bytes = integer(extent[0].bytes, true)
                if (bytes < 1 || bytes > store.limits.maximumRowBytes || extent[0].actualBytes !== bytes) invalid()
                const allocation = working.claim(131072 + 64 * bytes),
                  buffers: Uint8Array[] = []
                let keepAllocation = false
                try {
                  const values = (await k('rows')
                    .where({ tableName: table, position })
                    .select('payload')
                    .limit(2)) as Array<{ payload: string }>
                  if (
                    values.length !== 1 ||
                    typeof values[0].payload !== 'string' ||
                    Buffer.byteLength(values[0].payload) !== bytes
                  )
                    invalid()
                  const fields = JSON.parse(values[0].payload) as PortableRow,
                    metadata = decodePortableRow<Record<string, unknown>>(form.kind, fields),
                    binaries = await readBrc38SqlBinaryDescriptors(k, table, position),
                    texts = (await readBrc38SqlTextDescriptors(k, table, position)) ?? {},
                    incomingFields: Record<string, Field> = {},
                    references: Brc38ImportIdReference[] = []
                  for (const name of payloads[table]) {
                    const descriptor = binaryFields.has(name) ? binaries[name] : texts[name]
                    if (descriptor !== undefined)
                      incomingFields[name] = Object.freeze({
                        origin: 'incoming',
                        sourcePosition: position,
                        bytes: descriptor.bytes
                      })
                    else if (metadata[name] === undefined || metadata[name] === null) {
                      if (requiredFields[table].includes(name)) invalid()
                    } else if (binaryFields.has(name)) {
                      const value = metadata[name]
                      if (
                        !(value instanceof Uint8Array) &&
                        (!Array.isArray(value) ||
                          value.some(
                            byte => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255
                          ))
                      )
                        invalid()
                      const data = Uint8Array.from(value)
                      buffers.push(data)
                      incomingFields[name] = Object.freeze({ origin: 'inline', value: data })
                    } else {
                      if (typeof metadata[name] !== 'string') invalid()
                      incomingFields[name] = Object.freeze({ origin: 'inline', value: metadata[name] })
                    }
                  }
                  const incoming = model(table, metadata, incomingFields)
                  if (form.entity !== undefined && form.id !== undefined)
                    references.push({ entity: form.entity, incomingId: id(metadata[form.id]), required: true })
                  for (const parent of form.parents) {
                    if (parent.optional && metadata[parent.field] == null) continue
                    references.push({ entity: parent.entity, incomingId: id(metadata[parent.field]), required: true })
                  }
                  const loaded = await loadBrc38ImportIdMap(k, admission.scope, references),
                    parent =
                      table === 'certificateFields'
                        ? integer(loaded.map.certificate.idMap[id(metadata.certificateId)])
                        : table === 'commissions'
                          ? integer(loaded.map.transaction.idMap[id(metadata.transactionId)])
                          : undefined
                  if (
                    form.entity !== undefined &&
                    form.id !== undefined &&
                    integer(loaded.map[form.entity].idMap[id(metadata[form.id])]) !== rowId
                  )
                    invalid()
                  let quarantineTxid: string | undefined
                  const selectedModel = select(current, incoming, admission.scope.userId, parent, loaded.map, txid => {
                    quarantineTxid = txid
                  })
                  if (table === 'transactions') {
                    const effects = (await k(brc38PrivateMergeTargetsTable)
                      .where({ importId: admission.scope.importId, sourceRow: next })
                      .select('quarantineTxidSha256', 'quarantineOutputId', 'quarantineUpdatedAt')
                      .limit(2)) as Array<{
                      quarantineTxidSha256: string | null
                      quarantineOutputId: number | null
                      quarantineUpdatedAt: string | null
                    }>
                    if (
                      effects.length !== 1 ||
                      effects[0].quarantineTxidSha256 !==
                        (quarantineTxid === undefined
                          ? null
                          : createHash('sha256').update(quarantineTxid, 'utf8').digest('hex'))
                    )
                      invalid()
                    const effect = effects[0]
                    if (effect.quarantineOutputId === null) {
                      if (effect.quarantineUpdatedAt !== null) invalid()
                    } else {
                      if (
                        integer(effect.quarantineOutputId) < 1 ||
                        quarantineTxid === undefined ||
                        typeof effect.quarantineUpdatedAt !== 'string'
                      )
                        invalid()
                      assertIsoDate(effect.quarantineUpdatedAt, 'reconstructed quarantine timestamp')
                      const pages = (await k(brc38PrivateMergePagesTable)
                          .where({ importId: admission.scope.importId, tableName: 'transactions' })
                          .where('fromRow', '<=', next)
                          .where('nextRow', '>', next)
                          .select('writerStartedAt', 'writerFinishedAt')
                          .limit(2)) as Array<{ writerStartedAt: number; writerFinishedAt: number }>,
                        stamp = new Date(effect.quarantineUpdatedAt).getTime()
                      if (pages.length !== 1 || stamp < pages[0].writerStartedAt || stamp > pages[0].writerFinishedAt)
                        invalid()
                    }
                  }
                  if (selectedModel !== undefined) {
                    if (
                      selectedModel.table === 'outputs' &&
                      selectedModel.value.spendable &&
                      selectedModel.value.txid !== undefined &&
                      (await nativeSnapshotUnresolvedReclaim(
                        k,
                        admission.scope.userId,
                        selectedModel.value.txid,
                        signal
                      ))
                    )
                      selectedModel.value.spendable = false
                    if (current === undefined && form.id !== undefined) Reflect.set(selectedModel.value, form.id, rowId)
                    if (table === 'transactions' || table === 'outputs') {
                      const values: readonly unknown[] = Object.values(selectedModel.value)
                      for (let index = fieldHolds.length - 1; index >= 0; index--) {
                        const hold = fieldHolds[index]
                        if (hold.fields.some(field => values.includes(field))) continue
                        for (const data of hold.buffers) data.fill(0)
                        hold.charge.close()
                        fieldHolds.splice(index, 1)
                      }
                      const held = Object.values(incomingFields).filter(
                        field => field.origin === 'inline' && values.includes(field)
                      )
                      if (held.length !== 0) {
                        fieldHolds.push({ charge: allocation, fields: held, buffers })
                        keepAllocation = true
                        if (fieldHolds.length > payloads[table].length) invalid()
                      }
                    } else if (current === undefined || table !== 'commissions') {
                      retained.close()
                      for (const data of retainedBuffers) data.fill(0)
                      retained = allocation
                      retainedBuffers = buffers
                      keepAllocation = true
                    }
                    current = selectedModel
                    expectedMetadata = scalarMetadata(current)
                  }
                  touched = true
                  aliasCursor = next
                } finally {
                  if (!keepAllocation) {
                    for (const data of buffers) data.fill(0)
                    allocation.close()
                  }
                }
              }
              if (current === undefined || expectedMetadata === undefined || (!baseline && !touched)) invalid()
              const names = Object.keys(expectedMetadata),
                columns = (await k.raw(
                  'SELECT CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name FROM pragma_table_info(?) ORDER BY cid LIMIT 65',
                  [sql]
                )) as Array<{ name: string | null }>
              if (
                columns.length !== names.length + payloads[table].length ||
                columns.length > 64 ||
                columns.some(
                  column =>
                    column.name === null ||
                    (!Object.hasOwn(expectedMetadata!, column.name) && !payloads[table].includes(column.name))
                )
              )
                invalid()
              const extents = (await k(sql)
                .whereRaw('rowid=CAST(? AS INTEGER)', [physical.toString()])
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
              if (extents.length !== 1) invalid()
              const bytes = integer(extents[0].bytes, true)
              if (bytes > 131072) invalid()
              const allocation = working.claim(131072 + 32 * bytes)
              try {
                const actual = (await k(sql)
                  .whereRaw('rowid=CAST(? AS INTEGER)', [physical.toString()])
                  .select(names)
                  .limit(2)
                  .options({ safeIntegers: true })) as Array<Record<string, unknown>>
                if (actual.length !== 1 || names.some(name => !Object.is(actual[0][name], expectedMetadata![name])))
                  invalid()
              } finally {
                allocation.close()
              }
              for (const field of payloads[table]) {
                const expected = Reflect.get(current.value, field) as Field | undefined
                logicalBytes += BigInt(
                  await inspectBrc38PrivateSelectedField(store, source, k, {
                    table,
                    rowId,
                    field,
                    kind: binaryFields.has(field) ? 'blob' : 'text',
                    expected: expected ?? Object.freeze({ origin: 'null' }),
                    maximumReadBytes: width,
                    workingAllocation: working,
                    signal
                  })
                )
              }
            } finally {
              for (const hold of fieldHolds) {
                for (const data of hold.buffers) data.fill(0)
                hold.charge.close()
              }
              for (const data of retainedBuffers) data.fill(0)
              retained.close()
            }
          }
        if (baseline) {
          let copiedCharge: Brc38WorkingCharge | undefined
          try {
            const original = await Brc38NativeLocalBaselineSource.withOwnedRow(source, localTable, rowId, row => {
              return promiseFromSync(() => {
                check()
                const bytes = Object.values(row.metadata).reduce<number>(
                  (sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value) : 16),
                  0
                )
                if (!Number.isSafeInteger(bytes) || bytes > 1048576 || row.fields.length > 64) invalid()
                copiedCharge = working.claim(131072 + 32 * bytes + 1024 * row.fields.length)
                if (
                  Object.values(row.metadata).some(
                    value => value !== null && !['string', 'number', 'bigint'].includes(typeof value)
                  )
                )
                  invalid()
                return Object.freeze({
                  rowId: row.rowId,
                  metadata: Object.freeze({ ...row.metadata }),
                  fields: Object.freeze(row.fields.map(field => Object.freeze({ ...field })))
                })
              })
            })
            await inspect(original)
          } finally {
            copiedCharge?.close()
          }
        } else await inspect(undefined)
        afterActual = rowId
        if (baseline) afterSource = rowId
      }
      if (aliases - priorAliases !== counts.get(table)) invalid()
    }
    check()
    return Object.freeze({ rows, aliases, logicalBytes: logicalBytes.toString() })
  } finally {
    frame.close()
  }
}
