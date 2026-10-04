import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { RetainedReadSnapshot } from '../snapshot/RetainedReadSnapshot'
import type { WalletReadSnapshotOptions, WalletSnapshotTable } from '../snapshot/WalletReadSnapshot'
import { walletSnapshotSourceQuery } from '../snapshot/KnexWalletReadSnapshot'
import { readKnexSnapshotArchiveHeader } from '../snapshot/archive/KnexSnapshotArchiveSource'
import { assertKnexSnapshotArchiveClosure } from '../snapshot/archive/KnexSnapshotArchiveClosure'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { projectBrc38PackedRow } from './Brc38PackedRow'
import type { BRC38Tables } from './index'
import type { Brc38StreamSource } from './Brc38Stream'

type Row = BRC38Tables[WalletSnapshotTable][number]
interface SourceRow {
  row: Row
  ordinal?: bigint
}
interface Definition {
  name: string
  keys: readonly string[]
  booleans?: readonly string[]
  dates?: readonly string[]
}
const definitions: Record<WalletSnapshotTable, Definition> = {
  provenTxs: { name: 'proven_txs', keys: ['provenTxId'] },
  provenTxReqs: { name: 'proven_tx_reqs', keys: ['provenTxReqId'], booleans: ['notified'] },
  outputBaskets: { name: 'output_baskets', keys: ['basketId'], booleans: ['isDeleted'] },
  transactions: { name: 'transactions', keys: ['transactionId'], booleans: ['isOutgoing'] },
  commissions: { name: 'commissions', keys: ['commissionId'], booleans: ['isRedeemed'] },
  outputs: { name: 'outputs', keys: ['outputId'], booleans: ['spendable', 'change'] },
  outputTags: { name: 'output_tags', keys: ['outputTagId'], booleans: ['isDeleted'] },
  outputTagMaps: { name: 'output_tags_map', keys: ['outputId', 'outputTagId'], booleans: ['isDeleted'] },
  txLabels: { name: 'tx_labels', keys: ['txLabelId'], booleans: ['isDeleted'] },
  txLabelMaps: { name: 'tx_labels_map', keys: ['transactionId', 'txLabelId'], booleans: ['isDeleted'] },
  certificates: { name: 'certificates', keys: ['certificateId'], booleans: ['isDeleted'] },
  certificateFields: { name: 'certificate_fields', keys: ['certificateId', 'fieldName'] },
  syncStates: { name: 'sync_states', keys: ['syncStateId'], booleans: ['init'], dates: ['when'] }
}
export interface Brc38KnexSourceOptions extends WalletReadSnapshotOptions {
  maximumPageRows: number
  maximumPageBytes: number
  maximumRowAllocationBytes: number
  /** Allocation charge of detached rows retained for one locale-sorted certificate. */
  maximumCertificateGroupBytes: number
  maximumMetadataAllocationBytes?: number
}
function bound(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`)
}
function definition(table: WalletSnapshotTable): Definition {
  if (!Object.hasOwn(definitions, table)) throw new TypeError('Unknown BRC-38 source table')
  return definitions[table]
}
async function columns(k: Knex, name: string, mysql: boolean): Promise<string[]> {
  if (mysql) {
    const [rows]: Array<Array<{ name: string }>> = await k.raw(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT 65',
      [name]
    )
    return rows.map(row => row.name)
  }
  const rows: Array<{ name: string }> = await k.raw('SELECT name FROM pragma_table_info(?) LIMIT 65', [name])
  return rows.map(row => row.name)
}
function size(k: Knex, schema: Definition, fields: readonly string[], mysql: boolean): Knex.Raw {
  const length = mysql ? 'octet_length(??)' : 'length(cast(?? as blob))'
  const cell = `64 + 2 * coalesce(${length}, 0)`
  return k.raw(`(${fields.map(() => cell).join(' + ')}) as ??`, [
    ...fields.map(field => `${schema.name}.${field}`),
    '__portableBytes'
  ])
}
function seek(query: Knex.QueryBuilder, keys: readonly string[], after: readonly (number | string)[]): void {
  void query.where(function () {
    for (let index = 0; index < keys.length; index++) {
      void this.orWhere(function () {
        for (let preceding = 0; preceding < index; preceding++) void this.where(keys[preceding], after[preceding])
        void this.where(keys[index], '>', after[index])
      })
    }
  })
}
function sourceKey(value: unknown, key: string): { value: number | string } {
  if (key === 'fieldName') {
    if (typeof value !== 'string' || value.length > 200 || Array.from(value).length > 100)
      throw new TypeError('Invalid BRC-38 source field name')
    return { value }
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new TypeError('Invalid BRC-38 source numeric key')
  return { value }
}
function position(row: Record<string, unknown>, keys: readonly string[]): Array<number | string> {
  return keys.map(key => sourceKey(row[key], key).value)
}
function selectedPrefix(candidates: Array<Record<string, unknown>>, maximum: number): number {
  let bytes = 0,
    count = 0
  for (const row of candidates) {
    const charged = Number(row.__portableBytes)
    if (!Number.isSafeInteger(charged) || charged < 0) throw new TypeError('Invalid BRC-38 stored row charge')
    if (charged > maximum - bytes) {
      if (count === 0) throw new SnapshotResourceLimitError('BRC-38 source row exceeds its page allocation policy')
      break
    }
    bytes += charged
    count++
  }
  return count
}
function normalized(storage: StorageKnex, schema: Definition, raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(raw)) {
    const value = raw[key]
    if (schema.booleans?.includes(key)) {
      if (value !== undefined) result[key] = value !== 0 && value !== null && value !== false
      continue
    }
    if (value == null) continue
    if (key === 'created_at' || key === 'updated_at' || schema.dates?.includes(key))
      result[key] = storage.validateDate(value as Date)
    else result[key] = value
  }
  return result
}
interface PageContext {
  storage: StorageKnex
  userId: number
  fields: Map<WalletSnapshotTable, string[]>
  options: Readonly<Brc38KnexSourceOptions>
}
async function page(context: PageContext, k: Knex, table: WalletSnapshotTable, after?: readonly (number | string)[]) {
  const { storage, userId, fields, options } = context,
    schema = definition(table),
    mysql = storage.dbtype === 'MySQL'
  let names = fields.get(table)
  if (names === undefined) {
    names = await columns(k, schema.name, mysql)
    if (names.length < 1 || names.length > 64) throw new TypeError('Unsupported BRC-38 source schema')
    fields.set(table, names)
  }
  const keys = schema.keys.map(key => `${schema.name}.${key}`)
  const query = () => {
    const selected = walletSnapshotSourceQuery(k, table, userId)
    if (after !== undefined) seek(selected, keys, after)
    for (const key of keys) void selected.orderBy(key)
    return selected
  }
  // Field-name payloads are bounded in SQL before reaching the driver, just
  // like blob/history lengths. No whole-table row or ID map is materialized.
  const fieldLength = mysql ? 'octet_length(??)' : 'length(cast(?? as blob))'
  const keyColumns = schema.keys.map(key =>
    key === 'fieldName'
      ? k.raw(`case when ${fieldLength} <= 400 then ?? end as ??`, [
          `${schema.name}.${key}`,
          `${schema.name}.${key}`,
          key
        ])
      : `${schema.name}.${key}`
  )
  const candidates: Array<Record<string, unknown>> = await query()
    .select(...keyColumns, size(k, schema, names, mysql))
    .limit(options.maximumPageRows)
  const count = selectedPrefix(candidates, options.maximumPageBytes)
  if (count === 0) return { rows: [] as SourceRow[], after: undefined, done: true }
  const last = position(candidates[count - 1], schema.keys)
  const payload = query().select(`${schema.name}.*`).limit(count)
  const sqliteOrdinal = table === 'certificateFields' && !mysql
  if (sqliteOrdinal) {
    if (names.some(name => ['_rowid_', '__portableordinal'].includes(name.toLowerCase())))
      throw new TypeError('Unsupported BRC-38 certificate source ordinal schema')
    // The original unpaged SQLite finder retains rowid scan order for locale
    // ties. Keep its exact signed 64-bit ordinal private, as text before it
    // crosses the driver; never place this key in portable archive bytes.
    void payload.select(k.raw('cast(?? as text) as ??', [`${schema.name}._rowid_`, '__portableOrdinal']))
  }
  const raw: Array<Record<string, unknown>> = await payload
  if (raw.length !== count) throw new Error('BRC-38 retained source prefix changed')
  const rows = raw.map(value => {
    let ordinal: bigint | undefined
    if (sqliteOrdinal) {
      const text = value.__portableOrdinal
      if (typeof text !== 'string' || !/^-?\d{1,19}$/.test(text))
        throw new TypeError('Invalid BRC-38 certificate source ordinal')
      ordinal = BigInt(text)
      delete value.__portableOrdinal
    }
    const row = projectBrc38PackedRow(table, normalized(storage, schema, value), {
      maximumAllocationBytes: options.maximumRowAllocationBytes,
      signal: options.signal
    })
    return { row, ordinal }
  })
  return { rows, after: last, done: count === candidates.length && candidates.length < options.maximumPageRows }
}
function rowCharge(value: Row): number {
  // Certificate-field rows contain only scalars in the native table. Refuse a
  // schema extension here until its bounded grouping contract is reviewed.
  let bytes = 64
  for (const [key, child] of Object.entries(value)) {
    bytes += 64 + 2 * key.length
    if (typeof child === 'string') bytes += 64 + 2 * child.length
    else if (typeof child === 'number' || typeof child === 'boolean') bytes += 64
    else throw new TypeError('Unsupported BRC-38 certificate-field grouping value')
  }
  return bytes
}
function certificateOrder(first: SourceRow, second: SourceRow): number {
  if (typeof first.row.fieldName !== 'string' || typeof second.row.fieldName !== 'string')
    throw new TypeError('Invalid certificate field name')
  const compared = first.row.fieldName.localeCompare(second.row.fieldName)
  if (compared !== 0 || first.ordinal === undefined || second.ordinal === undefined) return compared
  if (first.ordinal < second.ordinal) return -1
  if (first.ordinal > second.ordinal) return 1
  return 0
}
async function* grouped(rows: AsyncIterable<SourceRow>, maximum: number): AsyncGenerator<Row> {
  let id: unknown,
    bytes = 0,
    group: SourceRow[] = []
  function* ordered() {
    group.sort(certificateOrder)
    for (const source of group) yield source.row
  }
  for await (const source of rows) {
    const row = source.row
    if (group.length > 0 && row.certificateId !== id) {
      yield* ordered()
      group = []
      bytes = 0
    }
    id = row.certificateId
    const charge = 128 + rowCharge(row)
    if (charge > maximum - bytes)
      throw new SnapshotResourceLimitError('BRC-38 certificate group exceeds its allocation policy')
    bytes += charge
    group.push(source)
  }
  yield* ordered()
}
/** Coherent SQL source. Supply a dedicated reader provider so an idle
 * file consumer does not occupy the foreground/writer pool. All metadata,
 * closure checks and thirteen keyset streams own the same retained transaction.
 * Portable order may need different SQL indexes; no performance or capability
 * claim is made by constructing this source. SQLite locale ties retain the
 * original rowid order; other provider collation still requires qualification. */
export async function openBrc38KnexSource(
  storage: StorageKnex,
  identityKey: string,
  selected: Brc38KnexSourceOptions
): Promise<Brc38StreamSource> {
  const options = Object.freeze({ ...selected })
  bound(options.maximumPageRows, 1000, 'maximumPageRows')
  bound(options.maximumPageBytes, 16777216, 'maximumPageBytes')
  bound(options.maximumRowAllocationBytes, 16777216, 'maximumRowAllocationBytes')
  bound(options.maximumCertificateGroupBytes, 16777216, 'maximumCertificateGroupBytes')
  bound(options.maximumMetadataAllocationBytes ?? 65536, 65536, 'maximumMetadataAllocationBytes')
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(identityKey)) throw new TypeError('Compressed profile identity required')
  options.signal?.throwIfAborted()
  const view: RetainedReadSnapshot = await storage.openReadSnapshot(options)
  let closed: Promise<void> | undefined
  const release = () => {
    closed ??= Promise.resolve().then(() => view.close())
    return closed
  }
  try {
    const header = await view.read(trx => readKnexSnapshotArchiveHeader(storage, identityKey, storage.toDb(trx)))
    const userId = header.header.user.userId
    // Closure uses the exact same direct profile predicates as the portable
    // reader; auxiliary-index membership cannot conceal an exported orphan.
    const closure = () => view.read(trx => assertKnexSnapshotArchiveClosure(storage.toDb(trx), userId))
    await closure()
    const metadataPolicy = {
      maximumAllocationBytes: options.maximumMetadataAllocationBytes ?? 65536,
      signal: options.signal
    }
    const sourceStorage = projectBrc38PackedRow('sourceStorage', header.header.sourceStorage, metadataPolicy)
    const user = projectBrc38PackedRow('user', header.header.user, metadataPolicy)
    if (user.identityKey !== identityKey || sourceStorage.chain !== storage.chain)
      throw new Error('BRC-38 source profile or network changed')
    const context: PageContext = { storage, userId, fields: new Map(), options }
    const completed = new Set<WalletSnapshotTable>()
    let reading = false
    async function* rawRows(table: WalletSnapshotTable) {
      let after: readonly (number | string)[] | undefined,
        done = false
      const pages = {
        [Symbol.asyncIterator]() {
          return this
        },
        async next() {
          if (done) return { done: true as const, value: undefined }
          options.signal?.throwIfAborted()
          const result = await view.read(trx => page(context, storage.toDb(trx), table, after))
          done = result.done
          if (!done && result.after === undefined) throw new Error('BRC-38 source failed to advance')
          after = result.after
          return { done: false as const, value: result }
        }
      }
      for await (const result of pages) yield* result.rows
    }
    return Object.freeze({
      sourceStorage,
      user,
      async *rows(table: WalletSnapshotTable) {
        definition(table)
        if (reading || completed.has(table)) throw new Error('BRC-38 source requires one complete read of each table')
        reading = true
        try {
          const rows = rawRows(table)
          if (table === 'certificateFields') yield* grouped(rows, options.maximumCertificateGroupBytes)
          else for await (const source of rows) yield source.row
          completed.add(table)
        } finally {
          reading = false
        }
      },
      async validateCompleted() {
        if (reading || completed.size !== 13) throw new Error('BRC-38 source tables did not complete')
        options.signal?.throwIfAborted()
        await closure()
      },
      release
    })
  } catch (error) {
    try {
      await release()
    } catch (error_) {
      if (error_ === error) throw error
      throw new AggregateError([error, error_], 'BRC-38 source opening and physical cleanup failed', { cause: error })
    }
    throw error
  }
}
