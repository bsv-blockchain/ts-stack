import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { SnapshotJournalMetadata } from './SnapshotJournalTypes'
export type { SnapshotJournalMetadata } from './SnapshotJournalTypes'
import type { SnapshotJournalPosition } from './SnapshotJournalTypes'
export type { SnapshotJournalPosition } from './SnapshotJournalTypes'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  compareSnapshotJournalRevisions,
  snapshotJournalRevision,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'
import { snapshotJournalRevisionOperand, snapshotJournalRevisionText } from './SnapshotJournalRevisionSql'

export interface SnapshotJournalInterval {
  /** Enumerate current present rows from the pinned view, without claiming
   * history below its retained floor. Only a complete scan permits mark/sweep. */
  bootstrap?: true
  stream: 'scope' | 'physical'
  tableId: number
  userId: number
  floor: SnapshotJournalRevision
  low: SnapshotJournalRevision
  high: SnapshotJournalRevision
  after?: SnapshotJournalPosition
  limit: number
}

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid snapshot journal interval or metadata')
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}

/** Source keys are exact UTF-8 bytes, independent of the source's text collation. */
function textKey(value: unknown): string {
  const text = value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : value
  if (typeof text !== 'string') invalid()
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength > 400 || bytes.toString('utf8') !== text) invalid()
  if (value instanceof Uint8Array && !bytes.equals(Buffer.from(value))) invalid()
  return text
}

function sqlite(k: Knex): boolean {
  const client = k.client.config.client
  if (client === 'sqlite3' || client === 'better-sqlite3' || isOwnedNativeSqlite(k)) return true
  if (client === 'mysql' || client === 'mysql2') return false
  throw new WERR_INVALID_OPERATION('Unsupported snapshot journal SQL driver')
}

function compare(left: SnapshotJournalPosition, right: SnapshotJournalPosition): number {
  return (
    compareSnapshotJournalRevisions(left.revision, right.revision) ||
    left.id1 - right.id1 ||
    left.id2 - right.id2 ||
    Buffer.compare(Buffer.from(left.exactText, 'utf8'), Buffer.from(right.exactText, 'utf8'))
  )
}

function validate(interval: SnapshotJournalInterval): void {
  const { stream, tableId, userId, floor, low, high, after, limit } = interval
  if (stream !== 'scope' && stream !== 'physical') invalid()
  integer(tableId, 0, 12)
  integer(userId, 1)
  integer(limit, 1, 256)
  for (const value of [floor, low, high]) snapshotJournalRevision(value)
  if (interval.bootstrap !== undefined && interval.bootstrap !== true) invalid()
  if (
    interval.bootstrap === true
      ? low !== '0' || compareSnapshotJournalRevisions(floor, high) > 0
      : compareSnapshotJournalRevisions(floor, low) > 0
  )
    invalid()
  if (compareSnapshotJournalRevisions(low, high) > 0) invalid()
  if (stream === 'physical' && tableId !== 8 && tableId !== 9) invalid()
  if (after !== undefined) {
    snapshotJournalRevision(after.revision)
    if (
      compareSnapshotJournalRevisions(after.revision, low) <= 0 ||
      compareSnapshotJournalRevisions(after.revision, high) > 0
    )
      invalid()
    integer(after.id1, tableId === 7 ? -Number.MAX_SAFE_INTEGER : 1)
    integer(after.id2, 0)
    if (typeof after.exactText !== 'string') invalid()
    textKey(after.exactText)
  }
}

