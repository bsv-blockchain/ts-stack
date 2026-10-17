import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { SnapshotJournalIdentityTable } from './SnapshotJournalTypes'
export type { SnapshotJournalIdentityTable } from './SnapshotJournalTypes'
import type { Knex } from 'knex'
import { snapshotJournalLineage, snapshotJournalAssociationGeneration } from './SnapshotJournalLineage'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  snapshotJournalRevision,
  compareSnapshotJournalRevisions,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'
import {
  readSnapshotJournalDestinationWindow,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'

export interface SnapshotJournalIdentityReference {
  tableId: SnapshotJournalIdentityTable
  incomingId: number
  generation: SnapshotJournalRevision
  /** Derived from the validated natural identity in the same pinned source view. */
  naturalIdentity: string
  /** Parents require an already acknowledged association of this exact identity. */
  required: boolean
}

export interface SnapshotJournalIdentityAssociation {
  generation: SnapshotJournalRevision
  naturalIdentity: string
  localId: number
}

export interface SnapshotJournalIdentityLimits {
  maximumMappings: number
  /** Explicit storage-capacity policy for integrated reconciliation. Version1
   * callers retain their original4096 limit; lookup batches stay256/128. */
  version?: 2
}

const mappings = 'snapshot_reconciliation_identity_maps'
const budgets = 'snapshot_reconciliation_identity_budgets'
const maximumReferences = 256
const tables: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 8, 9]
const hash = /^[0-9a-f]{64}$/

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid, stale or exhausted journal identity ledger')
}

function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}

function storedInteger(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/.test(value)) return integer(Number(value), minimum, maximum)
  return integer(value, minimum, maximum)
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !hash.test(value)) invalid()
  return value
}

function transaction(k: Knex): boolean {
  if (!k.isTransaction) invalid()
  const client = k.client.config.client
  if (client === 'sqlite3' || client === 'better-sqlite3' || isOwnedNativeSqlite(k)) return false
  if (client === 'mysql' || client === 'mysql2') return true
  return invalid()
}

function boundedNumber(k: Knex, field: string, minimum: number, maximum: number, mysql: boolean): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(cast(?? as char)) BETWEEN 1 AND 16 AND ?? BETWEEN ? AND ? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='integer' AND ?? BETWEEN ? AND ? THEN ?? ELSE NULL END AS ??",
    [field, field, minimum, maximum, field, field]
  )
}

function boundedText(k: Knex, field: string, minimum: number, maximum: number, mysql: boolean): Knex.Raw {
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(??) BETWEEN ? AND ? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='text' AND length(cast(?? as blob)) BETWEEN ? AND ? THEN ?? ELSE NULL END AS ??",
    mysql ? [field, minimum, maximum, field, field] : [field, field, minimum, maximum, field, field]
  )
}

function key(reference: Pick<SnapshotJournalIdentityReference, 'tableId' | 'incomingId'>): string {
  return reference.tableId + ':' + reference.incomingId
}

function same(
  left: Pick<SnapshotJournalIdentityAssociation, 'generation' | 'naturalIdentity'>,
  right: SnapshotJournalIdentityReference
): boolean {
  return left.generation === right.generation && left.naturalIdentity === right.naturalIdentity
}

/** Association namespace only. Computing it verifies no source or destination
 * authority; callers must independently fence the current transaction. */
export function snapshotJournalIdentityLineage(binding: SnapshotJournalDestinationBinding): string {
  return snapshotJournalLineage(binding)
}

/** Auxiliary DDL only; source-owned migration and shared storage quotas remain required. */
export function snapshotJournalIdentityLedgerDdl(k: Knex): string[] {
  const client = k.client.config.client
  if (!['better-sqlite3', 'sqlite3', 'mysql', 'mysql2'].includes(String(client)) && !isOwnedNativeSqlite(k)) invalid()
  const suffix =
    client === 'mysql' || client === 'mysql2'
      ? ' ENGINE=InnoDB DEFAULT CHARACTER SET ascii COLLATE ascii_bin ROW_FORMAT=DYNAMIC'
      : ''
  return [
    'CREATE TABLE ' +
      budgets +
      '(userId BIGINT NOT NULL,lineage VARCHAR(64) NOT NULL,maximumMappings INTEGER NOT NULL,mappings INTEGER NOT NULL,PRIMARY KEY(userId,lineage))' +
      suffix,
    'CREATE TABLE ' +
      mappings +
      '(userId BIGINT NOT NULL,lineage VARCHAR(64) NOT NULL,tableId INTEGER NOT NULL,incomingId BIGINT NOT NULL,generation VARCHAR(19) NOT NULL,naturalIdentity VARCHAR(64) NOT NULL,localId BIGINT NOT NULL,sourceGeneration VARCHAR(64) NOT NULL,seenSession VARCHAR(64) NOT NULL,PRIMARY KEY(userId,lineage,tableId,incomingId))' +
      suffix,
    'CREATE INDEX snapshot_reconciliation_identity_target ON ' +
      mappings +
      '(userId,tableId,localId,lineage,incomingId)',
    'CREATE INDEX snapshot_reconciliation_identity_scan ON ' +
      mappings +
      '(userId,lineage,seenSession,tableId,incomingId)'
  ]
}

