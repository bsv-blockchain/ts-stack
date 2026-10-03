import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { runInSeries } from '../../../utility/runInSeries'
import { lockSnapshotJournalRetention } from './SnapshotJournalReceipt'
import { reserveSnapshotJournalCaptureFence } from './SnapshotJournalCaptureFence'
import {
  compareSnapshotJournalRevisions,
  snapshotJournalRevision,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'
import { snapshotJournalRevisionOperand } from './SnapshotJournalRevisionSql'

export interface SnapshotJournalCollectionKey {
  tableId: number
  userId?: number
  id1: number
  id2: number
  exactText: string
}
export interface SnapshotJournalCollectionCursor {
  epoch: string
  floor: SnapshotJournalRevision
  stream: 'scope' | 'physical'
  key: SnapshotJournalCollectionKey
}
export interface SnapshotJournalCollectionRequest {
  epoch: string
  floor: SnapshotJournalRevision
  stream: 'scope' | 'physical'
  after?: SnapshotJournalCollectionCursor
  limit: number
}
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid snapshot journal tombstone collection state')
}
function object(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER, stored = false): number {
  if (stored && typeof value === 'string' && /^(0|[1-9]\d{0,15})$/.test(value)) value = Number(value)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid()
  return value
}
function text(value: unknown): string {
  const binary = Buffer.isBuffer(value) || value instanceof Uint8Array ? value : undefined
  const result = binary === undefined ? value : Buffer.from(binary).toString('utf8')
  if (typeof result !== 'string') return invalid()
  const bytes = Buffer.from(result, 'utf8')
  if (bytes.length > 400 || bytes.toString('utf8') !== result) return invalid()
  if (binary !== undefined && !bytes.equals(Buffer.from(binary))) return invalid()
  return result
}
function key(value: SnapshotJournalCollectionKey, stream: 'scope' | 'physical'): SnapshotJournalCollectionKey {
  if (!object(value)) return invalid()
  const result: SnapshotJournalCollectionKey = {
    tableId: integer(value.tableId, 0, 12),
    id1: integer(value.id1, 1),
    id2: integer(value.id2, 0),
    exactText: text(value.exactText)
  }
  if (stream === 'scope') result.userId = integer(value.userId, 1)
  else if (value.userId !== undefined) return invalid()
  return result
}
export function snapshotJournalCollectionRequest(
  value: SnapshotJournalCollectionRequest
): SnapshotJournalCollectionRequest {
  if (!object(value)) return invalid()
  const { epoch, stream } = value
  if (typeof epoch !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(epoch))
    return invalid()
  if (stream !== 'scope' && stream !== 'physical') return invalid()
  const result: SnapshotJournalCollectionRequest = {
    epoch,
    stream,
    floor: snapshotJournalRevision(value.floor),
    limit: integer(value.limit, 1, 256)
  }
  const after = value.after
  if (after !== undefined) {
    if (!object(after) || after.epoch !== epoch || after.floor !== result.floor || after.stream !== stream)
      return invalid()
    result.after = {
      epoch,
      stream,
      floor: result.floor,
      key: key(after.key, stream)
    }
  }
  return result
}
function local(k: Knex): boolean {
  if (['better-sqlite3', 'sqlite3'].includes(k.client.config.client)) return true
  if (['mysql2', 'mysql'].includes(k.client.config.client)) return false
  return invalid()
}
const columns = (stream: 'scope' | 'physical') =>
  stream === 'scope'
    ? (['tableId', 'userId', 'id1', 'id2', 'exactText'] as const)
    : (['tableId', 'id1', 'id2', 'exactText'] as const)
