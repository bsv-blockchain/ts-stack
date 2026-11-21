import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  prepareSnapshotJournalIdentityLedger,
  type SnapshotJournalIdentityReference,
  type SnapshotJournalIdentityAssociation,
  type SnapshotJournalIdentityLimits
} from './SnapshotJournalIdentityLedger'
import {
  withSnapshotJournalDestinationWindowFence,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'

export interface SnapshotJournalIdentityTransitionLimits extends SnapshotJournalIdentityLimits {
  maximumPendingAssociations: number
}

const queue = 'snapshot_reconciliation_identity_retirements'
const budgets = 'snapshot_reconciliation_identity_retirement_budgets'

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or exhausted journal identity retirement custody')
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/.test(value)) value = Number(value)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}

function mysql(k: Knex): boolean {
  if (!k.isTransaction) invalid()
  if (k.client.config.client === 'sqlite3' || k.client.config.client === 'better-sqlite3' || isOwnedNativeSqlite(k))
    return false
  if (k.client.config.client === 'mysql' || k.client.config.client === 'mysql2') return true
  return invalid()
}

function boundedNumber(k: Knex, field: string, maximum: number, remote: boolean): Knex.Raw {
  return k.raw(
    remote
      ? 'CASE WHEN octet_length(cast(?? as char)) BETWEEN 1 AND 16 AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='integer' AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??",
    [field, field, maximum, field, field]
  )
}

function boundedSession(k: Knex, remote: boolean): Knex.Raw {
  return k.raw(
    remote
      ? 'CASE WHEN octet_length(??)=64 THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='text' AND length(cast(?? as blob))=64 THEN ?? ELSE NULL END AS ??",
    remote
      ? ['retiredBySession', 'retiredBySession', 'retiredBySession']
      : ['retiredBySession', 'retiredBySession', 'retiredBySession', 'retiredBySession']
  )
}

/** Auxiliary DDL only. Real schema ownership, migrations, shared storage quota
 * and retirement consumption belong to the complete reconciliation lifecycle. */
export function snapshotJournalIdentityRetirementsDdl(k: Knex): string[] {
  const client = k.client.config.client
  if (!['better-sqlite3', 'sqlite3', 'mysql', 'mysql2'].includes(String(client)) && !isOwnedNativeSqlite(k)) invalid()
  const suffix =
    client === 'mysql' || client === 'mysql2'
      ? ' ENGINE=InnoDB DEFAULT CHARACTER SET ascii COLLATE ascii_bin ROW_FORMAT=DYNAMIC'
      : ''
  return [
    'CREATE TABLE ' +
      budgets +
      '(userId BIGINT NOT NULL,lineage VARCHAR(64) NOT NULL,maximumPendingAssociations INTEGER NOT NULL,pendingAssociations INTEGER NOT NULL,PRIMARY KEY(userId,lineage))' +
      suffix,
    'CREATE TABLE ' +
      queue +
      '(userId BIGINT NOT NULL,lineage VARCHAR(64) NOT NULL,tableId INTEGER NOT NULL,incomingId BIGINT NOT NULL,generation VARCHAR(19) NOT NULL,naturalIdentity VARCHAR(64) NOT NULL,localId BIGINT NOT NULL,retiredBySession VARCHAR(64) NOT NULL,retiredAtSequence BIGINT NOT NULL,PRIMARY KEY(userId,lineage,tableId,incomingId,generation,naturalIdentity,localId))' +
      suffix
  ]
}

/** Preserve replaced associations BEFORE the active ledger changes. One nested
 * SQL savepoint contains retirement custody, semantic callback work and ID-map
 * persistence, even if an outer caller catches a failure. The caller's fenced
 * window/checkpoint and successful OUTER commit still precede acknowledgment.
 * Queue records authorize no deletion: later semantic retirement must check
 * current associations, independent ownership and references in reverse order. */
