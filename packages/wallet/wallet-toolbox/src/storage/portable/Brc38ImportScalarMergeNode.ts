import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { SyncMap } from '../schema/entities/EntityBase'
import { mergeSimpleMetadata } from '../schema/entities/mergeSimpleMetadata'
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
import { isBrc38OwnedPrivateNativeWriter, isBrc38OwnedPrivateNativeSqlite } from './KnexBrc38StagingStore'
import { privateNativeDatabaseIdentity, privateNativeTransactionIdentity } from './Brc38PrivateNativeOwnershipNode'
import { prepareBrc38ImportStructuredOriginals } from './Brc38ImportStructuredProvenanceNode'
import { assertBrc38NativeStreamedSourceRow } from './Brc38NativeBinaryFieldNode'
import {
  insertBrc38PackedRestoreMetadata,
  insertBrc38PackedPlannedMetadata,
  updateBrc38PackedPrivateMetadata
} from './Brc38PackedRestoreMetadataNode'
import { prepareBrc38PrivatePageIds, type Brc38PrivatePageIds } from './Brc38PrivatePageIdsNode'
import { chargeBrc38ImportDecodedBudget, copyBrc38ImportDecodedValue } from './Brc38ImportDecodedBudget'
import type { PortableRow } from './Brc38PortableRows'

export type Brc38ScalarMergeTable = 'outputBaskets' | 'outputTags' | 'txLabels' | 'txLabelMaps' | 'outputTagMaps'
export type Brc38ScalarMergeMetadata = Record<string, unknown> & {
  created_at: Date
  updated_at: Date
  isDeleted: boolean
}
type Table = Brc38ScalarMergeTable
type Metadata = Brc38ScalarMergeMetadata
interface Row {
  readonly incoming: Metadata
  readonly current?: Metadata
  readonly target: Brc38ImportEntityTarget
  readonly existing: Brc38ImportExistingFieldRow
  readonly plannedId?: number
}
function invalid(): never {
  throw new Error('Private scalar merge differs from its complete original/current rows, parents, maps or actual owner')
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid()
  return value
}
function metadata(value: Readonly<Record<string, unknown>>): Metadata {
  if (
    !(value.created_at instanceof Date) ||
    !Number.isFinite(value.created_at.getTime()) ||
    !(value.updated_at instanceof Date) ||
    !Number.isFinite(value.updated_at.getTime()) ||
    typeof value.isDeleted !== 'boolean'
  )
    invalid()
  return value as Metadata
}
/** Complete metadata, not a partial wallet DTO. Preserve local identities,
 * creation dates, names, labels and parent coordinates on existing rows.
 * Archived managed-change values remain unchanged; later migration is separate. */
