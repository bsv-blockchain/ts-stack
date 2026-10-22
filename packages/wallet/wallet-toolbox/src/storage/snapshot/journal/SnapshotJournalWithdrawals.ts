import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import type { SnapshotJournalDelta } from './SnapshotJournalDeltaPage'
import { snapshotJournalIdentityLineage } from './SnapshotJournalIdentityLedger'
import { snapshotJournalAssociationGeneration } from './SnapshotJournalLineage'
import { snapshotJournalRevision, compareSnapshotJournalRevisions } from './SnapshotJournalRevision'
import {
  withSnapshotJournalDestinationWindowFence,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'
import {
  updateSnapshotJournalMembership,
  snapshotJournalMembershipProjections,
  parseSnapshotJournalMembership,
  type SnapshotJournalMembershipLimits
} from './SnapshotJournalMemberships'
import type { SnapshotJournalAllocationBudget } from './SnapshotJournalNativeRows'
import { snapshotSyncTables } from '../SnapshotSync'

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or stale journal withdrawal')
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

/** Record the old native key/postimage before removing its source association.
 * This never deletes a native entity. Reverse-order ownership/reference-aware
 * cleanup decides that separately; global proof/request rows remain shared.
 * A duplicate withdrawal or lost committed ACK cannot decrement counts twice. */
export async function withdrawSnapshotJournalEntity(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  tableId: number,
  change: SnapshotJournalDelta,
  limits: SnapshotJournalMembershipLimits,
  allocation: SnapshotJournalAllocationBudget
): Promise<void> {
  if (change.present || tableId === 7 || !Number.isSafeInteger(tableId) || tableId < 0 || tableId > 12) invalid()
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  await withSnapshotJournalDestinationWindowFence(k, binding, expected, async trx => {
    await updateSnapshotJournalMembership(trx, binding, expected, tableId, change, undefined, false, limits, allocation)
    if (tableId >= 10) return
    const scope = { userId: binding.destinationUserId, lineage: snapshotJournalIdentityLineage(binding) }
    const key = { ...scope, tableId, incomingId: change.metadata.id1 }
    const rows: Array<Record<string, unknown>> = await trx('snapshot_reconciliation_identity_maps')
      .where(key)
      .select(
        bounded(trx, 'localId', Number.MAX_SAFE_INTEGER, mysql),
        trx.raw(
          mysql
            ? 'CASE WHEN octet_length(generation) BETWEEN 1 AND 19 THEN generation ELSE NULL END AS generation'
            : "CASE WHEN typeof(generation)='text' AND length(generation) BETWEEN 1 AND 19 THEN generation ELSE NULL END AS generation"
        ),
        trx.raw(
          mysql
            ? 'CASE WHEN octet_length(naturalIdentity)=64 THEN naturalIdentity ELSE NULL END AS naturalIdentity'
            : "CASE WHEN typeof(naturalIdentity)='text' AND length(naturalIdentity)=64 THEN naturalIdentity ELSE NULL END AS naturalIdentity"
        ),
        trx.raw('substr(sourceGeneration,1,65) AS sourceGeneration'),
        trx.raw('substr(seenSession,1,65) AS seenSession')
      )
      .limit(2)
    if (rows.length > 1) invalid()
    if (!rows.length) return
    const previous = {
      localId: number(rows[0].localId),
      generation: snapshotJournalRevision(rows[0].generation),
      naturalIdentity: rows[0].naturalIdentity,
      sourceGeneration: rows[0].sourceGeneration,
      seenSession: rows[0].seenSession
    }
    if (
      previous.localId < 1 ||
      previous.generation === '0' ||
      typeof previous.naturalIdentity !== 'string' ||
      !/^[0-9a-f]{64}$/.test(previous.naturalIdentity) ||
      typeof previous.sourceGeneration !== 'string' ||
      !/^[0-9a-f]{64}$/.test(previous.sourceGeneration) ||
      typeof previous.seenSession !== 'string' ||
      !/^[0-9a-f]{64}$/.test(previous.seenSession) ||
      (previous.sourceGeneration === snapshotJournalAssociationGeneration(binding) &&
        compareSnapshotJournalRevisions(previous.generation, change.metadata.revision) > 0)
    )
      invalid()
    const budgets: Array<Record<string, unknown>> = await trx('snapshot_reconciliation_identity_budgets')
      .where(scope)
      .select(bounded(trx, 'mappings', 2147483647, mysql), bounded(trx, 'maximumMappings', 2147483647, mysql))
      .limit(2)
    if (budgets.length !== 1) invalid()
    const mappings = number(budgets[0].mappings, 2147483647),
      maximumMappings = number(budgets[0].maximumMappings, 2147483647)
    if (
      mappings < 1 ||
      mappings > maximumMappings ||
      (await trx('snapshot_reconciliation_identity_maps')
        .where({ ...key, ...previous })
        .delete()) !== 1 ||
      (await trx('snapshot_reconciliation_identity_budgets')
        .where({ ...scope, mappings, maximumMappings })
        .update({ mappings: mappings - 1 })) !== 1
    )
      invalid()
  })
}

/** Only after all present rows from one coherent full source have been applied,
 * retire associations that were not observed in this exact scan. Absence from
 * an incremental page, an interrupted intake or a different lineage cannot
 * authorize withdrawal. The original ownership/reference cleanup still decides
 * whether a native row can be removed. This pass commits at most32 intents.
 */
export async function withdrawUnseenSnapshotJournalMemberships(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  limits: SnapshotJournalMembershipLimits,
  allocation: SnapshotJournalAllocationBudget,
  maximum = 32
): Promise<{ withdrawn: number; complete: boolean }> {
  if (
    binding.bootstrap !== true ||
    expected.phase !== 'promoting' ||
    expected.tableIndex !== snapshotSyncTables.length - 1 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 32
  )
    invalid()
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  return await withSnapshotJournalDestinationWindowFence(k, binding, expected, async trx => {
    const scope = { userId: binding.destinationUserId, lineage: snapshotJournalIdentityLineage(binding) }
    const query = trx
      .from(
        trx.raw(
          mysql
            ? 'snapshot_reconciliation_memberships FORCE INDEX (snapshot_reconciliation_membership_scan)'
            : 'snapshot_reconciliation_memberships INDEXED BY snapshot_reconciliation_membership_scan'
        )
      )
      .where(scope)
      .whereNot('seenSession', expected.sessionId)
      .select(
        ...snapshotJournalMembershipProjections(trx, mysql),
        bounded(trx, 'tableId', 12, mysql),
        bounded(trx, 'incomingId1', Number.MAX_SAFE_INTEGER, mysql),
        bounded(trx, 'incomingId2', Number.MAX_SAFE_INTEGER, mysql),
        trx.raw(
          mysql
            ? 'CASE WHEN octet_length(incomingText)<=400 THEN incomingText ELSE NULL END AS incomingText'
            : "CASE WHEN typeof(incomingText)='blob' AND length(incomingText)<=400 THEN incomingText ELSE NULL END AS incomingText"
        )
      )
      .orderBy(['seenSession', 'tableId', 'incomingId1', 'incomingId2', 'incomingText'])
      .limit(maximum)
    if (mysql) query.forUpdate().noWait()
    const rows: Array<Record<string, unknown>> = await query
    for (const row of rows) {
      const previous = parseSnapshotJournalMembership(row)
      if (!(row.incomingText instanceof Uint8Array) || previous.seenSession === expected.sessionId) invalid()
      const bytes = Buffer.from(row.incomingText),
        exactText = bytes.toString('utf8')
      if (!Buffer.from(exactText, 'utf8').equals(bytes)) invalid()
      const tableId = number(row.tableId, 12),
        id1 = number(row.incomingId1),
        id2 = number(row.incomingId2)
      if (
        tableId === 7 ||
        id1 < 1 ||
        (previous.sourceGeneration === snapshotJournalAssociationGeneration(binding) &&
          compareSnapshotJournalRevisions(previous.revision, binding.receipt.highWater) > 0)
      )
        invalid()
      await withdrawSnapshotJournalEntity(
        trx,
        binding,
        expected,
        tableId,
        {
          present: false,
          metadata: { revision: binding.receipt.highWater, id1, id2, exactText, present: false }
        },
        limits,
        allocation
      )
    }
    const remaining = await trx('snapshot_reconciliation_memberships')
      .where(scope)
      .whereNot('seenSession', expected.sessionId)
      .select('tableId')
      .limit(1)
    return { withdrawn: rows.length, complete: remaining.length === 0 }
  })
}

/** Parent-only and superseded numeric associations are DATA. After all current
 * source rows are applied, remove at most32 unobserved associations and their
 * quota charges. This neither deletes native rows nor supplies authority for
 * native cleanup; actual memberships/references still govern that decision. */
export async function withdrawUnseenSnapshotJournalIdentityMappings(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint
): Promise<boolean> {
  if (
    binding.bootstrap !== true ||
    expected.phase !== 'promoting' ||
    expected.tableIndex !== snapshotSyncTables.length - 1
  )
    invalid()
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  return await withSnapshotJournalDestinationWindowFence(k, binding, expected, async trx => {
    const scope = { userId: binding.destinationUserId, lineage: snapshotJournalIdentityLineage(binding) }
    const query = trx
      .from(
        trx.raw(
          mysql
            ? 'snapshot_reconciliation_identity_maps FORCE INDEX (snapshot_reconciliation_identity_scan)'
            : 'snapshot_reconciliation_identity_maps INDEXED BY snapshot_reconciliation_identity_scan'
        )
      )
      .where(scope)
      .whereNot('seenSession', expected.sessionId)
      .select(
        bounded(trx, 'tableId', 9, mysql),
        bounded(trx, 'incomingId', Number.MAX_SAFE_INTEGER, mysql),
        trx.raw('substr(seenSession,1,65) AS seenSession')
      )
      .orderBy(['seenSession', 'tableId', 'incomingId'])
      .limit(32)
    if (mysql) query.forUpdate().noWait()
    const rows: Array<Record<string, unknown>> = await query
    for (const row of rows) {
      const tableId = number(row.tableId, 9),
        incomingId = number(row.incomingId)
      if (
        ![0, 1, 2, 3, 4, 5, 6, 8, 9].includes(tableId) ||
        incomingId < 1 ||
        typeof row.seenSession !== 'string' ||
        !/^[0-9a-f]{64}$/.test(row.seenSession) ||
        row.seenSession === expected.sessionId
      )
        invalid()
      if (
        (await trx('snapshot_reconciliation_identity_maps')
          .where({ ...scope, tableId, incomingId, seenSession: row.seenSession })
          .delete()) !== 1
      )
        invalid()
    }
    const counts: Array<Record<string, unknown>> = await trx('snapshot_reconciliation_identity_budgets')
      .where(scope)
      .select(bounded(trx, 'mappings', 2147483647, mysql), bounded(trx, 'maximumMappings', 2147483647, mysql))
      .limit(2)
    if (counts.length > 1 || (rows.length && counts.length !== 1)) invalid()
    if (counts.length) {
      const mappings = number(counts[0].mappings, 2147483647),
        maximumMappings = number(counts[0].maximumMappings, 2147483647)
      if (
        mappings < rows.length ||
        mappings > maximumMappings ||
        (await trx('snapshot_reconciliation_identity_budgets')
          .where({ ...scope, mappings, maximumMappings })
          .update({ mappings: mappings - rows.length })) !== 1
      )
        invalid()
    }
    return !(
      await trx('snapshot_reconciliation_identity_maps')
        .where(scope)
        .whereNot('seenSession', expected.sessionId)
        .select('tableId')
        .limit(1)
    ).length
  })
}
