import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { Knex } from 'knex'
import { snapshotJournalAssociationGeneration } from './SnapshotJournalLineage'
import type { SyncMap } from '../../schema/entities/EntityBase'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import type { SnapshotJournalDelta } from './SnapshotJournalDeltaPage'
import {
  snapshotJournalRevision,
  compareSnapshotJournalRevisions,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'
import { snapshotJournalIdentityLineage, type SnapshotJournalIdentityTable } from './SnapshotJournalIdentityLedger'
import { snapshotJournalIdentityEntities } from './SnapshotJournalDestinationIdentities'
import { snapshotJournalNativeEntityKeys, type SnapshotJournalAllocationBudget } from './SnapshotJournalNativeRows'
import {
  readSnapshotJournalNativeCustody,
  readSnapshotJournalNativeParents,
  parseSnapshotJournalNativeParents
} from './SnapshotJournalNativeCustody'
import {
  withSnapshotJournalDestinationWindowFence,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'

const table = 'snapshot_reconciliation_memberships'
const retirements = 'snapshot_reconciliation_membership_retirements'
const budgets = 'snapshot_reconciliation_membership_budgets'
const hash = /^[0-9a-f]{64}$/
export interface SnapshotJournalMembershipLimits {
  maximumMemberships: number
  maximumRetirements: number
}
export interface SnapshotJournalLocalKey {
  id1: number
  id2: number
  exactText: string
}
export interface SnapshotJournalMembership extends SnapshotJournalLocalKey {
  sourceGeneration: string
  seenSession: string
  revision: SnapshotJournalRevision
  fingerprint: string
  generation: string
  parentsJson: string
  created: number
}
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid, stale or exhausted journal membership custody')
}
function number(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/.test(value)) value = Number(value)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}
function remote(k: Knex): boolean {
  if (!k.isTransaction) invalid()
  if (['mysql', 'mysql2'].includes(String(k.client.config.client))) return true
  if (['sqlite3', 'better-sqlite3'].includes(String(k.client.config.client)) || isOwnedNativeSqlite(k)) return false
  return invalid()
}
function sourceKey(binding: SnapshotJournalDestinationBinding, tableId: number, change: SnapshotJournalDelta) {
  if (tableId === 7 || number(tableId, 0, 12) !== tableId) invalid()
  const { id1, id2, exactText, revision } = change.metadata
  number(id1, 1)
  number(id2)
  const bytes = Buffer.from(exactText, 'utf8')
  if (bytes.length > 400 || bytes.toString('utf8') !== exactText) invalid()
  if (tableId === 12 ? id2 !== 0 : exactText !== '' || (tableId >= 10 ? id2 < 1 : id2 !== 0)) invalid()
  if (compareSnapshotJournalRevisions(snapshotJournalRevision(revision), binding.receipt.highWater) > 0) invalid()
  return {
    userId: binding.destinationUserId,
    lineage: snapshotJournalIdentityLineage(binding),
    tableId,
    incomingId1: id1,
    incomingId2: id2,
    incomingText: bytes
  }
}
export function snapshotJournalLocalMembershipKey(
  tableId: number,
  change: SnapshotJournalDelta,
  map: SyncMap
): SnapshotJournalLocalKey {
  const incoming = change.metadata
  if (tableId < 10) {
    const entity = snapshotJournalIdentityEntities[tableId as SnapshotJournalIdentityTable]
    if (entity === undefined) invalid()
    return { id1: number(map[entity].idMap[incoming.id1], 1), id2: 0, exactText: '' }
  }
  if (tableId === 10)
    return {
      id1: number(map.txLabel.idMap[incoming.id1], 1),
      id2: number(map.transaction.idMap[incoming.id2], 1),
      exactText: ''
    }
  if (tableId === 11)
    return {
      id1: number(map.outputTag.idMap[incoming.id1], 1),
      id2: number(map.output.idMap[incoming.id2], 1),
      exactText: ''
    }
  if (tableId === 12)
    return { id1: number(map.certificate.idMap[incoming.id1], 1), id2: 0, exactText: incoming.exactText }
  return invalid()
}

