import type { Knex } from 'knex'
import type { SyncMap } from '../schema/entities/EntityBase'
import type { Brc38StageTable } from './Brc38SemanticStage'
import { requireBrc38ImportSqliteTransaction } from './Brc38ImportJournalSchema'
import {
  brc38ImportTargetIndexes,
  brc38ImportTargetIndexName,
  verifyBrc38ImportTargetIndexes,
  type Brc38ImportTargetIndex
} from './Brc38ImportTargetIndexes'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { runInSeries } from '../../utility/runInSeries'

type Key = Readonly<Record<string, string | number>>
interface Form {
  readonly id?: string
  readonly entity?: keyof SyncMap
  readonly owned?: boolean
  readonly strings: readonly string[]
  readonly parents?: readonly [keyof SyncMap, string, boolean][]
}
const forms: Readonly<Record<Brc38StageTable, Form>> = {
  provenTxs: { id: 'provenTxId', entity: 'provenTx', strings: ['txid'] },
  outputBaskets: { id: 'basketId', entity: 'outputBasket', owned: true, strings: ['name'] },
  outputTags: { id: 'outputTagId', entity: 'outputTag', owned: true, strings: ['tag'] },
  txLabels: { id: 'txLabelId', entity: 'txLabel', owned: true, strings: ['label'] },
  transactions: {
    id: 'transactionId',
    entity: 'transaction',
    owned: true,
    strings: [],
    parents: [['provenTx', 'provenTxId', true]]
  },
  outputs: {
    id: 'outputId',
    entity: 'output',
    owned: true,
    strings: [],
    parents: [
      ['transaction', 'transactionId', false],
      ['transaction', 'spentBy', true],
      ['outputBasket', 'basketId', true]
    ]
  },
  txLabelMaps: {
    strings: [],
    parents: [
      ['txLabel', 'txLabelId', false],
      ['transaction', 'transactionId', false]
    ]
  },
  outputTagMaps: {
    strings: [],
    parents: [
      ['outputTag', 'outputTagId', false],
      ['output', 'outputId', false]
    ]
  },
  certificates: {
    id: 'certificateId',
    entity: 'certificate',
    owned: true,
    strings: ['certifier', 'serialNumber']
  },
  certificateFields: {
    owned: true,
    strings: ['fieldName'],
    parents: [['certificate', 'certificateId', false]]
  },
  commissions: {
    id: 'commissionId',
    entity: 'commission',
    owned: true,
    strings: [],
    parents: [['transaction', 'transactionId', false]]
  },
  provenTxReqs: {
    id: 'provenTxReqId',
    entity: 'provenTxReq',
    strings: ['txid'],
    parents: [['provenTx', 'provenTxId', true]]
  },
  syncStates: { id: 'syncStateId', owned: true, strings: ['storageIdentityKey', 'storageName'] }
}
const parents = {
  provenTx: ['proven_txs', 'provenTxId', false],
  transaction: ['transactions', 'transactionId', true],
  outputBasket: ['output_baskets', 'basketId', true],
  outputTag: ['output_tags', 'outputTagId', true],
  txLabel: ['tx_labels', 'txLabelId', true],
  output: ['outputs', 'outputId', true],
  certificate: ['certificates', 'certificateId', true]
} as const
export interface Brc38ImportEntityTarget {
  readonly table: Brc38StageTable
  readonly found: boolean
  /** Composite entities have a key, not a fabricated numeric ID. Zero is valid. */
  readonly localId?: number
  readonly key: Key
  readonly index: Brc38ImportTargetIndex
}
function invalid(): never {
  throw new Error('Private import target identity or parent ownership is inconsistent')
}
function string(value: unknown): string {
  if (typeof value !== 'string') invalid()
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid()
  return value
}
function mapped(map: SyncMap, entity: keyof SyncMap, incoming: unknown): number {
  if (typeof incoming !== 'number' || !Number.isInteger(incoming)) invalid()
  const ids = map[entity].idMap
  if (!Object.hasOwn(ids, incoming)) invalid()
  return integer(ids[incoming])
}
async function requireParent(
  trx: Knex.Transaction,
  entity: keyof typeof parents,
  id: number,
  userId: number
): Promise<void> {
  const [table, field, owned] = parents[entity],
    key = owned ? { [field]: id, userId } : { [field]: id },
    rows: Array<{ found: number }> = await trx(table).where(key).select(trx.raw('1 AS found')).limit(2)
  if (rows.length !== 1) invalid()
}
function extent(key: Key, remaining: number, maximum: number, signal?: AbortSignal): number {
  for (const chunk of canonicalPortableChunks(key, {
    maximumValueBytes: maximum,
    maximumChunkBytes: 4096,
    signal
  })) {
    if (chunk.byteLength > remaining)
      throw new SnapshotResourceLimitError('Private import target keys exceed their fixed page byte budget')
    remaining -= chunk.byteLength
  }
  return remaining
}
function selection(trx: Knex.Transaction, index: Brc38ImportTargetIndex, key: Key): Knex.QueryBuilder {
  const [table] = brc38ImportTargetIndexes[index]
  // INDEXED BY is mandatory. A missing migration never falls back to a scan.
  return trx
    .from(trx.raw('?? INDEXED BY ??', [table, brc38ImportTargetIndexName(index, trx)]))
    .where(key)
    .limit(2)
}
async function find(
  trx: Knex.Transaction,
  table: Brc38StageTable,
  index: Brc38ImportTargetIndex,
  key: Key
): Promise<Brc38ImportEntityTarget> {
  const id = forms[table].id,
    query = selection(trx, index, key),
    rows: Array<{ localId: number }> = await query.select(
      id === undefined
        ? trx.raw('1 AS localId')
        : trx.raw("CASE WHEN typeof(??) = 'integer' AND ?? BETWEEN ? AND ? THEN ?? ELSE NULL END AS localId", [
            id,
            id,
            -Number.MAX_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER,
            id
          ])
    )
  if (rows.length > 1) invalid()
  const target: Brc38ImportEntityTarget = {
    table,
    index,
    key: Object.freeze({ ...key }),
    found: rows.length === 1,
    ...(id === undefined || rows.length === 0 ? {} : { localId: integer(rows[0].localId) })
  }
  return Object.freeze(target)
}
async function baseKey(
  trx: Knex.Transaction,
  table: Brc38StageTable,
  row: Readonly<Record<string, unknown>>,
  map: SyncMap,
  userId: number
): Promise<Key> {
  const form = forms[table],
    key: Record<string, string | number> = form.owned === true ? { userId } : {}
  for (const field of form.strings) key[field] = string(row[field])
  await runInSeries(form.parents ?? [], async ([entity, field, optional]) => {
    if (optional && row[field] === undefined) return
    const id = mapped(map, entity, row[field])
    if (!Object.hasOwn(parents, entity)) invalid()
    await requireParent(trx, entity as keyof typeof parents, id, userId)
    if (brc38ImportTargetIndexes[table][1].some(value => value === field)) key[field] = id
  })
  if (table === 'outputs') key.vout = integer(row.vout)
  return key
}
async function transactionTarget(
  trx: Knex.Transaction,
  row: Readonly<Record<string, unknown>>,
  userId: number,
  charge: (key: Key) => void
): Promise<Brc38ImportEntityTarget> {
  let missed: Brc38ImportEntityTarget | undefined
  if (row.txid !== undefined && string(row.txid) !== '') {
    const key = { userId, txid: string(row.txid) }
    charge(key)
    const target = await find(trx, 'transactions', 'transactions', key)
    if (target.found) return target
    missed = target
  }
  if (string(row.reference) !== '') {
    const key = { userId, reference: string(row.reference) }
    charge(key)
    return await find(trx, 'transactions', 'transactionReference', key)
  }
  return (
    missed ??
    Object.freeze({
      table: 'transactions',
      index: 'transactionReference',
      key: Object.freeze({ userId, reference: '' }),
      found: false
    })
  )
}
function checkOwnMapping(
  table: Brc38StageTable,
  row: Readonly<Record<string, unknown>>,
  map: SyncMap,
  target: Brc38ImportEntityTarget
): void {
  const { entity, id } = forms[table]
  if (entity === undefined || id === undefined) return
  const incoming = row[id]
  if (typeof incoming !== 'number' || !Number.isInteger(incoming)) invalid()
  const ids = map[entity].idMap
  if (Object.hasOwn(ids, incoming) && (!target.found || integer(ids[incoming]) !== target.localId)) invalid()
}
/** Identity selection needs only metadata. Streamed callers never fabricate a
 * complete entity DTO to select natural keys while large fields stay separate. */