export async function applySnapshotJournalIdentityTransition<T>(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  inputReferences: readonly SnapshotJournalIdentityReference[],
  inputLimits: SnapshotJournalIdentityTransitionLimits,
  merge: (
    trx: Knex,
    associations: ReadonlyMap<string, SnapshotJournalIdentityAssociation>,
    previous: ReadonlyMap<string, SnapshotJournalIdentityAssociation>
  ) => Promise<{ assignments: ReadonlyMap<string, number>; result: T }>,
  validateAssociation?: (
    trx: Knex,
    reference: SnapshotJournalIdentityReference,
    association: SnapshotJournalIdentityAssociation
  ) => Promise<boolean>
): Promise<T> {
  const remote = mysql(k)
  if (
    typeof inputLimits.maximumMappings !== 'number' ||
    typeof inputLimits.maximumPendingAssociations !== 'number' ||
    typeof merge !== 'function'
  )
    invalid()
  if (!Array.isArray(inputReferences) || inputReferences.length > 256) invalid()
  const references = inputReferences.map(reference => ({
    tableId: reference.tableId,
    incomingId: reference.incomingId,
    generation: reference.generation,
    naturalIdentity: reference.naturalIdentity,
    required: reference.required
  }))
  const binding = { ...input, source: { ...input.source }, receipt: { ...input.receipt } }
  const checkpoint = {
    ...expected,
    ...(expected.after === undefined ? {} : { after: { ...expected.after } })
  }
  if (inputLimits.version !== undefined && inputLimits.version !== 2) invalid()
  const maximumMappings = integer(inputLimits.maximumMappings, 1, inputLimits.version === 2 ? 2147483647 : 4096)
  const maximumPendingAssociations = integer(inputLimits.maximumPendingAssociations, 1, 4096)
  return await withSnapshotJournalDestinationWindowFence(k, binding, checkpoint, async trx => {
    const identity = await prepareSnapshotJournalIdentityLedger(
      trx,
      binding,
      checkpoint,
      references,
      {
        maximumMappings,
        ...(inputLimits.version === undefined ? {} : { version: inputLimits.version })
      },
      validateAssociation
    )
    const scope = { userId: binding.destinationUserId, lineage: identity.lineage }
    const rows: Array<Record<string, unknown>> = await trx(budgets)
      .select(
        boundedNumber(trx, 'maximumPendingAssociations', 4096, remote),
        boundedNumber(trx, 'pendingAssociations', maximumPendingAssociations, remote)
      )
      .where(scope)
      .limit(2)
    if (rows.length > 1) invalid()
    if (rows.length === 0) {
      if ((await trx(queue).select('incomingId').where(scope).limit(1)).length !== 0) invalid()
      await trx(budgets).insert({ ...scope, maximumPendingAssociations, pendingAssociations: 0 })
    } else if (integer(rows[0].maximumPendingAssociations, 1, 4096) !== maximumPendingAssociations) invalid()
    const priorCount = rows.length === 0 ? 0 : integer(rows[0].pendingAssociations, 0, maximumPendingAssociations)
    let nextCount = priorCount
    for (const [reference, association] of identity.previous) {
      const match = /^(0|1|2|3|4|5|6|8|9):([1-9]\d{0,15})$/.exec(reference)
      if (match === null) invalid()
      const selected = {
        ...scope,
        tableId: Number(match[1]),
        incomingId: integer(match[2], 1, Number.MAX_SAFE_INTEGER),
        ...association
      }
      const existing: Array<Record<string, unknown>> = await trx(queue)
        .select(boundedSession(trx, remote), boundedNumber(trx, 'retiredAtSequence', Number.MAX_SAFE_INTEGER, remote))
        .where(selected)
        .limit(2)
      if (existing.length > 1) invalid()
      if (existing.length === 1) {
        if (typeof existing[0].retiredBySession !== 'string' || !/^[0-9a-f]{64}$/.test(existing[0].retiredBySession))
          invalid()
        integer(existing[0].retiredAtSequence, 0, Number.MAX_SAFE_INTEGER)
        continue
      }
      if (nextCount === maximumPendingAssociations) invalid()
      await trx(queue).insert({
        ...selected,
        retiredBySession: checkpoint.sessionId,
        retiredAtSequence: checkpoint.sequence
      })
      nextCount++
    }
    if (
      (await trx(budgets)
        .where({ ...scope, maximumPendingAssociations, pendingAssociations: priorCount })
        .update({ pendingAssociations: nextCount })) !== 1
    )
      invalid()
    const merged = await merge(trx, identity.associations, identity.previous)
    await identity.persist(merged.assignments)
    return merged.result
  })
}