/** Source associations include composite relationships, not just numeric IDs.
 * A retirement intent preserves the exact previous destination key/postimage.
 * Neither a row, receipt nor this DDL authorizes deleting a native object. */
export function snapshotJournalMembershipDdl(k: Knex): string[] {
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  if (!mysql && !['sqlite3', 'better-sqlite3'].includes(String(k.client.config.client)) && !isOwnedNativeSqlite(k))
    invalid()
  const binary = mysql ? 'VARBINARY(400)' : 'BLOB'
  const suffix = mysql ? ' ENGINE=InnoDB DEFAULT CHARACTER SET ascii COLLATE ascii_bin ROW_FORMAT=DYNAMIC' : ''
  const scope =
    'userId BIGINT NOT NULL,lineage VARCHAR(64) NOT NULL,tableId INTEGER NOT NULL,incomingId1 BIGINT NOT NULL,incomingId2 BIGINT NOT NULL,incomingText ' +
    binary +
    ' NOT NULL'
  const value =
    'revision VARCHAR(19) NOT NULL,id1 BIGINT NOT NULL,id2 BIGINT NOT NULL,exactText ' +
    binary +
    ' NOT NULL,fingerprint VARCHAR(64) NOT NULL,generation VARCHAR(64) NOT NULL,parentsJson TEXT NOT NULL,created INTEGER NOT NULL,seenSession VARCHAR(64) NOT NULL,sourceGeneration VARCHAR(64) NOT NULL'
  return [
    'CREATE TABLE ' +
      budgets +
      '(userId BIGINT NOT NULL,lineage VARCHAR(64) NOT NULL,maximumMemberships INTEGER NOT NULL,maximumRetirements INTEGER NOT NULL,memberships INTEGER NOT NULL,retirements INTEGER NOT NULL,PRIMARY KEY(userId,lineage))' +
      suffix,
    'CREATE TABLE ' +
      table +
      '(' +
      scope +
      ',' +
      value +
      ',PRIMARY KEY(userId,lineage,tableId,incomingId1,incomingId2,incomingText))' +
      suffix,
    'CREATE TABLE ' +
      retirements +
      '(' +
      scope +
      ',' +
      value +
      ',retiredAtRevision VARCHAR(19) NOT NULL,PRIMARY KEY(userId,lineage,tableId,incomingId1,incomingId2,incomingText,revision))' +
      suffix,
    'CREATE INDEX snapshot_reconciliation_membership_target ON ' + table + '(userId,tableId,id1,id2,exactText)',
    'CREATE INDEX snapshot_reconciliation_membership_scan ON ' +
      table +
      '(userId,lineage,seenSession,tableId,incomingId1,incomingId2,incomingText)',
    'CREATE INDEX snapshot_reconciliation_membership_retirement_order ON ' +
      retirements +
      '(userId,lineage,tableId,incomingId1,incomingId2,incomingText,revision)'
  ]
}
function boundedNumber(k: Knex, field: string, maximum: number, mysql: boolean): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(cast(?? as char)) BETWEEN 1 AND 16 AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='integer' AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??",
    [field, field, maximum, field, field]
  )
}
function boundedText(k: Knex, field: string, maximum: number, mysql: boolean): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(??)<=? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='text' AND length(cast(?? as blob))<=? THEN ?? ELSE NULL END AS ??",
    mysql ? [field, maximum, field, field] : [field, field, maximum, field, field]
  )
}
export function snapshotJournalMembershipProjections(k: Knex, mysql: boolean): Knex.Raw[] {
  return [
    boundedNumber(k, 'id1', Number.MAX_SAFE_INTEGER, mysql),
    boundedNumber(k, 'id2', Number.MAX_SAFE_INTEGER, mysql),
    boundedNumber(k, 'created', 1, mysql),
    boundedText(k, 'revision', 19, mysql),
    boundedText(k, 'fingerprint', 64, mysql),
    boundedText(k, 'generation', 64, mysql),
    boundedText(k, 'parentsJson', 4096, mysql),
    boundedText(k, 'seenSession', 64, mysql),
    boundedText(k, 'sourceGeneration', 64, mysql),
    k.raw(
      mysql
        ? 'CASE WHEN octet_length(??)<=400 THEN ?? ELSE NULL END AS ??'
        : "CASE WHEN typeof(??)='blob' AND length(??)<=400 THEN ?? ELSE NULL END AS ??",
      mysql ? ['exactText', 'exactText', 'exactText'] : ['exactText', 'exactText', 'exactText', 'exactText']
    )
  ]
}
export function parseSnapshotJournalMembership(row: Record<string, unknown>): SnapshotJournalMembership {
  if (
    !(row.exactText instanceof Uint8Array) ||
    typeof row.fingerprint !== 'string' ||
    !hash.test(row.fingerprint) ||
    typeof row.generation !== 'string' ||
    !hash.test(row.generation) ||
    typeof row.parentsJson !== 'string' ||
    typeof row.seenSession !== 'string' ||
    !hash.test(row.seenSession) ||
    typeof row.sourceGeneration !== 'string' ||
    !hash.test(row.sourceGeneration)
  )
    invalid()
  parseSnapshotJournalNativeParents(row.parentsJson)
  const bytes = Buffer.from(row.exactText)
  const exactText = bytes.toString('utf8')
  if (bytes.length > 400 || !Buffer.from(exactText, 'utf8').equals(bytes)) invalid()
  return {
    id1: number(row.id1, 1),
    id2: number(row.id2),
    exactText,
    revision: snapshotJournalRevision(row.revision),
    fingerprint: row.fingerprint,
    generation: row.generation,
    parentsJson: row.parentsJson,
    created: number(row.created, 0, 1),
    seenSession: row.seenSession,
    sourceGeneration: row.sourceGeneration
  }
}
export function storedSnapshotJournalMembership(value: SnapshotJournalMembership) {
  return { ...value, exactText: Buffer.from(value.exactText, 'utf8') }
}

