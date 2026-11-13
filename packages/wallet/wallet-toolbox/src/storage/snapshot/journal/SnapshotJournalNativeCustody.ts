import type { SnapshotJournalFieldDescriptor } from './SnapshotJournalFieldTypes'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { snapshotJournalRevision, compareSnapshotJournalRevisions } from './SnapshotJournalRevision'
import { snapshotJournalReceiptPolicy } from './SnapshotJournalReceipt'
import { readSnapshotJournalSqliteGeneration } from './SnapshotJournalSqliteGeneration'
import { readSnapshotJournalMysqlGeneration } from './SnapshotJournalMysqlGeneration'
import { readSnapshotJournalNativeOwnedRow, type SnapshotJournalAllocationBudget } from './SnapshotJournalNativeRows'
import type { SnapshotJournalLocalKey } from './SnapshotJournalMemberships'

export interface SnapshotJournalNativeCustody {
  tableId: number
  local: SnapshotJournalLocalKey
  fingerprint: string
  generation: string
}
export interface SnapshotJournalNativeCustodyResult extends SnapshotJournalNativeCustody {
  key: Readonly<Record<string, string | number>>
  row: Readonly<Record<string, unknown>>
  fields?: Readonly<Record<string, Readonly<SnapshotJournalFieldDescriptor>>>
}
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Native journal custody no longer matches the actual destination')
}

/** Fresh physical generation and complete source ownership are observed in the
 * same destination writer as the raw postimage. The returned data are not an
 * authority token; cleanup repeats this read before deciding on a native row. */
export async function readSnapshotJournalNativeCustody(
  k: Knex,
  tableId: number,
  userId: number,
  local: SnapshotJournalLocalKey,
  allocation: SnapshotJournalAllocationBudget
): Promise<SnapshotJournalNativeCustodyResult | undefined> {
  if (!k.isTransaction) invalid()
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  if (!mysql && !['sqlite3', 'better-sqlite3'].includes(String(k.client.config.client)) && !isOwnedNativeSqlite(k))
    invalid()
  // Custody callers may pass a structural membership/retirement record. Only
  // the physical three-cell key identifies the row; bookkeeping must not alter
  // its generation hash or escape into returned parent identity coordinates.
  local = { id1: local.id1, id2: local.id2, exactText: local.exactText }
  const actual = await readSnapshotJournalNativeOwnedRow(k, tableId, userId, local, allocation)
  if (actual === undefined) return undefined
  const policyRows: Array<{ receiptLimit: unknown; receiptLifetimeMs: unknown }> = await k('snapshot_journal_retention')
    .where('id', 1)
    .select('receiptLimit', 'receiptLifetimeMs')
    .limit(2)
  const clocks: Array<{ ceiling: unknown }> = await k('snapshot_journal_clock')
    .where('id', 1)
    .select(k.raw(mysql ? 'CAST(ceiling AS CHAR) AS ceiling' : 'CAST(ceiling AS TEXT) AS ceiling'))
    .limit(2)
  if (policyRows.length !== 1 || clocks.length !== 1) invalid()
  const policy = snapshotJournalReceiptPolicy({
    receiptLimit: Number(policyRows[0].receiptLimit),
    receiptLifetimeMs: Number(policyRows[0].receiptLifetimeMs)
  })
  const ceiling = snapshotJournalRevision(clocks[0].ceiling)
  const source = mysql
    ? await readSnapshotJournalMysqlGeneration(k, ceiling, policy, k.client.config.migrations)
    : await readSnapshotJournalSqliteGeneration(k, policy, k.client.config.migrations)
  if (!source.complete || !source.enabled) invalid()
  const rows: Array<{ generation: unknown; revision: unknown; present: unknown }> = await k('snapshot_journal_physical')
    .where({
      tableId,
      id1: local.id1,
      id2: local.id2,
      exactText: mysql ? Buffer.from(local.exactText, 'utf8') : local.exactText
    })
    .select(
      'present',
      k.raw(mysql ? 'CAST(generation AS CHAR) AS generation' : 'CAST(generation AS TEXT) AS generation'),
      k.raw(mysql ? 'CAST(revision AS CHAR) AS revision' : 'CAST(revision AS TEXT) AS revision')
    )
    .limit(2)
  if (rows.length !== 1 || ![1, true].includes(rows[0].present as number | boolean)) invalid()
  const generation = snapshotJournalRevision(rows[0].generation),
    revision = snapshotJournalRevision(rows[0].revision)
  if (
    generation === '0' ||
    compareSnapshotJournalRevisions(generation, revision) > 0 ||
    compareSnapshotJournalRevisions(revision, ceiling) > 0
  )
    invalid()
  return {
    tableId,
    local: { ...local },
    ...actual,
    generation: createHash('sha256')
      .update('snapshot-journal-native-custody-v1\n')
      .update(JSON.stringify([source.source, source.epoch, tableId, local, generation]))
      .digest('hex')
  }
}

/** Fixed native relationships, read from the actual merged destination row.
 * Parent generation/postimage custody prevents cleanup through reused IDs. */
export async function readSnapshotJournalNativeParents(
  k: Knex,
  actual: SnapshotJournalNativeCustodyResult,
  userId: number,
  allocation: SnapshotJournalAllocationBudget
): Promise<SnapshotJournalNativeCustody[]> {
  const forms: Readonly<Record<number, readonly (readonly [number, string])[]>> = {
    0: [[8, 'provenTxId']],
    1: [
      [0, 'transactionId'],
      [0, 'spentBy'],
      [4, 'basketId']
    ],
    6: [[0, 'transactionId']],
    9: [[8, 'provenTxId']],
    10: [
      [3, 'txLabelId'],
      [0, 'transactionId']
    ],
    11: [
      [5, 'outputTagId'],
      [1, 'outputId']
    ],
    12: [[2, 'certificateId']]
  }
  const result: SnapshotJournalNativeCustody[] = []
  for (const [tableId, field] of forms[actual.tableId] ?? []) {
    const value = actual.row[field]
    if (value === null || value === undefined) continue
    const id = Number(value)
    if (!Number.isSafeInteger(id) || id < 1) invalid()
    if (result.some(parent => parent.tableId === tableId && parent.local.id1 === id)) continue
    const parent = await readSnapshotJournalNativeCustody(
      k,
      tableId,
      userId,
      { id1: id, id2: 0, exactText: '' },
      allocation
    )
    if (parent === undefined) invalid()
    result.push({ tableId, local: parent.local, fingerprint: parent.fingerprint, generation: parent.generation })
  }
  return result
}

export function parseSnapshotJournalNativeParents(value: unknown): SnapshotJournalNativeCustody[] {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096) invalid()
  const rows = JSON.parse(value) as SnapshotJournalNativeCustody[]
  if (!Array.isArray(rows) || rows.length > 3 || JSON.stringify(rows) !== value) invalid()
  for (const row of rows) {
    if (
      row === null ||
      typeof row !== 'object' ||
      Object.keys(row).join(',') !== 'tableId,local,fingerprint,generation' ||
      ![0, 1, 2, 3, 4, 5, 8].includes(row.tableId) ||
      row.local === null ||
      typeof row.local !== 'object' ||
      Object.keys(row.local).join(',') !== 'id1,id2,exactText' ||
      !Number.isSafeInteger(row.local.id1) ||
      row.local.id1 < 1 ||
      row.local.id2 !== 0 ||
      row.local.exactText !== '' ||
      typeof row.fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.fingerprint) ||
      typeof row.generation !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.generation)
    )
      invalid()
  }
  return rows
}
