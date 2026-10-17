import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { SnapshotJournalSourceNaturalKey, SnapshotJournalSourceIdentity } from './SnapshotJournalTypes'
export type { SnapshotJournalSourceNaturalKey, SnapshotJournalSourceIdentity } from './SnapshotJournalTypes'
import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { walletSnapshotSourceQuery } from '../KnexWalletReadSnapshot'
import type { WalletSnapshotTable } from '../WalletReadSnapshot'
import type { SnapshotJournalIdentityTable } from './SnapshotJournalIdentityLedger'
import { snapshotJournalRevision, type SnapshotJournalRevision } from './SnapshotJournalRevision'
import {
  readSnapshotJournalSourceGenerations,
  snapshotJournalSourceIndexes,
  type SnapshotJournalSourceIndexes,
  type SnapshotJournalSourceReference
} from './SnapshotJournalSourceGenerations'

interface Source {
  table: WalletSnapshotTable
  name: string
  key: string
  text?: Readonly<Record<string, number>>
}

const sources: Partial<Record<SnapshotJournalIdentityTable, Source>> = {
  0: {
    table: 'transactions',
    name: 'transactions',
    key: 'transactionId',
    text: { reference: 256, txid: 256 }
  },
  1: { table: 'outputs', name: 'outputs', key: 'outputId' },
  2: {
    table: 'certificates',
    name: 'certificates',
    key: 'certificateId',
    text: { serialNumber: 400, certifier: 400 }
  },
  3: { table: 'txLabels', name: 'tx_labels', key: 'txLabelId', text: { label: 1200 } },
  4: { table: 'outputBaskets', name: 'output_baskets', key: 'basketId', text: { name: 1200 } },
  5: { table: 'outputTags', name: 'output_tags', key: 'outputTagId', text: { tag: 600 } },
  6: { table: 'commissions', name: 'commissions', key: 'commissionId' },
  8: { table: 'provenTxs', name: 'proven_txs', key: 'provenTxId', text: { txid: 256 } },
  9: { table: 'provenTxReqs', name: 'proven_tx_reqs', key: 'provenTxReqId', text: { txid: 256 } }
}

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or missing pinned journal natural identity')
}

function integer(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid()
  return value
}

function text(value: unknown): string {
  if (typeof value !== 'string') invalid()
  return value
}

function key(reference: SnapshotJournalSourceReference): string {
  return reference.tableId + ':' + reference.incomingId
}

function digest(tableId: SnapshotJournalIdentityTable, parts: readonly unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify(['wallet-journal-source-identity/v1', tableId, ...parts]))
    .digest('hex')
}

function boundedText(k: Knex, field: string, maximumBytes: number, mysql: boolean): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(??) BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='text' AND length(cast(?? as blob)) BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??",
    mysql
      ? [field, maximumBytes, field, field.split('.').at(-1)!]
      : [field, field, maximumBytes, field, field.split('.').at(-1)!]
  )
}

function boundedInteger(k: Knex, field: string, minimum: number, mysql: boolean): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(cast(?? as char)) BETWEEN 1 AND 16 AND ?? BETWEEN ? AND ? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='integer' AND ?? BETWEEN ? AND ? THEN ?? ELSE NULL END AS ??",
    [field, field, minimum, Number.MAX_SAFE_INTEGER, field, field.split('.').at(-1)!]
  )
}

/** Data only, on the caller's SAME freshly verified pinned source transaction.
 * Receipt, epoch, schema, physical backend, profile and lease verification must
 * precede this call and the staged payload read; neither the supplied high water
 * nor this detached result grants authority. No source verdict is cached.
 *
 * The fingerprint identifies an association within its source lineage. It is
 * deliberately distinct from destination semantic lookup: transaction lookup
 * still prefers txid and falls back to reference. Learning a txid preserves a
 * transaction's reference fingerprint. Outputs/commissions bind the exact live
 * parent generation, never a raw source ID or an optional output txid. Names,
 * certificates and txids retain their exact stored values, with no new case,
 * whitespace or Unicode normalization. Bounded SQL projections read only key
 * cells, never blobs, descriptions, histories, notify or private material.
 */
