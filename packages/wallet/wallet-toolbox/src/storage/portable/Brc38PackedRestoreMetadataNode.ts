import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { Brc38StageTable } from './Brc38SemanticStage'
import { isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { privateNativeDatabaseIdentity, privateNativeTransactionIdentity } from './Brc38PrivateNativeOwnershipNode'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import { nativePackedTextSource } from './Brc38NativePackedTextSources'
import { hasBrc38NativePackedSchema } from './Brc38NativePackedSchemaNode'
import { brc38JsonBinaryField } from './Brc38JsonBinaryFields'
import type { Brc38NativePackedWalletTable } from './Brc38NativePackedWalletNode'
import { chargeBrc38ImportDecodedBudget, type Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
import type { Brc38ImportEntityTarget } from './Brc38ImportEntityTargets'
import {
  brc38ImportTargetIndexes,
  brc38ImportTargetIndexName,
  verifyBrc38ImportTargetIndexes
} from './Brc38ImportTargetIndexes'
import {
  takeBrc38PrivatePageId,
  assertBrc38PrivatePageIdPostimage,
  type Brc38PrivatePageIds
} from './Brc38PrivatePageIdsNode'

interface Form {
  readonly sql: string
  readonly id?: string
  readonly booleans?: readonly string[]
}
const forms: Readonly<Record<Brc38StageTable, Form>> = {
  provenTxs: { sql: 'proven_txs', id: 'provenTxId' },
  outputBaskets: { sql: 'output_baskets', id: 'basketId', booleans: ['isDeleted'] },
  outputTags: { sql: 'output_tags', id: 'outputTagId', booleans: ['isDeleted'] },
  txLabels: { sql: 'tx_labels', id: 'txLabelId', booleans: ['isDeleted'] },
  transactions: { sql: 'transactions', id: 'transactionId', booleans: ['isOutgoing'] },
  outputs: { sql: 'outputs', id: 'outputId', booleans: ['spendable', 'change'] },
  txLabelMaps: { sql: 'tx_labels_map', booleans: ['isDeleted'] },
  outputTagMaps: { sql: 'output_tags_map', booleans: ['isDeleted'] },
  certificates: { sql: 'certificates', id: 'certificateId', booleans: ['isDeleted'] },
  certificateFields: { sql: 'certificate_fields' },
  commissions: { sql: 'commissions', id: 'commissionId', booleans: ['isRedeemed'] },
  provenTxReqs: { sql: 'proven_tx_reqs', id: 'provenTxReqId', booleans: ['notified', 'wasBroadcast'] },
  syncStates: { sql: 'sync_states', id: 'syncStateId', booleans: ['init'] }
}
function invalid(): never {
  throw new Error('Private packed restore metadata or actual native writer differs')
}
/** Fixed SQL coordinates are data, never a native/source/import admission. */
export function brc38PackedRestoreBinaryTable(table: Brc38StageTable): Brc38NativePackedWalletTable | undefined {
  switch (table) {
    case 'provenTxs':
      return 'proven_txs'
    case 'provenTxReqs':
      return 'proven_tx_reqs'
    case 'transactions':
      return 'transactions'
    case 'outputs':
      return 'outputs'
    case 'commissions':
      return 'commissions'
    default:
      return undefined
  }
}
/** Internal SQL metadata only. The enclosing authenticated restore has already
 * checked semantics, parent mappings, original provenance and current journal
 * fences. It must install every declared field pointer before committing this
 * same transaction. No partial wallet DTO reaches an ordinary insert hook.
 * SQL expressions are constructed here, never accepted from metadata. */
export async function insertBrc38PackedRestoreMetadata(
  storage: StorageKnex,
  trx: Knex.Transaction,
  table: Brc38StageTable,
  metadata: Readonly<Record<string, unknown>>,
  binaryFields: readonly string[],
  budget: Brc38ImportDecodedBudget,
  textFields: readonly string[] = []
): Promise<number | void> {
  const { normalized, form, check } = await prepareBrc38PackedPrivateMetadata(
    storage,
    trx,
    table,
    metadata,
    binaryFields,
    budget,
    textFields
  )
  // Only mapped entities allocate fresh IDs. Original inert sync-state keys,
  // including zero and negative keys, retain their archived identity.
  if (form.id !== undefined) {
    const id = normalized[form.id]
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || (table !== 'syncStates' && id !== 0)) invalid()
    if (table !== 'syncStates') delete normalized[form.id]
  }
  check()
  if (table === 'certificateFields') {
    const inserted: Array<{ rowid: number }> = await trx(form.sql).insert(normalized).returning('rowid')
    check()
    if (inserted.length !== 1 || !Number.isSafeInteger(inserted[0].rowid) || inserted[0].rowid < 1) invalid()
    // A physical attachment coordinate only; certificate fields have no
    // numerical wallet entity ID and receive no synthetic map entry.
    return inserted[0].rowid
  }
  if (form.id === undefined) {
    await trx(form.sql).insert(normalized)
    check()
    return
  }
  const inserted: Array<Record<string, unknown>> = await trx(form.sql).insert(normalized).returning(form.id)
  check()
  const id = inserted[0]?.[form.id]
  if (
    inserted.length !== 1 ||
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    (table !== 'syncStates' && id < 1) ||
    (table === 'syncStates' && id !== normalized[form.id])
  )
    invalid()
  return id
}
/** Additive occupied-page path. Ordinary restore keeps its zero/auto-ID and
 * archived signed sync-state contracts above. Only the actual same-owner
 * read-issued allocation can select a new positive explicit operational ID. */
export async function insertBrc38PackedPlannedMetadata(
  storage: StorageKnex,
  trx: Knex.Transaction,
  table: Brc38StageTable,
  metadata: Readonly<Record<string, unknown>>,
  binaryFields: readonly string[],
  plan: Brc38PrivatePageIds,
  budget: Brc38ImportDecodedBudget,
  textFields: readonly string[] = []
): Promise<number> {
  const { normalized, form, check } = await prepareBrc38PackedPrivateMetadata(
    storage,
    trx,
    table,
    metadata,
    binaryFields,
    budget,
    textFields
  )
  if (form.id === undefined || normalized[form.id] !== 0) invalid()
  const savepoint = '__brc38_planned_metadata_' + randomUUID().replaceAll('-', '')
  await trx.raw('SAVEPOINT ' + savepoint)
  try {
    const id = await takeBrc38PrivatePageId(plan, storage, trx, table, budget)
    normalized[form.id] = id
    check()
    const inserted: Array<Record<string, unknown>> = await trx(form.sql).insert(normalized).returning(form.id)
    check()
    if (inserted.length !== 1 || inserted[0][form.id] !== id) invalid()
    await assertBrc38PrivatePageIdPostimage(plan, storage, trx, table, budget)
    check()
    await trx.raw('RELEASE ' + savepoint)
    return id
  } catch (cause) {
    try {
      await trx.raw('ROLLBACK TO ' + savepoint)
      await trx.raw('RELEASE ' + savepoint)
    } catch (error_) {
      throw new AggregateError([cause, error_], 'Incoming ID and metadata rollback remains required', { cause })
    }
    throw cause
  }
}
/** Actual private writer only. Natural-key/proof/history/primary policy remains
 * the enclosing one-use merge plan's responsibility. This update reselects the
 * exact indexed current target and preserves its user/primary/composite wallet
 * coordinates. Every declared field pointer must attach before the same writer
 * commits provenance, ID mappings and its journal receipt. */
export async function updateBrc38PackedPrivateMetadata(
  storage: StorageKnex,
  trx: Knex.Transaction,
  table: Brc38StageTable,
  metadata: Readonly<Record<string, unknown>>,
  binaryFields: readonly string[],
  selected: Brc38ImportEntityTarget,
  budget: Brc38ImportDecodedBudget,
  textFields: readonly string[] = []
): Promise<number> {
  if (
    !Object.hasOwn(forms, table) ||
    selected.table !== table ||
    !Object.hasOwn(brc38ImportTargetIndexes, selected.index) ||
    selected.found !== true ||
    selected.key === null ||
    typeof selected.key !== 'object' ||
    Array.isArray(selected.key)
  )
    invalid()
  const [sql, keys] = brc38ImportTargetIndexes[selected.index],
    key: Record<string, string | number> = Object.create(null),
    localId = selected.localId
  if (
    sql !== forms[table].sql ||
    (selected.index !== table && !(table === 'transactions' && selected.index === 'transactionReference')) ||
    Object.keys(selected.key).length !== keys.length
  )
    invalid()
  for (const name of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(selected.key, name)
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    const value: unknown = descriptor.value
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) invalid()
    } else if (typeof value !== 'string') invalid()
    chargeBrc38ImportDecodedBudget(budget, typeof value === 'string' ? 512 + 16 * value.length : 512)
    key[name] = value
  }
  const { normalized, form, check } = await prepareBrc38PackedPrivateMetadata(
    storage,
    trx,
    table,
    metadata,
    binaryFields,
    budget,
    textFields
  )
  await verifyBrc38ImportTargetIndexes(trx)
  check()
  const rows: Array<{ physical: number; localId?: number; userId?: number }> = await trx
    .from(trx.raw('?? INDEXED BY ??', [sql, brc38ImportTargetIndexName(selected.index, trx)]))
    .where(key)
    .select(
      trx.raw('rowid AS physical'),
      ...(form.id === undefined ? [] : [trx.raw('?? AS localId', [form.id])]),
      ...(Object.hasOwn(key, 'userId') ? ['userId'] : [])
    )
    .limit(2)
  if (
    rows.length !== 1 ||
    !Number.isSafeInteger(rows[0].physical) ||
    (form.id === undefined ? localId !== undefined : !Number.isSafeInteger(localId) || rows[0].localId !== localId) ||
    (Object.hasOwn(key, 'userId') && (rows[0].userId !== key.userId || normalized.userId !== key.userId))
  )
    invalid()
  if (form.id !== undefined) {
    if (Object.hasOwn(normalized, form.id) && normalized[form.id] !== localId) invalid()
    normalized[form.id] = localId
  }
  // Composite primary coordinates must never become an invented numeric wallet
  // ID, or move while pointers still address their previous physical row.
  if (form.id === undefined)
    for (const name of keys) if (!Object.hasOwn(normalized, name) || normalized[name] !== key[name]) invalid()
  check()
  if ((await trx(sql).where(key).whereRaw('rowid = ?', [rows[0].physical]).update(normalized)) !== 1) invalid()
  check()
  return rows[0].physical
}
async function prepareBrc38PackedPrivateMetadata(
  storage: StorageKnex,
  trx: Knex.Transaction,
  table: Brc38StageTable,
  metadata: Readonly<Record<string, unknown>>,
  binaryFields: readonly string[],
  budget: Brc38ImportDecodedBudget,
  textFields: readonly string[]
): Promise<{
  normalized: Record<string, unknown>
  form: Form
  check(): void
}> {
  const check = (): void => {
    const root = privateNativeDatabaseIdentity(storage.toDb()),
      actual = privateNativeTransactionIdentity(trx)
    if (!isBrc38OwnedPrivateNativeWriter(trx) || root?.slot !== 0 || actual?.slot !== 0 || root.token !== actual.token)
      invalid()
  }
  check()
  if (
    !Object.hasOwn(forms, table) ||
    !(await hasBrc38NativePackedSchema(trx)) ||
    metadata === null ||
    typeof metadata !== 'object' ||
    binaryFields.length > 3 ||
    new Set(binaryFields).size !== binaryFields.length ||
    textFields.length > 7 ||
    new Set(textFields).size !== textFields.length ||
    textFields.some(field => binaryFields.includes(field))
  )
    invalid()
  const keys = Reflect.ownKeys(metadata)
  if (keys.length > 64) invalid()
  if (
    textFields.length !== 0 &&
    (!(await hasBrc38NativePackedTextSchema(trx)) ||
      textFields.some(field => !nativePackedTextSource(table).fields.some(name => name === field)))
  )
    invalid()
  // The original page's combined budget pays for descriptor/row/SQL encoding
  // copies. It remains consumed after a rollback; a SQL rollback cannot refund
  // JavaScript allocations or authorize a larger retry on the same page.
  // Bound the actual own-key/descriptor containers, rather than charging every
  // small row as if it retained the maximum64 descriptors. Per-value copies
  // below remain separately charged before normalization and SQL encoding.
  chargeBrc38ImportDecodedBudget(budget, 1024 + 256 * keys.length)
  const descriptors = Object.getOwnPropertyDescriptors(metadata),
    row: Record<string, unknown> = {}
  for (const key of keys) {
    if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) invalid()
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    const value: unknown = descriptor.value
    if (binaryFields.includes(key) || textFields.includes(key)) {
      if (value != null) invalid()
      continue
    }
    if (brc38JsonBinaryField(table, key) && value != null) invalid()
    chargeBrc38ImportDecodedBudget(budget, typeof value === 'string' ? 512 + 16 * value.length : 512)
    // Legacy requests omit these migrated non-null columns. Absence uses SQL
    // defaults on insertion and preserves the actual counters on update.
    if (value === undefined && table === 'provenTxReqs' && (key === 'wasBroadcast' || key === 'rebroadcastAttempts'))
      continue
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) invalid()
      row[key] = new Date(value.getTime())
    } else if (
      value === undefined ||
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      row[key] = value
    else if (typeof value === 'string') row[key] = value
    else invalid()
  }
  const created = row.created_at,
    updated = row.updated_at
  if (!(created instanceof Date) || !(updated instanceof Date)) invalid()
  const form = forms[table]
  for (const name of form.booleans ?? []) {
    if (!Object.hasOwn(row, name)) continue
    const value = row[name]
    if (value !== undefined && value !== null && value !== true && value !== false && value !== 0 && value !== 1)
      invalid()
    if (value !== undefined) row[name] = value === true || value === 1 ? 1 : 0
  }
  for (const field of binaryFields) {
    if (!brc38JsonBinaryField(table, field)) invalid()
    row[field] = trx.raw('zeroblob(0)')
  }
  for (const field of textFields) row[field] = ''
  const normalized: Record<string, unknown> = await storage.validateEntityForInsert(
    { ...row, created_at: created, updated_at: updated },
    trx,
    table === 'syncStates' ? ['when'] : undefined
  )
  check()
  return { normalized, form, check }
}