export function selectBrc38ScalarMergeMetadata(
  table: Table,
  incoming: Metadata,
  current: Metadata | undefined
): Metadata | undefined {
  if (current === undefined) {
    const result = { ...incoming }
    if (table === 'outputBaskets' && result.name === '') result.name = 'default'
    return result
  }
  const change = mergeSimpleMetadata(current, incoming)
  if (change === undefined) return undefined
  return {
    ...current,
    ...change,
    ...(table !== 'outputBaskets'
      ? {}
      : {
          minimumDesiredUTXOValue: incoming.minimumDesiredUTXOValue,
          numberOfDesiredUTXOs: incoming.numberOfDesiredUTXOs
        })
  }
}
const parents = Object.freeze({
  txLabel: ['tx_labels', 'txLabelId'],
  transaction: ['transactions', 'transactionId'],
  outputTag: ['output_tags', 'outputTagId'],
  output: ['outputs', 'outputId']
} as const)
async function mappedParents(
  trx: Knex.Transaction,
  table: Table,
  incoming: Metadata,
  map: SyncMap,
  userId: number
): Promise<void> {
  for (const parent of brc38ImportRowForm(table).parents) {
    if (!Object.hasOwn(parents, parent.entity)) invalid()
    const [sql, key] = parents[parent.entity as keyof typeof parents],
      incomingId = incoming[parent.field]
    if (typeof incomingId !== 'number' || !Number.isInteger(incomingId)) invalid()
    const id = positive(map[parent.entity].idMap[incomingId]),
      rows = await trx(sql)
        .where({ userId, [key]: id })
        .select(key)
        .limit(2)
    if (rows.length !== 1) invalid()
  }
}
export class Brc38PreparedScalarMerge {
  #consumed = false
  readonly #root: Knex
  readonly #deadline: number
  constructor(
    private readonly storage: StorageKnex,
    private readonly admission: Readonly<Brc38ImportJournalAdmission>,
    private readonly page: Brc38PreparedStreamedPage,
    private readonly table: Table,
    private readonly rows: readonly Row[],
    private readonly originalMap: SyncMap,
    private readonly originals: { apply(trx: Knex.Transaction): Promise<void> },
    private readonly allowance: number,
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
      this.storage.toDb() !== this.#root ||
      root?.slot !== 0 ||
      actual?.slot !== 0 ||
      actual.token !== root.token ||
      !isBrc38OwnedPrivateNativeWriter(trx) ||
      Date.now() >= this.admission.expiresAt ||
      performance.now() >= this.#deadline
    )
      invalid()
  }
  async apply(trx: Knex.Transaction): Promise<{ inserts: number; updates: number }> {
    this.check(trx)
    if (this.#consumed || this.page.data.kind !== 'table') invalid()
    this.#consumed = true
    const { data, budget } = this.page,
      form = brc38ImportRowForm(this.table)
    chargeBrc38ImportDecodedBudget(budget, this.allowance + 32768 + 2048 * this.page.references.length)
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
      this.table,
      this.rows.map(row => row.target),
      this.rows.map(row => row.existing),
      this.allowance,
      this.signal
    )
    for (const [index, row] of this.rows.entries()) {
      await mappedParents(trx, this.table, row.incoming, loaded.map, this.admission.scope.userId)
      await assertBrc38NativeStreamedSourceRow(
        trx,
        this.table,
        data.fromIndex + index,
        data.rows[index].source,
        this.admission.maximumStepBytes
      )
    }
    await this.originals.apply(trx)
    let inserts = 0,
      updates = 0
    for (const [index, row] of this.rows.entries()) {
      this.check(trx)
      chargeBrc38ImportDecodedBudget(budget, 16384)
      const value = selectBrc38ScalarMergeMetadata(this.table, row.incoming, row.current),
        incomingId = form.id === undefined ? undefined : row.incoming[form.id]
      if (value !== undefined) {
        if (row.current === undefined) {
          if (Object.hasOwn(value, 'userId')) value.userId = this.admission.scope.userId
          for (const parent of form.parents)
            value[parent.field] = positive(loaded.map[parent.entity].idMap[value[parent.field] as number])
          if (form.id !== undefined) value[form.id] = 0
        }
        if (row.target.found) {
          await updateBrc38PackedPrivateMetadata(this.storage, trx, this.table, value, [], row.target, budget)
          updates++
        } else if (form.entity !== undefined) {
          if (
            this.allocation === undefined ||
            row.plannedId === undefined ||
            (await insertBrc38PackedPlannedMetadata(
              this.storage,
              trx,
              this.table,
              value,
              [],
              this.allocation,
              budget
            )) !== row.plannedId
          )
            invalid()
          inserts++
        } else {
          await insertBrc38PackedRestoreMetadata(this.storage, trx, this.table, value, [], budget)
          inserts++
        }
      }
      if (form.entity !== undefined) {
        if (typeof incomingId !== 'number' || !Number.isInteger(incomingId)) invalid()
        loaded.map[form.entity].idMap[incomingId] = row.target.found
          ? positive(row.target.localId)
          : positive(row.plannedId)
      }
      await assertBrc38NativeStreamedSourceRow(
        trx,
        this.table,
        data.fromIndex + index,
        data.rows[index].source,
        this.admission.maximumStepBytes
      )
    }
    await loaded.persist()
    this.check(trx)
    return { inserts, updates }
  }
}
/** Actual private read preparation of the five metadata-only tables, with
 * original provenance and exact parent/row/map checks repeated by the final
 * one-use writer. The enclosing journal owns admission/checkpoint/receipt. */
