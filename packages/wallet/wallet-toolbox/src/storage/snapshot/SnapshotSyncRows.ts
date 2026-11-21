import type { Knex } from 'knex'
import type { SyncChunk } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { createSyncMap, type SyncMap } from '../schema/entities/EntityBase'
import type { SnapshotSyncTable } from './SnapshotSync'
import { runInSeries } from '../../utility/runInSeries'
import {
  collectSnapshotSyncReferences,
  collectSnapshotSyncFieldReferences,
  type SnapshotMapScope,
  type SnapshotSyncPageReferences
} from './SnapshotSyncRowData'
export {
  detachSnapshotSyncPage,
  collectSnapshotSyncReferences,
  collectSnapshotSyncFieldReferences
} from './SnapshotSyncRowData'
export type { SnapshotMapScope, SnapshotSyncPageReferences } from './SnapshotSyncRowData'

interface IdRow {
  entity: keyof SyncMap
  incomingId: number
  localId: number
}

/** Produce one SQL parameter batch at a time without creating an eager query queue. */
function* idBatches<T>(values: T[]): Generator<T[]> {
  for (let offset = 0; offset < values.length; offset += 128) yield values.slice(offset, offset + 128)
}

/** Load only incoming IDs and their parent references; never parse or overwrite the legacy JSON map. */
export async function loadSnapshotIdMap(
  k: Knex,
  scope: SnapshotMapScope,
  sourceUserId: number,
  table: SnapshotSyncTable,
  chunk: SyncChunk
): Promise<{ map: SyncMap; persist: () => Promise<void> }> {
  return await loadReferences(k, scope, collectSnapshotSyncReferences(sourceUserId, table, chunk))
}

/** Metadata-only native preparation/writer mapping path. It neither invents
 * complete payload rows nor parses structured notifications. Those use their
 * own finite index reader. Parent existence/owner is inspected on the actual
 * current transaction; a saved mapping is DATA and cannot bless a parent. */
export async function loadSnapshotFieldIdMap(
  k: Knex,
  scope: SnapshotMapScope,
  sourceUserId: number,
  table: SnapshotSyncTable,
  rows: readonly Readonly<Record<string, unknown>>[]
): Promise<{ map: SyncMap; persist: () => Promise<void> }> {
  const references = collectSnapshotSyncFieldReferences(sourceUserId, table, rows),
    result = await loadReferences(k, scope, references)
  await inspectCurrentParents(k, scope.userId, result.map, references.required)
  return result
}

const parentTables: Partial<Record<keyof SyncMap, readonly [string, string, boolean]>> = {
  provenTx: ['proven_txs', 'provenTxId', false],
  transaction: ['transactions', 'transactionId', true],
  outputBasket: ['output_baskets', 'basketId', true],
  outputTag: ['output_tags', 'outputTagId', true],
  txLabel: ['tx_labels', 'txLabelId', true],
  output: ['outputs', 'outputId', true],
  certificate: ['certificates', 'certificateId', true]
}
async function inspectCurrentParents(
  k: Knex,
  userId: number,
  map: SyncMap,
  required: Map<keyof SyncMap, Set<number>>
): Promise<void> {
  for (const [entity, incoming] of required) {
    const definition = parentTables[entity]
    if (definition === undefined)
      throw new WERR_INVALID_OPERATION('Snapshot parent table differs from its actual entity contract')
    const localIds = [...new Set([...incoming].map(id => map[entity].idMap[id]))],
      [table, key, owned] = definition
    for (const batch of idBatches(localIds)) {
      if (batch.some(id => !Number.isSafeInteger(id) || id < 1))
        throw new WERR_INVALID_OPERATION('Snapshot parent mapping contains an invalid native local ID')
      const query = k(table).whereIn(key, batch)
      if (owned) void query.where({ userId })
      const actual = (await query.select(key).limit(batch.length + 1)) as Array<Record<string, number>>
      if (actual.length !== batch.length || actual.some(row => !batch.includes(row[key])))
        throw new WERR_INVALID_OPERATION('Snapshot mapped parent disappeared or belongs to another profile')
    }
  }
}

async function loadReferences(
  k: Knex,
  scope: SnapshotMapScope,
  references: SnapshotSyncPageReferences
): Promise<{ map: SyncMap; persist: () => Promise<void> }> {
  if (
    !Number.isSafeInteger(scope.userId) ||
    scope.userId < 1 ||
    typeof scope.sourceStorageIdentityKey !== 'string' ||
    scope.sourceStorageIdentityKey.length < 1 ||
    scope.sourceStorageIdentityKey.length > 256
  )
    throw new WERR_INVALID_PARAMETER('scope', 'a current single-user snapshot mapping scope')
  const { wanted, required } = references
  const map = createSyncMap()
  const known = new Map<keyof SyncMap, Set<number>>()
  await runInSeries(wanted, async ([entity, values]) => {
    await runInSeries(idBatches([...values]), async batch => {
      const found: IdRow[] = await k('snapshot_sync_ids')
        .select('incomingId', 'localId')
        .where({ ...scope, entity })
        .whereIn('incomingId', batch)
      for (const row of found) {
        // MySQL BIGINT drivers may return canonical decimal strings even for
        // safe IDs. Normalize database DATA without losing integer precision;
        // the original incoming/public metadata contract stays numeric.
        const id = (value: unknown): number => {
            const actual =
              typeof value === 'number'
                ? value
                : typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)
                  ? Number(value)
                  : Number.NaN
            if (!Number.isSafeInteger(actual) || actual < 1 || (typeof value === 'string' && String(actual) !== value))
              throw new WERR_INVALID_OPERATION('Snapshot current ID mapping differs from its scoped native rows')
            return actual
          },
          incomingId = id(row.incomingId),
          localId = id(row.localId)
        if (!batch.includes(incomingId) || map[entity].idMap[incomingId] !== undefined)
          throw new WERR_INVALID_OPERATION('Snapshot current ID mapping differs from its scoped native rows')
        map[entity].idMap[incomingId] = localId
      }
    })
    known.set(entity, new Set(Object.keys(map[entity].idMap).map(Number)))
  })
  for (const [entity, values] of required) {
    for (const id of values) {
      if (map[entity].idMap[id] === undefined)
        throw new WERR_INVALID_OPERATION('Snapshot parent mapping is missing; restart from the durable source view')
    }
  }
  return {
    map,
    async persist() {
      const additions: Array<IdRow & SnapshotMapScope> = []
      for (const [entity, values] of wanted) {
        for (const id of values) {
          const localId = map[entity].idMap[id]
          if (localId !== undefined && (!Number.isSafeInteger(localId) || localId < 1))
            throw new WERR_INVALID_OPERATION('Snapshot effect returned an invalid local ID mapping')
          if (localId !== undefined && !known.get(entity)?.has(id))
            additions.push({ ...scope, entity, incomingId: id, localId })
        }
      }
      await runInSeries(idBatches(additions), async batch => {
        await k('snapshot_sync_ids').insert(batch)
      })
    }
  }
}
