import type { Brc38PrivatePreparedFieldInstaller } from './Brc38NativePackedFieldPreparationNode'
import { writeBrc38PrivatePackedField } from './Brc38NativePackedFieldsNode'
import { hasBrc38NativePackedSchema } from './Brc38NativePackedSchemaNode'
import { verifyBrc38NativeTailLayout } from './Brc38NativeTailLayoutNode'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { Brc38StageTable } from './Brc38SemanticStage'
import type { Brc38AuthenticatedImportReader, Brc38AuthenticatedStreamedImportReader } from './KnexBrc38StagingStore'
import { isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { brc38ImportRowForm, type Brc38PreparedStreamedPage, type Brc38PreparedImportData } from './Brc38ImportPage'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { prepareBrc38ImportStreamedOriginals } from './Brc38ImportStreamedProvenanceNode'
import { insertBrc38PackedRestoreMetadata } from './Brc38PackedRestoreMetadataNode'
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

function invalid(): never {
  throw new Error('Private streamed restore differs from its admitted source or native writer')
}
const binaryTables = new Set<Brc38StageTable>(['provenTxs', 'provenTxReqs', 'transactions', 'outputs', 'commissions'])
/** Internal one-use effect plan. No original binary is materialized or represented
 * by a placeholder DTO. Empty physical BLOB cells belong to the explicit versioned packed layout;
 * payloads are independently hashed immutable chunks plus actual field pointers
 * before maps/receipt/cursor can commit.
 * Original incoming IDs/relations/operational histories remain identifiable in
 * a separate field-aware provenance family. Native IDs are deliberately mapped. */
export class Brc38PreparedStreamedEntityRestore {
  #consumed = false
  constructor(
    private readonly storage: StorageKnex,
    private readonly admission: Readonly<Brc38ImportJournalAdmission>,
    private readonly page: Brc38PreparedStreamedPage,
    private readonly originals: { apply: (trx: Knex.Transaction) => Promise<void> },
    private readonly histories: readonly Readonly<Brc38ImportHistoryProjection>[],
    private readonly cache?: Brc38ImportCacheFence,
    private readonly signal?: AbortSignal,
    private readonly installPreparedField?: Brc38PrivatePreparedFieldInstaller
  ) {}
  async apply(trx: Knex.Transaction): Promise<{ inserts: number; updates: 0 }> {
    if (!isBrc38OwnedPrivateNativeWriter(trx) || this.#consumed) invalid()
    requireBrc38ImportSqliteTransaction(trx)
    await verifyBrc38NativeTailLayout(trx)
    if (!(await hasBrc38NativePackedSchema(trx))) invalid()
    this.#consumed = true
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
      const rowId = await insertBrc38PackedRestoreMetadata(this.storage, trx, data.table, row, names, budget)
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
      // Recheck actual source metadata/descriptors after all native effects.
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
  }
}
/** Only actual retained source reads and read-only destination preparation.
 * Network/chain validation finishes before the caller takes the destination
 * writer. The enclosing journal must freshly compare its authoritative receipt
 * and actual source/profile/schema/primary fences before running apply. */
export async function prepareBrc38StreamedEntityRestore(
  trx: Knex.Transaction,
  storage: StorageKnex,
  reader: Readonly<Brc38AuthenticatedStreamedImportReader>,
  admission: Readonly<Brc38ImportJournalAdmission>,
  page: Brc38PreparedStreamedPage,
  signal?: AbortSignal,
  installPreparedField?: Brc38PrivatePreparedFieldInstaller
): Promise<Brc38PreparedStreamedEntityRestore> {
  requireBrc38ImportSqliteTransaction(trx)
  signal?.throwIfAborted()
  const { data, budget } = page,
    originalReader: Readonly<Brc38AuthenticatedImportReader> = Object.freeze({
      header: reader.header,
      count: reader.count,
      row: async (table: Brc38StageTable, index: number) => {
        const source = await reader.row(table, index)
        return source === undefined
          ? undefined
          : ({
              protocol: 'brc38-streamed-original/v1',
              table,
              index,
              fields: source.fields,
              binaries: source.binaries
            } as unknown as PortableRow)
      }
    }),
    originals = await prepareBrc38ImportStreamedOriginals(
      trx,
      originalReader,
      admission,
      data,
      page.step.fromRow,
      budget
    )
  await loadBrc38ImportIdMap(trx, admission.scope, page.references)
  let cache: Brc38ImportCacheFence | undefined,
    histories: readonly Readonly<Brc38ImportHistoryProjection>[] = Object.freeze([])
  if (data.kind === 'table') {
    if (data.table === 'provenTxs') {
      await runInSeries(data.rows.keys(), async index => {
        const maximum = JSON.parse(admission.originalLimitsJson) as number[],
          inspected = await inspectBrc38AuthenticatedStreamedProofReader(
            reader,
            storage,
            data.fromIndex + index,
            {
              maximumRawBytes: Math.min(1000000000, maximum[1]),
              maximumChunks: Math.min(1000000000, maximum[1]),
              maximumMerkleBytes: 1048576,
              maximumDecodedMerkleBytes: Math.max(1, Math.min(16777216, maximum[4], budget.remaining)),
              signal
            },
            admission.expiresAt
          ),
          source = data.rows[index].source
        if (
          inspected.txid !== String(source.fields.txid).toLowerCase() ||
          inspected.rawSha256 !== source.binaries.rawTx?.sha256 ||
          inspected.merkleSha256 !== source.binaries.merklePath?.sha256
        )
          invalid()
      })
      cache = await prepareBrc38ImportCacheFence(trx, storage, budget)
    }
    if (data.table === 'provenTxReqs' || data.table === 'syncStates') {
      // Only bounded metadata histories are passed to this original projection;
      // the full-row/entity apply path is never invoked with absent binaries.
      for (const row of data.rows) {
        const value = row.metadata[data.table === 'provenTxReqs' ? 'notify' : 'syncMap']
        if (typeof value !== 'string') invalid()
        chargeBrc38ImportDecodedBudget(budget, 1024 + 16 * Buffer.byteLength(value))
      }
      histories = await prepareBrc38ImportHistory(
        trx,
        admission.scope,
        {
          kind: 'table',
          table: data.table,
          fromIndex: data.fromIndex,
          rows: data.rows.map(row => row.metadata)
        } as unknown as Brc38PreparedImportData,
        Math.max(1, budget.remaining),
        signal
      )
    }
  }
  signal?.throwIfAborted()
  return new Brc38PreparedStreamedEntityRestore(
    storage,
    admission,
    page,
    originals,
    histories,
    cache,
    signal,
    installPreparedField
  )
}
