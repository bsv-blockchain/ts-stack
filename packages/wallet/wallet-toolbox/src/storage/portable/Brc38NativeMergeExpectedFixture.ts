import {
  copyIndependentNativeInventory,
  type IndependentNativeInventory
} from './Brc38IndependentNativeInventoryFixture'
import { composedArchivePostimage, type ComposedSemanticFixture } from './Brc38ComposedSemanticFixture'
import type { BRC38WalletData } from './index'

/** Independent small-model JSON bytes. Emit sorted keys directly: rebuilding
 * an object before JSON.stringify reorders integer names numerically. No
 * production encoder or candidate output supplies this expected spelling. */
export function nativeMergeExpectedJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(nativeMergeExpectedJson).join(',') + ']'
  if (value === null || typeof value !== 'object') {
    const scalar = JSON.stringify(value)
    if (scalar === undefined) throw new Error('Independent native expected JSON requires serializable data')
    return scalar
  }
  return (
    '{' +
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, child]) => JSON.stringify(name) + ':' + nativeMergeExpectedJson(child))
      .join(',') +
    '}'
  )
}
function dateCell(original: unknown, supplied: unknown): unknown {
  if (typeof supplied !== 'string') throw new Error('Independent native merge date must be an ISO string')
  const value = Date.parse(supplied)
  if (!Number.isSafeInteger(value)) throw new Error('Independent native merge date differs')
  if (typeof original === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(original))
    return new Date(value).toISOString()
  if (typeof original === 'bigint') return BigInt(value)
  if (typeof original === 'number') return value
  throw new Error('Independent native fixture requires its original SQLite date encoding')
}

/** Declare this occupied small graph before any merge. The independent
 * archive model supplies only the transaction and operational checkpoint
 * changes; all other typed metadata and full logical bytes in all47 tables
 * remain the separately captured serving-source preimage. Neither a candidate
 * nor any production merge/inventory result supplies expected values. */
export function nativeMergeExpectedFixture(
  initial: IndependentNativeInventory,
  before: ComposedSemanticFixture,
  incoming: BRC38WalletData
): ReturnType<typeof copyIndependentNativeInventory> {
  const expected = copyIndependentNativeInventory(initial),
    semantic = composedArchivePostimage(before, incoming)
  if (
    expected.transactions.length !== 1 ||
    expected.sync_states.length !== 1 ||
    semantic.transactions.length !== 1 ||
    semantic.sync_states.length !== 1
  )
    throw new Error('Independent occupied native oracle requires its original one-row graph')
  const transaction = expected.transactions[0],
    tx = semantic.transactions[0],
    checkpoint = expected.sync_states[0],
    sync = semantic.sync_states[0]
  expected.transactions[0] = {
    ...transaction,
    metadata: { ...transaction.metadata, updated_at: dateCell(transaction.metadata.updated_at, tx.updated_at) },
    fields: { ...transaction.fields, description: Buffer.from(String(tx.description), 'utf8') }
  }
  expected.sync_states[0] = {
    ...checkpoint,
    metadata: {
      ...checkpoint.metadata,
      storageName: sync.storageName,
      updated_at: dateCell(checkpoint.metadata.updated_at, sync.updated_at),
      when: sync.when === null ? null : dateCell(checkpoint.metadata.when ?? checkpoint.metadata.updated_at, sync.when)
    },
    fields: { ...checkpoint.fields, syncMap: Buffer.from(nativeMergeExpectedJson(sync.syncMap), 'utf8') }
  }
  return expected
}

/** Independently fixed deleted-high1600 reservation and one fresh basket per
 * episode. Retained consumed IDs are never reused after refolding. */
export function nativeMergeNewBasketExpectedFixture(
  initial: IndependentNativeInventory,
  before: ComposedSemanticFixture,
  incoming: BRC38WalletData,
  episode: 0 | 1
): ReturnType<typeof copyIndependentNativeInventory> {
  const expected = nativeMergeExpectedFixture(initial, before, incoming),
    incomingBasket = incoming.tables.outputBaskets[1],
    localId = 1601 + episode,
    old = expected.output_baskets[0],
    sync = expected.sync_states[0]
  if (
    incoming.tables.outputBaskets.length !== 2 ||
    incomingBasket.basketId !== 113 ||
    incomingBasket.name !== 'independent new basket' ||
    old === undefined ||
    sync.fields.syncMap === null
  )
    throw new Error('Independent new-basket fixture differs from its authored reservation')
  const integer = (oldValue: unknown, value: number): number | bigint => {
    if (typeof oldValue === 'bigint') return BigInt(value)
    if (typeof oldValue === 'number') return value
    throw new Error('Independent basket fixture requires its original integer types')
  }
  expected.output_baskets.push({
    rowId: localId,
    fields: {},
    metadata: {
      ...old.metadata,
      basketId: integer(old.metadata.basketId, localId),
      name: incomingBasket.name,
      created_at: dateCell(old.metadata.created_at, incomingBasket.created_at),
      updated_at: dateCell(old.metadata.updated_at, incomingBasket.updated_at),
      numberOfDesiredUTXOs: integer(old.metadata.numberOfDesiredUTXOs, 7),
      minimumDesiredUTXOValue: integer(old.metadata.minimumDesiredUTXOValue, 11),
      isDeleted: integer(old.metadata.isDeleted, 0)
    }
  })
  const map = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sync.fields.syncMap)) as Record<
    string,
    { idMap: Record<string, number> }
  >
  if (map.outputBasket?.idMap === undefined)
    throw new Error('Independent original operational map omitted its basket entity')
  map.outputBasket.idMap['113'] = localId
  expected.sync_states[0] = {
    ...sync,
    fields: { ...sync.fields, syncMap: Buffer.from(nativeMergeExpectedJson(map), 'utf8') }
  }
  return expected
}
