import { brc38ImportRowForm } from './Brc38ImportForms'
import { copyBrc38ImportDecodedValue, type Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
import type { Brc38StageTable } from './Brc38SemanticStage'
export interface Brc38ImportHistoryProjection {
  readonly field: 'notify' | 'syncMap'
  readonly originalJson: string
  readonly mappedJson: string
  readonly unmappedIds: number
  /** Original source checkpoints remain provenance, never automatic activation. */
  readonly activated: false
}
import type { SyncMap } from '../schema/entities/EntityBase'

export interface Brc38IdbRestoreParent {
  readonly entity: keyof SyncMap
  readonly incomingId: number
  readonly localId: number
}
export interface Brc38IdbRestoreMetadata {
  readonly table: Brc38StageTable
  readonly store: string
  /** Present for the nine entity mappings. Original sync-state IDs remain
   * provenance, while the isolated IDB destination assigns its native key. */
  readonly identity?: Readonly<{ entity: keyof SyncMap; incomingId: number }>
  readonly originalSyncStateId?: number
  readonly row: Readonly<Record<string, unknown>>
}
const stores: Readonly<Record<Brc38StageTable, string>> = Object.freeze({
  provenTxs: 'proven_txs',
  outputBaskets: 'output_baskets',
  outputTags: 'output_tags',
  txLabels: 'tx_labels',
  transactions: 'transactions',
  outputs: 'outputs',
  txLabelMaps: 'tx_labels_map',
  outputTagMaps: 'output_tags_map',
  certificates: 'certificates',
  certificateFields: 'certificate_fields',
  commissions: 'commissions',
  provenTxReqs: 'proven_tx_reqs',
  syncStates: 'sync_states'
})
export function brc38IdbRestoreStore(table: Brc38StageTable | 'header'): string {
  if (table === 'header') return 'users'
  if (!Object.hasOwn(stores, table)) invalid()
  return stores[table]
}
function invalid(): never {
  throw new Error('Isolated IndexedDB restore metadata differs from its prepared source or mappings')
}
function local(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid()
  return value
}

/** Preparation DATA only, outside the destination writer. The actual source
 * owner must authenticate/replay semantics; the genuine journal must freshly
 * admit its actor/profile/receipt before consuming these values. Explicit
 * large fields/proof validation/provenance/inventory/activation are separate.
 * The caller's original shared decoded budget accounts for this retained clone.
 * All accepted incoming integer identities (including zero/negative/exponents)
 * are preserved separately from generated positive IndexedDB destination keys. */
export function prepareBrc38IdbRestoreMetadata(
  table: Brc38StageTable,
  decoded: Readonly<Record<string, unknown>>,
  userId: number,
  parents: readonly Brc38IdbRestoreParent[],
  budget: Brc38ImportDecodedBudget,
  history?: Readonly<Brc38ImportHistoryProjection>,
  streamedHistoryField?: 'notify' | 'syncMap'
): Readonly<Brc38IdbRestoreMetadata> {
  const form = brc38ImportRowForm(table)
  local(userId)
  if (
    !Array.isArray(parents) ||
    parents.length > 3 ||
    decoded === null ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded)
  )
    invalid()
  const row = copyBrc38ImportDecodedValue(decoded, budget) as Record<string, unknown>
  let identity: Readonly<{ entity: keyof SyncMap; incomingId: number }> | undefined
  if (form.id !== undefined && form.entity !== undefined) {
    const incomingId = row[form.id]
    if (typeof incomingId !== 'number' || !Number.isInteger(incomingId)) invalid()
    identity = Object.freeze({ entity: form.entity, incomingId })
    // An absent inline primary key requests the actual IDB auto-increment key;
    // passing zero as an auto-ID sentinel would be a different IDB operation.
    delete row[form.id]
  }
  const used = new Set<number>()
  for (const parent of form.parents) {
    const incomingId = row[parent.field]
    if (incomingId === undefined && parent.optional === true) continue
    if (typeof incomingId !== 'number' || !Number.isInteger(incomingId)) invalid()
    let found = -1
    for (let index = 0; index < parents.length; index++) {
      const candidate = parents[index]
      if (candidate.entity === parent.entity && candidate.incomingId === incomingId) {
        if (found !== -1) invalid()
        found = index
      }
    }
    if (found === -1) invalid()
    used.add(found)
    row[parent.field] = local(parents[found].localId)
  }
  if (used.size !== parents.length) invalid()
  if (Object.hasOwn(row, 'userId')) row.userId = userId
  const expectedHistory = table === 'provenTxReqs' ? 'notify' : table === 'syncStates' ? 'syncMap' : undefined
  if (streamedHistoryField !== undefined) {
    // The actual source/controller owns the field and genuine staged content.
    // No temporary empty string or substitute DTO represents a large history.
    if (streamedHistoryField !== expectedHistory || Object.hasOwn(row, streamedHistoryField) || history !== undefined)
      invalid()
  } else if (expectedHistory !== undefined) {
    if (
      history === undefined ||
      history.field !== expectedHistory ||
      history.activated !== false ||
      typeof row[expectedHistory] !== 'string' ||
      row[expectedHistory] !== history.originalJson ||
      typeof history.mappedJson !== 'string' ||
      !Number.isSafeInteger(history.unmappedIds) ||
      history.unmappedIds < 0
    )
      invalid()
    row[expectedHistory] = copyBrc38ImportDecodedValue(history.mappedJson, budget)
  } else if (history !== undefined) invalid()
  let originalSyncStateId: number | undefined
  if (table === 'syncStates') {
    const original = row.syncStateId
    if (typeof original !== 'number' || !Number.isInteger(original)) invalid()
    originalSyncStateId = original
    delete row.syncStateId
    row.init = false
  }
  return Object.freeze({
    table,
    store: stores[table],
    row: Object.freeze(row),
    ...(identity === undefined ? {} : { identity }),
    ...(originalSyncStateId === undefined ? {} : { originalSyncStateId })
  })
}