function values(
  position: SnapshotJournalCollectionKey,
  stream: 'scope' | 'physical',
  sqlite: boolean
): Array<number | string | Buffer> {
  return columns(stream).map(field =>
    field === 'exactText' && !sqlite ? Buffer.from(position.exactText, 'utf8') : position[field]!
  )
}
function seek(query: Knex.QueryBuilder, k: Knex, request: SnapshotJournalCollectionRequest): void {
  if (request.after === undefined) return
  const fields = columns(request.stream).map(field => 'j.' + field),
    operands = values(request.after.key, request.stream, local(k))
  if (local(k)) {
    query.whereRaw('(' + fields.map(() => '??').join(',') + ') > (' + fields.map(() => '?').join(',') + ')', [
      ...fields,
      ...operands
    ])
    return
  }
  // Explicit equality-prefix ranges retain every component of MySQL's primary
  // index range; do not filter by present/revision before this bounded scan.
  query.where(fields[0], '>=', operands[0]).where(function () {
    for (const [index, field] of fields.entries()) {
      this.orWhere(function () {
        for (let prefix = 0; prefix < index; prefix++) this.where(fields[prefix], operands[prefix])
        this.where(field, '>', operands[index])
      })
    }
  })
}
/** Primary-key scan bounds examined metadata, including live and newer rows. */
export function snapshotJournalCollectionQuery(k: Knex, input: SnapshotJournalCollectionRequest): Knex.QueryBuilder {
  const request = snapshotJournalCollectionRequest(input),
    sqlite = local(k),
    table = 'snapshot_journal_' + request.stream
  const hint = sqlite ? '?? AS ?? INDEXED BY ??' : '?? AS ?? FORCE INDEX (??)'
  const query = k
    .from(k.raw(hint, [table, 'j', sqlite ? 'sqlite_autoindex_' + table + '_1' : 'PRIMARY']))
    .select(
      ...columns(request.stream)
        .filter(field => field !== 'exactText')
        .map(field => 'j.' + field),
      'j.present'
    )
    .select(
      k.raw(sqlite ? "coalesce(substr(CAST(?? AS BLOB),1,401),'') AS ??" : 'substr(??,1,401) AS ??', [
        'j.exactText',
        'exactBytes'
      ])
    )
    .select(
      k.raw(sqlite ? 'substr(CAST(?? AS TEXT),1,20) AS ??' : 'substr(CAST(?? AS CHAR),1,20) AS ??', [
        'j.revision',
        'revisionText'
      ])
    )
    .orderBy(columns(request.stream).map(field => 'j.' + field))
    .limit(request.limit)
  if (sqlite) query.select(k.raw('typeof(??) AS ??', ['j.exactText', 'keyType']))
  else query.forUpdate().noWait()
  if (request.stream === 'physical')
    query.select(
      k.raw(sqlite ? 'substr(CAST(?? AS TEXT),1,20) AS ??' : 'substr(CAST(?? AS CHAR),1,20) AS ??', [
        'j.generation',
        'generationText'
      ])
    )
  seek(query, k, request)
  return query
}
interface Metadata {
  key: SnapshotJournalCollectionKey
  revision: SnapshotJournalRevision
  present: boolean
}
function metadata(row: Record<string, unknown>, stream: 'scope' | 'physical', sqlite: boolean): Metadata {
  if (sqlite && row.keyType !== 'text') return invalid()
  if (![0, 1, false, true].includes(row.present as number | boolean)) return invalid()
  const position = key(
    {
      tableId: integer(row.tableId, 0, 12, true),
      userId: stream === 'scope' ? integer(row.userId, 1, Number.MAX_SAFE_INTEGER, true) : undefined,
      id1: integer(row.id1, 1, Number.MAX_SAFE_INTEGER, true),
      id2: integer(row.id2, 0, Number.MAX_SAFE_INTEGER, true),
      exactText: text(row.exactBytes)
    },
    stream
  )
  const revision = snapshotJournalRevision(row.revisionText)
  if (revision === '0') return invalid()
  if (stream === 'physical') {
    const generation = snapshotJournalRevision(row.generationText)
    if (generation === '0' || compareSnapshotJournalRevisions(generation, revision) > 0) return invalid()
  }
  return {
    key: position,
    revision,
    present: row.present === 1 || row.present === true
  }
}
async function generation(k: Knex, epoch: string): Promise<void> {
  const query = k('snapshot_journal_generation')
    .select('id', 'version', 'complete', k.raw('substr(??,1,37) AS ??', ['epoch', 'epoch']))
    .limit(2)
  if (!local(k)) query.forUpdate().noWait()
  const rows = await query
  if (
    rows.length !== 1 ||
    rows[0].id !== 1 ||
    rows[0].version !== 1 ||
    rows[0].complete !== 1 ||
    rows[0].epoch !== epoch
  )
    return invalid()
}
function compare(
  a: SnapshotJournalCollectionKey,
  b: SnapshotJournalCollectionKey,
  stream: 'scope' | 'physical'
): number {
  for (const field of columns(stream)) {
    const order =
      field === 'exactText'
        ? Buffer.compare(Buffer.from(a.exactText, 'utf8'), Buffer.from(b.exactText, 'utf8'))
        : a[field]! - b[field]!
    if (order !== 0) return order
  }
  return 0
}
/** Internal primitive: caller validates complete owned DDL/source and excludes
 * migration before starting this fresh short transaction. It never deletes
 * source rows. A cursor binds one epoch, floor and stream; a later floor must
 * start a new pass. Complete means end of this bounded primary-key pass, not
 * physical file shrink or collection of events after that floor.
 */
export async function collectSnapshotJournalTombstones(
  k: Knex,
  input: SnapshotJournalCollectionRequest
): Promise<
  | {
      examined: number
      removed: number
      complete: boolean
      after?: SnapshotJournalCollectionCursor
    }
  | undefined
> {
  const request = snapshotJournalCollectionRequest(input)
  if (!k.isTransaction) return invalid()
  const highWater = await reserveSnapshotJournalCaptureFence(k)
  if (highWater === undefined) return undefined
  await generation(k, request.epoch)
  const retention = await lockSnapshotJournalRetention(k)
  if (retention.floor !== request.floor || compareSnapshotJournalRevisions(retention.floor, highWater) > 0)
    return invalid()
  const records: Array<Record<string, unknown>> = await snapshotJournalCollectionQuery(k, request)
  if (records.length > request.limit) return invalid()
  const rows = records.map(row => metadata(row, request.stream, local(k)))
  let previous = request.after?.key
  for (const row of rows) {
    if (previous !== undefined && compare(previous, row.key, request.stream) >= 0) return invalid()
    previous = row.key
  }
  let removed = 0
  await runInSeries(rows, async row => {
    if (row.present || compareSnapshotJournalRevisions(row.revision, request.floor) > 0) return
    const fields = columns(request.stream),
      operands = values(row.key, request.stream, local(k))
    const query = k('snapshot_journal_' + request.stream)
      .where('present', 0)
      .where('revision', snapshotJournalRevisionOperand(k, row.revision))
    for (const [index, field] of fields.entries()) query.where(field, operands[index])
    if ((await query.delete()) !== 1) return invalid()
    removed++
  })
  return {
    examined: rows.length,
    removed,
    complete: rows.length < request.limit,
    ...(previous === undefined
      ? {}
      : {
          after: {
            epoch: request.epoch,
            stream: request.stream,
            floor: request.floor,
            key: previous
          }
        })
  }
}
