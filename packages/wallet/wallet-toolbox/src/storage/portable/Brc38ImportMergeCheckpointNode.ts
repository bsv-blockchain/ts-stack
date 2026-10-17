import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { TableSettings, TableUser, TableSyncState } from '../schema/tables'
import { createSyncMap, type SyncMap } from '../schema/entities/EntityBase'
import { EntitySyncState } from '../schema/entities/EntitySyncState'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import type { Brc38PreparedImportData } from './Brc38ImportPage'
import type { Brc38AuthenticatedImportReader } from './KnexBrc38StagingStore'
import { runInSeries } from '../../utility/runInSeries'
import { randomBytesBase64 } from '../../utility/utilityHelpers'
import { WERR_INVALID_OPERATION, WERR_BAD_REQUEST } from '../../sdk/WERR_errors'
import { loadBrc38ImportIdMap, type Brc38ImportIdReference } from './Brc38ImportIdMap'
import { prepareBrc38ImportExistingTargets } from './Brc38ImportExistingRows'
import { brc38ImportTargetIndexName } from './Brc38ImportTargetIndexes'
import {
  chargeBrc38ImportDecodedBudget,
  copyBrc38ImportDecodedValue,
  type Brc38ImportDecodedBudget
} from './Brc38ImportEntityMergeNode'