/** Observe the previous association's ACTUAL row before semantic merge. A
 * later no-op merge must not adopt a locally changed postimage as source-owned. */
export async function readSnapshotJournalMembershipPreimage(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  tableId: number,
  change: SnapshotJournalDelta,
  allocation: SnapshotJournalAllocationBudget
): Promise<{ fingerprint: string; generation: string } | undefined> {
  const mysql = remote(k)
  const rows: Array<Record<string, unknown>> = await k(table)
    .where(sourceKey(binding, tableId, change))
    .select(snapshotJournalMembershipProjections(k, mysql))
    .limit(2)
  if (rows.length > 1) invalid()
  if (!rows.length) return undefined
  const previous = parseSnapshotJournalMembership(rows[0])
  const actual = await readSnapshotJournalNativeCustody(k, tableId, binding.destinationUserId, previous, allocation)
  return actual === undefined ? undefined : { fingerprint: actual.fingerprint, generation: actual.generation }
}

/** A replaced source may renumber its IDs. Creation ownership follows only an
 * independently observed unchanged native preimage in the SAME profile lineage,
 * never an incoming ID or a recorded source-generation digest alone. */
export async function readSnapshotJournalInheritedMembershipPreimage(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  tableId: number,
  row: Readonly<Record<string, unknown>>,
  allocation: SnapshotJournalAllocationBudget
): Promise<{ fingerprint: string; generation: string; inheritedCreated: true } | undefined> {
  if (binding.lineageVersion !== 2 || tableId === 7) return undefined
  const mysql = remote(k),
    keys = snapshotJournalNativeEntityKeys[tableId]?.[1]
  if (keys === undefined) invalid()
  const local = {
    id1: number(row[keys[0]], 1),
    id2: tableId === 10 ? number(row.transactionId, 1) : tableId === 11 ? number(row.outputId, 1) : 0,
    exactText: tableId === 12 ? row.fieldName : ''
  }
  if (typeof local.exactText !== 'string') invalid()
  const actual = await readSnapshotJournalNativeCustody(
    k,
    tableId,
    binding.destinationUserId,
    { ...local, exactText: local.exactText },
    allocation
  )
  if (actual === undefined) return undefined
  const parentsJson = JSON.stringify(
    await readSnapshotJournalNativeParents(k, actual, binding.destinationUserId, allocation)
  )
  parseSnapshotJournalNativeParents(parentsJson)
  const query = k
    .from(
      k.raw(
        mysql
          ? 'snapshot_reconciliation_memberships FORCE INDEX (snapshot_reconciliation_membership_target)'
          : 'snapshot_reconciliation_memberships INDEXED BY snapshot_reconciliation_membership_target'
      )
    )
    .where({
      userId: binding.destinationUserId,
      lineage: snapshotJournalIdentityLineage(binding),
      tableId,
      id1: local.id1,
      id2: local.id2,
      exactText: Buffer.from(local.exactText, 'utf8'),
      created: 1,
      fingerprint: actual.fingerprint,
      generation: actual.generation,
      parentsJson
    })
    .select('created')
    .limit(1)
  if (mysql) query.forUpdate().noWait()
  if (!(await query).length) return undefined
  return { fingerprint: actual.fingerprint, generation: actual.generation, inheritedCreated: true }
}

