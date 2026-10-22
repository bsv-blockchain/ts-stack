import {
  brc38PrivateIncomingIdRanges,
  hasBrc38PrivateIncomingIdSchema,
  readBrc38PrivateIncomingIdRange,
  type Brc38PrivateIncomingIdRange
} from './Brc38PrivateIncomingIdSchemaNode'
import { readBrc38PrivateLocalCandidateJournal } from './Brc38PrivateLocalCandidateJournalNode'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { Brc38StageTable } from './Brc38SemanticStage'
import { isBrc38OwnedPrivateNativeSqlite, isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { privateNativeDatabaseIdentity, privateNativeTransactionIdentity } from './Brc38PrivateNativeOwnershipNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { chargeBrc38ImportDecodedBudget, type Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'

export const brc38PrivatePageIdForms = Object.freeze({
  provenTxs: ['proven_txs', 'provenTxId'],
  outputBaskets: ['output_baskets', 'basketId'],
  outputTags: ['output_tags', 'outputTagId'],
  txLabels: ['tx_labels', 'txLabelId'],
  transactions: ['transactions', 'transactionId'],
  outputs: ['outputs', 'outputId'],
  certificates: ['certificates', 'certificateId'],
  commissions: ['commissions', 'commissionId'],
  provenTxReqs: ['proven_tx_reqs', 'provenTxReqId'],
  syncStates: ['sync_states', 'syncStateId']
} as const)
const forms = brc38PrivatePageIdForms
type Table = keyof typeof forms
interface Counters {
  readonly sequence?: number
  readonly maximum?: number
}
interface State {
  readonly storage: StorageKnex
  readonly root: Knex
  readonly token: object
  readonly table: Table
  readonly prior: Counters
  readonly reservation?: Readonly<Brc38PrivateIncomingIdRange>
  readonly expiresAt: number
  readonly deadline: number
  readonly ids: readonly number[]
  used: number
  writer?: Knex.Transaction
}
/** IDs are planning DATA only. No row, map, receipt or primary is reserved or
 * committed by preparation. The issued record's membership is lifecycle for
 * one actual owner; SQL source/schema/current-row admission remains separate. */
export interface Brc38PrivatePageIds {
  readonly table: Table
  readonly ids: readonly number[]
}
const issued = new WeakMap<Brc38PrivatePageIds, State>()
function invalid(): never {
  throw new Error('Private page ID allocation changed; reprepare from the current owned read view')
}
function actor(storage: StorageKnex, root: Knex, trx: Knex.Transaction, token: object, writer: boolean): void {
  const actualRoot = privateNativeDatabaseIdentity(root),
    actual = privateNativeTransactionIdentity(trx)
  if (
    storage.toDb() !== root ||
    actualRoot?.slot !== 0 ||
    actualRoot.token !== token ||
    actual?.slot !== (writer ? 0 : 3) ||
    actual.token !== token ||
    !(writer ? isBrc38OwnedPrivateNativeWriter(trx) : isBrc38OwnedPrivateNativeSqlite(trx))
  )
    invalid()
}
async function counters(trx: Knex.Transaction, table: Table): Promise<Counters> {
  const [sql, id] = forms[table]
  // Fresh actual primary/counter schema, not an earlier schema verdict. Each
  // query returns at most two fixed scalar rows and transfers no payload.
  const schema: Array<{ valid: number }> = await trx.raw(
    "SELECT count(*) AS valid FROM pragma_table_info(?) WHERE name=? AND upper(type)='INTEGER' AND pk=1",
    [sql, id]
  )
  const definition = (await trx('sqlite_schema')
    .where({ type: 'table', name: sql })
    .first(trx.raw("CASE WHEN instr(upper(sql),'AUTOINCREMENT')>0 THEN 1 ELSE 0 END AS valid"))) as
    { valid: number } | undefined
  if (schema.length !== 1 || schema[0].valid !== 1 || definition?.valid !== 1) invalid()
  const sequence: Array<{ seq: number }> = await trx('sqlite_sequence').where({ name: sql }).select('seq').limit(2),
    rows: Array<{ maximum: number }> = await trx(sql).select({ maximum: id }).orderBy(id, 'desc').limit(1)
  if (
    sequence.length > 1 ||
    sequence.some(row => !Number.isSafeInteger(row.seq) || row.seq < 0) ||
    rows.some(row => !Number.isSafeInteger(row.maximum))
  )
    invalid()
  return Object.freeze({
    ...(sequence.length === 0 ? {} : { sequence: sequence[0].seq }),
    ...(rows.length === 0 ? {} : { maximum: rows[0].maximum })
  })
}
export async function prepareBrc38PrivatePageIds(
  storage: StorageKnex,
  trx: Knex.Transaction,
  table: Brc38StageTable,
  count: number,
  expiresAt: number,
  budget: Brc38ImportDecodedBudget
): Promise<Readonly<Brc38PrivatePageIds>> {
  budget.signal?.throwIfAborted()
  const root = storage.toDb(),
    original = privateNativeDatabaseIdentity(root),
    began = performance.now(),
    lifetime = expiresAt - Date.now()
  if (
    original?.slot !== 0 ||
    !Object.hasOwn(forms, table) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 4096 ||
    !Number.isSafeInteger(expiresAt) ||
    lifetime < 1 ||
    lifetime > 3600000
  )
    invalid()
  const selected = table as Table
  actor(storage, root, trx, original.token, false)
  chargeBrc38ImportDecodedBudget(budget, 32768 + 1024 * count)
  await verifyBrc38AuthenticatedSourceSeal(trx)
  const binding = (await trx('private_binding')
    .where({ slot: 1 })
    .first(trx.raw("json_extract(limitsJson,'$[5]') AS expiresAt"))) as { expiresAt: number } | undefined
  if (!Number.isSafeInteger(binding?.expiresAt) || expiresAt > binding!.expiresAt) invalid()
  const prior = await counters(trx, selected),
    tableId = Object.keys(forms).indexOf(selected),
    reserved = await hasBrc38PrivateIncomingIdSchema(trx),
    reservation = reserved ? await readBrc38PrivateIncomingIdRange(trx, tableId) : undefined
  if (reserved) {
    const journal = await readBrc38PrivateLocalCandidateJournal(trx)
    if (
      reservation === undefined ||
      journal.phase !== 'RECOVERY' ||
      journal.bindingSha256 !== reservation.bindingSha256 ||
      journal.sourceSha256 !== reservation.sourceSha256 ||
      journal.epoch !== reservation.sourceEpoch ||
      reservation.expiresAt !== expiresAt ||
      count > reservation.count - reservation.used ||
      (prior.sequence ?? 0) < reservation.first + reservation.count - 1
    )
      invalid()
  }
  const first =
    reservation === undefined
      ? Math.max(0, prior.sequence ?? 0, prior.maximum ?? 0) + 1
      : reservation.first + reservation.used
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(first + count - 1)) invalid()
  const ids = Object.freeze(Array.from({ length: count }, (_, ordinal) => first + ordinal)),
    result = Object.freeze({ table: selected, ids })
  if (
    reservation !== undefined &&
    (
      await trx(forms[selected][0])
        .whereIn(forms[selected][1], [...ids])
        .select(forms[selected][1])
        .limit(1)
    ).length
  )
    invalid()
  actor(storage, root, trx, original.token, false)
  if (Date.now() >= expiresAt || performance.now() - began >= lifetime) invalid()
  issued.set(result, {
    storage,
    root,
    token: original.token,
    table: selected,
    prior,
    expiresAt,
    deadline: began + lifetime,
    ids,
    reservation,
    used: 0
  })
  return result
}
/** Used only by the dedicated actual private metadata insert. The first call
 * freshly compares the exact read-side counters; later calls require this
 * same actual writer and the previous issued INSERT's committed-in-transaction
 * counter postimage. Staleness/collision/rollback consumes the plan and requires
 * fresh preparation; no arbitrary explicit ID is admitted through metadata. */
