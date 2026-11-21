import {
  readSnapshotJournalCapturedIdentities,
  requireSnapshotJournalCapturedFrame
} from './SnapshotJournalCapturedIdentities'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { createSyncMap, type SyncMap } from '../../schema/entities/EntityBase'
import type { SnapshotJournalCapturedIdentity } from './SnapshotJournalCapturedIdentities'
import {
  prepareSnapshotJournalIdentityLedger,
  type SnapshotJournalIdentityAssociation,
  type SnapshotJournalIdentityLimits,
  type SnapshotJournalIdentityTable
} from './SnapshotJournalIdentityLedger'
import {
  withSnapshotJournalDestinationWindowFence,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'
import {
  chargeSnapshotJournalAllocation,
  snapshotJournalIndexedEntityQuery,
  type SnapshotJournalAllocationBudget
} from './SnapshotJournalNativeRows'
import { brc38ImportTargetIndexes, type Brc38ImportTargetIndex } from '../../portable/Brc38ImportTargetIndexes'

export const snapshotJournalIdentityEntities: Readonly<Record<SnapshotJournalIdentityTable, keyof SyncMap>> = {
  0: 'transaction',
  1: 'output',
  2: 'certificate',
  3: 'txLabel',
  4: 'outputBasket',
  5: 'outputTag',
  6: 'commission',
  8: 'provenTx',
  9: 'provenTxReq'
}
const ids: Readonly<Record<SnapshotJournalIdentityTable, string>> = {
  0: 'transactionId',
  1: 'outputId',
  2: 'certificateId',
  3: 'txLabelId',
  4: 'basketId',
  5: 'outputTagId',
  6: 'commissionId',
  8: 'provenTxId',
  9: 'provenTxReqId'
}
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Journal association no longer identifies its destination entity')
}
function positive(value: unknown): number {
  const number = typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) invalid()
  return number
}
function parent(map: SyncMap, incomingId: number): number {
  return positive(map.transaction.idMap[incomingId])
}

/** Resolve the same semantic keys as the legacy entity classes. Only bounded
 * key cells and the local ID are read. A persisted local ID is data, never proof
 * that the current row is still the same entity or belongs to this profile. */
export async function verifySnapshotJournalDestinationIdentity(
  k: Knex,
  userId: number,
  reference: SnapshotJournalCapturedIdentity,
  association: SnapshotJournalIdentityAssociation,
  map: SyncMap,
  allowAbsentBootstrapSelf = false
): Promise<boolean> {
  if (
    !k.isTransaction ||
    association.generation !== reference.generation ||
    association.naturalIdentity !== reference.naturalIdentity
  )
    invalid()
  const natural = reference.naturalKey
  if (natural.tableId !== reference.tableId) invalid()
  const candidates: Array<{ index: Brc38ImportTargetIndex; key: Record<string, string | number> }> = []
  switch (natural.tableId) {
    case 0:
      if (natural.txid) candidates.push({ index: 'transactions', key: { userId, txid: natural.txid } })
      if (natural.reference)
        candidates.push({ index: 'transactionReference', key: { userId, reference: natural.reference } })
      break
    case 1:
      candidates.push({
        index: 'outputs',
        key: { userId, transactionId: parent(map, natural.transactionId), vout: natural.vout }
      })
      break
    case 2:
      candidates.push({
        index: 'certificates',
        key: { userId, certifier: natural.certifier, serialNumber: natural.serialNumber }
      })
      break
    case 3:
      candidates.push({ index: 'txLabels', key: { userId, label: natural.label } })
      break
    case 4:
      candidates.push({ index: 'outputBaskets', key: { userId, name: natural.name } })
      break
    case 5:
      candidates.push({ index: 'outputTags', key: { userId, tag: natural.tag } })
      break
    case 6:
      candidates.push({ index: 'commissions', key: { userId, transactionId: parent(map, natural.transactionId) } })
      break
    case 8:
      // Native field writes preserve captured spelling; the legacy proof
      // validator canonicalizes new/replacement rows. Both are exact indexed
      // keys, while the acknowledged physical ID still has to match.
      candidates.push({ index: 'provenTxs', key: { txid: natural.txid } })
      if (natural.txid.toLowerCase() !== natural.txid)
        candidates.push({ index: 'provenTxs', key: { txid: natural.txid.toLowerCase() } })
      break
    case 9:
      candidates.push({ index: 'provenTxReqs', key: { txid: natural.txid } })
      break
  }
  const remote = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  for (const candidate of candidates) {
    const id = ids[reference.tableId]
    const query = snapshotJournalIndexedEntityQuery(k, candidate.index, candidate.key)
    if (remote) query.forUpdate().noWait()
    if (reference.tableId === 8)
      query.whereRaw(remote ? 'CAST(txid AS BINARY)=CAST(? AS BINARY)' : 'CAST(txid AS BLOB)=CAST(? AS BLOB)', [
        candidate.key.txid
      ])
    query.select(
      k.raw(
        remote
          ? 'CASE WHEN octet_length(cast(?? as char)) BETWEEN 1 AND 16 AND ?? BETWEEN 1 AND ? THEN ?? ELSE NULL END AS ??'
          : "CASE WHEN typeof(??)='integer' AND ?? BETWEEN 1 AND ? THEN ?? ELSE NULL END AS ??",
        [id, id, Number.MAX_SAFE_INTEGER, id, id]
      )
    )
    for (const [field, value] of Object.entries(candidate.key)) {
      if (typeof value === 'string')
        query.select(
          k.raw(
            remote
              ? 'CASE WHEN octet_length(??)<=? THEN ?? ELSE NULL END AS ??'
              : "CASE WHEN typeof(??)='text' AND length(cast(?? as blob))<=? THEN ?? ELSE NULL END AS ??",
            remote
              ? [field, Buffer.byteLength(value, 'utf8'), field, field]
              : [field, field, Buffer.byteLength(value, 'utf8'), field, field]
          )
        )
      else query.select(field)
    }
    const rows: Array<Record<string, unknown>> = await query
    if (rows.length > 1) invalid()
    if (rows.length === 0) continue
    if (
      positive(rows[0][id]) !== association.localId ||
      Object.entries(candidate.key).some(([field, value]) =>
        typeof value === 'string'
          ? rows[0][field] !== value
          : !Number.isSafeInteger(Number(rows[0][field])) || Number(rows[0][field]) !== value
      )
    )
      invalid()
    return true
  }
  // A complete bootstrap can repair a genuinely absent self row. Natural-key
  // absence alone is insufficient: an occupied old primary key must still
  // refuse, including a reused ID belonging to another profile. This is a
  // current physical query in the same writer, never a serialized verdict.
  if (allowAbsentBootstrapSelf && !reference.required && candidates.length > 0) {
    const [table] = brc38ImportTargetIndexes[candidates[0].index]
    const query = k(table).where(ids[reference.tableId], association.localId).select(ids[reference.tableId]).limit(1)
    if (remote) query.forUpdate().noWait()
    if ((await query).length === 0) return false
  }
  invalid()
}

