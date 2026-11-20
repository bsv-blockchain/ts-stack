import { promiseFromSync } from '../../utility/promiseFromSync'
import {
  copyBrc38ImportDecodedValue,
  chargeBrc38ImportDecodedBudget,
  cloneBrc38ImportDecodedValue,
  chargeBrc38ImportDecodedValue,
  type Brc38ImportDecodedBudget
} from './Brc38ImportDecodedBudget'
export { copyBrc38ImportDecodedValue, chargeBrc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
export type { Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import { EntityBase, createSyncMap, type SyncMap } from '../schema/entities/EntityBase'
import { EntityProvenTx } from '../schema/entities/EntityProvenTx'
import { EntityOutputBasket } from '../schema/entities/EntityOutputBasket'
import { EntityOutputTag } from '../schema/entities/EntityOutputTag'
import { EntityTxLabel } from '../schema/entities/EntityTxLabel'
import { EntityTransaction } from '../schema/entities/EntityTransaction'
import { EntityOutput } from '../schema/entities/EntityOutput'
import { EntityTxLabelMap } from '../schema/entities/EntityTxLabelMap'
import { EntityOutputTagMap } from '../schema/entities/EntityOutputTagMap'
import { EntityCertificate } from '../schema/entities/EntityCertificate'
import { EntityCertificateField } from '../schema/entities/EntityCertificateField'
import { EntityCommission } from '../schema/entities/EntityCommission'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'
import type { TableSettings, TableSyncState } from '../schema/tables'
import { canonicalizeSyncProofIdentifiers, sameSyncProof, validateSyncProof } from '../methods/validateSyncProof'
import { prepareBrc38ImportEntityTargets, type Brc38ImportEntityTarget } from './Brc38ImportEntityTargets'
import { prepareBrc38ImportExistingRows, prepareBrc38ImportExistingTargets } from './Brc38ImportExistingRows'
import { prepareBrc38ImportHistory, type Brc38ImportHistoryProjection } from './Brc38ImportHistory'
import { loadBrc38ImportIdMap, type Brc38ImportMapScope, type Brc38ImportIdReference } from './Brc38ImportIdMap'
import type { Brc38ImportRowTypes, Brc38PreparedImportData } from './Brc38ImportPage'
import type { Brc38StageTable } from './Brc38SemanticStage'
import { brc38ImportTargetIndexes, brc38ImportTargetIndexName } from './Brc38ImportTargetIndexes'
import { requireBrc38ImportSqliteTransaction } from './Brc38ImportJournalSchema'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { runInSeries } from '../../utility/runInSeries'

interface Form {
  readonly method: string
  readonly id?: string
  readonly entity?: keyof SyncMap
  readonly parents?: readonly [keyof SyncMap, string][]
}
const forms: Readonly<Record<Brc38StageTable, Form>> = {
  provenTxs: { method: 'ProvenTx', id: 'provenTxId', entity: 'provenTx' },
  outputBaskets: { method: 'OutputBasket', id: 'basketId', entity: 'outputBasket' },
  outputTags: { method: 'OutputTag', id: 'outputTagId', entity: 'outputTag' },
  txLabels: { method: 'TxLabel', id: 'txLabelId', entity: 'txLabel' },
  transactions: {
    method: 'Transaction',
    id: 'transactionId',
    entity: 'transaction',
    parents: [['provenTx', 'provenTxId']]
  },
  outputs: {
    method: 'Output',
    id: 'outputId',
    entity: 'output',
    parents: [
      ['transaction', 'transactionId'],
      ['transaction', 'spentBy'],
      ['outputBasket', 'basketId']
    ]
  },
  txLabelMaps: {
    method: 'TxLabelMap',
    parents: [
      ['txLabel', 'txLabelId'],
      ['transaction', 'transactionId']
    ]
  },
  outputTagMaps: {
    method: 'OutputTagMap',
    parents: [
      ['outputTag', 'outputTagId'],
      ['output', 'outputId']
    ]
  },
  certificates: { method: 'Certificate', id: 'certificateId', entity: 'certificate' },
  certificateFields: { method: 'CertificateField', parents: [['certificate', 'certificateId']] },
  commissions: {
    method: 'Commission',
    id: 'commissionId',
    entity: 'commission',
    parents: [['transaction', 'transactionId']]
  },
  provenTxReqs: {
    method: 'ProvenTxReq',
    id: 'provenTxReqId',
    entity: 'provenTxReq',
    parents: [['provenTx', 'provenTxId']]
  },
  syncStates: { method: 'SyncState', id: 'syncStateId' }
}
interface Operation {
  readonly method: string
  readonly arguments: readonly unknown[]
  readonly mapping?: { readonly entity: keyof SyncMap; readonly incomingId: number }
}
type Budget = Brc38ImportDecodedBudget
function invalid(): never {
  throw new Error('Private import merge differs from its prepared entity or ownership')
}
const take = chargeBrc38ImportDecodedBudget
const copy = copyBrc38ImportDecodedValue
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) invalid()
  return value
}
function operationalMap(map: SyncMap): SyncMap {
  const result = createSyncMap()
  for (const entity of Object.keys(map) as Array<keyof SyncMap>)
    for (const local of Object.values(map[entity].idMap)) result[entity].idMap[positive(local)] = local
  return result
}
function remap(row: Record<string, unknown>, table: Brc38StageTable, map: SyncMap, userId: number): void {
  if (Object.hasOwn(row, 'userId')) row.userId = userId
  for (const [entity, field] of forms[table].parents ?? []) {
    const incoming = row[field]
    if (incoming === undefined) continue
    if (typeof incoming !== 'number' || !Number.isInteger(incoming) || !Object.hasOwn(map[entity].idMap, incoming))
      invalid()
    row[field] = positive(map[entity].idMap[incoming])
  }
}
function action<T>(
  entity: EntityBase<T>,
  incoming: T,
  existing: unknown,
  storage: StorageKnex,
  userId: number,
  map: SyncMap,
  trx: Knex.Transaction
): Promise<unknown> {
  return existing !== undefined
    ? entity.mergeExisting(storage, undefined, incoming, map, trx)
    : entity.mergeNew(storage, userId, map, trx)
}
function entityAction<K extends Exclude<Brc38StageTable, 'syncStates'>>(
  table: K,
  incoming: Brc38ImportRowTypes[K],
  existing: Brc38ImportRowTypes[K] | undefined,
  storage: StorageKnex,
  userId: number,
  map: SyncMap,
  trx: Knex.Transaction
): Promise<unknown> {
  const row = existing ?? incoming,
    previous = existing
  // Each constructor receives its original typed API. The actual entity methods
  // own timestamp, tombstone, notification and BRC-177 policy. The new staged
  // archive API explicitly preserves managed-change values; any later upgrade
  // is a separate operational decision, while legacy sync keeps its default.
  switch (table) {
    case 'provenTxs':
      return action(
        new EntityProvenTx(row as Brc38ImportRowTypes['provenTxs']),
        incoming as Brc38ImportRowTypes['provenTxs'],
        previous,
        storage,
        userId,
        map,
        trx
      )
    case 'outputBaskets':
      return action(
        new EntityOutputBasket(row as Brc38ImportRowTypes['outputBaskets'], true),
        incoming as Brc38ImportRowTypes['outputBaskets'],
        previous,
        storage,
        userId,
        map,
        trx
      )
    case 'outputTags':
      return action(
        new EntityOutputTag(row as Brc38ImportRowTypes['outputTags']),
        incoming as Brc38ImportRowTypes['outputTags'],
        previous,
        storage,
        userId,
        map,
        trx
      )
    case 'txLabels':
      return action(
        new EntityTxLabel(row as Brc38ImportRowTypes['txLabels']),
        incoming as Brc38ImportRowTypes['txLabels'],
        previous,
        storage,
        userId,
        map,
        trx
      )
    case 'transactions':
      return action(
        new EntityTransaction(row as Brc38ImportRowTypes['transactions']),
        incoming as Brc38ImportRowTypes['transactions'],
        previous,
        storage,
        userId,
        map,
        trx
      )
    case 'outputs':
      return action(
        new EntityOutput(row as Brc38ImportRowTypes['outputs']),
        incoming as Brc38ImportRowTypes['outputs'],
        previous,
        storage,
        userId,
        map,
        trx
      )
    case 'txLabelMaps':
      return action(
        new EntityTxLabelMap(row as Brc38ImportRowTypes['txLabelMaps']),
        incoming as Brc38ImportRowTypes['txLabelMaps'],
        previous,
        storage,
        userId,
        map,
        trx
      )
    case 'outputTagMaps':
      return action(
        new EntityOutputTagMap(row as Brc38ImportRowTypes['outputTagMaps']),
        incoming as Brc38ImportRowTypes['outputTagMaps'],
        previous,
        storage,
        userId,
        map,
        trx
      )
    case 'certificates':
      return action(
        new EntityCertificate(row as Brc38ImportRowTypes['certificates']),
        incoming as Brc38ImportRowTypes['certificates'],
        previous,
        storage,
        userId,
        map,
        trx
      )
    case 'certificateFields':
      return action(
        new EntityCertificateField(row as Brc38ImportRowTypes['certificateFields']),
        incoming as Brc38ImportRowTypes['certificateFields'],
        previous,
        storage,
        userId,
        map,
        trx
      )
    case 'commissions':
      return action(
        new EntityCommission(row as Brc38ImportRowTypes['commissions']),
        incoming as Brc38ImportRowTypes['commissions'],
        previous,
        storage,
        userId,
        map,
        trx
      )
    case 'provenTxReqs':
      return action(
        new EntityProvenTxReq(row as Brc38ImportRowTypes['provenTxReqs']),
        incoming as Brc38ImportRowTypes['provenTxReqs'],
        previous,
        storage,
        userId,
        map,
        trx
      )
    default:
      return invalid()
  }
}
async function secondary(
  trx: Knex.Transaction,
  storage: StorageKnex,
  userId: number,
  index: 'transactionReclaim' | 'reclaimOutput',
  key: Readonly<Record<string, string | number>>,
  budget: Budget
): Promise<readonly object[]> {
  const table = index === 'transactionReclaim' ? 'transactions' : 'outputs',
    id = index === 'transactionReclaim' ? 'transactionId' : 'outputId',
    rows: Array<{ localId: number }> = await trx
      .from(trx.raw('?? INDEXED BY ??', [brc38ImportTargetIndexes[index][0], brc38ImportTargetIndexName(index, trx)]))
      .where(key)
      .select({ localId: id })
      .limit(2)
  if (rows.length > 1) invalid()
  const target: Brc38ImportEntityTarget = {
      table,
      index,
      key,
      found: rows.length !== 0,
      ...(rows.length === 0 ? {} : { localId: positive(rows[0].localId) })
    },
    prepared = await prepareBrc38ImportExistingTargets(
      trx,
      storage,
      userId,
      table,
      [target],
      budget.remaining,
      budget.signal
    )
  take(budget, prepared[0].allocationBytes)
  return prepared[0].row === undefined ? [] : [copy(prepared[0].row, budget)]
}
async function readyArtifacts(
  trx: Knex.Transaction,
  budget: Budget
): Promise<{ ids: number[]; allocationBytes: number }> {
  const before = budget.remaining,
    rows: Array<{ preparedBeefId: number; allocationBytes: number }> = await trx
      .from(trx.raw('prepared_beefs INDEXED BY ??', [brc38ImportTargetIndexName('preparedBeefReady', trx)]))
      .where({ state: 'ready' })
      .select(
        'preparedBeefId',
        trx.raw(
          "CASE WHEN typeof(beef) = 'blob' AND 16 * length(beef) + 1024 <= ? THEN 16 * length(beef) + 1024 END AS allocationBytes",
          [budget.remaining]
        )
      )
      .orderBy('preparedBeefId')
      .limit(4097)
  if (rows.length > 4096)
    throw new SnapshotResourceLimitError('Private import proof invalidation exceeds 4096 prepared artifacts')
  const ids = rows.map(row => {
    take(budget, row.allocationBytes)
    return positive(row.preparedBeefId)
  })
  return { ids, allocationBytes: before - budget.remaining }
}
export interface Brc38ImportCacheFence {
  readonly epoch: number
  readonly maximumAllocationBytes: number
  readonly artifacts: { readonly ids: readonly number[]; readonly allocationBytes: number }
}
type CacheFence = Brc38ImportCacheFence
export async function prepareBrc38ImportCacheFence(
  trx: Knex.Transaction,
  storage: StorageKnex,
  budget: Brc38ImportDecodedBudget
): Promise<Brc38ImportCacheFence> {
  return {
    epoch: await storage.readPreparedBeefProofEpoch(trx),
    maximumAllocationBytes: budget.remaining,
    artifacts: await readyArtifacts(trx, budget)
  }
}
export async function applyBrc38ImportCacheFence(
  trx: Knex.Transaction,
  storage: StorageKnex,
  cache: Brc38ImportCacheFence,
  signal?: AbortSignal
): Promise<void> {
  if (
    (await storage.readPreparedBeefProofEpoch(trx)) !== cache.epoch ||
    JSON.stringify(
      await readyArtifacts(trx, {
        maximum: cache.maximumAllocationBytes,
        remaining: cache.maximumAllocationBytes,
        signal
      })
    ) !== JSON.stringify(cache.artifacts)
  )
    invalid()
  await storage.invalidatePreparedBeefs(trx)
}
interface PreparedEffects {
  readonly operations: readonly Operation[]
  readonly mappings: readonly { entity: keyof SyncMap; incomingId: number; localId: number }[]
  readonly cache?: CacheFence
}
/** One-use internal operations. The caller must retain the authenticated owner,
 * exact destination receipt, and actual atomic journal transaction. This object
 * is not a capability and must never be exposed as an activation token. */