export type Brc38ImportTargetData =
  | { readonly kind: 'header' }
  | {
      readonly kind: 'table'
      readonly table: Brc38StageTable
      readonly rows: readonly Readonly<object>[]
    }
/** Internal read-only preparation under the actual authenticated owner's pinned
 * destination. Reads identities only: no payloads, proof reconstruction, entity
 * writes, map persistence, provenance storage or activation authorization. */
export async function prepareBrc38ImportEntityTargets(
  trx: Knex.Transaction,
  userId: number,
  data: Brc38ImportTargetData,
  map: SyncMap,
  maximumKeyBytes: number,
  signal?: AbortSignal
): Promise<readonly Brc38ImportEntityTarget[]> {
  requireBrc38ImportSqliteTransaction(trx)
  integer(userId)
  if (!Number.isSafeInteger(maximumKeyBytes) || maximumKeyBytes < 1 || maximumKeyBytes > 16777216)
    throw new RangeError('Invalid fixed private import target key budget')
  signal?.throwIfAborted()
  const mode: Array<{ query_only: number }> = await trx.raw('PRAGMA query_only')
  if (mode.length !== 1 || mode[0].query_only !== 1)
    throw new Error('Private import target preparation requires query-only ownership')
  await verifyBrc38ImportTargetIndexes(trx)
  if (data.kind === 'header') return Object.freeze([])
  if (data.rows.length > 4096) throw new SnapshotResourceLimitError('Private import target page exceeds 4096 rows')
  let remaining = maximumKeyBytes
  const charge = (key: Key): void => {
      remaining = extent(key, remaining, maximumKeyBytes, signal)
    },
    prepared: Brc38ImportEntityTarget[] = []
  await runInSeries<Readonly<object>, void>(data.rows, async input => {
    signal?.throwIfAborted()
    const row = input as unknown as Readonly<Record<string, unknown>>,
      key = await baseKey(trx, data.table, row, map, userId)
    let target: Brc38ImportEntityTarget
    if (data.table === 'transactions') target = await transactionTarget(trx, row, userId, charge)
    else {
      charge(key)
      target = await find(trx, data.table, data.table, key)
    }
    checkOwnMapping(data.table, row, map, target)
    prepared.push(target)
  })
  signal?.throwIfAborted()
  return Object.freeze(prepared)
}
