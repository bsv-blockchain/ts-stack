import type { Knex } from 'knex'
import { brc38PrivateCheckpointData, type Brc38PrivateCheckpointData } from './Brc38PrivateCheckpointData'
import type { StorageKnex } from '../StorageKnex'
import type { TableSettings, TableUser } from '../schema/tables'
import { createSyncMap } from '../schema/entities/EntityBase'
import { randomBytesBase64 } from '../../utility/utilityHelpers'
import { WERR_BAD_REQUEST, WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import type { KnexBrc38StagingStore, Brc38AuthenticatedStreamedImportReader } from './KnexBrc38StagingStore'
import { isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { privateNativeDatabaseIdentity } from './Brc38PrivateNativeOwnershipNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { brc38ImportRowForm, type Brc38PreparedStreamedPage } from './Brc38ImportPage'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import { decodePortableRow } from './Brc38PortableRows'
import { brc38ImportTargetIndexName, verifyBrc38ImportTargetIndexes } from './Brc38ImportTargetIndexes'
import type { Brc38ImportEntityTarget } from './Brc38ImportEntityTargets'
import {
  prepareBrc38ImportExistingFieldTargets,
  assertBrc38ImportExistingFieldTargets,
  type Brc38ImportExistingFieldRow
} from './Brc38ImportExistingRows'
import { prepareBrc38PrivatePageIds } from './Brc38PrivatePageIdsNode'
import { insertBrc38PackedPlannedMetadata, updateBrc38PackedPrivateMetadata } from './Brc38PackedRestoreMetadataNode'
import {
  withBrc38PreparedPrivateCheckpointText,
  type Brc38PrivateCheckpointText
} from './Brc38PrivateCheckpointTextNode'
import type { Brc38PrivateCurrentStructuredPolicy } from './Brc38PrivateCurrentStructuredSourceNode'
import type { Brc38CheckpointSyncMapDelta } from './Brc38CheckpointSyncMap'
import { writeBrc38NativePackedTextBytes } from './Brc38NativePackedTextFieldsNode'
import { chargeBrc38ImportDecodedBudget, copyBrc38ImportDecodedValue } from './Brc38ImportDecodedBudget'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import {
  withBrc38PrivateCheckpointWindowDeltas,
  type Brc38PrivateCheckpointWindow
} from './Brc38PrivateCheckpointWindowNode'
import { brc38WorkingAllocation } from './Brc38WorkingAllocation'

export interface Brc38PrivateOperationalCheckpoint {
  readonly syncStateId: number
  /** Actual DATA only after apply on the same live writer. */
  committedData(trx: Knex.Transaction): Readonly<Brc38PrivateCheckpointData>
  /** Call before any entity/original effects in the same journal transaction. */
  assert(trx: Knex.Transaction): Promise<void>
  /** Call after entity effects have persisted their actual ID mappings. */
  apply(trx: Knex.Transaction): Promise<void>
}
function invalid(): never {
  throw new Error(
    'Private operational checkpoint differs from its actual source, current profile or committed mappings'
  )
}
function date(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid()
  return new Date(value.getTime())
}
function sourceQuery(trx: Knex.Transaction, key: Readonly<Record<string, string | number>>) {
  return trx.from(trx.raw('sync_states INDEXED BY ??', [brc38ImportTargetIndexName('syncStates', trx)])).where(key)
}
async function target(
  trx: Knex.Transaction,
  storage: StorageKnex,
  userId: number,
  source: Readonly<TableSettings>,
  page: Brc38PreparedStreamedPage
): Promise<{ target: Brc38ImportEntityTarget; current: Brc38ImportExistingFieldRow }> {
  await verifyBrc38ImportTargetIndexes(trx)
  const identity = { userId, storageIdentityKey: source.storageIdentityKey },
    desired = { ...identity, storageName: source.storageName },
    rows: Array<{ syncStateId: number; storageName: string }> = await sourceQuery(trx, identity)
      .select(
        'syncStateId',
        trx.raw(
          "CASE WHEN typeof(storageName)='text' AND length(CAST(storageName AS BLOB))<=4096 THEN storageName END AS storageName"
        )
      )
      .limit(2)
  if (rows.some(row => !Number.isSafeInteger(row.syncStateId) || typeof row.storageName !== 'string')) invalid()
  if (rows.length > 1) {
    const exact = await sourceQuery(trx, desired).select('syncStateId').limit(2)
    if (exact.length !== 1)
      throw new WERR_INVALID_OPERATION(
        'Storage identity has conflicting sync states. Use a unique identity for each storage provider.'
      )
    throw new WERR_BAD_REQUEST('Result must exist and be unique.')
  }
  const selection: Brc38ImportEntityTarget = Object.freeze({
    table: 'syncStates',
    index: 'syncStates',
    key: Object.freeze(rows.length === 0 ? desired : { ...identity, storageName: rows[0].storageName }),
    found: rows.length === 1,
    ...(rows.length === 0 ? {} : { localId: rows[0].syncStateId })
  })
  const current = await prepareBrc38ImportExistingFieldTargets(
    trx,
    storage,
    userId,
    'syncStates',
    [selection],
    65536,
    page.budget.signal
  )
  if (current.length !== 1) invalid()
  return { target: selection, current: current[0] }
}
async function user(trx: Knex.Transaction, storage: StorageKnex, userId: number): Promise<TableUser> {
  const rows: TableUser[] = await trx('users')
    .where({ userId })
    .select(
      'userId',
      ...['created_at', 'updated_at'].map(field =>
        trx.raw(
          "CASE WHEN typeof(??) IN ('text','integer','real') AND length(CAST(?? AS BLOB))<=80 THEN ?? END AS ??",
          [field, field, field, field]
        )
      ),
      trx.raw(
        "CASE WHEN typeof(identityKey)='text' AND length(CAST(identityKey AS BLOB)) BETWEEN 1 AND 256 THEN identityKey END AS identityKey"
      ),
      trx.raw(
        "CASE WHEN typeof(activeStorage)='text' AND length(CAST(activeStorage AS BLOB))<=256 THEN activeStorage END AS activeStorage"
      )
    )
    .limit(2)
  if (rows.length !== 1 || typeof rows[0].identityKey !== 'string' || typeof rows[0].activeStorage !== 'string')
    invalid()
  return storage.validateEntity(rows[0])
}

/** Real operational checkpoint for occupied private candidates. Original
 * archived sync states are a separate provenance family; none supplies init,
 * primary, errors or map authority here. A finite read-planned ID delta is
 * streamed into genuine prepared current-map content before writer admission.
 * The final writer rechecks full current state/user and actual persisted entity
 * mappings, then applies the checkpoint inside its row/map/provenance/receipt
 * transaction. This callback owns no publication or primary cutover. */
export async function withBrc38PrivateOperationalCheckpoint<T>(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  admission: Readonly<Brc38ImportJournalAdmission>,
  page: Brc38PreparedStreamedPage,
  reader: Readonly<Brc38AuthenticatedStreamedImportReader>,
  selectedMappings: readonly Readonly<{ incomingId: number; localId: number }>[],
  policy: Brc38PrivateCurrentStructuredPolicy,
  work: (checkpoint: Readonly<Brc38PrivateOperationalCheckpoint>) => Promise<T>,
  window?: Readonly<Brc38PrivateCheckpointWindow>
): Promise<T> {
  const root = storage.toDb(),
    origin = privateNativeDatabaseIdentity(root),
    binding = store.binding,
    deadline = performance.now() + Math.max(0, admission.expiresAt - Date.now()),
    { data, budget } = page
  if (
    root !== store.knex ||
    origin?.slot !== 0 ||
    binding === undefined ||
    binding.digest !== admission.scope.bindingSha256 ||
    binding.binding.archiveSha256 !== admission.scope.archiveSha256 ||
    binding.limitsJson !== admission.originalLimitsJson ||
    admission.expiresAt !== store.limits.expiresAt ||
    policy.expiresAt !== admission.expiresAt ||
    !Array.isArray(selectedMappings) ||
    selectedMappings.length > 4000
  )
    invalid()
  chargeBrc38ImportDecodedBudget(budget, 32768 + 2048 * selectedMappings.length)
  const mappings = Object.freeze(
      selectedMappings.map(value => {
        if (!Number.isInteger(value.incomingId) || !Number.isSafeInteger(value.localId) || value.localId < 1) invalid()
        return Object.freeze({ incomingId: value.incomingId, localId: value.localId })
      })
    ),
    actor = (): void => {
      budget.signal?.throwIfAborted()
      if (
        storage.toDb() !== root ||
        privateNativeDatabaseIdentity(root)?.token !== origin.token ||
        Date.now() >= admission.expiresAt ||
        performance.now() >= deadline
      )
        invalid()
      store.assertPrivateNativeDestination(root)
    }
  actor()
  const header = await reader.header(),
    source = decodePortableRow<TableSettings>('settings', header.sourceStorage)
  if (
    header.user.identityKey !== binding.binding.identityKey ||
    source.chain !== binding.binding.chain ||
    typeof source.storageIdentityKey !== 'string' ||
    Buffer.byteLength(source.storageIdentityKey) > 4096 ||
    typeof source.storageName !== 'string' ||
    Buffer.byteLength(source.storageName) > 4096
  )
    invalid()
  const form = data.kind === 'header' ? undefined : brc38ImportRowForm(data.table),
    entity = form?.entity
  // Composite entities still advance their own counters without numeric maps.
  const composite =
      data.kind === 'table'
        ? (
            { txLabelMaps: 'txLabelMap', outputTagMaps: 'outputTagMap', certificateFields: 'certificateField' } as const
          )[data.table as 'txLabelMaps' | 'outputTagMaps' | 'certificateFields']
        : undefined,
    selectedEntity = entity ?? composite
  if (
    (selectedEntity === undefined && mappings.length !== 0) ||
    (entity !== undefined &&
      data.kind === 'table' &&
      (mappings.length !== data.rows.length ||
        data.rows.some((row, index) => row.metadata[form!.id!] !== mappings[index].incomingId)))
  )
    invalid()
  const preparedAt = Date.now()
  let maximum: Date | undefined,
    importedWhen: Date | undefined,
    timestamp = new Date(preparedAt),
    done =
      page.step.fromRow + page.step.rows === admission.totalRows ||
      (data.kind === 'table' && data.table === 'syncStates')
  if (data.kind === 'table' && selectedEntity !== undefined)
    for (const row of data.rows) {
      const updated = date(row.metadata.updated_at)
      if (maximum === undefined || updated > maximum) maximum = updated
    }
  if (data.kind === 'header' && !done) {
    done = true
    for (const table of [
      'provenTxs',
      'outputBaskets',
      'outputTags',
      'txLabels',
      'transactions',
      'outputs',
      'txLabelMaps',
      'outputTagMaps',
      'certificates',
      'certificateFields',
      'commissions',
      'provenTxReqs'
    ] as const) {
      actor()
      const count = await reader.count(table)
      if (!Number.isSafeInteger(count) || count < 0) invalid()
      if (count !== 0) done = false
    }
  }
  if (data.kind === 'table' && data.table === 'syncStates')
    for (const row of data.rows) {
      if (
        row.metadata.storageIdentityKey === source.storageIdentityKey &&
        row.metadata.storageName === source.storageName
      ) {
        timestamp = date(row.metadata.updated_at)
        importedWhen = row.metadata.when === undefined ? undefined : date(row.metadata.when)
      }
    }
  const delta: Brc38CheckpointSyncMapDelta = Object.freeze({
      entity: selectedEntity,
      count: selectedEntity === undefined || data.kind === 'header' ? 0 : data.rows.length,
      mappings,
      maximumUpdatedAt: maximum,
      done
    }),
    skip = data.kind === 'table' && data.table === 'syncStates' && data.fromIndex > 0
  const prepared = await store.withPrivateNativeDatabase(
    true,
    async database =>
      await database.transaction(async trx => {
        actor()
        store.assertPrivateNativeReadTransaction(trx)
        await verifyBrc38AuthenticatedSourceSeal(trx)
        chargeBrc38ImportDecodedBudget(budget, 1114112)
        const current = await target(trx, storage, admission.scope.userId, source, page)
        if (current.current.metadata === undefined && data.kind !== 'header') invalid()
        const priorUser = data.kind === 'header' ? await user(trx, storage, admission.scope.userId) : undefined
        if (priorUser !== undefined && priorUser.identityKey !== binding.binding.identityKey) invalid()
        const allocation =
          current.current.metadata !== undefined
            ? undefined
            : await prepareBrc38PrivatePageIds(storage, trx, 'syncStates', 1, admission.expiresAt, budget)
        actor()
        return {
          ...current,
          priorUser: priorUser === undefined ? undefined : copyBrc38ImportDecodedValue(priorUser, budget),
          allocation
        }
      })
  )
  const syncStateId = prepared.current.metadata === undefined ? prepared.allocation?.ids[0] : prepared.target.localId
  if (typeof syncStateId !== 'number' || !Number.isSafeInteger(syncStateId)) invalid()
  if (window !== undefined && window.receipt.nextRow !== page.step.fromRow) invalid()
  const incremental = window?.incremental === true,
    materialize =
      !incremental || done || window.pendingPages + 1 >= 128 || window.pendingMappings + mappings.length >= 128,
    nextRow = page.step.fromRow + page.step.rows,
    observation = (
      mode: 'NEW' | 'UPDATE' | 'SKIP',
      selectedTimestamp: string | null,
      refNum: string | null
    ): Readonly<Brc38PrivateCheckpointData> => {
      const data = { syncStateId, mode, preparedAt, timestamp: selectedTimestamp, refNum }
      return brc38PrivateCheckpointData(
        incremental
          ? {
              protocol: 'brc38-private-checkpoint-data/v2',
              ...data,
              materializedNextRow: mode !== 'UPDATE' || materialize ? nextRow : window.materializedNextRow
            }
          : { protocol: 'brc38-private-checkpoint-data/v1', ...data }
      )
    }
  let live = true,
    consumed = false,
    asserted: Knex.Transaction | undefined,
    committed: Readonly<Brc38PrivateCheckpointData> | undefined
  const writer = (trx: Knex.Transaction): void => {
      actor()
      store.assertPrivateNativeWriteTransaction(trx)
      if (!live || consumed || !isBrc38OwnedPrivateNativeWriter(trx)) invalid()
    },
    use = async (text?: Readonly<Brc38PrivateCheckpointText>): Promise<T> => {
      const effects = new Brc38OwnedImportReads()
      const checkpoint: Readonly<Brc38PrivateOperationalCheckpoint> = Object.freeze({
        syncStateId,
        committedData: (trx: Knex.Transaction) => {
          actor()
          store.assertPrivateNativeWriteTransaction(trx)
          if (
            !live ||
            !consumed ||
            asserted !== trx ||
            committed === undefined ||
            !isBrc38OwnedPrivateNativeWriter(trx)
          )
            invalid()
          return committed
        },
        assert: (trx: Knex.Transaction) =>
          effects.run(async () => {
            writer(trx)
            if (asserted !== undefined && asserted !== trx) invalid()
            await verifyBrc38AuthenticatedSourceSeal(trx)
            chargeBrc38ImportDecodedBudget(budget, 1114112)
            await assertBrc38ImportExistingFieldTargets(
              trx,
              storage,
              admission.scope.userId,
              'syncStates',
              [prepared.target],
              [prepared.current],
              65536,
              budget.signal
            )
            if (prepared.priorUser !== undefined) {
              const current = await user(trx, storage, admission.scope.userId)
              if (JSON.stringify(current) !== JSON.stringify(prepared.priorUser)) invalid()
            }
            await text?.assert(trx)
            asserted = trx
            writer(trx)
          }),
        apply: (trx: Knex.Transaction) =>
          effects.run(async () => {
            writer(trx)
            if (asserted !== trx) invalid()
            await verifyBrc38AuthenticatedSourceSeal(trx)
            consumed = true
            if (skip) {
              if (incremental && window.pendingPages !== 0) invalid()
              committed = observation('SKIP', null, null)
              return
            }
            chargeBrc38ImportDecodedBudget(budget, 32768 + 2048 * mappings.length)
            if (entity !== undefined) {
              const loaded = await loadBrc38ImportIdMap(
                trx,
                admission.scope,
                mappings.map(value => ({ entity, incomingId: value.incomingId, required: true }))
              )
              for (const value of mappings) if (loaded.map[entity].idMap[value.incomingId] !== value.localId) invalid()
            }
            if (
              prepared.priorUser !== undefined &&
              data.kind === 'header' &&
              data.user.updated_at > prepared.priorUser.updated_at
            ) {
              const current = await user(trx, storage, admission.scope.userId)
              if (JSON.stringify(current) !== JSON.stringify(prepared.priorUser)) invalid()
              await storage.updateUser(current.userId, { updated_at: new Date(data.user.updated_at.getTime()) }, trx)
            }
            chargeBrc38ImportDecodedBudget(budget, 32768)
            if (prepared.current.metadata === undefined) {
              if (prepared.allocation === undefined || data.kind !== 'header') invalid()
              // Complete genuine NEW checkpoint DTO, never archived operational
              // history or a placeholder for absent source payloads.
              const created = new Date(timestamp.getTime()),
                initial = Buffer.from(JSON.stringify(createSyncMap())),
                metadata = {
                  syncStateId: 0,
                  userId: admission.scope.userId,
                  created_at: created,
                  updated_at: created,
                  storageIdentityKey: source.storageIdentityKey,
                  storageName: source.storageName,
                  init: false,
                  status: 'unknown',
                  refNum: randomBytesBase64(12),
                  when: undefined,
                  satoshis: undefined,
                  errorLocal: undefined,
                  errorOther: undefined
                }
              try {
                if (initial.length > 4096) invalid()
                if (
                  (await insertBrc38PackedPlannedMetadata(
                    storage,
                    trx,
                    'syncStates',
                    metadata,
                    [],
                    prepared.allocation,
                    budget,
                    ['syncMap']
                  )) !== syncStateId
                )
                  invalid()
                await writeBrc38NativePackedTextBytes(
                  trx,
                  { table: 'syncStates', field: 'syncMap', rowId: syncStateId },
                  initial,
                  budget.signal
                )
                committed = observation('NEW', created.toISOString(), metadata.refNum)
              } finally {
                initial.fill(0)
              }
            } else {
              if (materialize && text === undefined) invalid()
              const metadata: Record<string, unknown> = {
                ...prepared.current.metadata,
                storageName: source.storageName,
                updated_at: new Date(timestamp.getTime())
              }
              if (done)
                metadata.when =
                  importedWhen ?? (text?.maximumUpdatedAt === undefined ? undefined : new Date(text.maximumUpdatedAt))
              await updateBrc38PackedPrivateMetadata(
                storage,
                trx,
                'syncStates',
                metadata,
                [],
                prepared.target,
                budget,
                ['syncMap']
              )
              await text?.attach(trx)
              committed = observation('UPDATE', timestamp.toISOString(), null)
            }
            actor()
          })
      })
      try {
        return await effects.retain(async () => await work(checkpoint))
      } finally {
        live = false
      }
    }
  // Later archived sync-state pages retain originals only; their source values
  // never replace a newly built operational map or activate local history.
  if (prepared.current.metadata === undefined || skip) return await use()
  if (!materialize) return await use()
  if (incremental) {
    const working = brc38WorkingAllocation(policy.workingAllocation)
    if (working === undefined) invalid()
    return await withBrc38PrivateCheckpointWindowDeltas(
      store,
      storage,
      admission,
      reader,
      window,
      syncStateId,
      delta,
      working,
      budget,
      async deltas =>
        await withBrc38PreparedPrivateCheckpointText(store, storage, syncStateId, policy, deltas, budget, use)
    )
  }
  return await withBrc38PreparedPrivateCheckpointText(store, storage, syncStateId, policy, delta, budget, use)
}
