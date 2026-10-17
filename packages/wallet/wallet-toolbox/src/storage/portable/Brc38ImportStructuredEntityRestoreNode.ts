import { prepareBrc38NativePackedTextWalletWrite } from './Brc38NativePackedTextWalletNode'
import { nativePackedTextSource } from './Brc38NativePackedTextSources'
import { brc38JsonTextField } from './Brc38JsonTextFields'
import { readBrc38SqlTextDescriptors } from './Brc38SqlTextStaging'
import { readBrc38SqlProjectedStructuredDescriptors } from './Brc38SqlProjectedStructuredStaging'
import type { Brc38PrivatePreparedFieldInstaller } from './Brc38NativePackedFieldPreparationNode'
import type { Brc38PrivatePreparedTextInstaller } from './Brc38NativePackedTextPreparationNode'
import { readBrc38SqlCanonicalStructuredDescriptors } from './Brc38SqlCanonicalStructuredStaging'
import { brc38StructuredInlineProofFields, brc38StructuredInlineProofReader } from './Brc38StructuredInlineProofNode'
import { prepareBrc38NativePackedWalletWrite } from './Brc38NativePackedWalletNode'
import { writeBrc38NativePackedBytes } from './Brc38NativePackedFieldsNode'
import { writeBrc38PrivatePackedTextField, writeBrc38NativePackedTextBytes } from './Brc38NativePackedTextFieldsNode'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import { brc38JsonStructuredField, type Brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import { brc38PrivateStructuredPolicy, type Brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'
import type { Brc38StreamedSyncMapProjectionPolicy } from './Brc38StreamedSyncMapProjectionNode'
import { privateNativeTransactionIdentity } from './Brc38PrivateNativeOwnershipNode'
import type { Brc38NativeTextRead } from './Brc38NativeBlobProtocol'
import { writeBrc38PrivatePackedField } from './Brc38NativePackedFieldsNode'
import { hasBrc38NativePackedSchema } from './Brc38NativePackedSchemaNode'
import { verifyBrc38NativeTailLayout } from './Brc38NativeTailLayoutNode'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { Brc38StageTable } from './Brc38SemanticStage'
import type {
  Brc38AuthenticatedImportReader,
  Brc38AuthenticatedStreamedImportReader,
  KnexBrc38StagingStore
} from './KnexBrc38StagingStore'
import { isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { brc38ImportRowForm, type Brc38PreparedStreamedPage, type Brc38PreparedImportData } from './Brc38ImportPage'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { prepareBrc38ImportStructuredOriginals } from './Brc38ImportStructuredProvenanceNode'
import { insertBrc38PackedRestoreMetadata, brc38PackedRestoreBinaryTable } from './Brc38PackedRestoreMetadataNode'
import { prepareBrc38ImportHistory, type Brc38ImportHistoryProjection } from './Brc38ImportHistory'
import { inspectBrc38AuthenticatedStreamedProofReader } from './Brc38AuthenticatedStreamedProofNode'
import { assertBrc38NativeStreamedSourceRow } from './Brc38NativeBinaryFieldNode'
import type { Brc38NativeBlobWrite } from './Brc38NativeBlobProtocol'
import {
  prepareBrc38ImportCacheFence,
  applyBrc38ImportCacheFence,
  copyBrc38ImportDecodedValue,
  chargeBrc38ImportDecodedBudget,
  type Brc38ImportCacheFence
} from './Brc38ImportEntityMergeNode'
import type { PortableRow } from './Brc38PortableRows'
import { requireBrc38ImportSqliteTransaction } from './Brc38ImportJournalSchema'
import { runInSeries } from '../../utility/runInSeries'
import { reserveBrc38ImportDecodedScratch } from './Brc38ImportDecodedBudget'

function invalid(): never {
  throw new Error('Private structured restore differs from its admitted source or native writer')
}
const binaryTables = new Set<Brc38StageTable>(['provenTxs', 'provenTxReqs', 'transactions', 'outputs', 'commissions'])
/** Internal one-use effect plan. No original binary/structured field is materialized or represented
 * by a placeholder DTO. Empty physical BLOB cells belong to the explicit versioned packed layout;
 * payloads are independently hashed immutable chunks plus actual field pointers
 * before maps/receipt/cursor can commit.
 * Original incoming IDs/relations/operational histories remain identifiable in
 * a separate field-aware provenance family. Native IDs are deliberately mapped. */
export class Brc38PreparedStructuredEntityRestore {
  #consumed = false
  constructor(
    private readonly storage: StorageKnex,
    private readonly admission: Readonly<Brc38ImportJournalAdmission>,
    private readonly page: Brc38PreparedStreamedPage,
    private readonly originals: { apply: (trx: Knex.Transaction) => Promise<void> },
    private readonly histories: readonly (Readonly<Brc38ImportHistoryProjection> | undefined)[],
    private readonly projected: readonly (Readonly<Brc38JsonStructuredField> | undefined)[],
    private readonly cache?: Brc38ImportCacheFence,
    private readonly signal?: AbortSignal,
    private readonly inlineBinary: readonly (
      ReturnType<typeof prepareBrc38NativePackedWalletWrite>['fields'] | undefined
    )[] = [],
    private readonly installPreparedField?: Brc38PrivatePreparedFieldInstaller,
    private readonly installPreparedText?: Brc38PrivatePreparedTextInstaller,
    private readonly inlineText: readonly (
      ReturnType<typeof prepareBrc38NativePackedTextWalletWrite>['fields'] | undefined
    )[] = []
  ) {}
  async apply(trx: Knex.Transaction): Promise<{ inserts: number; updates: 0 }> {
    if (!isBrc38OwnedPrivateNativeWriter(trx) || this.#consumed) invalid()
    requireBrc38ImportSqliteTransaction(trx)
    await verifyBrc38NativeTailLayout(trx)
    if (!(await hasBrc38NativePackedSchema(trx)) || !(await hasBrc38NativePackedTextSchema(trx))) invalid()
    this.#consumed = true
    try {
      this.signal?.throwIfAborted()
      await this.originals.apply(trx)
      const { data, references, budget } = this.page
      if (data.kind === 'header') {
        if (data.user.userId !== this.admission.scope.userId) invalid()
        const user = copyBrc38ImportDecodedValue({ ...data.user, activeStorage: '' }, budget),
          value = await this.storage.validateEntityForInsert(user, trx)
        // Preserve the admitted single user even when its accepted native ID is
        // zero. The ordinary insertUser auto-ID convention is not a restore fence.
        await trx('users').insert(value)
        this.signal?.throwIfAborted()
        return { inserts: 1, updates: 0 }
      }
      const loaded = await loadBrc38ImportIdMap(trx, this.admission.scope, references),
        form = brc38ImportRowForm(data.table)
      await runInSeries(data.rows.entries(), async ([index, prepared]) => {
        this.signal?.throwIfAborted()
        await assertBrc38NativeStreamedSourceRow(
          trx,
          data.table,
          data.fromIndex + index,
          prepared.source,
          this.admission.maximumStepBytes
        )
        const row = copyBrc38ImportDecodedValue(prepared.metadata, budget) as Record<string, unknown>,
          incomingId = form.id === undefined ? undefined : row[form.id]
        for (const parent of form.parents) {
          const incoming = row[parent.field]
          if (incoming === undefined && parent.optional === true) continue
          if (
            typeof incoming !== 'number' ||
            !Number.isInteger(incoming) ||
            !Object.hasOwn(loaded.map[parent.entity].idMap, incoming)
          )
            invalid()
          row[parent.field] = loaded.map[parent.entity].idMap[incoming]
        }
        if (form.entity !== undefined && form.id !== undefined) row[form.id] = 0
        const history = this.histories[index]
        if (history !== undefined) {
          if (history.activated !== false) invalid()
          row[history.field] = history.mappedJson
        }
        // Original remote progress is provenance, never a newly activated local
        // checkpoint or primary. Native sensitive fields remain explicitly inert.
        if (data.table === 'syncStates') row.init = false
        const names = Object.keys(prepared.source.binaries)
        if (names.length !== 0 && !binaryTables.has(data.table)) invalid()
        const json = prepared.source.structured ?? {},
          jsonNames = Object.keys(json),
          canonicalFields: Readonly<Record<string, Brc38JsonStructuredField>> =
            await readBrc38SqlCanonicalStructuredDescriptors(trx, data.table, data.fromIndex + index)
        if (jsonNames.length !== Object.keys(canonicalFields).length || jsonNames.length > 3) invalid()
        for (const name of jsonNames) {
          if (!brc38JsonStructuredField(data.table, name) || canonicalFields[name] === undefined) invalid()
          row[name] = ''
        }
        const texts = prepared.source.texts ?? {},
          textNames = Object.keys(texts),
          actualTexts = await readBrc38SqlTextDescriptors(trx, data.table, data.fromIndex + index)
        if (textNames.length > 7 || textNames.length !== Object.keys(actualTexts).length) invalid()
        for (const name of textNames) {
          if (
            !brc38JsonTextField(data.table, name) ||
            Object.hasOwn(json, name) ||
            JSON.stringify(actualTexts[name]) !== JSON.stringify(texts[name])
          )
            invalid()
          row[name] = ''
        }
        // Small SQL metadata and original inline payloads remain separate.
        // Every marker is built by the private native metadata writer.
        const inlineFields = this.inlineBinary[index] ?? [],
          binaryNames = [...names]
        for (const field of inlineFields) {
          if (Object.hasOwn(prepared.source.binaries, field.field)) invalid()
          binaryNames.push(field.field)
          delete row[field.field]
        }
        const inline = this.inlineText[index] ?? []
        for (const field of inline) {
          if (Object.hasOwn(json, field.field) || Object.hasOwn(texts, field.field)) invalid()
          row[field.field] = ''
        }
        const rowId = await insertBrc38PackedRestoreMetadata(this.storage, trx, data.table, row, binaryNames, budget)
        if (
          jsonNames.length !== 0 &&
          ((data.table !== 'provenTxReqs' && data.table !== 'syncStates') ||
            typeof rowId !== 'number' ||
            !Number.isSafeInteger(rowId))
        )
          invalid()
        for (const name of jsonNames) {
          const projection = this.projected[index],
            operational = name === 'notify' || name === 'syncMap'
          if (operational && (projection === undefined || projection.field !== name)) invalid()
          if (this.installPreparedText !== undefined) {
            await this.installPreparedText(
              trx,
              data.table as Brc38NativeTextRead['table'],
              data.fromIndex + index,
              rowId as number,
              operational ? projection! : canonicalFields[name],
              operational ? 'projected' : 'canonical'
            )
          } else
            await writeBrc38PrivatePackedTextField(trx, {
              table: data.table as Brc38NativeTextRead['table'],
              sourceIndex: data.fromIndex + index,
              destinationRowId: rowId as number,
              field: operational ? projection! : canonicalFields[name],
              family: operational ? 'projected' : 'canonical',
              expiresAt: this.admission.expiresAt,
              signal: this.signal
            })
        }
        if (
          textNames.length !== 0 &&
          (typeof rowId !== 'number' || !Number.isSafeInteger(rowId) || this.installPreparedText === undefined)
        )
          invalid()
        for (const name of textNames)
          await this.installPreparedText!(
            trx,
            data.table as Brc38NativeTextRead['table'],
            data.fromIndex + index,
            rowId as number,
            actualTexts[name],
            'text'
          )
        for (const field of inline)
          await writeBrc38NativePackedTextBytes(
            trx,
            { table: data.table as Brc38NativeTextRead['table'], field: field.field, rowId: rowId as number },
            field.bytes,
            this.signal
          )
        for (const field of inlineFields)
          await writeBrc38NativePackedBytes(
            trx,
            { table: data.table as Brc38NativeBlobWrite['table'], field: field.field, rowId: rowId as number },
            field.bytes,
            this.signal
          )
        if (form.entity !== undefined) {
          if (
            typeof incomingId !== 'number' ||
            !Number.isInteger(incomingId) ||
            typeof rowId !== 'number' ||
            !Number.isSafeInteger(rowId) ||
            rowId < 1
          )
            invalid()
          for (const name of names) {
            if (this.installPreparedField !== undefined) {
              await this.installPreparedField(
                trx,
                data.table as Brc38NativeBlobWrite['table'],
                data.fromIndex + index,
                rowId,
                prepared.source.binaries[name]
              )
            } else
              await writeBrc38PrivatePackedField(trx, {
                table: data.table as Brc38NativeBlobWrite['table'],
                sourceIndex: data.fromIndex + index,
                destinationRowId: rowId,
                field: prepared.source.binaries[name],
                expiresAt: this.admission.expiresAt,
                signal: this.signal
              })
          }
          loaded.map[form.entity].idMap[incomingId] = rowId
        } else if (names.length !== 0) invalid()
        await assertBrc38NativeStreamedSourceRow(
          trx,
          data.table,
          data.fromIndex + index,
          prepared.source,
          this.admission.maximumStepBytes
        )
      })
      if (this.cache !== undefined) await applyBrc38ImportCacheFence(trx, this.storage, this.cache, this.signal)
      await loaded.persist()
      this.signal?.throwIfAborted()
      return { inserts: data.rows.length, updates: 0 }
    } finally {
      for (const fields of this.inlineBinary) for (const field of fields ?? []) field.bytes.fill(0)
      for (const fields of this.inlineText) for (const field of fields ?? []) field.bytes.fill(0)
    }
  }
}
/** Complete preparation stays on the actual read-only destination view. Local
 * projection writes use short independent private writer transactions; proof
 * network/chain callbacks finish before the final entity/journal writer. */
export async function prepareBrc38StructuredEntityRestore(
  trx: Knex.Transaction,
  storage: StorageKnex,
  reader: Readonly<Brc38AuthenticatedStreamedImportReader>,
  admission: Readonly<Brc38ImportJournalAdmission>,
  page: Brc38PreparedStreamedPage,
  store: KnexBrc38StagingStore,
  selectedSourcePolicy: Brc38PrivateStructuredPolicy,
  selectedProjectionPolicy: Brc38StreamedSyncMapProjectionPolicy,
  signal?: AbortSignal,
  installPreparedField?: Brc38PrivatePreparedFieldInstaller,
  preparedProjections?: ReadonlyMap<number, Readonly<Brc38JsonStructuredField>>,
  installPreparedText?: Brc38PrivatePreparedTextInstaller
): Promise<Brc38PreparedStructuredEntityRestore> {
  signal?.throwIfAborted()
  requireBrc38ImportSqliteTransaction(trx)
  if (privateNativeTransactionIdentity(trx)?.slot !== 3) invalid()
  const sourcePolicy = brc38PrivateStructuredPolicy(selectedSourcePolicy, store.directory),
    projectionPolicy = Object.freeze({ ...selectedProjectionPolicy }),
    { data, budget } = page,
    originalReader: Readonly<Brc38AuthenticatedImportReader> = Object.freeze({
      header: reader.header,
      count: reader.count,
      row: async (table: Brc38StageTable, index: number) => {
        const source = await reader.row(table, index)
        return source === undefined
          ? undefined
          : ({
              protocol: 'brc38-structured-original/v1',
              table,
              index,
              fields: source.fields,
              binaries: source.binaries,
              structured: source.structured ?? {},
              ...(Object.keys(source.texts ?? {}).length === 0 ? {} : { texts: source.texts })
            } as unknown as PortableRow)
      }
    }),
    originals = await prepareBrc38ImportStructuredOriginals(
      trx,
      originalReader,
      admission,
      data,
      page.step.fromRow,
      budget
    )
  if (
    projectionPolicy.expiresAt !== admission.expiresAt ||
    projectionPolicy.privateParent !== sourcePolicy.privateIndexParent ||
    (projectionPolicy.maximumReadBytes !== undefined &&
      sourcePolicy.maximumReadBytes !== undefined &&
      projectionPolicy.maximumReadBytes > sourcePolicy.maximumReadBytes)
  )
    invalid()
  await loadBrc38ImportIdMap(trx, admission.scope, page.references)
  let cache: Brc38ImportCacheFence | undefined
  const histories: Array<Readonly<Brc38ImportHistoryProjection> | undefined> = [],
    projected: Array<Readonly<Brc38JsonStructuredField> | undefined> = [],
    inlineBinary: Array<ReturnType<typeof prepareBrc38NativePackedWalletWrite>['fields'] | undefined> = [],
    inlineText: Array<ReturnType<typeof prepareBrc38NativePackedTextWalletWrite>['fields'] | undefined> = []
  if (data.kind === 'table') {
    // Prepare every original inline binary before taking the final writer.
    // Streamed descriptors never reach the ordinary full-DTO packed hooks.
    for (const [index, row] of data.rows.entries()) {
      const binaryNames = Object.keys(row.metadata).filter(name =>
        ['rawTx', 'inputBEEF', 'merklePath', 'noSendExpiryReclaimRawTx', 'lockingScript'].includes(name)
      )
      if (binaryNames.length === 0) continue
      chargeBrc38ImportDecodedBudget(budget, 262144)
      for (const name of binaryNames) {
        const value = row.metadata[name]
        if (value == null) continue
        if (!(value instanceof Uint8Array) && !Array.isArray(value)) invalid()
        chargeBrc38ImportDecodedBudget(budget, 512 + 16 * value.length)
      }
      const binaryTable = brc38PackedRestoreBinaryTable(data.table)
      if (binaryTable === undefined) invalid()
      inlineBinary[index] = prepareBrc38NativePackedWalletWrite(binaryTable, row.metadata).fields
    }
    if (data.table === 'provenTxs') {
      await runInSeries(data.rows.keys(), async index => {
        const maximum = JSON.parse(admission.originalLimitsJson) as number[],
          source = data.rows[index].source,
          allowance =
            1024 +
            ['rawTx', 'merklePath'].reduce(
              (sum, field) =>
                sum + (Object.hasOwn(source.fields, field) ? 512 + 16 * String(source.fields[field]).length : 0),
              0
            )
        chargeBrc38ImportDecodedBudget(budget, allowance)
        const expected = brc38StructuredInlineProofFields(source, allowance).row,
          proofReader = brc38StructuredInlineProofReader(reader, allowance, signal),
          maximumDecodedMerkleBytes = Math.max(1, Math.min(16777216, maximum[4], Math.floor(budget.remaining / 2)))
        const releaseProofScratch = reserveBrc38ImportDecodedScratch(budget, maximumDecodedMerkleBytes)
        const inspected = await inspectBrc38AuthenticatedStreamedProofReader(
          proofReader,
          storage,
          data.fromIndex + index,
          {
            maximumRawBytes: Math.min(1000000000, maximum[1]),
            maximumChunks: Math.min(1000000000, maximum[1]),
            maximumMerkleBytes: 1048576,
            maximumDecodedMerkleBytes,
            signal
          },
          admission.expiresAt
        )
        if (
          inspected.txid !== String(source.fields.txid).toLowerCase() ||
          inspected.rawSha256 !== expected.binaries.rawTx?.sha256 ||
          inspected.merkleSha256 !== expected.binaries.merklePath?.sha256
        )
          invalid()
        // Inspection returns bounded hashes/data only after its Merkle buffers
        // and actual network work drain. Failure/retained cleanup never refunds.
        releaseProofScratch()
      })
      cache = await prepareBrc38ImportCacheFence(trx, storage, budget)
    }
    if (data.table === 'provenTxReqs' || data.table === 'syncStates') {
      const field = data.table === 'provenTxReqs' ? 'notify' : 'syncMap'
      for (const [index, row] of data.rows.entries()) {
        signal?.throwIfAborted()
        if (row.source.structured?.[field] !== undefined) {
          chargeBrc38ImportDecodedBudget(budget, 2048)
          const expected = preparedProjections?.get(data.fromIndex + index),
            actual = (await readBrc38SqlProjectedStructuredDescriptors(trx, data.table, data.fromIndex + index))[field]
          if (expected === undefined || actual === undefined || JSON.stringify(actual) !== JSON.stringify(expected))
            invalid()
          projected[index] = actual
        } else {
          const value = row.metadata[field]
          if (typeof value !== 'string') invalid()
          chargeBrc38ImportDecodedBudget(budget, 1024 + 16 * Buffer.byteLength(value))
          // Reserve decoded output before legacy normalization allocates it.
          const allowance = Math.max(1, Math.floor((budget.remaining - 1024) / (32 * (data.rows.length - index))))
          chargeBrc38ImportDecodedBudget(budget, 1024 + 16 * allowance)
          histories[index] = (
            await prepareBrc38ImportHistory(
              trx,
              admission.scope,
              {
                kind: 'table',
                table: data.table,
                fromIndex: data.fromIndex + index,
                rows: [row.metadata]
              } as unknown as Brc38PreparedImportData,
              allowance,
              signal
            )
          )[0]
        }
      }
    }
  }
  if (
    data.kind === 'table' &&
    [
      'transactions',
      'provenTxReqs',
      'outputs',
      'commissions',
      'syncStates',
      'certificates',
      'certificateFields'
    ].includes(data.table)
  ) {
    const spec = nativePackedTextSource(data.table)
    for (const [index, prepared] of data.rows.entries()) {
      signal?.throwIfAborted()
      const keys = Object.keys(prepared.metadata)
      if (keys.length > 64) invalid()
      // Charge the actual shallow metadata container. Converted payload copies
      // below remain independently precharged by their actual UTF-8 byte size.
      chargeBrc38ImportDecodedBudget(budget, 1024 + 256 * keys.length)
      const metadata: Record<string, unknown> = { ...prepared.metadata },
        history = histories[index]
      if (history !== undefined) metadata[history.field] = history.mappedJson
      // Charge actual converted copies before allocation, on the original page
      // budget shared with binary/provenance/current-row preparation.
      for (const name of spec.fields) {
        const value = metadata[name]
        if (value == null) continue
        if (typeof value !== 'string') invalid()
        chargeBrc38ImportDecodedBudget(budget, 512 + 16 * Buffer.byteLength(value, 'utf8'))
      }
      for (const field of inlineBinary[index] ?? []) delete metadata[field.field]
      inlineText[index] = prepareBrc38NativePackedTextWalletWrite(spec.sql, metadata).fields
    }
  }
  signal?.throwIfAborted()
  return new Brc38PreparedStructuredEntityRestore(
    storage,
    admission,
    page,
    originals,
    Object.freeze(histories),
    Object.freeze(projected),
    cache,
    signal,
    Object.freeze(inlineBinary),
    installPreparedField,
    installPreparedText,
    Object.freeze(inlineText)
  )
}