const entities = {
  provenTxs: ['provenTx', 'provenTxId'],
  outputBaskets: ['outputBasket', 'basketId'],
  outputTags: ['outputTag', 'outputTagId'],
  txLabels: ['txLabel', 'txLabelId'],
  transactions: ['transaction', 'transactionId'],
  outputs: ['output', 'outputId'],
  txLabelMaps: ['txLabelMap', undefined],
  outputTagMaps: ['outputTagMap', undefined],
  certificates: ['certificate', 'certificateId'],
  certificateFields: ['certificateField', undefined],
  commissions: ['commission', 'commissionId'],
  provenTxReqs: ['provenTxReq', 'provenTxReqId']
} as const
function invalid(): never {
  throw new Error('Prepared native import source checkpoint differs from its owned destination')
}
function nativeSource(trx: Knex.Transaction, key: Readonly<Record<string, string | number>>) {
  return trx.from(trx.raw('sync_states INDEXED BY ??', [brc38ImportTargetIndexName('syncStates', trx)])).where(key)
}
async function sourceIds(trx: Knex.Transaction, key: Readonly<Record<string, string | number>>): Promise<number[]> {
  const rows: Array<{ localId: number }> = await nativeSource(trx, key)
    .select(
      trx.raw(
        "CASE WHEN typeof(syncStateId) = 'integer' AND syncStateId BETWEEN -9007199254740991 AND 9007199254740991 THEN syncStateId END AS localId"
      )
    )
    .limit(2)
  if (rows.some(row => !Number.isSafeInteger(row.localId))) invalid()
  return rows.map(row => row.localId)
}
async function sourceKey(
  trx: Knex.Transaction,
  userId: number,
  source: Readonly<TableSettings>,
  budget: Brc38ImportDecodedBudget
): Promise<{ key: Readonly<Record<string, string | number>>; localId?: number }> {
  const identity = { userId, storageIdentityKey: source.storageIdentityKey },
    desired = { ...identity, storageName: source.storageName },
    ids = await sourceIds(trx, identity)
  if (ids.length === 0) return { key: Object.freeze(desired) }
  if (ids.length > 1) {
    const exact = await sourceIds(trx, desired)
    if (exact.length !== 1)
      throw new WERR_INVALID_OPERATION(
        'Storage identity has conflicting sync states. Use a unique identity for each storage provider.'
      )
    throw new WERR_BAD_REQUEST('Result must exist and be unique.')
  }
  // Preflight the one old name before transferring its bounded payload. A
  // renamed provider keeps its existing native identity, as legacy merge does.
  const rows: Array<{ storageName: string }> = await nativeSource(trx, identity)
    .where({ syncStateId: ids[0] })
    .select(
      trx.raw(
        "CASE WHEN typeof(storageName) = 'text' AND 256 + 8 * length(CAST(storageName AS BLOB)) <= ? THEN storageName END AS storageName",
        [budget.remaining]
      )
    )
    .limit(1)
  if (rows.length !== 1 || typeof rows[0].storageName !== 'string') invalid()
  chargeBrc38ImportDecodedBudget(budget, 256 + 8 * Buffer.byteLength(rows[0].storageName))
  return { key: Object.freeze({ ...identity, storageName: rows[0].storageName }), localId: ids[0] }
}
async function preparedSource(
  trx: Knex.Transaction,
  storage: StorageKnex,
  admission: Brc38ImportJournalAdmission,
  source: Readonly<TableSettings>,
  budget: Brc38ImportDecodedBudget
): Promise<{ key: Readonly<Record<string, string | number>>; row?: TableSyncState }> {
  const { key, localId } = await sourceKey(trx, admission.scope.userId, source, budget)
  const existing = await prepareBrc38ImportExistingTargets(
    trx,
    storage,
    admission.scope.userId,
    'syncStates',
    [
      {
        table: 'syncStates',
        index: 'syncStates',
        key,
        found: localId !== undefined,
        ...(localId === undefined ? {} : { localId })
      }
    ],
    budget.remaining,
    budget.signal
  )
  chargeBrc38ImportDecodedBudget(budget, existing[0].allocationBytes)
  return { key, row: existing[0].row as TableSyncState | undefined }
}
async function preparedUser(
  trx: Knex.Transaction,
  storage: StorageKnex,
  userId: number,
  budget: Brc38ImportDecodedBudget
): Promise<TableUser> {
  // Only a fixed native user row, with string extents checked before transfer.
  const rows: TableUser[] = await trx('users')
    .where({ userId })
    .select(
      'userId',
      ...['created_at', 'updated_at'].map(field =>
        trx.raw(
          "CASE WHEN typeof(??) IN ('text', 'integer', 'real') AND length(CAST(?? AS BLOB)) <= 80 THEN ?? END AS ??",
          [field, field, field, field]
        )
      ),
      trx.raw(
        "CASE WHEN typeof(identityKey) = 'text' AND length(CAST(identityKey AS BLOB)) BETWEEN 1 AND 256 THEN identityKey END AS identityKey"
      ),
      trx.raw(
        "CASE WHEN typeof(activeStorage) = 'text' AND length(CAST(activeStorage AS BLOB)) <= 256 THEN activeStorage END AS activeStorage"
      )
    )
    .limit(2)
  if (rows.length !== 1 || typeof rows[0].identityKey !== 'string' || typeof rows[0].activeStorage !== 'string')
    invalid()
  return copyBrc38ImportDecodedValue({ ...storage.validateEntity(rows[0]) }, budget)
}
interface Delta {
  readonly entity?: keyof SyncMap
  readonly ids: readonly number[]
  readonly newIds: readonly number[]
  readonly skip?: boolean
  readonly timestamp?: Date
  readonly count: number
  readonly maximum?: Date
  readonly done: boolean
  readonly importedWhen?: Date
}
/** One bounded prepared update of the actual native source checkpoint. Existing
 * source maps are payload-preflighted before parsing. No archive-wide scan,
 * crypto, source I/O or unbounded payload discovery belongs in the writer. */
