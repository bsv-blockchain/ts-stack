import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { walletSnapshotSourceQuery } from '../KnexWalletReadSnapshot'
import type { SnapshotJournalDelta } from './SnapshotJournalDeltaPage'
import type { SnapshotJournalIdentityTable } from './SnapshotJournalIdentityLedger'
import { snapshotJournalSourceIndexes, type SnapshotJournalSourceIndexes } from './SnapshotJournalSourceGenerations'
import { snapshotJournalRevision, type SnapshotJournalRevision } from './SnapshotJournalRevision'
import {
  readSnapshotJournalSourceIdentities,
  type SnapshotJournalSourceIdentity
} from './SnapshotJournalSourceIdentities'

export interface SnapshotJournalRowReference {
  tableId: SnapshotJournalIdentityTable
  incomingId: number
  use: 'entity' | 'parent' | 'notification'
}

interface Form {
  id?: string
  parents?: readonly (readonly [SnapshotJournalIdentityTable, string, boolean?])[]
}

const forms: readonly Form[] = [
  { id: 'transactionId', parents: [[8, 'provenTxId', true]] },
  {
    id: 'outputId',
    parents: [
      [0, 'transactionId'],
      [0, 'spentBy', true],
      [4, 'basketId', true]
    ]
  },
  { id: 'certificateId' },
  { id: 'txLabelId' },
  { id: 'basketId' },
  { id: 'outputTagId' },
  { id: 'commissionId', parents: [[0, 'transactionId']] },
  {}, // Operational syncStates are retained provenance, never entity promotion.
  { id: 'provenTxId' },
  { id: 'provenTxReqId', parents: [[8, 'provenTxId', true]] },
  {
    parents: [
      [3, 'txLabelId'],
      [0, 'transactionId']
    ]
  },
  {
    parents: [
      [5, 'outputTagId'],
      [1, 'outputId']
    ]
  },
  { parents: [[2, 'certificateId']] }
]

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid pinned journal row references')
}

function integer(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid()
  return value
}

function field(row: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, name)
  if (descriptor === undefined) return undefined
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
  return descriptor.value
}

/** Yield references without collecting a wallet-sized map. Direct dependencies
 * cover the complete existing entity merge contract. A global proof request's
 * notification IDs are candidates: the same pinned source view filters other
 * profiles and absent transactions before their identities are captured.
 * Withdrawals use prior acknowledged associations, never current source rows.
 */
export function* snapshotJournalRowReferences(
  tableId: number,
  change: SnapshotJournalDelta,
  skipNotifications?: true
): Generator<SnapshotJournalRowReference> {
  const id = integer(tableId, 0)
  if (id >= forms.length || id === 7) invalid()
  if (!change.present) return
  const row = change.row
  if (row === null || typeof row !== 'object' || Array.isArray(row)) invalid()
  const form = forms[id]
  if (form.id !== undefined) {
    const incomingId = integer(field(row, form.id))
    if (incomingId !== change.metadata.id1) invalid()
    yield { tableId: id as SnapshotJournalIdentityTable, incomingId, use: 'entity' }
  }
  for (const [parentTable, name, optional] of form.parents ?? []) {
    const value = field(row, name)
    if (optional === true && value == null) continue
    yield { tableId: parentTable, incomingId: integer(value), use: 'parent' }
  }
  if (id !== 9 || skipNotifications === true) return
  const notify = field(row, 'notify')
  if (typeof notify !== 'string' || Buffer.byteLength(notify, 'utf8') > 1048576) invalid()
  const parsed: unknown = JSON.parse(notify)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) invalid()
  const ids = field(parsed, 'transactionIds')
  if (ids == null) return
  if (!Array.isArray(ids)) invalid()
  for (const value of ids) {
    // Match existing notification normalization: invalid/nonintegral entries
    // are discarded. Source SQL IDs must additionally be safely representable.
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) continue
    yield { tableId: 0, incomingId: value, use: 'notification' }
  }
}

/** Capture identity sidecars while the payload's freshly verified source view
 * remains pinned. Every yielded batch has at most128 identities, including
 * implicit output/commission parents; it cannot exhaust the256-reference
 * reader merely because a frame contains256 rows or many notifications.
 * The consumer must persist these data alongside the frame before intake ACK.
 * No verdict or generation is resolved against a later source transaction.
 */