export async function takeBrc38PrivatePageId(
  plan: Brc38PrivatePageIds,
  storage: StorageKnex,
  trx: Knex.Transaction,
  table: Brc38StageTable,
  budget: Brc38ImportDecodedBudget
): Promise<number> {
  budget.signal?.throwIfAborted()
  const state = issued.get(plan)
  if (
    state === undefined ||
    state.storage !== storage ||
    state.table !== table ||
    state.used >= state.ids.length ||
    (state.writer !== undefined && state.writer !== trx) ||
    Date.now() >= state.expiresAt ||
    performance.now() >= state.deadline
  )
    invalid()
  actor(storage, state.root, trx, state.token, true)
  chargeBrc38ImportDecodedBudget(budget, 16384)
  await verifyBrc38AuthenticatedSourceSeal(trx)
  const current = await counters(trx, state.table),
    previous =
      state.used === 0
        ? state.prior
        : state.reservation === undefined
          ? { sequence: state.ids[state.used - 1], maximum: state.ids[state.used - 1] }
          : { sequence: state.prior.sequence, maximum: Math.max(state.prior.maximum ?? 0, state.ids[state.used - 1]) }
  if (state.reservation !== undefined) {
    const range = await readBrc38PrivateIncomingIdRange(trx, state.reservation.tableId),
      expectedUsed = state.reservation.used + state.used
    if (
      range === undefined ||
      range.bindingSha256 !== state.reservation.bindingSha256 ||
      range.sourceSha256 !== state.reservation.sourceSha256 ||
      range.sourceEpoch !== state.reservation.sourceEpoch ||
      range.first !== state.reservation.first ||
      range.count !== state.reservation.count ||
      range.used !== expectedUsed ||
      range.expiresAt !== state.expiresAt ||
      (
        await trx(forms[state.table][0])
          .where({ [forms[state.table][1]]: state.ids[state.used] })
          .select(forms[state.table][1])
          .limit(1)
      ).length
    ) {
      issued.delete(plan)
      invalid()
    }
  }
  actor(storage, state.root, trx, state.token, true)
  if (
    current.sequence !== previous.sequence ||
    current.maximum !== previous.maximum ||
    Date.now() >= state.expiresAt ||
    performance.now() >= state.deadline
  ) {
    issued.delete(plan)
    invalid()
  }
  const id = state.ids[state.used]
  if (
    state.reservation !== undefined &&
    (await trx(brc38PrivateIncomingIdRanges)
      .where({ tableId: state.reservation.tableId, used: state.reservation.used + state.used })
      .update({ used: state.reservation.used + state.used + 1 })) !== 1
  ) {
    issued.delete(plan)
    invalid()
  }
  state.used++
  state.writer = trx
  return id
}
/** The actual INSERT must produce the exact counter postimage before its
 * pointer, mapping or checkpoint can rely on a prepared ID. */