/** Postimage persistence or withdrawal shares the semantic row's savepoint and
 * promotion cursor. Duplicate scope/physical events are idempotent; older events
 * cannot erase a later association. Cleanup is a separate reverse-order pass. */
export async function updateSnapshotJournalMembership(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  tableId: number,
  change: SnapshotJournalDelta,
  local: SnapshotJournalLocalKey | undefined,
  inserted: boolean,
  limits: SnapshotJournalMembershipLimits,
  allocation: SnapshotJournalAllocationBudget,
  preimage?: { fingerprint: string; generation: string; inheritedCreated?: true }
): Promise<void> {
  const mysql = remote(k),
    key = sourceKey(binding, tableId, change)
  const maximumMemberships = number(limits.maximumMemberships, 1, 2147483647)
  const maximumRetirements = number(limits.maximumRetirements, 1, 2147483647)
  return await withSnapshotJournalDestinationWindowFence(k, binding, expected, async trx => {
    const scope = { userId: key.userId, lineage: key.lineage }
    const rows: Array<Record<string, unknown>> = await trx(budgets)
      .where(scope)
      .select(
        boundedNumber(trx, 'maximumMemberships', 2147483647, mysql),
        boundedNumber(trx, 'maximumRetirements', 2147483647, mysql),
        boundedNumber(trx, 'memberships', maximumMemberships, mysql),
        boundedNumber(trx, 'retirements', maximumRetirements, mysql)
      )
      .limit(2)
    if (rows.length > 1) invalid()
    if (rows.length === 0) {
      if (
        (await trx(table).where(scope).select('tableId').limit(1)).length ||
        (await trx(retirements).where(scope).select('tableId').limit(1)).length
      )
        invalid()
      await trx(budgets).insert({ ...scope, maximumMemberships, maximumRetirements, memberships: 0, retirements: 0 })
    } else if (
      number(rows[0].maximumMemberships) !== maximumMemberships ||
      number(rows[0].maximumRetirements) !== maximumRetirements
    )
      invalid()
    const counts = {
      memberships: rows.length ? number(rows[0].memberships) : 0,
      retirements: rows.length ? number(rows[0].retirements) : 0
    }
    const previousRows: Array<Record<string, unknown>> = await trx(table)
      .where(key)
      .select(snapshotJournalMembershipProjections(trx, mysql))
      .limit(2)
    if (previousRows.length > 1) invalid()
    const previous = previousRows.length ? parseSnapshotJournalMembership(previousRows[0]) : undefined
    const sourceGeneration = snapshotJournalAssociationGeneration(binding)
    const revision = snapshotJournalRevision(change.metadata.revision)
    const currentGeneration = previous?.sourceGeneration === sourceGeneration
    if (previous !== undefined && currentGeneration && compareSnapshotJournalRevisions(previous.revision, revision) > 0)
      invalid()
    let next: SnapshotJournalMembership | undefined
    if (change.present) {
      if (local === undefined) invalid()
      const actual = await readSnapshotJournalNativeCustody(
        trx,
        tableId,
        binding.destinationUserId,
        { ...local, exactText: local.exactText },
        allocation
      )
      if (actual === undefined) invalid()
      const parentsJson = JSON.stringify(
        await readSnapshotJournalNativeParents(trx, actual, binding.destinationUserId, allocation)
      )
      parseSnapshotJournalNativeParents(parentsJson)
      const sameTarget =
        previous !== undefined &&
        previous.id1 === local.id1 &&
        previous.id2 === local.id2 &&
        previous.exactText === local.exactText
      next = {
        ...local,
        revision,
        sourceGeneration,
        fingerprint: actual.fingerprint,
        generation: actual.generation,
        parentsJson,
        seenSession: expected.sessionId,
        created: inserted
          ? 1
          : sameTarget &&
              previous.generation === actual.generation &&
              preimage?.generation === previous.generation &&
              preimage.fingerprint === previous.fingerprint
            ? previous.created
            : preimage?.inheritedCreated === true && preimage.generation === actual.generation
              ? 1
              : 0
      }
      if (
        previous !== undefined &&
        currentGeneration &&
        previous.revision === revision &&
        (!sameTarget ||
          previous.fingerprint !== next.fingerprint ||
          previous.generation !== next.generation ||
          previous.parentsJson !== next.parentsJson ||
          previous.created !== next.created)
      )
        invalid()
    } else if (local !== undefined || inserted) invalid()
    const retire =
      previous !== undefined &&
      (next === undefined ||
        previous.id1 !== next.id1 ||
        previous.id2 !== next.id2 ||
        previous.exactText !== next.exactText ||
        previous.generation !== next.generation)
    let retired = counts.retirements
    if (retire) {
      const intent = { ...key, ...storedSnapshotJournalMembership(previous) }
      const exists: Array<{ revision: unknown }> = await trx(retirements)
        .where({ ...key, revision: previous.revision })
        .select('revision')
        .limit(2)
      if (exists.length > 1) invalid()
      if (!exists.length) {
        if (retired >= maximumRetirements) invalid()
        await trx(retirements).insert({ ...intent, retiredAtRevision: revision })
        retired++
      }
    }
    const count =
      counts.memberships +
      (previous === undefined && next !== undefined ? 1 : 0) -
      (previous !== undefined && next === undefined ? 1 : 0)
    if (count < 0 || count > maximumMemberships) invalid()
    if (previous === undefined && next !== undefined)
      await trx(table).insert({ ...key, ...storedSnapshotJournalMembership(next) })
    else if (previous !== undefined) {
      const query = trx(table).where({ ...key, ...storedSnapshotJournalMembership(previous) })
      if ((next === undefined ? await query.delete() : await query.update(storedSnapshotJournalMembership(next))) !== 1)
        invalid()
    }
    if (
      (await trx(budgets)
        .where({ ...scope, maximumMemberships, maximumRetirements, ...counts })
        .update({ memberships: count, retirements: retired })) !== 1
    )
      invalid()
  })
}
