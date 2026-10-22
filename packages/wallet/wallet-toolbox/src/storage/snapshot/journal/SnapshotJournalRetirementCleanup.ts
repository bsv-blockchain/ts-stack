import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { snapshotJournalIdentityLineage } from './SnapshotJournalIdentityLedger'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import { verifySnapshotJournalDestinationSchema } from './SnapshotJournalDestinationSchema'
import {
  parseSnapshotJournalMembership,
  snapshotJournalMembershipProjections,
  storedSnapshotJournalMembership
} from './SnapshotJournalMemberships'
import { parseSnapshotJournalNativeParents, readSnapshotJournalNativeCustody } from './SnapshotJournalNativeCustody'
import { snapshotJournalNativeHasReferences } from './SnapshotJournalNativeReferences'
import { snapshotJournalNativeEntityKeys, type SnapshotJournalAllocationBudget } from './SnapshotJournalNativeRows'
import { brc38ImportTargetIndexes } from '../../portable/Brc38ImportTargetIndexes'
import {
  withSnapshotJournalDestinationWindowFence,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'

const retirements = 'snapshot_reconciliation_membership_retirements'
const budgets = 'snapshot_reconciliation_membership_budgets'
const order = [12, 11, 10, 6, 1, 2, 5, 4, 3, 0, 9, 8] as const
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Journal retirement custody or remaining capacity is inconsistent')
}
function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/.test(value)) value = Number(value)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid()
  return value
}
function bounded(k: Knex, field: string, maximum: number, mysql: boolean): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(cast(?? as char)) BETWEEN 1 AND 16 AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='integer' AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??",
    [field, field, maximum, field, field]
  )
}
function text(k: Knex, field: string, maximum: number, mysql: boolean): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(??)<=? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='text' AND length(cast(?? as blob))<=? THEN ?? ELSE NULL END AS ??",
    mysql ? [field, maximum, field, field] : [field, field, maximum, field, field]
  )
}
function binary(k: Knex, field: string, mysql: boolean): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(??)<=400 THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='blob' AND length(??)<=400 THEN ?? ELSE NULL END AS ??",
    mysql ? [field, field, field] : [field, field, field, field]
  )
}
async function associated(
  k: Knex,
  userId: number,
  tableId: number,
  local: { id1: number; id2: number; exactText: string },
  mysql: boolean
): Promise<boolean> {
  const membership = k
    .from(
      k.raw(
        mysql
          ? 'snapshot_reconciliation_memberships FORCE INDEX (snapshot_reconciliation_membership_target)'
          : 'snapshot_reconciliation_memberships INDEXED BY snapshot_reconciliation_membership_target'
      )
    )
    .where({ userId, tableId, id1: local.id1, id2: local.id2, exactText: Buffer.from(local.exactText, 'utf8') })
    .select('tableId')
    .limit(1)
  if (mysql) membership.forUpdate().noWait()
  if ((await membership).length) return true
  if (tableId >= 10) return false
  const identity = k
    .from(
      k.raw(
        mysql
          ? 'snapshot_reconciliation_identity_maps FORCE INDEX (snapshot_reconciliation_identity_target)'
          : 'snapshot_reconciliation_identity_maps INDEXED BY snapshot_reconciliation_identity_target'
      )
    )
    .where({ userId, tableId, localId: local.id1 })
    .select('tableId')
    .limit(1)
  if (mysql) identity.forUpdate().noWait()
  return (await identity).length !== 0
}

/** Remove a bounded number of retirement intents in native dependency order.
 * Only a row created by this reconciliation, with the SAME actual physical
 * generation and complete postimage, unchanged parents, no current source
 * association and no independent native reference can be deleted. Shared global
 * proof/request rows and locally changed rows survive. Cursor, semantic cleanup
 * and quota release commit together; a lost reply cannot delete/decrement twice.
 */