/** The ledger persists an association, never an authority/schema verdict. Its
 * source generation and natural identity MUST come from the same independently
 * verified pinned source view as the staged row and its parents. No receipt or
 * hash supplied by a caller grants source authority. Retirement of an old source
 * association is distinct from deleting a potentially shared destination row. */
export async function prepareSnapshotJournalIdentityLedger(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  inputReferences: readonly SnapshotJournalIdentityReference[],
  inputLimits: SnapshotJournalIdentityLimits
): Promise<{
  lineage: string
  associations: ReadonlyMap<string, SnapshotJournalIdentityAssociation>
  /** Old identities are exposed for semantic retirement; they are never reused. */
  previous: ReadonlyMap<string, SnapshotJournalIdentityAssociation>
  persist: (assignments: ReadonlyMap<string, number>) => Promise<void>
}> {
  const mysql = transaction(k)
  const binding: SnapshotJournalDestinationBinding = {
    ...input,
    source: { ...input.source },
    receipt: { ...input.receipt }
  }
  const checkpoint: SnapshotJournalDestinationCheckpoint = {
    ...expected,
    ...(expected.after === undefined ? {} : { after: { ...expected.after } })
  }
  if (inputLimits.version !== undefined && inputLimits.version !== 2) invalid()
  const maximumCapacity = inputLimits.version === 2 ? 2147483647 : 4096
  const maximumMappings = integer(inputLimits.maximumMappings, 1, maximumCapacity)
  if (!Array.isArray(inputReferences) || inputReferences.length > maximumReferences) invalid()
  const references = inputReferences.map(reference => {
    if (!tables.includes(reference.tableId) || typeof reference.required !== 'boolean') invalid()
    const generation = snapshotJournalRevision(reference.generation)
    if (generation === '0' || compareSnapshotJournalRevisions(generation, binding.receipt.highWater) > 0) invalid()
    return {
      tableId: reference.tableId,
      incomingId: integer(reference.incomingId),
      generation,
      naturalIdentity: digest(reference.naturalIdentity),
      required: reference.required
    }
  })
  const byKey = new Map<string, SnapshotJournalIdentityReference>()
  for (const reference of references) {
    const prior = byKey.get(key(reference))
    if (prior !== undefined && (!same(prior, reference) || prior.required !== reference.required)) invalid()
    byKey.set(key(reference), reference)
  }
  async function requireCheckpoint(): Promise<void> {
    const actual = await readSnapshotJournalDestinationWindow(k, binding)
    if (
      actual === undefined ||
      actual.phase !== 'promoting' ||
      ['version', 'sessionId', 'binding', 'sequence', 'phase', 'streamIndex', 'tableIndex', 'promotionSequence'].some(
        field =>
          actual[field as keyof SnapshotJournalDestinationCheckpoint] !==
          checkpoint[field as keyof SnapshotJournalDestinationCheckpoint]
      ) ||
      actual.after?.revision !== checkpoint.after?.revision ||
      actual.after?.id1 !== checkpoint.after?.id1 ||
      actual.after?.id2 !== checkpoint.after?.id2 ||
      actual.after?.exactText !== checkpoint.after?.exactText
    )
      invalid()
  }
  await requireCheckpoint()
  // V2 shares association DATA across source generations of one profile. Each
  // record's generation must match before reuse; full replacement never treats
  // the stable lineage or old map as current source/backend/primary authority.
  const lineage = snapshotJournalIdentityLineage(binding)
  const sourceGeneration = snapshotJournalAssociationGeneration(binding)
  const scope = { userId: binding.destinationUserId, lineage }
  const budgetRows: Array<Record<string, unknown>> = await k(budgets)
    .select(
      boundedNumber(k, 'maximumMappings', 1, maximumCapacity, mysql),
      boundedNumber(k, 'mappings', 0, maximumMappings, mysql)
    )
    .where(scope)
    .limit(2)
  if (budgetRows.length > 1) invalid()
  if (budgetRows.length === 0) {
    if ((await k(mappings).select('incomingId').where(scope).limit(1)).length !== 0) invalid()
    await k(budgets).insert({ ...scope, maximumMappings, mappings: 0 })
  }
  const count = budgetRows.length === 0 ? 0 : storedInteger(budgetRows[0].mappings, 0, maximumMappings)
  if (budgetRows.length !== 0 && storedInteger(budgetRows[0].maximumMappings, 1, maximumCapacity) !== maximumMappings)
    invalid()
  const associations = new Map<string, SnapshotJournalIdentityAssociation>()
  const previous = new Map<string, SnapshotJournalIdentityAssociation>()
  const stored = new Map<string, SnapshotJournalIdentityAssociation>()
  const storedGenerations = new Map<string, { sourceGeneration: string; seenSession: string }>()
  for (const tableId of tables) {
    const requested = [...byKey.values()].filter(reference => reference.tableId === tableId)
    for (let index = 0; index < requested.length; index += 128) {
      const batch = requested.slice(index, index + 128)
      const records: Array<Record<string, unknown>> = await k(mappings)
        .select(
          boundedNumber(k, 'incomingId', 1, Number.MAX_SAFE_INTEGER, mysql),
          boundedNumber(k, 'localId', 1, Number.MAX_SAFE_INTEGER, mysql),
          boundedText(k, 'generation', 1, 19, mysql),
          boundedText(k, 'naturalIdentity', 64, 64, mysql),
          boundedText(k, 'sourceGeneration', 64, 64, mysql),
          boundedText(k, 'seenSession', 64, 64, mysql)
        )
        .where({ ...scope, tableId })
        .whereIn(
          'incomingId',
          batch.map(reference => reference.incomingId)
        )
        .limit(batch.length + 1)
      if (records.length > batch.length) invalid()
      for (const record of records) {
        const incomingId = storedInteger(record.incomingId)
        const reference = byKey.get(key({ tableId: tableId as SnapshotJournalIdentityTable, incomingId }))
        if (reference === undefined || stored.has(key(reference))) invalid()
        const association = {
          generation: snapshotJournalRevision(record.generation),
          naturalIdentity: digest(record.naturalIdentity),
          localId: storedInteger(record.localId)
        }
        const generation = {
          sourceGeneration: digest(record.sourceGeneration),
          seenSession: digest(record.seenSession)
        }
        const currentGeneration = generation.sourceGeneration === sourceGeneration
        if (
          association.generation === '0' ||
          (currentGeneration && compareSnapshotJournalRevisions(association.generation, reference.generation) > 0)
        )
          invalid()
        stored.set(key(reference), association)
        storedGenerations.set(key(reference), generation)
        if (currentGeneration && same(association, reference)) associations.set(key(reference), { ...association })
        else previous.set(key(reference), { ...association })
      }
    }
  }
  for (const reference of byKey.values()) if (reference.required && !associations.has(key(reference))) invalid()
  const newCount = [...byKey.keys()].filter(reference => !stored.has(reference)).length
  if (count + newCount > maximumMappings) invalid()
  let consumed = false
  return {
    lineage,
    associations: new Map([...associations].map(([reference, association]) => [reference, { ...association }])),
    previous: new Map([...previous].map(([reference, association]) => [reference, { ...association }])),
    persist: async inputAssignments => {
      if (consumed) invalid()
      consumed = true
      const size = Object.getOwnPropertyDescriptor(Map.prototype, 'size')?.get
      if (size === undefined || size.call(inputAssignments) !== byKey.size) invalid()
      const assignments = new Map<string, number>()
      for (const [reference, value] of Map.prototype.entries.call(inputAssignments) as IterableIterator<
        [string, number]
      >) {
        if (!byKey.has(reference)) invalid()
        assignments.set(reference, integer(value))
      }
      for (const [reference, association] of associations)
        if (assignments.get(reference) !== association.localId) invalid()
      await requireCheckpoint()
      for (const reference of byKey.values()) {
        const selected = { ...scope, tableId: reference.tableId, incomingId: reference.incomingId }
        const prior = stored.get(key(reference))
        const replacement = {
          sourceGeneration,
          seenSession: checkpoint.sessionId,
          generation: reference.generation,
          naturalIdentity: reference.naturalIdentity,
          localId: assignments.get(key(reference))!
        }
        if (prior === undefined) await k(mappings).insert({ ...selected, ...replacement })
        else if (
          (await k(mappings)
            .where({ ...selected, ...prior, ...storedGenerations.get(key(reference)) })
            .update(replacement)) !== 1
        )
          invalid()
      }
      if (
        (await k(budgets)
          .where({ ...scope, maximumMappings, mappings: count })
          .update({ mappings: count + newCount })) !== 1
      )
        invalid()
    }
  }
}
