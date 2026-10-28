import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { SyncMap } from '../schema/entities/EntityBase'
import { planTransactionMerge } from '../schema/entities/EntityTransaction'
import { planOutputMerge } from '../schema/entities/EntityOutput'
import { transactionPayloadFields, outputPayloadFields } from '../snapshot/SnapshotSyncActionMetadata'
import {
  readNativeSnapshotSyncActionCurrent,
  requireSameNativeSnapshotSyncActionCurrent,
  nativeSnapshotUnresolvedReclaim,
  nativeSnapshotQuarantineReclaim,
  type NativeSnapshotSyncAction,
  type NativeSnapshotSyncActionCurrent
} from '../snapshot/NativeSnapshotSyncActionsCurrentNode'
import { assertIsoDate, type PortableRow } from './Brc38PortableRows'
import { createHash } from 'node:crypto'
import { brc38ImportTargetIndexName } from './Brc38ImportTargetIndexes'
import type { Brc38PrivateActionQuarantine } from './Brc38PrivateMergeTargetsNode'
import type { Brc38AuthenticatedImportReader, Brc38AuthenticatedStreamedImportReader } from './KnexBrc38StagingStore'
import { isBrc38OwnedPrivateNativeWriter, isBrc38OwnedPrivateNativeSqlite } from './KnexBrc38StagingStore'
import { privateNativeDatabaseIdentity, privateNativeTransactionIdentity } from './Brc38PrivateNativeOwnershipNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { requireBrc38ImportSqliteTransaction } from './Brc38ImportJournalSchema'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import type { Brc38PreparedStreamedPage } from './Brc38ImportPage'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import { prepareBrc38ImportOriginalFieldPolicy } from './Brc38ImportFieldPolicyRowsNode'
import { prepareBrc38ImportStructuredOriginals } from './Brc38ImportStructuredProvenanceNode'
import { Brc38ImportAliasPageError } from './Brc38ImportEntityMergeNode'
import { chargeBrc38ImportDecodedBudget, copyBrc38ImportDecodedValue } from './Brc38ImportDecodedBudget'
import { prepareBrc38PrivatePageIds, type Brc38PrivatePageIds } from './Brc38PrivatePageIdsNode'
import { insertBrc38PackedPlannedMetadata, updateBrc38PackedPrivateMetadata } from './Brc38PackedRestoreMetadataNode'
import { assertBrc38NativeStreamedSourceRow } from './Brc38NativeBinaryFieldNode'
import { prepareBrc38NativePackedTextWalletWrite } from './Brc38NativePackedTextWalletNode'
import { prepareBrc38NativePackedWalletWrite } from './Brc38NativePackedWalletNode'
import { writeBrc38NativePackedBytes } from './Brc38NativePackedFieldsNode'
import { writeBrc38NativePackedTextBytes } from './Brc38NativePackedTextFieldsNode'
import type { Brc38PrivatePreparedFieldInstaller } from './Brc38NativePackedFieldPreparationNode'
import type { Brc38PrivatePreparedTextInstaller } from './Brc38NativePackedTextPreparationNode'

interface Row {
  readonly incoming: NativeSnapshotSyncAction
  readonly current: NativeSnapshotSyncActionCurrent
  readonly inlineText: ReturnType<typeof prepareBrc38NativePackedTextWalletWrite>['fields']
  readonly inlineBinary: ReturnType<typeof prepareBrc38NativePackedWalletWrite>['fields']
  readonly localId: number
}
const issuer = Object.freeze({})
function invalid(): never {
  throw new Error('Private action merge differs from its actual source, current row, mapped parents or owner')
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid()
  return value
}
function cell(row: object, name: string): unknown {
  return Object.getOwnPropertyDescriptor(row, name)?.value as unknown
}
/** Capture only the real effect of this same short writer. The declared txid
 * hash and provider timestamp remain DATA for later independent reconstruction;
 * neither the effect packet nor its stored hash is an output-policy verdict. */