export async function assertBrc38PrivatePageIdPostimage(
  plan: Brc38PrivatePageIds,
  storage: StorageKnex,
  trx: Knex.Transaction,
  table: Brc38StageTable,
  budget: Brc38ImportDecodedBudget
): Promise<void> {
  budget.signal?.throwIfAborted()
  const state = issued.get(plan)
  if (
    state === undefined ||
    state.storage !== storage ||
    state.table !== table ||
    state.writer !== trx ||
    state.used < 1 ||
    Date.now() >= state.expiresAt ||
    performance.now() >= state.deadline
  )
    invalid()
  actor(storage, state.root, trx, state.token, true)
  chargeBrc38ImportDecodedBudget(budget, 16384)
  const current = await counters(trx, state.table),
    id = state.ids[state.used - 1]
  actor(storage, state.root, trx, state.token, true)
  if (state.reservation !== undefined) {
    const range = await readBrc38PrivateIncomingIdRange(trx, state.reservation.tableId)
    if (
      range === undefined ||
      range.used !== state.reservation.used + state.used ||
      range.first !== state.reservation.first ||
      range.count !== state.reservation.count ||
      range.bindingSha256 !== state.reservation.bindingSha256 ||
      range.sourceSha256 !== state.reservation.sourceSha256 ||
      range.sourceEpoch !== state.reservation.sourceEpoch
    ) {
      issued.delete(plan)
      invalid()
    }
  }
  const expected =
    state.reservation === undefined
      ? { sequence: id, maximum: id }
      : { sequence: state.prior.sequence, maximum: Math.max(state.prior.maximum ?? 0, id) }
  if (
    current.sequence !== expected.sequence ||
    current.maximum !== expected.maximum ||
    Date.now() >= state.expiresAt ||
    performance.now() >= state.deadline
  ) {
    issued.delete(plan)
    invalid()
  }
}