export class Brc38PreparedMergeCheckpoint {
  #consumed = false
  constructor(
    readonly storage: StorageKnex,
    readonly admission: Brc38ImportJournalAdmission,
    readonly key: Readonly<Record<string, string | number>>,
    readonly prior: TableSyncState | undefined,
    readonly state: EntitySyncState,
    readonly references: readonly Brc38ImportIdReference[],
    readonly delta: Delta,
    readonly user: TableUser | undefined,
    readonly previousUser: TableUser | undefined,
    readonly signal?: AbortSignal
  ) {}
  async assert(trx: Knex.Transaction): Promise<void> {
    const rows = await nativeSource(trx, this.key).select('syncStateId').limit(2)
    if (this.prior === undefined) {
      if (rows.length !== 0) invalid()
    } else {
      if (rows.length !== 1 || rows[0].syncStateId !== this.prior.syncStateId) invalid()
      const same = await nativeSource(trx, this.key)
        .where({ syncStateId: this.prior.syncStateId, syncMap: this.prior.syncMap })
        .select('syncStateId')
        .limit(1)
      if (same.length !== 1) invalid()
    }
    this.signal?.throwIfAborted()
  }
  private async updateUser(trx: Knex.Transaction): Promise<void> {
    if (this.user !== undefined && this.previousUser !== undefined) {
      const rows = await trx('users')
        .where({
          userId: this.previousUser.userId,
          identityKey: this.previousUser.identityKey,
          activeStorage: this.previousUser.activeStorage,
          updated_at: this.previousUser.updated_at.toISOString()
        })
        .select('userId')
        .limit(1)
      if (rows.length !== 1) invalid()
      await this.storage.updateUser(this.user.userId, this.user, trx)
    }
  }
  private async updateMap(trx: Knex.Transaction): Promise<void> {
    const map = this.state.syncMap,
      delta = this.delta
    if (delta.entity === undefined) return
    {
      const loaded = await loadBrc38ImportIdMap(trx, this.admission.scope, this.references),
        entry = map[delta.entity]
      for (const incomingId of delta.ids) {
        const localId = loaded.map[delta.entity].idMap[incomingId]
        if (
          !Number.isSafeInteger(localId) ||
          (!delta.newIds.includes(incomingId) &&
            Object.hasOwn(entry.idMap, incomingId) &&
            entry.idMap[incomingId] !== localId)
        )
          invalid()
        entry.idMap[incomingId] = localId
      }
      entry.count += delta.count
      if (delta.maximum !== undefined && (entry.maxUpdated_at === undefined || delta.maximum > entry.maxUpdated_at))
        entry.maxUpdated_at = delta.maximum
    }
  }
  private finishMap(): void {
    const map = this.state.syncMap,
      delta = this.delta
    if (!delta.done) return
    {
      let maximum: Date | undefined
      for (const name of Object.keys(createSyncMap()) as Array<keyof SyncMap>) {
        const entry = map[name]
        if (entry.maxUpdated_at !== undefined && (maximum === undefined || entry.maxUpdated_at > maximum))
          maximum = entry.maxUpdated_at
        entry.count = 0
      }
      this.state.when = delta.importedWhen ?? maximum
    }
  }
  async apply(trx: Knex.Transaction): Promise<void> {
    if (this.#consumed) throw new Error('Prepared native merge checkpoint is already consumed')
    this.#consumed = true
    this.signal?.throwIfAborted()
    if (this.delta.skip) return
    await this.updateUser(trx)
    await this.updateMap(trx)
    this.finishMap()
    if (this.delta.timestamp !== undefined) this.state.updated_at = this.delta.timestamp
    const api = this.state.toApi()
    if (this.prior === undefined) await this.storage.insertSyncState(api, trx)
    else
      await this.storage.updateSyncState(
        this.prior.syncStateId,
        {
          syncMap: api.syncMap,
          when: api.when,
          storageName: api.storageName,
          ...(this.delta.timestamp === undefined ? {} : { updated_at: api.updated_at })
        },
        trx
      )
    this.signal?.throwIfAborted()
  }
}
function reserveIncoming(
  data: Extract<Brc38PreparedImportData, { kind: 'table' }>,
  map: SyncMap
): Pick<Delta, 'entity' | 'ids' | 'newIds' | 'maximum'> {
  if (data.table === 'syncStates') return { ids: [], newIds: [] }
  const form = entities[data.table],
    entity = form[0],
    ids: number[] = [],
    newIds: number[] = []
  let maximum: Date | undefined
  for (const row of data.rows) {
    if (maximum === undefined || row.updated_at > maximum) maximum = new Date(row.updated_at)
    if (form[1] === undefined) continue
    const id = Reflect.get(row, form[1])
    if (typeof id !== 'number' || !Number.isInteger(id)) invalid()
    ids.push(id)
    if (!Object.hasOwn(map[entity].idMap, id)) {
      newIds.push(id)
      map[entity].idMap[id] = -Number.MAX_SAFE_INTEGER
    }
  }
  return { entity, ids, newIds, maximum }
}
function preparedDelta(
  data: Brc38PreparedImportData,
  source: Readonly<TableSettings>,
  done: boolean,
  map: SyncMap
): Delta {
  if (data.kind === 'header') return { ids: [], newIds: [], count: 0, done, timestamp: new Date() }
  const delta = reserveIncoming(data, map)
  let importedWhen: Date | undefined,
    timestamp = new Date()
  if (data.table === 'syncStates')
    for (const row of data.rows) {
      if (row.storageIdentityKey === source.storageIdentityKey && row.storageName === source.storageName) {
        timestamp = new Date(row.updated_at)
        importedWhen = row.when === undefined ? undefined : new Date(row.when)
      }
    }
  return {
    ...delta,
    count: data.rows.length,
    done,
    importedWhen,
    skip: data.table === 'syncStates' && data.fromIndex > 0,
    timestamp
  }
}
function validateMap(map: SyncMap, delta: Delta): void {
  const partial: Partial<SyncMap> = map
  for (const name of Object.keys(createSyncMap()) as Array<keyof SyncMap>) {
    const entry = partial[name]
    if (entry === undefined || !Number.isSafeInteger(entry.count) || entry.count < 0) invalid()
    const ids: unknown = entry.idMap
    if (ids === null || typeof ids !== 'object' || Array.isArray(ids)) invalid()
    if (name === delta.entity && !Number.isSafeInteger(entry.count + delta.count)) invalid()
    if (entry.maxUpdated_at !== undefined && !Number.isFinite(entry.maxUpdated_at.getTime())) invalid()
    if (Object.values(entry.idMap).some(value => !Number.isSafeInteger(value))) invalid()
  }
}
async function headerUser(
  trx: Knex.Transaction,
  storage: StorageKnex,
  admission: Brc38ImportJournalAdmission,
  data: Brc38PreparedImportData,
  budget: Brc38ImportDecodedBudget
): Promise<{ user?: TableUser; previousUser?: TableUser }> {
  if (data.kind !== 'header') return {}
  const previousUser = await preparedUser(trx, storage, admission.scope.userId, budget)
  if (previousUser.identityKey !== data.user.identityKey) invalid()
  const user =
    data.user.updated_at > previousUser.updated_at
      ? { ...previousUser, updated_at: new Date(data.user.updated_at) }
      : undefined
  return { user, previousUser }
}
async function sourceComplete(
  data: Brc38PreparedImportData,
  reader: Readonly<Brc38AuthenticatedImportReader>,
  done: boolean
): Promise<boolean> {
  if (done || data.kind !== 'header') return done
  let empty = true
  await runInSeries(Object.keys(entities) as Array<keyof typeof entities>, async table => {
    const count = await reader.count(table)
    if (!Number.isSafeInteger(count) || count < 0) invalid()
    if (count !== 0) empty = false
  })
  return empty
}
export async function prepareBrc38ImportMergeCheckpoint(
  trx: Knex.Transaction,
  storage: StorageKnex,
  admission: Brc38ImportJournalAdmission,
  data: Brc38PreparedImportData,
  references: readonly Brc38ImportIdReference[],
  source: Readonly<TableSettings>,
  reader: Readonly<Brc38AuthenticatedImportReader>,
  done: boolean,
  budget: Brc38ImportDecodedBudget
): Promise<Brc38PreparedMergeCheckpoint> {
  const { key, row } = await preparedSource(trx, storage, admission, source, budget)
  if (data.kind !== 'header' && row === undefined) invalid()
  const owned = row === undefined ? undefined : copyBrc38ImportDecodedValue(row, budget)
  if (owned !== undefined && (!owned.syncMap || owned.syncMap === '{}')) owned.syncMap = JSON.stringify(createSyncMap())
  const state = new EntitySyncState(owned)
  state.api.storageName = source.storageName
  if (row === undefined)
    Object.assign(state.api, {
      userId: admission.scope.userId,
      storageIdentityKey: source.storageIdentityKey,
      storageName: source.storageName,
      refNum: randomBytesBase64(12)
    })
  const { user, previousUser } = await headerUser(trx, storage, admission, data, budget),
    delta = preparedDelta(data, source, await sourceComplete(data, reader, done), state.syncMap)
  validateMap(state.syncMap, delta)
  state.syncMap = copyBrc38ImportDecodedValue(state.syncMap, budget)
  chargeBrc38ImportDecodedBudget(budget, 4096 + 16 * JSON.stringify(state.syncMap).length)
  return new Brc38PreparedMergeCheckpoint(
    storage,
    admission,
    key,
    row,
    state,
    references,
    delta,
    user,
    previousUser,
    budget.signal
  )
}