async function quarantine(
  storage: StorageKnex,
  trx: Knex.Transaction,
  userId: number,
  txid: string,
  signal?: AbortSignal
): Promise<Readonly<Brc38PrivateActionQuarantine>> {
  const rows = (await trx
    .from(trx.raw('?? INDEXED BY ??', ['outputs', brc38ImportTargetIndexName('reclaimOutput', trx)]))
    .where({ userId, txid, vout: 0 })
    .select('outputId', trx.raw('CASE WHEN spendable IS NOT NULL AND spendable!=0 THEN 1 ELSE 0 END AS spendable'))
    .limit(2)) as Array<{ outputId: number; spendable: number }>
  if (rows.length > 1 || (rows.length === 1 && ![0, 1].includes(rows[0].spendable))) invalid()
  const txidSha256 = createHash('sha256').update(txid, 'utf8').digest('hex')
  await nativeSnapshotQuarantineReclaim(storage, trx, userId, txid, signal)
  if (rows.length === 0 || rows[0].spendable === 0) return Object.freeze({ txidSha256 })
  const outputId = positive(rows[0].outputId),
    after = (await trx('outputs')
      .where({ outputId, userId, txid, vout: 0 })
      .select(
        trx.raw('CASE WHEN spendable IS NOT NULL AND spendable=0 THEN 0 END AS spendable'),
        trx.raw(
          "CASE WHEN typeof(updated_at)='text' AND length(CAST(updated_at AS BLOB))=24 THEN updated_at END AS updatedAt"
        )
      )
      .limit(2)) as Array<{ spendable: number | null; updatedAt: string | null }>
  if (after.length !== 1 || after[0].spendable !== 0 || typeof after[0].updatedAt !== 'string') invalid()
  assertIsoDate(after[0].updatedAt, 'actual quarantine updated_at')
  return Object.freeze({ txidSha256, outputId, updatedAt: after[0].updatedAt })
}
function select(
  incoming: NativeSnapshotSyncAction,
  actual: NativeSnapshotSyncActionCurrent,
  map: SyncMap,
  userId: number
): { action?: NativeSnapshotSyncAction; quarantineTxid?: string } {
  const current = actual.action
  if (incoming.table === 'transactions') {
    if (current !== undefined && current.table !== 'transactions') invalid()
    const policy = current === undefined ? undefined : planTransactionMerge(current.row, incoming.row, map)
    return {
      action:
        current === undefined
          ? { table: 'transactions', row: { ...incoming.row, userId, provenTxId: actual.parentIds.provenTxId } }
          : policy === undefined
            ? undefined
            : { table: 'transactions', row: policy.row },
      quarantineTxid: policy?.quarantineReclaimTxid
    }
  }
  if (current !== undefined && current.table !== 'outputs') invalid()
  const policy = current === undefined ? undefined : planOutputMerge(current.row, incoming.row, map, actual.parentIds)
  return {
    action:
      current === undefined
        ? {
            table: 'outputs',
            row: {
              ...incoming.row,
              userId,
              transactionId: actual.parentIds.transactionId,
              basketId: actual.parentIds.basketId,
              spentBy: actual.parentIds.spentBy
            }
          }
        : policy === undefined
          ? undefined
          : { table: 'outputs', row: policy }
  }
}

/** Internal one-use private effects. Full current postimages and physical parent
 * generations are compared again in the final writer; policies run on that
 * fresh current state. The enclosing controller alone admits profile, primary,
 * provenance, streamed operational checkpoint and durable replay receipt. */