export async function readSnapshotJournalSourceIdentities(
  k: Knex,
  userId: number,
  highWater: SnapshotJournalRevision,
  inputReferences: readonly SnapshotJournalSourceReference[],
  inputIndexes?: SnapshotJournalSourceIndexes
): Promise<ReadonlyMap<string, SnapshotJournalSourceIdentity>> {
  if (!k.isTransaction || !Array.isArray(inputReferences) || inputReferences.length > 256) invalid()
  const client = String(k.client.config.client)
  if (!['sqlite3', 'better-sqlite3', 'mysql', 'mysql2'].includes(client) && !isOwnedNativeSqlite(k)) invalid()
  const mysql = client === 'mysql' || client === 'mysql2'
  const indexes = snapshotJournalSourceIndexes(k, inputIndexes)
  const profile = integer(userId)
  const high = snapshotJournalRevision(highWater)
  if (high === '0') invalid()
  const references = new Map<string, SnapshotJournalSourceReference>()
  for (const input of inputReferences) {
    if (typeof input.tableId !== 'number' || !Object.hasOwn(sources, input.tableId)) invalid()
    const reference = { tableId: input.tableId, incomingId: integer(input.incomingId) }
    references.set(key(reference), reference)
  }
  const requested = new Set(references.keys())
  const rows = new Map<string, SnapshotJournalSourceNaturalKey>()
  // The initial detached set is finite; newly discovered parents are read below.
  async function readNatural(reference: SnapshotJournalSourceReference): Promise<void> {
    const source = sources[reference.tableId]!
    const query = walletSnapshotSourceQuery(
      k,
      source.table,
      profile,
      indexes.profile,
      indexes.relation,
      indexes.certificate,
      indexes.global
    )
      .where(source.name + '.' + source.key, reference.incomingId)
      .limit(2)
    for (const [field, maximumBytes] of Object.entries(source.text ?? {}))
      query.select(boundedText(k, source.name + '.' + field, maximumBytes, mysql))
    if (reference.tableId === 0)
      query.select(
        k.raw(
          mysql
            ? 'CASE WHEN ?? IS NULL OR octet_length(??) BETWEEN 0 AND 256 THEN 1 ELSE 0 END AS ??'
            : "CASE WHEN ?? IS NULL OR (typeof(??)='text' AND length(cast(?? as blob)) BETWEEN 0 AND 256) THEN 1 ELSE 0 END AS ??",
          mysql
            ? ['transactions.txid', 'transactions.txid', 'optionalTxidValid']
            : ['transactions.txid', 'transactions.txid', 'transactions.txid', 'optionalTxidValid']
        )
      )
    if (reference.tableId === 1 || reference.tableId === 6)
      query.select(boundedInteger(k, source.name + '.transactionId', 1, mysql))
    if (reference.tableId === 1) query.select(boundedInteger(k, source.name + '.vout', 0, mysql))
    const selected: Array<Record<string, unknown>> = await query
    if (selected.length !== 1) invalid()
    const row = selected[0]
    let natural: SnapshotJournalSourceNaturalKey
    switch (reference.tableId) {
      case 0:
        if (![1, true].includes(row.optionalTxidValid as number | boolean)) invalid()
        natural = {
          tableId: 0,
          reference: text(row.reference),
          ...(row.txid == null ? {} : { txid: text(row.txid) })
        }
        break
      case 1:
        natural = {
          tableId: 1,
          transactionId: integer(row.transactionId),
          vout: integer(row.vout, 0)
        }
        break
      case 2:
        natural = {
          tableId: 2,
          serialNumber: text(row.serialNumber),
          certifier: text(row.certifier)
        }
        break
      case 3:
        natural = { tableId: 3, label: text(row.label) }
        break
      case 4:
        natural = { tableId: 4, name: text(row.name) }
        break
      case 5:
        natural = { tableId: 5, tag: text(row.tag) }
        break
      case 6:
        natural = { tableId: 6, transactionId: integer(row.transactionId) }
        break
      case 8:
      case 9:
        natural = { tableId: reference.tableId, txid: text(row.txid) }
        break
      default:
        invalid()
    }
    rows.set(key(reference), natural)
    if (natural.tableId === 1 || natural.tableId === 6) {
      const parent = { tableId: 0 as const, incomingId: natural.transactionId }
      references.set(key(parent), parent)
      if (references.size > 256) invalid()
    }
  }
  // Read the initial seed separately: readNatural can add discovered references.
  for (const reference of Array.from(references.values())) await readNatural(reference)
  for (const reference of references.values()) if (!rows.has(key(reference))) await readNatural(reference)
  const generations = await readSnapshotJournalSourceGenerations(k, profile, high, [...references.values()], indexes)
  const result = new Map<string, SnapshotJournalSourceIdentity>()
  function identity(reference: SnapshotJournalSourceReference): SnapshotJournalSourceIdentity {
    const coordinate = key(reference)
    const cached = result.get(coordinate)
    if (cached) return cached
    const natural = rows.get(coordinate),
      generation = generations.get(coordinate)
    if (!natural || !generation) invalid()
    let parts: readonly unknown[]
    switch (natural.tableId) {
      case 0:
        parts = ['reference', natural.reference]
        break
      case 1:
      case 6: {
        const parent = identity({ tableId: 0, incomingId: natural.transactionId })
        parts = [
          'transaction',
          parent.naturalIdentity,
          parent.generation,
          ...(natural.tableId === 1 ? ['vout', natural.vout] : [])
        ]
        break
      }
      case 2:
        parts = ['serialNumber', natural.serialNumber, 'certifier', natural.certifier]
        break
      case 3:
        parts = ['label', natural.label]
        break
      case 4:
        parts = ['name', natural.name]
        break
      case 5:
        parts = ['tag', natural.tag]
        break
      case 8:
      case 9:
        parts = ['txid', natural.txid]
        break
      default:
        invalid()
    }
    const value = Object.freeze({
      ...generation,
      ...reference,
      naturalIdentity: digest(reference.tableId, parts),
      naturalKey: Object.freeze({ ...natural }),
      required: !requested.has(coordinate)
    })
    result.set(coordinate, value)
    return value
  }
  for (const reference of references.values()) identity(reference)
  return result
}
