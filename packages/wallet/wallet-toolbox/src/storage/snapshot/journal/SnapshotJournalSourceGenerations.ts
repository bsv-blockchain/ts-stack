import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { SnapshotJournalSourceGeneration } from './SnapshotJournalTypes'
export type { SnapshotJournalSourceGeneration } from './SnapshotJournalTypes'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { walletSnapshotSourceQuery } from '../KnexWalletReadSnapshot'
import type { WalletSnapshotTable } from '../WalletReadSnapshot'
import type { SnapshotIndexState } from '../../schema/snapshotSqliteIndexState'
import type { SnapshotJournalIdentityTable } from './SnapshotJournalIdentityLedger'
import {
  snapshotJournalRevision,
  compareSnapshotJournalRevisions,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'
import { snapshotJournalRevisionOperand } from './SnapshotJournalRevisionSql'

export interface SnapshotJournalSourceReference {
  tableId: SnapshotJournalIdentityTable
  incomingId: number
}

export interface SnapshotJournalSourceIndexes {
  profile: SnapshotIndexState
  relation: SnapshotIndexState
  certificate: SnapshotIndexState
  global: SnapshotIndexState
}

/** Detached index names are data, not an installation/capability verdict. The
 * producer obtains them through fresh metadata in the payload's pinned view. */
export function snapshotJournalSourceIndexes(
  k: Knex,
  input?: SnapshotJournalSourceIndexes
): SnapshotJournalSourceIndexes {
  const local = ['sqlite3', 'better-sqlite3'].includes(String(k.client.config.client)) || isOwnedNativeSqlite(k)
  const value =
    input === undefined
      ? {
          profile: local ? ('v2' as const) : true,
          relation: local ? ('v2' as const) : true,
          certificate: local ? ('v2' as const) : true,
          global: local ? ('v2' as const) : true
        }
      : { profile: input.profile, relation: input.relation, certificate: input.certificate, global: input.global }
  if (Object.values(value).some(state => state !== true && state !== 'v2')) invalid()
  return value
}

interface Source {
  table: WalletSnapshotTable
  name: string
  key: string
}

const sources: Partial<Record<SnapshotJournalIdentityTable, Source>> = {
  0: { table: 'transactions', name: 'transactions', key: 'transactionId' },
  1: { table: 'outputs', name: 'outputs', key: 'outputId' },
  2: { table: 'certificates', name: 'certificates', key: 'certificateId' },
  3: { table: 'txLabels', name: 'tx_labels', key: 'txLabelId' },
  4: { table: 'outputBaskets', name: 'output_baskets', key: 'basketId' },
  5: { table: 'outputTags', name: 'output_tags', key: 'outputTagId' },
  6: { table: 'commissions', name: 'commissions', key: 'commissionId' },
  8: { table: 'provenTxs', name: 'proven_txs', key: 'provenTxId' },
  9: { table: 'provenTxReqs', name: 'proven_tx_reqs', key: 'provenTxReqId' }
}

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Missing or inconsistent pinned journal source generation')
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid()
  return value
}

function revisionProjection(
  k: Knex,
  field: string,
  alias: string,
  high: SnapshotJournalRevision,
  mysql: boolean
): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(CAST(?? AS CHAR)) BETWEEN 1 AND 19 AND ?? BETWEEN 1 AND ? THEN CAST(?? AS CHAR) ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='integer' AND ?? BETWEEN 1 AND ? THEN CAST(?? AS TEXT) ELSE NULL END AS ??",
    [field, field, snapshotJournalRevisionOperand(k, high), field, alias]
  )
}

/** Resolve live rows and unchanged parents on the caller's SAME pinned source
 * transaction. The caller must freshly verify source receipt/epoch/schema,
 * physical backend, profile and lease before using this data. No supplied high
 * water or returned generation grants authority. This reads no payload and
 * creates no cross-call source/schema verdict cache. Withdrawals must retire
 * the acknowledged destination association, not resolve a later source row. */
export async function readSnapshotJournalSourceGenerations(
  k: Knex,
  userId: number,
  highWater: SnapshotJournalRevision,
  inputReferences: readonly SnapshotJournalSourceReference[],
  inputIndexes?: SnapshotJournalSourceIndexes
): Promise<ReadonlyMap<string, SnapshotJournalSourceGeneration>> {
  if (!k.isTransaction) invalid()
  const client = k.client.config.client
  if (!['sqlite3', 'better-sqlite3', 'mysql', 'mysql2'].includes(String(client)) && !isOwnedNativeSqlite(k)) invalid()
  const mysql = client === 'mysql' || client === 'mysql2'
  const indexes = snapshotJournalSourceIndexes(k, inputIndexes)
  const profile = integer(userId)
  const high = snapshotJournalRevision(highWater)
  if (high === '0' || !Array.isArray(inputReferences) || inputReferences.length > 256) invalid()
  const references = new Map<string, SnapshotJournalSourceReference>()
  for (const input of inputReferences) {
    if (typeof input.tableId !== 'number' || !Object.hasOwn(sources, input.tableId)) invalid()
    const reference = { tableId: input.tableId, incomingId: integer(input.incomingId) }
    references.set(reference.tableId + ':' + reference.incomingId, reference)
  }
  const result = new Map<string, SnapshotJournalSourceGeneration>()
  for (const [key, reference] of references) {
    const source = sources[reference.tableId]!
    // The physical primary key fixes all four coordinates. A derived point
    // query also keeps its "present" column distinct from global membership.
    const physical = k('snapshot_journal_physical')
      .select({ journalIncomingId: 'id1' })
      .select(
        revisionProjection(k, 'generation', 'journalGeneration', high, mysql),
        revisionProjection(k, 'revision', 'journalRevision', high, mysql),
        k.raw(
          mysql
            ? 'CASE WHEN ?? IN (0,1) THEN ?? ELSE NULL END AS ??'
            : "CASE WHEN typeof(??)='integer' AND ?? IN (0,1) THEN ?? ELSE NULL END AS ??",
          mysql ? ['present', 'present', 'journalPresent'] : ['present', 'present', 'present', 'journalPresent']
        )
      )
      .where({ tableId: reference.tableId, id1: reference.incomingId, id2: 0, exactText: '' })
      .limit(2)
    const rows: Array<Record<string, unknown>> = await walletSnapshotSourceQuery(
      k,
      source.table,
      profile,
      indexes.profile,
      indexes.relation,
      indexes.certificate,
      indexes.global
    )
      .join(physical.as('journalIdentity'), source.name + '.' + source.key, 'journalIdentity.journalIncomingId')
      .where(source.name + '.' + source.key, reference.incomingId)
      .select('journalIdentity.journalGeneration', 'journalIdentity.journalRevision', 'journalIdentity.journalPresent')
      .limit(2)
    if (rows.length !== 1 || ![1, true].includes(rows[0].journalPresent as number | boolean)) invalid()
    const generation = snapshotJournalRevision(rows[0].journalGeneration)
    const revision = snapshotJournalRevision(rows[0].journalRevision)
    if (
      generation === '0' ||
      compareSnapshotJournalRevisions(generation, revision) > 0 ||
      compareSnapshotJournalRevisions(revision, high) > 0
    )
      invalid()
    result.set(key, { generation, revision })
  }
  return result
}