export async function cleanupSnapshotJournalRetirements(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  maximumIntents: number,
  allocation: SnapshotJournalAllocationBudget,
  identityOnly = false
): Promise<{ processed: number; deleted: number; retained: number; complete: boolean }> {
  if (expected.phase !== 'promoting') invalid()
  const maximum = number(maximumIntents, 32)
  if (maximum < 1) invalid()
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  return await withSnapshotJournalDestinationWindowFence(k, binding, expected, async trx => {
    await verifySnapshotJournalDestinationSchema(trx)
    const scope = { userId: binding.destinationUserId, lineage: snapshotJournalIdentityLineage(binding) }
    let processed = 0,
      deleted = 0,
      retained = 0
    for (const tableId of identityOnly ? [] : order) {
      if (processed === maximum) break
      const rows: Array<Record<string, unknown>> = await trx(retirements)
        .where({ ...scope, tableId })
        .select(
          ...snapshotJournalMembershipProjections(trx, mysql),
          bounded(trx, 'incomingId1', Number.MAX_SAFE_INTEGER, mysql),
          bounded(trx, 'incomingId2', Number.MAX_SAFE_INTEGER, mysql),
          binary(trx, 'incomingText', mysql),
          text(trx, 'retiredAtRevision', 19, mysql)
        )
        .orderBy(['incomingId1', 'incomingId2', 'incomingText', 'revision'])
        .limit(maximum - processed)
      for (const row of rows) {
        const previous = parseSnapshotJournalMembership(row)
        if (!(row.incomingText instanceof Uint8Array)) invalid()
        const incomingText = Buffer.from(row.incomingText),
          decoded = incomingText.toString('utf8')
        if (!Buffer.from(decoded, 'utf8').equals(incomingText)) invalid()
        const key = {
          ...scope,
          tableId,
          incomingId1: number(row.incomingId1),
          incomingId2: number(row.incomingId2),
          incomingText,
          revision: previous.revision
        }
        if (key.incomingId1 < 1) invalid()
        snapshotJournalRevision(row.retiredAtRevision)
        let removed = false
        if (
          previous.created === 1 &&
          tableId !== 8 &&
          tableId !== 9 &&
          !(await associated(trx, scope.userId, tableId, previous, mysql))
        ) {
          const actual = await readSnapshotJournalNativeCustody(trx, tableId, scope.userId, previous, allocation)
          if (
            actual !== undefined &&
            actual.fingerprint === previous.fingerprint &&
            actual.generation === previous.generation
          ) {
            let parentsMatch = true
            for (const parent of parseSnapshotJournalNativeParents(previous.parentsJson)) {
              const current = await readSnapshotJournalNativeCustody(
                trx,
                parent.tableId,
                scope.userId,
                parent.local,
                allocation
              )
              if (
                current === undefined ||
                current.fingerprint !== parent.fingerprint ||
                current.generation !== parent.generation
              ) {
                parentsMatch = false
                break
              }
            }
            if (parentsMatch && !(await snapshotJournalNativeHasReferences(trx, scope.userId, actual))) {
              const [entity] = snapshotJournalNativeEntityKeys[tableId]
              if ((await trx(brc38ImportTargetIndexes[entity][0]).where(actual.key).delete()) !== 1) invalid()
              removed = true
              deleted++
            }
          }
        }
        if (!removed) retained++
        if (
          (await trx(retirements)
            .where({ ...key, ...storedSnapshotJournalMembership(previous), retiredAtRevision: row.retiredAtRevision })
            .delete()) !== 1
        )
          invalid()
        const counts: Array<{ retirements: unknown; maximumRetirements: unknown }> = await trx(budgets)
          .where(scope)
          .select(bounded(trx, 'retirements', 2147483647, mysql), bounded(trx, 'maximumRetirements', 2147483647, mysql))
          .limit(2)
        if (counts.length !== 1) invalid()
        const pending = number(counts[0].retirements, 2147483647),
          capacity = number(counts[0].maximumRetirements, 2147483647)
        if (
          pending < 1 ||
          pending > capacity ||
          (await trx(budgets)
            .where({ ...scope, retirements: pending, maximumRetirements: capacity })
            .update({ retirements: pending - 1 })) !== 1
        )
          invalid()
        processed++
      }
    }
    const identityQueue = 'snapshot_reconciliation_identity_retirements',
      identityBudget = 'snapshot_reconciliation_identity_retirement_budgets'
    if (processed < maximum) {
      const rows: Array<Record<string, unknown>> = await trx(identityQueue)
        .where(scope)
        .select(
          bounded(trx, 'tableId', 9, mysql),
          bounded(trx, 'incomingId', Number.MAX_SAFE_INTEGER, mysql),
          bounded(trx, 'localId', Number.MAX_SAFE_INTEGER, mysql),
          bounded(trx, 'retiredAtSequence', Number.MAX_SAFE_INTEGER, mysql),
          text(trx, 'generation', 19, mysql),
          text(trx, 'naturalIdentity', 64, mysql),
          text(trx, 'retiredBySession', 64, mysql)
        )
        .orderBy(['tableId', 'incomingId', 'generation', 'naturalIdentity', 'localId'])
        .limit(maximum - processed)
      for (const row of rows) {
        const tableId = number(row.tableId, 9),
          incomingId = number(row.incomingId),
          localId = number(row.localId),
          retiredAtSequence = number(row.retiredAtSequence)
        if (
          ![0, 1, 2, 3, 4, 5, 6, 8, 9].includes(tableId) ||
          incomingId < 1 ||
          localId < 1 ||
          typeof row.naturalIdentity !== 'string' ||
          !/^[0-9a-f]{64}$/.test(row.naturalIdentity) ||
          typeof row.retiredBySession !== 'string' ||
          !/^[0-9a-f]{64}$/.test(row.retiredBySession)
        )
          invalid()
        const generation = snapshotJournalRevision(row.generation)
        if (
          generation === '0' ||
          (await trx(identityQueue)
            .where({
              ...scope,
              tableId,
              incomingId,
              localId,
              retiredAtSequence,
              generation,
              naturalIdentity: row.naturalIdentity,
              retiredBySession: row.retiredBySession
            })
            .delete()) !== 1
        )
          invalid()
        const counts: Array<{ pendingAssociations: unknown }> = await trx(identityBudget)
          .where(scope)
          .select(bounded(trx, 'pendingAssociations', 4096, mysql))
          .limit(2)
        if (counts.length !== 1) invalid()
        const pending = number(counts[0].pendingAssociations, 4096)
        if (
          pending < 1 ||
          (await trx(identityBudget)
            .where({ ...scope, pendingAssociations: pending })
            .update({ pendingAssociations: pending - 1 })) !== 1
        )
          invalid()
        processed++
      }
    }
    const hasMembership = (await trx(retirements).where(scope).select('tableId').limit(1)).length !== 0
    const hasIdentity = (await trx(identityQueue).where(scope).select('tableId').limit(1)).length !== 0
    if (!hasMembership) {
      const counts: Array<{ retirements: unknown }> = await trx(budgets)
        .where(scope)
        .select(bounded(trx, 'retirements', 2147483647, mysql))
        .limit(2)
      if (counts.length > 1 || (counts.length === 1 && number(counts[0].retirements) !== 0)) invalid()
    }
    if (!hasIdentity) {
      const counts: Array<{ pendingAssociations: unknown }> = await trx(identityBudget)
        .where(scope)
        .select(bounded(trx, 'pendingAssociations', 4096, mysql))
        .limit(2)
      if (counts.length > 1 || (counts.length === 1 && number(counts[0].pendingAssociations) !== 0)) invalid()
    }
    return { processed, deleted, retained, complete: (identityOnly || !hasMembership) && !hasIdentity }
  })
}
