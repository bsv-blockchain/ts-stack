import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { SyncMap } from '../schema/entities/EntityBase'
import { planProvenTxReqMergeMetadata } from '../schema/entities/EntityProvenTxReq'
import {
  readNativeSnapshotSyncRequestCurrent,
  requireSameNativeSnapshotSyncRequestCurrent,
  readNativeSnapshotTransactionMembershipRevision,
  type NativeSnapshotSyncRequestCurrent
} from '../snapshot/NativeSnapshotSyncRequestsCurrentNode'
import { brc38ImportRequestIdentity, type SnapshotSyncRequestRow } from '../snapshot/SnapshotSyncRequestMetadata'
import type {
  KnexBrc38StagingStore,
  Brc38AuthenticatedImportReader,
  Brc38AuthenticatedStreamedImportReader
} from './KnexBrc38StagingStore'
import { isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { privateNativeDatabaseIdentity, privateNativeTransactionIdentity } from './Brc38PrivateNativeOwnershipNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { requireBrc38ImportSqliteTransaction } from './Brc38ImportJournalSchema'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { admissionCopy } from './Brc38ImportJournalCore'
import type { Brc38PreparedStreamedPage } from './Brc38ImportPage'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import { prepareBrc38ImportOriginalFieldPolicy } from './Brc38ImportFieldPolicyRowsNode'
import { prepareBrc38ImportStructuredOriginals } from './Brc38ImportStructuredProvenanceNode'
import type { PortableRow } from './Brc38PortableRows'
import { Brc38ImportAliasPageError } from './Brc38ImportEntityMergeNode'
import { chargeBrc38ImportDecodedBudget, copyBrc38ImportDecodedValue } from './Brc38ImportDecodedBudget'
import { prepareBrc38PrivatePageIds, type Brc38PrivatePageIds } from './Brc38PrivatePageIdsNode'
import { insertBrc38PackedPlannedMetadata, updateBrc38PackedPrivateMetadata } from './Brc38PackedRestoreMetadataNode'
import { assertBrc38NativeStreamedSourceRow } from './Brc38NativeBinaryFieldNode'
import { prepareBrc38NativePackedWalletWrite } from './Brc38NativePackedWalletNode'
import { writeBrc38NativePackedBytes } from './Brc38NativePackedFieldsNode'
import type { Brc38PrivatePreparedFieldInstaller } from './Brc38NativePackedFieldPreparationNode'
import { prepareBrc38PrivateOccupiedHistoryText } from './Brc38PrivateOccupiedHistoryTextNode'
import { prepareBrc38PrivateOccupiedNotifyText } from './Brc38PrivateOccupiedNotifyTextNode'
import { prepareBrc38PrivateNewRequestText } from './Brc38PrivateNewRequestTextNode'
import { compareBrc38PrivateDerivedText } from './Brc38PrivateDerivedTextComparisonNode'
import type { Brc38PrivateDerivedTextDescriptor } from './Brc38PrivateDerivedTextVersionNode'
import type { Brc38PrivateCurrentStructuredPolicy } from './Brc38PrivateCurrentStructuredSourceNode'
import type { Brc38StreamedHistoryProjectionPolicy } from './Brc38StreamedHistoryProjection'
import {
  readBrc38NativePackedTextVersionDescriptor,
  readBrc38NativePackedTextDescriptor
} from './Brc38NativePackedTextFieldsNode'
import { nativePackedTextTables } from './Brc38NativePackedTextSchemaNode'
import { brc38NativeTextCoordinate } from './Brc38NativeBlobProtocol'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'

interface SelectedRow {
  readonly incoming: SnapshotSyncRequestRow
  readonly current: NativeSnapshotSyncRequestCurrent
  readonly localId: number
  readonly inlineBinary: ReturnType<typeof prepareBrc38NativePackedWalletWrite>['fields']
}
interface Row extends SelectedRow {
  readonly history: Readonly<Brc38PrivateDerivedTextDescriptor>
  readonly notify: Readonly<Brc38PrivateDerivedTextDescriptor>
  readonly historyBaseline?: Readonly<Brc38PrivateDerivedTextDescriptor>
  readonly notifyBaseline?: Readonly<Brc38PrivateDerivedTextDescriptor>
  readonly historyEqual: boolean
  readonly notifyEqual: boolean
  readonly notifiedReset: boolean
}
const issuer = Object.freeze({})
function invalid(): never {
  throw new Error('Private request merge differs from its actual source, current row, receipt, parents or owner')
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid()
  return value
}

/** One-use final row effects. Request status/attempts/proof/raw/input/broadcast
 * fields survive occupied merges. Legacy normalized history/notify comparison
 * decides whether any row write occurs, and only that write may reset notified.
 * The enclosing journal controller owns checkpoint, page receipt and primary
 * fencing in this same transaction. Bulk payload hashing and all network work
 * finish before entry; already bounded inline binary DATA uses its row writer. */
export class Brc38PreparedRequestMerge {
  #closed = false
  #consumed = false
  readonly #root: Knex
  readonly #token: object
  readonly #rows: readonly Row[]
  readonly #originalMap: SyncMap
  readonly #effects = new Brc38OwnedImportReads()
  constructor(
    token: object,
    private readonly store: KnexBrc38StagingStore,
    private readonly storage: StorageKnex,
    private readonly admission: Readonly<Brc38ImportJournalAdmission>,
    private readonly page: Brc38PreparedStreamedPage,
    rows: readonly Row[],
    originalMap: SyncMap,
    private readonly receipt: string,
    private readonly membership: string,
    private readonly originals: { apply(trx: Knex.Transaction): Promise<void> },
    private readonly install: Brc38PrivatePreparedFieldInstaller,
    private readonly deadline: number,
    readonly checkpointMappings: readonly Readonly<{ incomingId: number; localId: number }>[],
    private readonly allocation?: Brc38PrivatePageIds,
    private readonly signal?: AbortSignal
  ) {
    if (token !== issuer) invalid()
    this.#rows = rows
    this.#originalMap = originalMap
    this.#root = storage.toDb()
    const identity = privateNativeDatabaseIdentity(this.#root)
    if (identity?.slot !== 0 || this.#root !== store.knex) invalid()
    this.#token = identity.token
  }
  private check(trx: Knex.Transaction): void {
    this.signal?.throwIfAborted()
    const root = privateNativeDatabaseIdentity(this.#root),
      actual = privateNativeTransactionIdentity(trx)
    if (
      this.#closed ||
      this.storage.toDb() !== this.#root ||
      root?.slot !== 0 ||
      root.token !== this.#token ||
      actual?.slot !== 0 ||
      actual.token !== this.#token ||
      !isBrc38OwnedPrivateNativeWriter(trx) ||
      Date.now() >= this.admission.expiresAt ||
      performance.now() >= this.deadline
    )
      invalid()
    this.store.assertPrivateNativeWriteTransaction(trx)
    requireBrc38ImportSqliteTransaction(trx)
  }
  private async version(trx: Knex.Transaction, selected: Readonly<Brc38PrivateDerivedTextDescriptor>): Promise<void> {
    this.check(trx)
    const actual = await readBrc38NativePackedTextVersionDescriptor(trx, selected.sha256)
    if (actual.bytes !== selected.bytes || actual.sha256 !== selected.sha256) invalid()
  }
  private async attach(trx: Knex.Transaction, row: Row, field: 'history' | 'notify'): Promise<void> {
    const selected = row[field],
      prior = row.current.field.texts?.[field],
      packet = brc38NativeTextCoordinate('provenTxReqs', field),
      key = { tableId: packet[0], fieldId: packet[1], rowId: row.localId }
    await this.version(trx, selected)
    const pointers: Array<{ sha256: string }> = await trx(nativePackedTextTables.fields)
      .where(key)
      .select('sha256')
      .limit(2)
    if (
      pointers.length > 1 ||
      (prior === undefined ? pointers.length !== 0 : pointers.length !== 1 || pointers[0].sha256 !== prior.sha256)
    )
      invalid()
    await trx(nativePackedTextTables.fields).where(key).delete()
    await trx(nativePackedTextTables.fields).insert({ ...key, sha256: selected.sha256 })
    const actual = await readBrc38NativePackedTextDescriptor(trx, { table: 'provenTxReqs', field, rowId: row.localId })
    if (actual?.bytes !== selected.bytes || actual.sha256 !== selected.sha256) invalid()
    this.check(trx)
  }
  apply(trx: Knex.Transaction): Promise<{ inserts: number; updates: number }> {
    return this.#effects.run(async () => await this.applyRows(trx))
  }
  private async applyRows(trx: Knex.Transaction): Promise<{ inserts: number; updates: number }> {
    this.check(trx)
    if (this.#consumed || this.page.data.kind !== 'table' || this.page.data.table !== 'provenTxReqs') invalid()
    this.#consumed = true
    try {
      const { data, budget } = this.page
      chargeBrc38ImportDecodedBudget(budget, 32768 + 2048 * this.page.references.length)
      await verifyBrc38AuthenticatedSourceSeal(trx)
      if (
        JSON.stringify(await readBrc38ImportJournal(trx, this.admission)) !== this.receipt ||
        (await readNativeSnapshotTransactionMembershipRevision(trx)) !== this.membership
      )
        invalid()
      const loaded = await loadBrc38ImportIdMap(trx, this.admission.scope, this.page.references)
      for (const ref of this.page.references) {
        const before = this.#originalMap[ref.entity].idMap,
          after = loaded.map[ref.entity].idMap
        if (
          Object.hasOwn(before, ref.incomingId) !== Object.hasOwn(after, ref.incomingId) ||
          before[ref.incomingId] !== after[ref.incomingId]
        )
          invalid()
      }
      // Validate the complete page before originals or any selected row effect.
      for (const [index, row] of this.#rows.entries()) {
        chargeBrc38ImportDecodedBudget(budget, 1114112)
        requireSameNativeSnapshotSyncRequestCurrent(
          row.current,
          await readNativeSnapshotSyncRequestCurrent(
            this.storage,
            trx,
            this.admission.scope.userId,
            row.incoming,
            loaded.map,
            this.signal
          )
        )
        await assertBrc38NativeStreamedSourceRow(
          trx,
          'provenTxReqs',
          data.fromIndex + index,
          data.rows[index].source,
          this.admission.maximumStepBytes
        )
        for (const version of [row.history, row.notify, row.historyBaseline, row.notifyBaseline])
          if (version !== undefined) await this.version(trx, version)
      }
      await this.originals.apply(trx)
      let inserts = 0
      for (const [index, row] of this.#rows.entries()) {
        this.check(trx)
        chargeBrc38ImportDecodedBudget(budget, 1114112)
        const actual = await readNativeSnapshotSyncRequestCurrent(
          this.storage,
          trx,
          this.admission.scope.userId,
          row.incoming,
          loaded.map,
          this.signal
        )
        requireSameNativeSnapshotSyncRequestCurrent(row.current, actual)
        const prior = actual.row,
          selected = prior === undefined ? row.incoming : planProvenTxReqMergeMetadata(prior, row.incoming)
        if (
          prior !== undefined &&
          selected.batch === prior.batch &&
          selected.updated_at.getTime() === prior.updated_at.getTime() &&
          row.historyEqual &&
          row.notifyEqual
        ) {
          loaded.map.provenTxReq.idMap[row.incoming.provenTxReqId] = row.localId
          continue
        }
        chargeBrc38ImportDecodedBudget(budget, 16384)
        const metadata: Record<string, unknown> = { ...selected, provenTxReqId: prior === undefined ? 0 : row.localId }
        for (const field of ['history', 'notify', 'rawTx', 'inputBEEF']) delete metadata[field]
        if (row.notifiedReset) metadata.notified = false
        const binaries: Array<'rawTx' | 'inputBEEF'> = []
        if (prior === undefined) {
          metadata.provenTxId = actual.incomingProvenTxId
          for (const field of ['rawTx', 'inputBEEF'] as const)
            if (row.incoming[field] !== undefined) binaries.push(field)
          if (!binaries.includes('rawTx') || this.allocation === undefined) invalid()
        }
        const physical =
          prior === undefined && this.allocation !== undefined
            ? await insertBrc38PackedPlannedMetadata(
                this.storage,
                trx,
                'provenTxReqs',
                metadata,
                binaries,
                this.allocation,
                budget,
                ['history', 'notify']
              )
            : actual.target === undefined
              ? invalid()
              : await updateBrc38PackedPrivateMetadata(
                  this.storage,
                  trx,
                  'provenTxReqs',
                  metadata,
                  binaries,
                  actual.target,
                  budget,
                  ['history', 'notify']
                )
        positive(physical)
        if (prior === undefined && physical !== row.localId) invalid()
        for (const field of binaries) {
          const original = data.rows[index].source.binaries[field]
          if (original !== undefined)
            await this.install(trx, 'provenTxReqs', data.fromIndex + index, row.localId, original)
          else {
            const inline = row.inlineBinary.find(value => value.field === field)
            if (inline === undefined) invalid()
            await writeBrc38NativePackedBytes(
              trx,
              { table: 'provenTxReqs', field, rowId: row.localId },
              inline.bytes,
              this.signal
            )
          }
        }
        await this.attach(trx, row, 'history')
        await this.attach(trx, row, 'notify')
        loaded.map.provenTxReq.idMap[row.incoming.provenTxReqId] = row.localId
        await assertBrc38NativeStreamedSourceRow(
          trx,
          'provenTxReqs',
          data.fromIndex + index,
          data.rows[index].source,
          this.admission.maximumStepBytes
        )
        if (prior === undefined) inserts++
      }
      await loaded.persist()
      await verifyBrc38AuthenticatedSourceSeal(trx)
      this.check(trx)
      // EntityProvenTxReq.mergeExisting historically returns false even on write.
      return { inserts, updates: 0 }
    } finally {
      this.dispose()
    }
  }
  private dispose(): void {
    this.#closed = true
    for (const row of this.#rows) for (const field of row.inlineBinary) field.bytes.fill(0)
  }
  async close(): Promise<void> {
    try {
      await this.#effects.finish()
    } finally {
      this.dispose()
    }
  }
}

/** Scoped owner retains and drains even an unawaited pending effect before
 * its authenticated receiver callback may close. Preparation alone installs
 * nothing; the enclosing journal must await apply within its final writer. */
export async function withBrc38PreparedRequestMerge<T>(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  reader: Readonly<Brc38AuthenticatedStreamedImportReader>,
  admission: Readonly<Brc38ImportJournalAdmission>,
  page: Brc38PreparedStreamedPage,
  install: Brc38PrivatePreparedFieldInstaller,
  source: Brc38PrivateCurrentStructuredPolicy,
  projection: Brc38StreamedHistoryProjectionPolicy,
  work: (merge: Brc38PreparedRequestMerge) => Promise<T>
): Promise<T> {
  return await Brc38PrivateDerivedTextLifetimes.with(store, projection, async lifetimes => {
    const merge = await prepareBrc38RequestMerge(
      store,
      storage,
      reader,
      admission,
      page,
      install,
      source,
      projection,
      lifetimes
    )
    let result!: T,
      failed = false,
      failure: unknown
    try {
      result = await work(merge)
    } catch (cause) {
      failed = true
      failure = cause
    }
    try {
      await merge.close()
    } catch (cause) {
      if (failed && cause !== failure)
        throw new AggregateError([failure, cause], 'Private request callback and retained effect both failed')
      throw cause
    }
    if (failed) throw failure
    return result
  })
}

/** Initial metadata/provenance preparation drains its actual read pool before
 * any derived writer is acquired. Complete history/notify staging then occurs
 * outside retained SQL transactions, with source/current checks at every read.
 * Call only within the actual authenticated structured receiver's owner scope. */
async function prepareBrc38RequestMerge(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  reader: Readonly<Brc38AuthenticatedStreamedImportReader>,
  selectedAdmission: Readonly<Brc38ImportJournalAdmission>,
  page: Brc38PreparedStreamedPage,
  install: Brc38PrivatePreparedFieldInstaller,
  sourcePolicy: Brc38PrivateCurrentStructuredPolicy,
  projectionPolicy: Brc38StreamedHistoryProjectionPolicy,
  lifetimes: Brc38PrivateDerivedTextLifetimes
): Promise<Brc38PreparedRequestMerge> {
  const admission = admissionCopy(selectedAdmission),
    source = Object.freeze({ ...sourcePolicy }),
    projection = Object.freeze({ ...projectionPolicy }),
    root = storage.toDb(),
    origin = privateNativeDatabaseIdentity(root),
    { data, budget } = page,
    signal = projection.signal,
    deadline = performance.now() + Math.max(0, admission.expiresAt - Date.now()),
    owned: SelectedRow[] = [],
    capturedBinary: Uint8Array[] = []
  if (
    root !== store.knex ||
    origin?.slot !== 0 ||
    data.kind !== 'table' ||
    data.table !== 'provenTxReqs' ||
    admission.scope.bindingSha256 !== store.binding?.digest ||
    admission.scope.archiveSha256 !== store.binding?.binding.archiveSha256 ||
    admission.originalLimitsJson !== store.binding?.limitsJson ||
    admission.expiresAt !== store.limits.expiresAt ||
    admission.expiresAt !== source.expiresAt ||
    admission.expiresAt !== projection.expiresAt ||
    source.signal !== signal ||
    budget.signal !== signal
  )
    invalid()
  const check = (): void => {
    signal?.throwIfAborted()
    if (
      storage.toDb() !== root ||
      privateNativeDatabaseIdentity(root)?.token !== origin.token ||
      Date.now() >= admission.expiresAt ||
      performance.now() >= deadline
    )
      invalid()
    store.assertPrivateNativeDestination(root)
  }
  try {
    const prepared = await store.withPrivateNativeDatabase(
      true,
      async database =>
        await database.transaction(async trx => {
          check()
          store.assertPrivateNativeReadTransaction(trx)
          requireBrc38ImportSqliteTransaction(trx)
          await verifyBrc38AuthenticatedSourceSeal(trx)
          const receipt = await readBrc38ImportJournal(trx, admission)
          if (receipt.state === 'COMPLETE' || receipt.state === 'EXPIRED') invalid()
          const membership = await readNativeSnapshotTransactionMembershipRevision(trx),
            originalReader: Readonly<Brc38AuthenticatedImportReader> = Object.freeze<Brc38AuthenticatedImportReader>({
              header: reader.header,
              count: reader.count,
              row: async (table, index) => {
                const value = await reader.row(table, index)
                return value === undefined
                  ? undefined
                  : ({
                      protocol: 'brc38-structured-original/v1',
                      table,
                      index,
                      fields: value.fields,
                      binaries: value.binaries,
                      structured: value.structured ?? {},
                      ...(Object.keys(value.texts ?? {}).length === 0 ? {} : { texts: value.texts })
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
            selected: Array<Omit<SelectedRow, 'localId'>> = [],
            keys = new Set<string>()
          for (const [index, value] of data.rows.entries()) {
            check()
            const policy = prepareBrc38ImportOriginalFieldPolicy(
              'provenTxReqs',
              data.fromIndex + index,
              value.metadata,
              value.source,
              budget
            )
            if (policy.table !== 'provenTxReqs' || !/^[0-9a-f]{64}$/i.test(policy.value.txid)) invalid()
            const incoming = brc38ImportRequestIdentity(policy.value),
              naturalIdentity = incoming.txid.toLowerCase()
            if (keys.has(naturalIdentity)) throw new Brc38ImportAliasPageError(index)
            keys.add(naturalIdentity)
            chargeBrc38ImportDecodedBudget(budget, 1114112)
            const current = await readNativeSnapshotSyncRequestCurrent(
              storage,
              trx,
              admission.scope.userId,
              incoming,
              loaded.map,
              signal
            )
            if (
              Object.hasOwn(loaded.map.provenTxReq.idMap, incoming.provenTxReqId) &&
              current.row?.provenTxReqId !== loaded.map.provenTxReq.idMap[incoming.provenTxReqId]
            )
              invalid()
            if (current.row !== undefined) planProvenTxReqMergeMetadata(current.row, incoming)
            const inline: Record<string, unknown> = {}
            if (current.row === undefined)
              for (const field of ['rawTx', 'inputBEEF']) {
                const bytes = value.metadata[field]
                if (bytes == null) continue
                if (!(bytes instanceof Uint8Array) && !Array.isArray(bytes)) invalid()
                chargeBrc38ImportDecodedBudget(budget, 262144 + 16 * bytes.length)
                inline[field] = bytes
              }
            chargeBrc38ImportDecodedBudget(budget, 262144)
            const inlineBinary = prepareBrc38NativePackedWalletWrite('proven_tx_reqs', inline).fields
            for (const field of inlineBinary) capturedBinary.push(field.bytes)
            selected.push({ incoming, current, inlineBinary })
          }
          const count = selected.filter(row => row.current.row === undefined).length,
            allocation =
              count === 0
                ? undefined
                : await prepareBrc38PrivatePageIds(storage, trx, 'provenTxReqs', count, admission.expiresAt, budget)
          chargeBrc38ImportDecodedBudget(budget, 8192 + 2048 * selected.length)
          let ordinal = 0
          for (const row of selected)
            owned.push(
              Object.freeze({
                ...row,
                localId:
                  row.current.row === undefined
                    ? positive(allocation?.ids[ordinal++])
                    : positive(row.current.row.provenTxReqId)
              })
            )
          check()
          store.assertPrivateNativeReadTransaction(trx)
          return { originals, originalMap, allocation, receipt: JSON.stringify(receipt), membership }
        })
    )
    const rows: Row[] = []
    for (const [index, row] of owned.entries()) {
      check()
      const position = data.fromIndex + index
      if (row.current.row === undefined) {
        const text = await prepareBrc38PrivateNewRequestText(
          store,
          storage,
          position,
          row.incoming.txid,
          admission,
          source,
          projection,
          budget,
          lifetimes
        )
        if (text.transactionMembershipRevision !== prepared.membership) invalid()
        rows.push(
          Object.freeze({
            ...row,
            history: text.history,
            notify: text.notify,
            historyEqual: false,
            notifyEqual: false,
            notifiedReset: text.notifiedReset
          })
        )
      } else {
        const history = await prepareBrc38PrivateOccupiedHistoryText(
            store,
            storage,
            position,
            row.localId,
            row.incoming.txid,
            source,
            projection,
            budget,
            lifetimes
          ),
          notify = await prepareBrc38PrivateOccupiedNotifyText(
            store,
            storage,
            position,
            row.localId,
            row.incoming.txid,
            admission,
            source,
            projection,
            budget,
            lifetimes
          )
        if (
          notify.transactionMembershipRevision !== prepared.membership ||
          history.prior.bytes !== row.current.field.texts?.history?.bytes ||
          history.prior.sha256 !== row.current.field.texts?.history?.sha256 ||
          notify.prior.bytes !== row.current.field.texts?.notify?.bytes ||
          notify.prior.sha256 !== row.current.field.texts?.notify?.sha256
        )
          invalid()
        const comparison = Object.freeze({
            expiresAt: projection.expiresAt,
            workingAllocation: projection.workingAllocation,
            signal
          }),
          historyEqual = await compareBrc38PrivateDerivedText(
            store,
            history.normalizedCurrent,
            history.output,
            comparison,
            budget
          ),
          notifyEqual = await compareBrc38PrivateDerivedText(
            store,
            notify.normalizedCurrent,
            notify.output,
            comparison,
            budget
          )
        rows.push(
          Object.freeze({
            ...row,
            history: history.output,
            notify: notify.output,
            historyBaseline: history.normalizedCurrent,
            notifyBaseline: notify.normalizedCurrent,
            historyEqual,
            notifyEqual,
            notifiedReset: notify.notifiedReset
          })
        )
      }
    }
    chargeBrc38ImportDecodedBudget(budget, 8192 + 2048 * rows.length)
    const mappings = Object.freeze(
      rows.map(row => Object.freeze({ incomingId: row.incoming.provenTxReqId, localId: row.localId }))
    )
    check()
    return new Brc38PreparedRequestMerge(
      issuer,
      store,
      storage,
      admission,
      page,
      Object.freeze(rows),
      prepared.originalMap,
      prepared.receipt,
      prepared.membership,
      prepared.originals,
      install,
      deadline,
      mappings,
      prepared.allocation,
      signal
    )
  } catch (cause) {
    for (const bytes of capturedBinary) bytes.fill(0)
    throw cause
  }
}