/** One row's map only. Parents are loaded in table order from bounded captured
 * identity batches; the transaction parent precedes outputs and commissions.
 * Callers must supply the fresh destination fence and actual schema indexes. */
export async function loadSnapshotJournalDestinationParents(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  references: AsyncIterable<readonly SnapshotJournalCapturedIdentity[]>,
  limits: SnapshotJournalIdentityLimits,
  budget: SnapshotJournalAllocationBudget
): Promise<{ map: SyncMap; self?: SnapshotJournalCapturedIdentity }> {
  const map = createSyncMap()
  let self: SnapshotJournalCapturedIdentity | undefined
  for await (const batch of references) {
    if (batch.length > 128) invalid()
    const required = batch.filter(reference => reference.required)
    const loaded = await prepareSnapshotJournalIdentityLedger(k, binding, expected, required, limits)
    for (const reference of batch) {
      if (!reference.required) {
        if (self !== undefined) invalid()
        self = reference
        continue
      }
      const association = loaded.associations.get(reference.tableId + ':' + reference.incomingId)
      if (association === undefined) invalid()
      await verifySnapshotJournalDestinationIdentity(k, binding.destinationUserId, reference, association, map)
      const idMap = map[snapshotJournalIdentityEntities[reference.tableId]].idMap
      if (!Object.hasOwn(idMap, reference.incomingId)) chargeSnapshotJournalAllocation(budget, 256)
      else if (idMap[reference.incomingId] !== association.localId) invalid()
      idMap[reference.incomingId] = association.localId
    }
  }
  return { map, ...(self === undefined ? {} : { self }) }
}

/** Journal-only notification projection. Every batch resolves original sealed
 * captured references through current associations and real physical parents;
 * missing/unsafe legacy IDs remain unmapped. No snapshot_sync_ids or whole map. */
export async function readSnapshotJournalNotificationMappings(
  trx: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  frameDigest: string,
  changeIndex: number,
  frameChanges: number,
  incoming: readonly number[],
  limits: SnapshotJournalIdentityLimits
): Promise<readonly (number | undefined)[]> {
  if (!Array.isArray(incoming) || incoming.length > 128 || incoming.some(id => !Number.isInteger(id))) invalid()
  return await withSnapshotJournalDestinationWindowFence(trx, binding, expected, async actual => {
    await requireSnapshotJournalCapturedFrame(actual, binding, expected, frameDigest, frameChanges)
    const ids = [...new Set(incoming.filter(id => Number.isSafeInteger(id) && id > 0))]
    if (ids.length === 0) return Object.freeze(incoming.map(() => undefined))
    const references = await readSnapshotJournalCapturedIdentities(
      actual,
      binding,
      expected,
      frameDigest,
      changeIndex,
      undefined,
      { kind: 'transaction-points', ids }
    )
    if (references.some(reference => reference.tableId !== 0 || !reference.required)) invalid()
    const loaded = await prepareSnapshotJournalIdentityLedger(actual, binding, expected, references, limits),
      map = createSyncMap(),
      result = new Map<number, number>()
    for (const reference of references) {
      const association = loaded.associations.get('0:' + reference.incomingId)
      if (association === undefined) invalid()
      await verifySnapshotJournalDestinationIdentity(actual, binding.destinationUserId, reference, association, map)
      result.set(reference.incomingId, association.localId)
    }
    return Object.freeze(incoming.map(id => result.get(id)))
  })
}