export class Brc38PreparedEntityMerge {
  #consumed = false
  readonly #effects: PreparedEffects
  readonly #storage: StorageKnex
  readonly #scope: Brc38ImportMapScope
  readonly #references: readonly Brc38ImportIdReference[]
  readonly #signal?: AbortSignal
  constructor(
    storage: StorageKnex,
    scope: Brc38ImportMapScope,
    references: readonly Brc38ImportIdReference[],
    effects: PreparedEffects,
    signal?: AbortSignal
  ) {
    this.#storage = storage
    this.#scope = Object.freeze({ ...scope })
    this.#references = references.map(ref => Object.freeze({ ...ref }))
    this.#effects = effects
    this.#signal = signal
  }
  get operationCount(): number {
    return this.#effects.operations.length
  }
  async apply(trx: Knex.Transaction): Promise<{ inserts: number; updates: number }> {
    requireBrc38ImportSqliteTransaction(trx)
    if (this.#consumed) throw new Error('Prepared private entity merge is already consumed')
    this.#consumed = true
    this.#signal?.throwIfAborted()
    const loaded = await loadBrc38ImportIdMap(trx, this.#scope, this.#references)
    for (const value of this.#effects.mappings) loaded.map[value.entity].idMap[value.incomingId] = value.localId
    let inserts = 0,
      updates = 0
    await runInSeries(this.#effects.operations, async operation => {
      this.#signal?.throwIfAborted()
      const method: unknown = Reflect.get(this.#storage, operation.method)
      if (typeof method !== 'function') invalid()
      const args = cloneBrc38ImportDecodedValue(operation.arguments) as unknown[]
      const result: unknown = await Reflect.apply(method, this.#storage, [...args, trx])
      if (operation.method.startsWith('insert')) {
        inserts++
        if (operation.mapping !== undefined)
          loaded.map[operation.mapping.entity].idMap[operation.mapping.incomingId] = positive(result)
      } else updates++
    })
    if (this.#effects.cache !== undefined) {
      const cache = this.#effects.cache
      // One original invalidation per page, including its atomic worker epoch.
      // The verified source index and preceding fixed bound prevent a broad
      // tenant-controlled artifact update from slipping into this writer.
      await applyBrc38ImportCacheFence(trx, this.#storage, cache, this.#signal)
    }
    await loaded.persist()
    this.#signal?.throwIfAborted()
    return { inserts, updates }
  }
}
function syncStateOperation(
  row: TableSyncState,
  existing: TableSyncState | undefined,
  source: Readonly<TableSettings>
): Operation {
  if (existing === undefined) return { method: 'insertSyncState', arguments: [{ ...row, syncStateId: 0 }] }
  const update = { ...row, syncStateId: existing.syncStateId }
  if (row.storageIdentityKey === source.storageIdentityKey && row.storageName === source.storageName)
    update.syncMap = existing.syncMap
  return { method: 'updateSyncState', arguments: [existing.syncStateId, update] }
}
function originalHistoryIds(value: unknown): Record<number, number> {
  const ids: Record<number, number> = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ids
  for (const [key, local] of Object.entries(value)) {
    const remote = Number(key)
    if (Number.isInteger(remote) && typeof local === 'number' && Number.isInteger(local)) ids[remote] = local
  }
  return ids
}
function legacyNativeSyncMap(projection: Brc38ImportHistoryProjection, budget: Budget): string {
  // The bounded inactive projection and raw provenance retain their own formats.
  // Native history follows the existing legacy order and retains virtual IDs
  // when this archive has no corresponding imported entity.
  const original = copy(JSON.parse(projection.originalJson), budget) as Record<string, unknown>,
    mapped = copy(JSON.parse(projection.mappedJson), budget) as SyncMap,
    ordered = createSyncMap()
  for (const entity of Object.keys(ordered) as Array<keyof SyncMap>) {
    const entry = mapped[entity],
      source = original[entity],
      ids = originalHistoryIds(typeof source === 'object' && source !== null ? Reflect.get(source, 'idMap') : undefined)
    if (Object.values(forms).some(form => form.entity === entity))
      for (const [key, local] of Object.entries(entry.idMap)) ids[Number(key)] = local
    ordered[entity] = { entityName: entry.entityName, idMap: ids, count: entry.count }
    if (entry.maxUpdated_at !== undefined) ordered[entity].maxUpdated_at = new Date(entry.maxUpdated_at)
  }
  const prepared = copy(ordered, budget)
  // Both bounded source forms plus fixed standard keys upper-bound the native
  // serialization before allocating it; no payload discovery belongs in writer.
  take(budget, 2048 + 8 * (projection.originalJson.length + projection.mappedJson.length))
  return JSON.stringify(prepared)
}
function projectHistory(
  row: Record<string, unknown>,
  projection: Brc38ImportHistoryProjection | undefined,
  map: SyncMap,
  budget: Budget
): void {
  if (projection === undefined) return
  row[projection.field] =
    projection.field === 'syncMap' ? legacyNativeSyncMap(projection, budget) : projection.mappedJson
  if (projection.field !== 'notify') return
  const notify = JSON.parse(projection.mappedJson) as { transactionIds: number[] }
  for (const id of notify.transactionIds) map.transaction.idMap[positive(id)] = id
}
export class Brc38ImportAliasPageError extends SnapshotResourceLimitError {
  constructor(readonly prefixRows: number) {
    super('Private import page requires natural-key alias segmentation')
  }
}
function claimIdentities(
  seen: Set<string>,
  target: Brc38ImportEntityTarget,
  row: Brc38ImportRowTypes[Brc38StageTable],
  prefixRows: number
): void {
  const identities = [JSON.stringify([target.index, target.key])]
  if (target.localId !== undefined) identities.push(JSON.stringify([target.table, target.localId]))
  if (target.table === 'transactions') {
    const transaction = row as Brc38ImportRowTypes['transactions']
    if (transaction.txid !== undefined && transaction.txid !== '')
      identities.push(JSON.stringify(['transactionTxid', transaction.txid]))
    if (transaction.reference !== '') identities.push(JSON.stringify(['transactionReference', transaction.reference]))
  }
  if (identities.some(identity => seen.has(identity))) throw new Brc38ImportAliasPageError(prefixRows)
  for (const identity of identities) seen.add(identity)
}
/** Prepare actual legacy entity effects under the query-only destination. All
 * parsers, current-chain proof validation and secondary reads finish here,
 * before the writer. Original decoded rows/history remain untouched. */
export async function prepareBrc38ImportEntityMerge(
  trx: Knex.Transaction,
  storage: StorageKnex,
  scope: Brc38ImportMapScope,
  data: Brc38PreparedImportData,
  references: readonly Brc38ImportIdReference[],
  source: Readonly<TableSettings>,
  maximumAllocationBytes: number,
  signal?: AbortSignal
): Promise<Brc38PreparedEntityMerge> {
  requireBrc38ImportSqliteTransaction(trx)
  if (
    data.kind !== 'table' ||
    !Number.isSafeInteger(maximumAllocationBytes) ||
    maximumAllocationBytes < 1 ||
    maximumAllocationBytes > 16777216
  )
    invalid()
  const budget: Budget = {
      maximum: maximumAllocationBytes,
      remaining: maximumAllocationBytes,
      signal
    },
    operational = copy(data, budget),
    loaded = await loadBrc38ImportIdMap(trx, scope, references)
  if (operational.table === 'provenTxs') for (const row of operational.rows) canonicalizeSyncProofIdentifiers(row)
  const targets = await prepareBrc38ImportEntityTargets(
      trx,
      scope.userId,
      operational,
      loaded.map,
      budget.remaining,
      signal
    ),
    existing = await prepareBrc38ImportExistingRows(
      trx,
      storage,
      scope.userId,
      operational,
      targets,
      budget.remaining,
      signal
    )
  for (const value of existing) take(budget, value.allocationBytes)
  const history = await prepareBrc38ImportHistory(
      trx,
      scope,
      operational,
      Math.max(1, Math.floor(budget.remaining / 8)),
      signal
    ),
    map = operationalMap(loaded.map),
    operations: Operation[] = [],
    mappings: Array<{ entity: keyof SyncMap; incomingId: number; localId: number }> = [],
    seen = new Set<string>()
  let invalidates = false
  const allowed = new Set(Object.values(forms).flatMap(form => ['insert' + form.method, 'update' + form.method]))
  await runInSeries(
    operational.rows.entries() as Iterable<[number, Brc38ImportRowTypes[Brc38StageTable]]>,
    async ([index, value]) => {
      signal?.throwIfAborted()
      const target = targets[index],
        form = forms[operational.table]
      // Alias segmentation must precede writer ownership. Never apply multiple
      // stale prepared versions of one identity in a single page.
      claimIdentities(seen, target, value, index)
      if (target.localId !== undefined) positive(target.localId)
      const incoming = value as unknown as Record<string, unknown>,
        old = existing[index].row === undefined ? undefined : copy(existing[index].row, budget),
        incomingId = form.id === undefined ? undefined : incoming[form.id]
      remap(incoming, operational.table, loaded.map, scope.userId)
      if (history[index] !== undefined) chargeBrc38ImportDecodedValue(budget, history[index].mappedJson)
      projectHistory(incoming, history[index], map, budget)
      const adapter = new Proxy(storage, {
        get(_target, property) {
          if (property === 'invalidatePreparedBeefs')
            return () => {
              return promiseFromSync(() => {
                invalidates = true
                return 0
              })
            }
          if (property === 'findTransactions' || property === 'findOutputs')
            return async (args: { partial: Record<string, string | number>; trx: Knex.Transaction }) => {
              if (args.trx !== trx || args.partial.userId !== scope.userId) invalid()
              const index = property === 'findTransactions' ? 'transactionReclaim' : 'reclaimOutput',
                keys = brc38ImportTargetIndexes[index][1]
              if (
                Object.keys(args.partial).length !== keys.length ||
                keys.some(key => !Object.hasOwn(args.partial, key))
              )
                invalid()
              return await secondary(trx, storage, scope.userId, index, args.partial, budget)
            }
          if (typeof property !== 'string' || !allowed.has(property)) return invalid()
          return (...args: unknown[]) => {
            return promiseFromSync(() => {
              if (args.at(-1) !== trx || operations.length >= 8192) invalid()
              const mapping =
                property === 'insert' + form.method && form.entity !== undefined && typeof incomingId === 'number'
                  ? { entity: form.entity, incomingId }
                  : undefined
              operations.push({
                method: property,
                arguments: copy(args.slice(0, -1), budget),
                ...(mapping === undefined ? {} : { mapping })
              })
              return 1
            })
          }
        }
      })
      if (operational.table === 'provenTxs') {
        const candidate = value as Brc38ImportRowTypes['provenTxs'],
          previous = old as Brc38ImportRowTypes['provenTxs'] | undefined
        if (previous === undefined || !sameSyncProof(previous, candidate)) await validateSyncProof(storage, candidate)
      }
      if (operational.table === 'syncStates') {
        operations.push(
          copy(syncStateOperation(value as TableSyncState, old as TableSyncState | undefined, source), budget)
        )
      } else
        await entityAction(
          operational.table,
          value as Brc38ImportRowTypes[Exclude<Brc38StageTable, 'syncStates'>],
          old as Brc38ImportRowTypes[Exclude<Brc38StageTable, 'syncStates'>] | undefined,
          adapter,
          scope.userId,
          map,
          trx
        )
      if (form.entity !== undefined && typeof incomingId === 'number' && target.localId !== undefined)
        mappings.push({ entity: form.entity, incomingId, localId: target.localId })
    }
  )
  signal?.throwIfAborted()
  const cache = invalidates ? await prepareBrc38ImportCacheFence(trx, storage, budget) : undefined
  return new Brc38PreparedEntityMerge(
    storage,
    scope,
    references,
    { operations, mappings, ...(cache === undefined ? {} : { cache }) },
    signal
  )
}