export async function prepareBrc38ScalarMerge(
  trx: Knex.Transaction,
  storage: StorageKnex,
  reader: Readonly<Brc38AuthenticatedStreamedImportReader>,
  admission: Readonly<Brc38ImportJournalAdmission>,
  page: Brc38PreparedStreamedPage,
  signal?: AbortSignal
): Promise<Brc38PreparedScalarMerge> {
  signal?.throwIfAborted()
  const root = privateNativeDatabaseIdentity(storage.toDb()),
    actual = privateNativeTransactionIdentity(trx),
    { data, budget } = page
  if (
    root?.slot !== 0 ||
    actual?.slot !== 3 ||
    root.token !== actual.token ||
    !isBrc38OwnedPrivateNativeSqlite(trx) ||
    data.kind !== 'table' ||
    !['outputBaskets', 'outputTags', 'txLabels', 'txLabelMaps', 'outputTagMaps'].includes(data.table)
  )
    invalid()
  const table = data.table as Table,
    originalReader: Readonly<Brc38AuthenticatedImportReader> = Object.freeze<Brc38AuthenticatedImportReader>({
      header: reader.header,
      count: reader.count,
      row: async (name, index) => {
        const source = await reader.row(name, index)
        return source === undefined
          ? undefined
          : ({
              protocol: 'brc38-structured-original/v1',
              table: name,
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
    allowance = Math.min(1048576, Math.floor(budget.remaining / 8))
  if (allowance < 16384) invalid()
  chargeBrc38ImportDecodedBudget(budget, 2 * allowance)
  // The original new-basket policy normalizes an empty name to "default".
  // Select that actual destination identity for aliases/repeat imports too;
  // original source/provenance and legacy provider selection stay unchanged.
  chargeBrc38ImportDecodedBudget(budget, 8192 + 1024 * data.rows.length)
  const targetRows = data.rows.map(row =>
    table === 'outputBaskets' && row.metadata.name === ''
      ? { ...copyBrc38ImportDecodedValue(row.metadata, budget), name: 'default' }
      : row.metadata
  )
  const targets = await prepareBrc38ImportEntityTargets(
      trx,
      admission.scope.userId,
      { kind: 'table', table, rows: targetRows },
      loaded.map,
      allowance,
      signal
    ),
    existing = await prepareBrc38ImportExistingFieldTargets(
      trx,
      storage,
      admission.scope.userId,
      table,
      targets,
      allowance,
      signal
    ),
    identities = new Set<string>(),
    rows: Row[] = []
  for (const [index, prepared] of data.rows.entries()) {
    if (
      Object.keys(prepared.source.binaries).length +
        Object.keys(prepared.source.structured ?? {}).length +
        Object.keys(prepared.source.texts ?? {}).length !==
      0
    )
      invalid()
    chargeBrc38ImportDecodedBudget(budget, existing[index].allocationBytes + 8192)
    const target = targets[index],
      identity = JSON.stringify([target.index, target.key])
    if (identities.has(identity)) throw new Brc38ImportAliasPageError(index)
    identities.add(identity)
    const incoming = metadata(copyBrc38ImportDecodedValue(prepared.metadata, budget)),
      current =
        existing[index].metadata === undefined
          ? undefined
          : metadata(copyBrc38ImportDecodedValue(existing[index].metadata!, budget))
    await mappedParents(trx, table, incoming, loaded.map, admission.scope.userId)
    rows.push({ incoming, current, target, existing: existing[index] })
  }
  const form = brc38ImportRowForm(table),
    count = form.entity === undefined ? 0 : rows.filter(row => !row.target.found).length,
    allocation =
      count === 0
        ? undefined
        : await prepareBrc38PrivatePageIds(storage, trx, table, count, admission.expiresAt, budget),
    checkpointMappings: Array<Readonly<{ incomingId: number; localId: number }>> = []
  chargeBrc38ImportDecodedBudget(budget, 8192 + 2048 * rows.length)
  let ordinal = 0
  for (const [index, row] of rows.entries()) {
    if (form.entity === undefined || form.id === undefined) continue
    const incomingId = row.incoming[form.id],
      localId = row.target.found ? positive(row.target.localId) : positive(allocation?.ids[ordinal++])
    if (typeof incomingId !== 'number' || !Number.isInteger(incomingId)) invalid()
    if (!row.target.found) rows[index] = { ...row, plannedId: localId }
    checkpointMappings.push(Object.freeze({ incomingId, localId }))
  }
  signal?.throwIfAborted()
  return new Brc38PreparedScalarMerge(
    storage,
    admission,
    page,
    table,
    rows,
    originalMap,
    originals,
    allowance,
    Object.freeze(checkpointMappings),
    allocation,
    signal
  )
}