/** Caller supplies the same pinned connection used for floor, high-water and payload reads. */
export function snapshotJournalMetadataQuery(k: Knex, interval: SnapshotJournalInterval): Knex.QueryBuilder {
  validate(interval)
  const local = sqlite(k)
  const table = 'snapshot_journal_' + interval.stream
  const query = k
    .from(k.raw(local ? '?? AS ?? INDEXED BY ??' : '?? AS ?? FORCE INDEX (??)', [table, 'j', table + '_page']))
    .select('j.id1', 'j.id2', 'j.exactText', 'j.present')
    .select({ revisionText: snapshotJournalRevisionText(k, 'j.revision') })
    .where('j.tableId', interval.tableId)
    .where('j.revision', '<=', snapshotJournalRevisionOperand(k, interval.high))
    .orderBy(['j.revision', 'j.id1', 'j.id2', 'j.exactText'])
    .limit(interval.limit)
  if (interval.stream === 'scope') query.where('j.userId', interval.userId)
  else query.select({ generationText: snapshotJournalRevisionText(k, 'j.generation') })
  if (interval.bootstrap === true) query.where('j.present', 1)
  const after = interval.after
  if (after === undefined) query.where('j.revision', '>', snapshotJournalRevisionOperand(k, interval.low))
  else {
    const revision = snapshotJournalRevisionOperand(k, after.revision)
    if (local) {
      query.whereRaw('(??,??,??,??) > (?,?,?,?)', [
        'j.revision',
        'j.id1',
        'j.id2',
        'j.exactText',
        revision,
        after.id1,
        after.id2,
        after.exactText
      ])
    } else {
      query.where('j.revision', '>=', revision).where(function () {
        this.where('j.revision', '>', revision)
          .orWhere(function () {
            this.where('j.revision', revision).where('j.id1', '>', after.id1)
          })
          .orWhere(function () {
            this.where('j.revision', revision).where('j.id1', after.id1).where('j.id2', '>', after.id2)
          })
          .orWhere(function () {
            this.where('j.revision', revision)
              .where('j.id1', after.id1)
              .where('j.id2', after.id2)
              .where('j.exactText', '>', Buffer.from(after.exactText, 'utf8'))
          })
      })
    }
  }
  return query
}

/** The bound applies before membership filtering, including unrelated global changes. */
export async function readSnapshotJournalMetadataPage(
  k: Knex,
  interval: SnapshotJournalInterval
): Promise<{
  rows: SnapshotJournalMetadata[]
  examined: number
  complete: boolean
  after?: SnapshotJournalPosition
}> {
  const query = snapshotJournalMetadataQuery(k, interval)
  if (interval.low === interval.high) return { rows: [], examined: 0, complete: true }
  const records: Array<Record<string, unknown>> = await query
  if (records.length > interval.limit) invalid()
  const rows = records.map(record => {
    const revision = snapshotJournalRevision(record.revisionText)
    if (
      compareSnapshotJournalRevisions(revision, interval.low) <= 0 ||
      compareSnapshotJournalRevisions(revision, interval.high) > 0
    )
      invalid()
    if (
      ![0, 1, false, true].includes(record.present as number | boolean) ||
      (interval.bootstrap === true && !(record.present === 1 || record.present === true))
    )
      invalid()
    const row: SnapshotJournalMetadata = {
      revision,
      id1: integer(record.id1, interval.tableId === 7 ? -Number.MAX_SAFE_INTEGER : 1),
      id2: integer(record.id2, 0),
      exactText: textKey(record.exactText),
      present: record.present === 1 || record.present === true
    }
    if (interval.stream === 'physical') {
      const generation = snapshotJournalRevision(record.generationText)
      if (generation === '0' || compareSnapshotJournalRevisions(generation, revision) > 0) invalid()
      row.generation = generation
    }
    return row
  })
  let previous = interval.after
  for (const row of rows) {
    if (previous !== undefined && compare(previous, row) >= 0) invalid()
    previous = row
  }
  const last = rows.at(-1)
  return {
    rows,
    examined: rows.length,
    complete: rows.length < interval.limit,
    ...(last === undefined
      ? {}
      : {
          after: {
            revision: last.revision,
            id1: last.id1,
            id2: last.id2,
            exactText: last.exactText
          }
        })
  }
}