export class Brc38PreparedActionMerge {
  #closed = false
  #consumed = false
  readonly #root: Knex
  readonly #token: object
  readonly #rows: readonly Row[]
  readonly #originalMap: SyncMap
  readonly #quarantines?: Array<Readonly<Brc38PrivateActionQuarantine> | null>
  get actionQuarantines(): readonly (Readonly<Brc38PrivateActionQuarantine> | null)[] | undefined {
    return this.#quarantines === undefined ? undefined : Object.freeze([...this.#quarantines])
  }
  constructor(
    token: object,
    private readonly storage: StorageKnex,
    private readonly admission: Readonly<Brc38ImportJournalAdmission>,
    private readonly page: Brc38PreparedStreamedPage,
    rows: readonly Row[],
    originalMap: SyncMap,
    private readonly originals: { apply(trx: Knex.Transaction): Promise<void> },
    private readonly installBinary: Brc38PrivatePreparedFieldInstaller,
    private readonly installText: Brc38PrivatePreparedTextInstaller,
    private readonly deadline: number,
    readonly checkpointMappings: readonly Readonly<{ incomingId: number; localId: number }>[],
    private readonly allocation?: Brc38PrivatePageIds,
    private readonly signal?: AbortSignal
  ) {
    if (token !== issuer) invalid()
    this.#rows = rows
    this.#originalMap = originalMap
    if (page.data.kind === 'table' && page.data.table === 'transactions') this.#quarantines = rows.map(() => null)
    this.#root = storage.toDb()
    const identity = privateNativeDatabaseIdentity(this.#root)
    if (identity?.slot !== 0) invalid()
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
    requireBrc38ImportSqliteTransaction(trx)
  }
  async apply(trx: Knex.Transaction): Promise<{ inserts: number; updates: number }> {
    this.check(trx)
    if (
      this.#consumed ||
      this.page.data.kind !== 'table' ||
      !['transactions', 'outputs'].includes(this.page.data.table)
    )
      invalid()
    this.#consumed = true
    try {
      const { data, budget } = this.page,
        table = data.table as 'transactions' | 'outputs',
        entity = table === 'transactions' ? 'transaction' : 'output',
        idName = table === 'transactions' ? 'transactionId' : 'outputId',
        names: readonly string[] = table === 'transactions' ? transactionPayloadFields : outputPayloadFields
      chargeBrc38ImportDecodedBudget(budget, 32768 + 2048 * this.page.references.length)
      await verifyBrc38AuthenticatedSourceSeal(trx)
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
      for (const row of this.#rows) {
        this.check(trx)
        chargeBrc38ImportDecodedBudget(budget, 1114112)
        requireSameNativeSnapshotSyncActionCurrent(
          row.current,
          await readNativeSnapshotSyncActionCurrent(
            this.storage,
            trx,
            this.admission.scope.userId,
            row.incoming,
            loaded.map,
            this.signal
          )
        )
      }
      await this.originals.apply(trx)
      let inserts = 0,
        updates = 0
      for (const [index, row] of this.#rows.entries()) {
        this.check(trx)
        chargeBrc38ImportDecodedBudget(budget, 1114112)
        const actual = await readNativeSnapshotSyncActionCurrent(
          this.storage,
          trx,
          this.admission.scope.userId,
          row.incoming,
          loaded.map,
          this.signal
        )
        requireSameNativeSnapshotSyncActionCurrent(row.current, actual)
        await assertBrc38NativeStreamedSourceRow(
          trx,
          table,
          data.fromIndex + index,
          data.rows[index].source,
          this.admission.maximumStepBytes
        )
        chargeBrc38ImportDecodedBudget(budget, 16384)
        const selection = select(row.incoming, actual, loaded.map, this.admission.scope.userId),
          selected = selection.action
        if (selected === undefined) {
          if (actual.action === undefined) invalid()
          loaded.map[entity].idMap[cell(row.incoming.row, idName) as number] = row.localId
          continue
        }
        if (
          selected.table === 'outputs' &&
          selected.row.spendable &&
          selected.row.txid !== undefined &&
          (await nativeSnapshotUnresolvedReclaim(trx, this.admission.scope.userId, selected.row.txid, this.signal))
        )
          selected.row.spendable = false
        const metadata: Record<string, unknown> = {
            ...selected.row,
            [idName]: actual.action === undefined ? 0 : row.localId
          },
          binaries: string[] = [],
          texts: string[] = []
        for (const name of names) {
          const value = cell(selected.row, name)
          if (value === undefined) {
            metadata[name] = null
            continue
          }
          if (
            actual.action !== undefined &&
            value === cell(actual.action.row, name) &&
            (actual.field.binaries[name] !== undefined || actual.field.texts?.[name] !== undefined)
          ) {
            delete metadata[name]
            continue
          }
          if (value !== cell(row.incoming.row, name)) invalid()
          delete metadata[name]
          if (
            typeof value === 'string' ||
            actual.field.texts?.[name] !== undefined ||
            data.rows[index].source.texts?.[name] !== undefined
          )
            texts.push(name)
          else if (
            data.rows[index].source.binaries[name] !== undefined ||
            row.inlineBinary.some(field => field.field === name)
          )
            binaries.push(name)
          else invalid()
        }
        const physical =
          actual.action === undefined && this.allocation !== undefined
            ? await insertBrc38PackedPlannedMetadata(
                this.storage,
                trx,
                table,
                metadata,
                binaries,
                this.allocation,
                budget,
                texts
              )
            : actual.target === undefined
              ? invalid()
              : await updateBrc38PackedPrivateMetadata(
                  this.storage,
                  trx,
                  table,
                  metadata,
                  binaries,
                  actual.target,
                  budget,
                  texts
                )
        positive(physical)
        if (actual.action === undefined && physical !== row.localId) invalid()
        for (const name of texts) {
          const source = data.rows[index].source.texts?.[name]
          if (source !== undefined)
            await this.installText(trx, table, data.fromIndex + index, row.localId, source, 'text')
          else {
            const field = row.inlineText.find(value => value.field === name)
            if (field === undefined) invalid()
            await writeBrc38NativePackedTextBytes(
              trx,
              { table, field: field.field, rowId: row.localId },
              field.bytes,
              this.signal
            )
          }
        }
        for (const name of binaries) {
          const source = data.rows[index].source.binaries[name]
          if (source !== undefined) await this.installBinary(trx, table, data.fromIndex + index, physical, source)
          else {
            const field = row.inlineBinary.find(value => value.field === name)
            if (field === undefined) invalid()
            await writeBrc38NativePackedBytes(
              trx,
              { table, field: field.field, rowId: physical },
              field.bytes,
              this.signal
            )
          }
        }
        loaded.map[entity].idMap[cell(row.incoming.row, idName) as number] = row.localId
        if (selection.quarantineTxid !== undefined) {
          if (this.#quarantines === undefined) invalid()
          this.#quarantines[index] = await quarantine(
            this.storage,
            trx,
            this.admission.scope.userId,
            selection.quarantineTxid,
            this.signal
          )
        }
        await assertBrc38NativeStreamedSourceRow(
          trx,
          table,
          data.fromIndex + index,
          data.rows[index].source,
          this.admission.maximumStepBytes
        )
        if (actual.action === undefined) inserts++
        else updates++
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
    for (const row of this.#rows) {
      for (const field of row.inlineText) field.bytes.fill(0)
      for (const field of row.inlineBinary) field.bytes.fill(0)
    }
  }
}

export async function prepareBrc38ActionMerge(
  trx: Knex.Transaction,
  storage: StorageKnex,
  reader: Readonly<Brc38AuthenticatedStreamedImportReader>,
  admission: Readonly<Brc38ImportJournalAdmission>,
  page: Brc38PreparedStreamedPage,
  installBinary: Brc38PrivatePreparedFieldInstaller,
  installText: Brc38PrivatePreparedTextInstaller,
  signal?: AbortSignal
): Promise<Brc38PreparedActionMerge> {
  requireBrc38ImportSqliteTransaction(trx)
  const root = storage.toDb(),
    identity = privateNativeDatabaseIdentity(root),
    read = privateNativeTransactionIdentity(trx),
    { data, budget } = page,
    deadline = performance.now() + Math.max(0, admission.expiresAt - Date.now())
  if (
    identity?.slot !== 0 ||
    read?.slot !== 3 ||
    read.token !== identity.token ||
    !isBrc38OwnedPrivateNativeSqlite(trx) ||
    data.kind !== 'table' ||
    (data.table !== 'transactions' && data.table !== 'outputs')
  )
    invalid()
  const check = (): void => {
    signal?.throwIfAborted()
    if (
      storage.toDb() !== root ||
      privateNativeDatabaseIdentity(root)?.token !== identity.token ||
      privateNativeTransactionIdentity(trx)?.token !== identity.token ||
      !isBrc38OwnedPrivateNativeSqlite(trx) ||
      Date.now() >= admission.expiresAt ||
      performance.now() >= deadline
    )
      invalid()
  }
  check()
  await verifyBrc38AuthenticatedSourceSeal(trx)
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
    rows: Array<Omit<Row, 'localId'>> = [],
    keys = new Set<string>(),
    table = data.table,
    idName = table === 'transactions' ? 'transactionId' : 'outputId'
  try {
    for (const [index, selected] of data.rows.entries()) {
      check()
      const policy = prepareBrc38ImportOriginalFieldPolicy(
        table,
        data.fromIndex + index,
        selected.metadata,
        selected.source,
        budget
      )
      if (policy.table !== 'transactions' && policy.table !== 'outputs') invalid()
      const incoming: NativeSnapshotSyncAction =
        policy.table === 'transactions'
          ? { table: 'transactions', row: policy.value }
          : { table: 'outputs', row: policy.value }
      chargeBrc38ImportDecodedBudget(budget, 1114112)
      const current = await readNativeSnapshotSyncActionCurrent(
          storage,
          trx,
          admission.scope.userId,
          incoming,
          loaded.map,
          signal
        ),
        key =
          current.target === undefined
            ? JSON.stringify([table, 'unidentified', cell(incoming.row, idName)])
            : JSON.stringify([current.target.index, current.target.key])
      if (keys.has(key)) throw new Brc38ImportAliasPageError(index)
      keys.add(key)
      if (
        Object.hasOwn(
          loaded.map[table === 'transactions' ? 'transaction' : 'output'].idMap,
          cell(incoming.row, idName) as number
        ) &&
        current.field.metadata?.[idName] !==
          loaded.map[table === 'transactions' ? 'transaction' : 'output'].idMap[cell(incoming.row, idName) as number]
      )
        invalid()
      const selectedPolicy = select(incoming, current, loaded.map, admission.scope.userId).action,
        values = selectedPolicy === undefined ? {} : selectedPolicy.row,
        inlineTextValues: Record<string, string> = {},
        names: readonly string[] = table === 'transactions' ? transactionPayloadFields : outputPayloadFields
      for (const name of names) {
        const value = cell(values, name)
        if (typeof value === 'string') inlineTextValues[name] = value
      }
      const textBytes = Object.values(inlineTextValues).reduce<number>(
        (sum, value) => sum + Buffer.byteLength(value),
        0
      )
      chargeBrc38ImportDecodedBudget(budget, 262144 + 16 * textBytes)
      const inlineText = prepareBrc38NativePackedTextWalletWrite(table, inlineTextValues).fields,
        row: Omit<Row, 'localId'> = { incoming, current, inlineText, inlineBinary: [] }
      rows.push(row)
      const inlineValues: Record<string, unknown> = {}
      for (const name of Object.keys(selected.metadata)) {
        if (
          !['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx', 'lockingScript'].includes(name) ||
          selected.metadata[name] == null
        )
          continue
        const value = selected.metadata[name]
        if (!(value instanceof Uint8Array) && !Array.isArray(value)) invalid()
        chargeBrc38ImportDecodedBudget(budget, 262144 + 16 * value.length)
        inlineValues[name] = value
      }
      rows[index] = { ...row, inlineBinary: prepareBrc38NativePackedWalletWrite(table, inlineValues).fields }
    }
    check()
    const count = rows.filter(row => row.current.action === undefined).length,
      allocation =
        count === 0
          ? undefined
          : await prepareBrc38PrivatePageIds(storage, trx, table, count, admission.expiresAt, budget)
    chargeBrc38ImportDecodedBudget(budget, 8192 + 2048 * rows.length)
    let ordinal = 0
    const resolved = Object.freeze(
        rows.map(row =>
          Object.freeze({
            ...row,
            localId:
              row.current.action === undefined
                ? positive(allocation?.ids[ordinal++])
                : positive(row.current.field.metadata?.[idName])
          })
        )
      ),
      mappings = Object.freeze(
        resolved.map(row =>
          Object.freeze({ incomingId: cell(row.incoming.row, idName) as number, localId: row.localId })
        )
      )
    check()
    return new Brc38PreparedActionMerge(
      issuer,
      storage,
      admission,
      page,
      resolved,
      originalMap,
      originals,
      installBinary,
      installText,
      deadline,
      mappings,
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
