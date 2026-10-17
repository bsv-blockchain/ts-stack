import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { SyncMap } from '../schema/entities/EntityBase'
import {
  nativeSimplePayloadMerge,
  nativeSimplePayloadMetadata,
  nativeSimplePayloadFields,
  type NativeSimplePayloadRow
} from '../snapshot/NativeSnapshotSyncSimpleRows'
import {
  prepareBrc38ImportOriginalFieldPolicy,
  prepareBrc38ImportCurrentFieldPolicy
} from './Brc38ImportFieldPolicyRowsNode'
import { prepareBrc38ImportEntityTargets, type Brc38ImportEntityTarget } from './Brc38ImportEntityTargets'
import {
  prepareBrc38ImportExistingFieldTargets,
  assertBrc38ImportExistingFieldTargets,
  type Brc38ImportExistingFieldRow
} from './Brc38ImportExistingRows'
import { Brc38ImportAliasPageError } from './Brc38ImportEntityMergeNode'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import { brc38ImportRowForm, type Brc38PreparedStreamedPage } from './Brc38ImportPage'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import type { Brc38AuthenticatedImportReader, Brc38AuthenticatedStreamedImportReader } from './KnexBrc38StagingStore'
import { isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { privateNativeDatabaseIdentity, privateNativeTransactionIdentity } from './Brc38PrivateNativeOwnershipNode'
import { requireBrc38ImportSqliteTransaction } from './Brc38ImportJournalSchema'
import { prepareBrc38ImportStructuredOriginals } from './Brc38ImportStructuredProvenanceNode'
import { assertBrc38NativeStreamedSourceRow } from './Brc38NativeBinaryFieldNode'
import {
  insertBrc38PackedRestoreMetadata,
  insertBrc38PackedPlannedMetadata,
  updateBrc38PackedPrivateMetadata
} from './Brc38PackedRestoreMetadataNode'
import { prepareBrc38PrivatePageIds, type Brc38PrivatePageIds } from './Brc38PrivatePageIdsNode'
import { prepareBrc38NativePackedTextWalletWrite } from './Brc38NativePackedTextWalletNode'
import { prepareBrc38NativePackedWalletWrite } from './Brc38NativePackedWalletNode'
import { writeBrc38NativePackedBytes } from './Brc38NativePackedFieldsNode'
import { writeBrc38NativePackedTextBytes } from './Brc38NativePackedTextFieldsNode'
import { nativePackedTextSource } from './Brc38NativePackedTextSources'
import type { Brc38PrivatePreparedFieldInstaller } from './Brc38NativePackedFieldPreparationNode'
import type { Brc38PrivatePreparedTextInstaller } from './Brc38NativePackedTextPreparationNode'
import { chargeBrc38ImportDecodedBudget, copyBrc38ImportDecodedValue } from './Brc38ImportDecodedBudget'
import type { PortableRow } from './Brc38PortableRows'

interface Row {
  readonly incoming: NativeSimplePayloadRow
  readonly current?: NativeSimplePayloadRow
  readonly target: Readonly<Brc38ImportEntityTarget>
  readonly existing: Readonly<Brc38ImportExistingFieldRow>
  readonly inlineText: ReturnType<typeof prepareBrc38NativePackedTextWalletWrite>['fields']
  readonly inlineBinary: ReturnType<typeof prepareBrc38NativePackedWalletWrite>['fields']
  readonly plannedId?: number
}
function invalid(): never {
  throw new Error('Private simple field merge differs from its actual source/current rows/maps or native owner')
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid()
  return value
}
function simple(row: ReturnType<typeof prepareBrc38ImportOriginalFieldPolicy>): NativeSimplePayloadRow {
  if (row.table !== 'certificates' && row.table !== 'certificateFields' && row.table !== 'commissions') invalid()
  return row
}
function parent(row: NativeSimplePayloadRow, map: SyncMap): number | undefined {
  if (row.table === 'certificateFields') return positive(map.certificate.idMap[row.value.certificateId])
  if (row.table === 'commissions') return positive(map.transaction.idMap[row.value.transactionId])
  return undefined
}
async function currentParent(
  trx: Knex.Transaction,
  row: NativeSimplePayloadRow,
  map: SyncMap,
  userId: number
): Promise<void> {
  const id = parent(row, map)
  if (id === undefined) return
  const certificate = row.table === 'certificateFields',
    rows: Array<{ found: number }> = await trx(certificate ? 'certificates' : 'transactions')
      .where({ userId, [certificate ? 'certificateId' : 'transactionId']: id })
      .select(trx.raw('1 AS found'))
      .limit(2)
  if (rows.length !== 1) invalid()
}
/** One-use private effects. It owns no archive/preview/primary admission: only
 * the enclosing isolated-candidate journal writer can commit its receipt. */
export class Brc38PreparedSimpleFieldMerge {
  #consumed = false
  #closed = false
  readonly #root: Knex
  readonly #deadline: number
  constructor(
    private readonly storage: StorageKnex,
    private readonly admission: Readonly<Brc38ImportJournalAdmission>,
    private readonly page: Brc38PreparedStreamedPage,
    private readonly rows: readonly Row[],
    private readonly originalMap: SyncMap,
    private readonly originals: { apply(trx: Knex.Transaction): Promise<void> },
    private readonly fieldAllowance: number,
    private readonly installBinary: Brc38PrivatePreparedFieldInstaller,
    private readonly installText: Brc38PrivatePreparedTextInstaller,
    readonly checkpointMappings: readonly Readonly<{ incomingId: number; localId: number }>[],
    private readonly allocation?: Brc38PrivatePageIds,
    private readonly signal?: AbortSignal
  ) {
    this.#root = storage.toDb()
    this.#deadline = performance.now() + Math.max(0, admission.expiresAt - Date.now())
  }
  private check(trx: Knex.Transaction): void {
    this.signal?.throwIfAborted()
    const root = privateNativeDatabaseIdentity(this.#root),
      actual = privateNativeTransactionIdentity(trx)
    if (
      this.#closed ||
      this.storage.toDb() !== this.#root ||
      root?.slot !== 0 ||
      actual?.slot !== 0 ||
      root.token !== actual.token ||
      !isBrc38OwnedPrivateNativeWriter(trx) ||
      Date.now() >= this.admission.expiresAt ||
      performance.now() >= this.#deadline
    )
      invalid()
    requireBrc38ImportSqliteTransaction(trx)
  }
  async apply(trx: Knex.Transaction): Promise<{ inserts: number; updates: number }> {
    this.check(trx)
    if (this.#consumed || this.page.data.kind !== 'table') invalid()
    this.#consumed = true
    try {
      const data = this.page.data,
        { budget } = this.page
      chargeBrc38ImportDecodedBudget(budget, this.fieldAllowance + 32768 + 2048 * this.page.references.length)
      const loaded = await loadBrc38ImportIdMap(trx, this.admission.scope, this.page.references)
      for (const ref of this.page.references) {
        const before = this.originalMap[ref.entity].idMap,
          now = loaded.map[ref.entity].idMap
        if (
          Object.hasOwn(before, ref.incomingId) !== Object.hasOwn(now, ref.incomingId) ||
          before[ref.incomingId] !== now[ref.incomingId]
        )
          invalid()
      }
      await assertBrc38ImportExistingFieldTargets(
        trx,
        this.storage,
        this.admission.scope.userId,
        data.table,
        this.rows.map(row => row.target),
        this.rows.map(row => row.existing),
        this.fieldAllowance,
        this.signal
      )
      for (const [index, row] of this.rows.entries()) {
        this.check(trx)
        await currentParent(trx, row.incoming, loaded.map, this.admission.scope.userId)
        await assertBrc38NativeStreamedSourceRow(
          trx,
          data.table,
          data.fromIndex + index,
          data.rows[index].source,
          this.admission.maximumStepBytes
        )
      }
      await this.originals.apply(trx)
      let inserts = 0,
        updates = 0
      const form = brc38ImportRowForm(data.table)
      for (const [index, row] of this.rows.entries()) {
        this.check(trx)
        const selected = nativeSimplePayloadMerge(
            row.current,
            row.incoming,
            this.admission.scope.userId,
            parent(row.incoming, loaded.map)
          ),
          incomingId = form.id === undefined ? undefined : Reflect.get(row.incoming.value, form.id)
        if (selected === undefined) {
          if (!row.target.found) invalid()
          if (form.entity !== undefined)
            loaded.map[form.entity].idMap[incomingId as number] = positive(row.target.localId)
          continue
        }
        const metadata = nativeSimplePayloadMetadata(selected, row.target.found),
          texts: string[] = [],
          binaries: string[] = [],
          source = data.rows[index].source,
          retainedCommission = selected.table === 'commissions' && row.current !== undefined
        if (form.id !== undefined) metadata[form.id] = row.target.found ? positive(row.target.localId) : 0
        if (!retainedCommission) {
          for (const name of nativeSimplePayloadFields[selected.table]) {
            const value: unknown = Reflect.get(selected.value, name)
            if (value === undefined) {
              metadata[name] = null
              continue
            }
            if (name === 'lockingScript') {
              binaries.push(name)
              delete metadata[name]
              continue
            }
            texts.push(name)
            delete metadata[name]
          }
        }
        const id = row.target.found
          ? await updateBrc38PackedPrivateMetadata(
              this.storage,
              trx,
              data.table,
              metadata,
              binaries,
              row.target,
              budget,
              texts
            )
          : row.plannedId !== undefined && this.allocation !== undefined
            ? await insertBrc38PackedPlannedMetadata(
                this.storage,
                trx,
                data.table,
                metadata,
                binaries,
                this.allocation,
                budget,
                texts
              )
            : await insertBrc38PackedRestoreMetadata(this.storage, trx, data.table, metadata, binaries, budget, texts)
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) invalid()
        if (!row.target.found && form.entity !== undefined && id !== row.plannedId) invalid()
        const logical = row.target.found && form.id !== undefined ? positive(row.target.localId) : id,
          sql = nativePackedTextSource(data.table).sql,
          physical: Array<{ rowid: number }> = await trx(sql)
            .where(form.id === undefined ? { rowid: id } : { [form.id]: logical })
            .select('rowid')
            .limit(2)
        if (physical.length !== 1 || !Number.isSafeInteger(physical[0].rowid) || physical[0].rowid < 1) invalid()
        for (const name of texts) {
          const field = source.texts?.[name]
          if (field !== undefined)
            await this.installText(
              trx,
              data.table as 'certificates' | 'certificateFields' | 'commissions',
              data.fromIndex + index,
              form.id === undefined ? physical[0].rowid : logical,
              field,
              'text'
            )
          else {
            const inline = row.inlineText.find(value => value.field === name)
            if (inline === undefined) invalid()
            await writeBrc38NativePackedTextBytes(
              trx,
              {
                table: data.table as 'certificates' | 'certificateFields' | 'commissions',
                field: inline.field,
                rowId: form.id === undefined ? physical[0].rowid : logical
              },
              inline.bytes,
              this.signal
            )
          }
        }
        for (const name of binaries) {
          const field = source.binaries[name]
          if (field !== undefined)
            await this.installBinary(trx, 'commissions', data.fromIndex + index, physical[0].rowid, field)
          else {
            const inline = row.inlineBinary.find(value => value.field === name)
            if (inline === undefined) invalid()
            await writeBrc38NativePackedBytes(
              trx,
              { table: 'commissions', field: inline.field, rowId: physical[0].rowid },
              inline.bytes,
              this.signal
            )
          }
        }
        if (form.entity !== undefined) {
          if (typeof incomingId !== 'number' || !Number.isInteger(incomingId)) invalid()
          loaded.map[form.entity].idMap[incomingId] = logical
        }
        await assertBrc38NativeStreamedSourceRow(
          trx,
          data.table,
          data.fromIndex + index,
          source,
          this.admission.maximumStepBytes
        )
        if (row.target.found) updates++
        else inserts++
      }
      await loaded.persist()
      this.check(trx)
      return { inserts, updates }
    } finally {
      this.close()
    }
  }
  close(): void {
    this.#closed = true
    for (const row of this.rows) {
      for (const field of row.inlineText) field.bytes.fill(0)
      for (const field of row.inlineBinary) field.bytes.fill(0)
    }
  }
}
/** Complete three-table occupied policy preparation. It runs on the actual
 * private read owner, captures current indexed metadata/pointers and parent
 * maps, and segments aliases before effects. Large original source fields are
 * independently prepared by callback-scoped installers before final writer
 * admission. Existing commission payloads remain untouched. */
export async function prepareBrc38SimpleFieldMerge(
  trx: Knex.Transaction,
  storage: StorageKnex,
  reader: Readonly<Brc38AuthenticatedStreamedImportReader>,
  admission: Readonly<Brc38ImportJournalAdmission>,
  page: Brc38PreparedStreamedPage,
  installBinary: Brc38PrivatePreparedFieldInstaller,
  installText: Brc38PrivatePreparedTextInstaller,
  signal?: AbortSignal
): Promise<Brc38PreparedSimpleFieldMerge> {
  signal?.throwIfAborted()
  requireBrc38ImportSqliteTransaction(trx)
  const root = privateNativeDatabaseIdentity(storage.toDb()),
    read = privateNativeTransactionIdentity(trx),
    { data, budget } = page
  if (
    root?.slot !== 0 ||
    read?.slot !== 3 ||
    read.token !== root.token ||
    data.kind !== 'table' ||
    !['certificates', 'certificateFields', 'commissions'].includes(data.table)
  )
    invalid()
  const originalReader: Readonly<Brc38AuthenticatedImportReader> = Object.freeze<Brc38AuthenticatedImportReader>({
      header: reader.header,
      count: reader.count,
      row: async (table, index) => {
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
  chargeBrc38ImportDecodedBudget(budget, 32768 + 2048 * page.references.length)
  const loaded = await loadBrc38ImportIdMap(trx, admission.scope, page.references),
    originalMap = copyBrc38ImportDecodedValue(loaded.map, budget),
    keyAllowance = Math.min(1048576, Math.floor(budget.remaining / 8)),
    fieldAllowance = Math.min(1048576, Math.floor(budget.remaining / 4))
  if (keyAllowance < 16384 || fieldAllowance < 16384) invalid()
  chargeBrc38ImportDecodedBudget(budget, keyAllowance + fieldAllowance)
  const targets = await prepareBrc38ImportEntityTargets(
      trx,
      admission.scope.userId,
      { kind: 'table', table: data.table, rows: data.rows.map(row => row.metadata) },
      loaded.map,
      keyAllowance,
      signal
    ),
    existing = await prepareBrc38ImportExistingFieldTargets(
      trx,
      storage,
      admission.scope.userId,
      data.table,
      targets,
      fieldAllowance,
      signal
    ),
    rows: Row[] = [],
    identities = new Set<string>()
  try {
    for (const [index, prepared] of data.rows.entries()) {
      signal?.throwIfAborted()
      chargeBrc38ImportDecodedBudget(budget, existing[index].allocationBytes + 8192)
      const target = targets[index],
        identity = JSON.stringify([target.index, target.key])
      if (identities.has(identity)) throw new Brc38ImportAliasPageError(index)
      identities.add(identity)
      const incoming = simple(
          prepareBrc38ImportOriginalFieldPolicy(
            data.table as 'certificates' | 'certificateFields' | 'commissions',
            data.fromIndex + index,
            prepared.metadata,
            prepared.source,
            budget
          )
        ),
        currentData = prepareBrc38ImportCurrentFieldPolicy(existing[index], budget),
        current = currentData === undefined ? undefined : simple(currentData),
        selected = nativeSimplePayloadMerge(current, incoming, admission.scope.userId, parent(incoming, loaded.map)),
        metadata = selected === undefined ? {} : nativeSimplePayloadMetadata(selected, target.found),
        retainedCommission = data.table === 'commissions' && current !== undefined,
        textBytes = Object.values(metadata).reduce<number>(
          (sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value) : 0),
          0
        )
      chargeBrc38ImportDecodedBudget(budget, 262144 + 16 * textBytes)
      const inlineText = prepareBrc38NativePackedTextWalletWrite(
        nativePackedTextSource(data.table).sql,
        metadata
      ).fields
      // Enroll already-owned TEXT before the next binary allocation can fail.
      const row: Row = { incoming, current, target, existing: existing[index], inlineText, inlineBinary: [] }
      rows.push(row)
      if (
        data.table === 'commissions' &&
        selected !== undefined &&
        !retainedCommission &&
        prepared.source.binaries.lockingScript === undefined
      ) {
        const value = prepared.metadata.lockingScript
        if (!(value instanceof Uint8Array) && !Array.isArray(value)) invalid()
        chargeBrc38ImportDecodedBudget(budget, 262144 + 16 * value.length)
        rows[index] = {
          ...row,
          inlineBinary: prepareBrc38NativePackedWalletWrite('commissions', { lockingScript: value }).fields
        }
      }
    }
    signal?.throwIfAborted()
    const form = brc38ImportRowForm(data.table),
      newRows = form.entity === undefined ? 0 : rows.filter(row => !row.target.found).length,
      allocation =
        newRows === 0
          ? undefined
          : await prepareBrc38PrivatePageIds(storage, trx, data.table, newRows, admission.expiresAt, budget),
      checkpointMappings: Array<Readonly<{ incomingId: number; localId: number }>> = []
    chargeBrc38ImportDecodedBudget(budget, 8192 + 2048 * rows.length)
    let ordinal = 0
    for (const [index, row] of rows.entries()) {
      if (form.entity === undefined || form.id === undefined) continue
      const incomingId: unknown = Reflect.get(row.incoming.value, form.id),
        localId = row.target.found ? positive(row.target.localId) : positive(allocation?.ids[ordinal++])
      if (typeof incomingId !== 'number' || !Number.isInteger(incomingId)) invalid()
      if (!row.target.found) rows[index] = { ...row, plannedId: localId }
      checkpointMappings.push(Object.freeze({ incomingId, localId }))
    }
    return new Brc38PreparedSimpleFieldMerge(
      storage,
      admission,
      page,
      rows,
      originalMap,
      originals,
      fieldAllowance,
      installBinary,
      installText,
      Object.freeze(checkpointMappings),
      allocation,
      signal
    )
  } catch (cause) {
    for (const row of rows) {
      for (const field of row.inlineText) field.bytes.fill(0)
      for (const field of row.inlineBinary) field.bytes.fill(0)
    }
    throw cause
  }
}