export async function* readSnapshotJournalRowSourceIdentities(
  k: Knex,
  userId: number,
  highWater: SnapshotJournalRevision,
  tableId: number,
  change: SnapshotJournalDelta,
  inputIndexes?: SnapshotJournalSourceIndexes,
  skipNotifications?: true
): AsyncGenerator<ReadonlyMap<string, SnapshotJournalSourceIdentity>> {
  if (
    !k.isTransaction ||
    (!['sqlite3', 'better-sqlite3', 'mysql', 'mysql2'].includes(String(k.client.config.client)) &&
      !isOwnedNativeSqlite(k))
  )
    invalid()
  const user = integer(userId)
  const indexes = snapshotJournalSourceIndexes(k, inputIndexes)
  const high = snapshotJournalRevision(highWater)
  if (high === '0') invalid()
  const iterator = snapshotJournalRowReferences(tableId, change, skipNotifications)
  let done = false
  while (!done) {
    const references = new Map<string, SnapshotJournalRowReference>()
    // Count visited entries as well as distinct keys so duplicates cannot turn
    // one batch into an unbounded synchronous loop or source SQL operation.
    for (let visited = 0; visited < 64; visited++) {
      const next = iterator.next()
      if (next.done) {
        done = true
        break
      }
      const reference = next.value
      const key = reference.tableId + ':' + reference.incomingId
      const prior = references.get(key)
      if (prior === undefined || (prior.use === 'notification' && reference.use !== 'notification'))
        references.set(key, reference)
    }
    if (references.size === 0) continue
    const notifications = [...references.values()].filter(reference => reference.use === 'notification')
    if (notifications.length !== 0) {
      const rows: Array<{ transactionId: unknown }> = await walletSnapshotSourceQuery(
        k,
        'transactions',
        user,
        indexes.profile,
        indexes.relation,
        indexes.certificate,
        indexes.global
      )
        .select('transactions.transactionId')
        .whereIn(
          'transactions.transactionId',
          notifications.map(reference => reference.incomingId)
        )
        .limit(65)
      if (rows.length > notifications.length) invalid()
      const owned = new Set(rows.map(row => integer(row.transactionId)))
      if (owned.size !== rows.length) invalid()
      for (const reference of notifications)
        if (!owned.has(reference.incomingId)) references.delete('0:' + reference.incomingId)
    }
    if (references.size === 0) continue
    const captured = await readSnapshotJournalSourceIdentities(k, user, high, [...references.values()], indexes)
    const result = new Map<string, SnapshotJournalSourceIdentity>()
    for (const [key, value] of captured) {
      const reference = references.get(key)
      // Only the actual promoted numeric entity may establish an association.
      // All parents/notifications need an already acknowledged exact identity.
      result.set(key, Object.freeze({ ...value, required: reference?.use !== 'entity' }))
    }
    yield result
  }
}

/** One bounded notification batch from the original retained JSON visitor.
 * Actual indexed profile membership is required before capturing identities. */
export async function readSnapshotJournalNotificationSourceIdentities(
  k: Knex,
  userId: number,
  highWater: SnapshotJournalRevision,
  input: readonly number[],
  inputIndexes?: SnapshotJournalSourceIndexes
): Promise<ReadonlyMap<string, SnapshotJournalSourceIdentity>> {
  if (!k.isTransaction || input.length < 1 || input.length > 64) invalid()
  const user = integer(userId),
    indexes = snapshotJournalSourceIndexes(k, inputIndexes),
    ids = [...new Set(input.map(value => integer(value)))],
    rows: Array<{ transactionId: unknown }> = await walletSnapshotSourceQuery(
      k,
      'transactions',
      user,
      indexes.profile,
      indexes.relation,
      indexes.certificate,
      indexes.global
    )
      .select('transactions.transactionId')
      .whereIn('transactions.transactionId', ids)
      .limit(65)
  if (rows.length > ids.length) invalid()
  const owned = rows.map(row => integer(row.transactionId))
  if (new Set(owned).size !== owned.length || owned.some(id => !ids.includes(id))) invalid()
  if (owned.length === 0) return new Map()
  const values = await readSnapshotJournalSourceIdentities(
    k,
    user,
    snapshotJournalRevision(highWater),
    owned.map(incomingId => ({ tableId: 0 as const, incomingId })),
    indexes
  )
  return new Map([...values].map(([key, value]) => [key, Object.freeze({ ...value, required: true })]))
}
