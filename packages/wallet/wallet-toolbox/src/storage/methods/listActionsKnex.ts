/**
 * listActionsKnex.ts — V7 post-cutover rewrite
 *
 * ## Post-cutover layout changes
 *
 * After `runV7Cutover`, the schema splits the old monolithic `transactions`
 * table into two tables:
 *
 *   - `transactions` (V7): per-txid on-chain state.
 *     Columns: transactionId, txid, processing, processingChangedAt, rawTx, …
 *     Notable ABSENCES: userId, status, satoshis, description, isOutgoing,
 *                        version, lockTime, reference — all gone from this table.
 *
 *   - `actions`: per-user view of a transaction.
 *     Columns: actionId, userId, transactionId (FK→transactions), reference,
 *              description, isOutgoing, satoshis_delta, …
 *
 * ## `version` and `lockTime` — V7 gap (option b: return undefined)
 *
 * The legacy `transactions` table stored `version` and `lockTime` as columns.
 * V7 does not persist them — they are derivable by parsing `transactions.rawTx`
 * but we do NOT do that here to avoid unnecessary deserialization overhead on
 * every list call.
 *
 * Decision: return `version: undefined, lockTime: undefined` for all V7 rows.
 * Callers that need the exact values can fetch `rawTx` from the V7 transaction
 * and parse it with `BsvTransaction.fromBinary(rawTx)`.
 *
 * This can be backfilled later by adding `version` and `lockTime` as optional
 * columns to the `actions` table and populating them during cutover.
 *
 * ## Label join keyspace change
 *
 * Post-cutover `tx_labels_map.transactionId` is an FK to `actions.actionId`
 * (NOT `transactions.transactionId`). The label-enrichment helper
 * `storage.getLabelsForTransactionId(id)` queries
 * `tx_labels_map.transactionId = id`, so after cutover we must pass `actionId`
 * to it — NOT the V7 `transactions.transactionId`. The helper's name is
 * intentionally left unchanged (renaming blast radius too large); callers
 * must pass the correct keyspace value.
 *
 * ## `transactionId` field in the internal row shape
 *
 * The `enrichActionOutputs` and `enrichActionInputs` helpers query the
 * `outputs` table via `outputs.transactionId`, which is a FK to the V7
 * `transactions.transactionId` (not `actionId`). We therefore carry BOTH ids:
 *   - `v7ActionRow.transactionId` → V7 `transactions.transactionId` (for outputs/inputs)
 *   - `v7ActionRow.actionId`      → `actions.actionId` (for labels)
 */

import {
  Transaction as BsvTransaction,
  ActionStatus,
  ListActionsResult,
  WalletAction,
  WalletActionOutput,
  WalletActionInput,
  Validation
} from '@bsv/sdk'
import type { StorageKnex } from '../StorageKnex'
import { partitionActionLabels } from './ListActionsSpecOp'
import { AuthId } from '../../sdk/WalletStorage.interfaces'
import { TableTxLabel } from '../schema/tables/TableTxLabel'
import { TableOutputX } from '../schema/tables/TableOutput'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { makeBrc114ActionTimeLabel, parseBrc114ActionTimeLabels } from '../../utility/brc114ActionTimeLabels'
import { ProcessingStatus, TransactionStatus, transactionStatusToProcessing } from '../../sdk/types'
import { V7TransactionService } from '../schema/v7Service'

/**
 * Internal row shape combining V7 `actions` + `transactions` data.
 *
 * `transactionId` = V7 `transactions.transactionId` — used to locate outputs
 *                   and inputs (both tables FK to this).
 * `actionId`      = `actions.actionId` — used to locate labels
 *                   (tx_labels_map.transactionId = actionId post-cutover).
 */
interface V7ActionRow {
  /** V7 transactions.transactionId — FK target for outputs/inputs */
  transactionId: number
  /** actions.actionId — FK target for tx_labels_map post-cutover */
  actionId: number
  txid: string
  reference: string
  /** actions.satoshis_delta mapped to satoshis for return-shape compat */
  satoshis: number
  /** transactions.processing mapped to legacy status for return-shape compat */
  status: TransactionStatus
  isOutgoing: boolean
  description: string
  created_at: Date
  /**
   * V7 gap: version is not stored. Returns undefined.
   * Backfill by parsing transactions.rawTx if needed.
   */
  version: undefined
  /**
   * V7 gap: lockTime is not stored. Returns undefined.
   * Backfill by parsing transactions.rawTx if needed.
   */
  lockTime: undefined
}

/**
 * Maps a V7 `ProcessingStatus` back to the legacy `TransactionStatus` for
 * return-shape compatibility. This is the inverse of
 * `transactionStatusToProcessing`.
 *
 * The mapping is best-effort: V7 has more granular states than the legacy API
 * exposes. States that have no direct legacy equivalent are mapped to the
 * nearest semantic equivalent.
 */
function processingToTransactionStatus (p: ProcessingStatus): TransactionStatus {
  switch (p) {
    case 'proven': return 'completed'
    case 'invalid': return 'failed'
    case 'doubleSpend': return 'failed'
    case 'queued': return 'unprocessed'
    case 'sending': return 'sending'
    case 'sent': return 'unproven'
    case 'seen': return 'unproven'
    case 'seen_multi': return 'unproven'
    case 'unconfirmed': return 'unproven'
    case 'reorging': return 'unproven'
    case 'nosend': return 'nosend'
    case 'nonfinal': return 'nonfinal'
    case 'unfail': return 'unfail'
    case 'frozen': return 'unprocessed'
  }
}

/**
 * Maps the legacy `TransactionStatus[]` filter (as produced by
 * `ListActionsSpecOp.setStatusFilter`) to V7 `ProcessingStatus[]`.
 *
 * The legacy "completed" → "proven"; "unproven" → several V7 states.
 * We expand each legacy status into the full set of V7 states it covers so
 * that the query returns the same semantic set as the legacy query would have.
 */
function legacyStatiToProcessing (stati: string[]): ProcessingStatus[] {
  const result = new Set<ProcessingStatus>()
  for (const s of stati as TransactionStatus[]) {
    const p = transactionStatusToProcessing(s)
    result.add(p)
    // `unproven` covered several V7 transitional states in the old model
    if (s === 'unproven') {
      result.add('sent')
      result.add('seen')
      result.add('seen_multi')
      result.add('unconfirmed')
      result.add('reorging')
    }
    // `unprocessed` also means queued/nonfinal in the old model
    if (s === 'unprocessed') {
      result.add('queued')
      result.add('nonfinal')
    }
    // `completed` → proven only
    // `sending` → sending only
    // `nosend` → nosend only
    // `nonfinal` → nonfinal only
    // `failed` → invalid + doubleSpend
    if (s === 'failed') result.add('doubleSpend')
    // `unsigned` maps to queued already via transactionStatusToProcessing
  }
  return [...result]
}

async function enrichActionLabels (
  storage: StorageKnex,
  row: V7ActionRow,
  action: WalletAction,
  timeFilterRequested: boolean
): Promise<void> {
  // Post-cutover: tx_labels_map.transactionId = actions.actionId.
  // We therefore pass row.actionId to getLabelsForTransactionId.
  // The function name is misleading in V7 context — it actually looks up
  // by tx_labels_map.transactionId which is now the actionId keyspace.
  action.labels = (await storage.getLabelsForTransactionId(row.actionId)).map(l => l.label)
  if (timeFilterRequested) {
    const ts = (row.created_at != null) ? new Date(row.created_at as any).getTime() : Number.NaN
    if (!Number.isNaN(ts)) {
      const timeLabel = makeBrc114ActionTimeLabel(ts)
      if (!action.labels.includes(timeLabel)) action.labels.push(timeLabel)
    }
  }
}

async function enrichActionOutputs (
  storage: StorageKnex,
  row: V7ActionRow,
  action: WalletAction,
  includeOutputLockingScripts: boolean
): Promise<void> {
  // outputs.transactionId FKs transactions.transactionId (V7) — use row.transactionId
  const outputs: TableOutputX[] = await storage.findOutputs({
    partial: { transactionId: row.transactionId },
    noScript: !includeOutputLockingScripts
  })
  action.outputs = []
  for (const o of outputs) {
    await storage.extendOutput(o, true, true)
    const wo: WalletActionOutput = {
      satoshis: o.satoshis || 0,
      spendable: !!o.spendable,
      tags: o.tags?.map(t => t.tag) || [],
      outputIndex: Number(o.vout),
      outputDescription: o.outputDescription || '',
      basket: o.basket?.name || ''
    }
    if (includeOutputLockingScripts) wo.lockingScript = asString(o.lockingScript || [])
    action.outputs.push(wo)
  }
}

async function enrichActionInputs (
  storage: StorageKnex,
  row: V7ActionRow,
  action: WalletAction,
  includeSourceLockingScripts: boolean,
  includeUnlockingScripts: boolean
): Promise<void> {
  // outputs.spentBy FKs transactions.transactionId (V7) — use row.transactionId
  const inputs: TableOutputX[] = await storage.findOutputs({
    partial: { spentBy: row.transactionId },
    noScript: !includeSourceLockingScripts
  })
  action.inputs = []
  if (inputs.length === 0) return
  const rawTx = await storage.getRawTxOfKnownValidTransaction(row.txid)
  let bsvTx: BsvTransaction | undefined
  if (rawTx != null) bsvTx = BsvTransaction.fromBinary(rawTx)
  for (const o of inputs) {
    await storage.extendOutput(o, true, true)
    const input = bsvTx?.inputs.find(v => v.sourceTXID === o.txid && v.sourceOutputIndex === o.vout)
    const wo: WalletActionInput = {
      sourceOutpoint: `${o.txid}.${o.vout}`,
      sourceSatoshis: o.satoshis || 0,
      inputDescription: o.outputDescription || '',
      sequenceNumber: input?.sequence || 0
    }
    action.inputs.push(wo)
    if (includeSourceLockingScripts) wo.sourceLockingScript = asString(o.lockingScript || [])
    if (includeUnlockingScripts) wo.unlockingScript = input?.unlockingScript?.toHex()
  }
}

export async function listActions (
  storage: StorageKnex,
  auth: AuthId,
  vargs: Validation.ValidListActionsArgs
): Promise<ListActionsResult> {
  const limit = vargs.limit
  const offset = vargs.offset

  const k = storage.toDb(undefined)
  // V7TransactionService takes a Knex instance (not a QueryBuilder).
  // StorageKnex.knex is the raw Knex handle; storage.toDb() returns a
  // QueryBuilder handle. We use storage.knex here.
  const svcKnex = storage.knex

  const r: ListActionsResult = {
    totalActions: 0,
    actions: []
  }

  const {
    from: actionTimeFrom,
    to: actionTimeTo,
    timeFilterRequested,
    remainingLabels: ordinaryLabelsPreSpecOp
  } = parseBrc114ActionTimeLabels(vargs.labels)

  const createdAtFrom = actionTimeFrom === undefined ? undefined : new Date(actionTimeFrom)
  const createdAtTo = actionTimeTo === undefined ? undefined : new Date(actionTimeTo)

  const { specOp, specOpLabels, labels } = partitionActionLabels(ordinaryLabelsPreSpecOp)

  let labelIds: number[] = []
  if (labels.length > 0) {
    const q = k<TableTxLabel>('tx_labels')
      .where({
        userId: auth.userId,
        isDeleted: false
      })
      .whereNotNull('txLabelId')
      .whereIn('label', labels)
      .select('txLabelId')
    const rows = await q
    labelIds = rows.map(r => r.txLabelId)
  }

  const isQueryModeAll = vargs.labelQueryMode === 'all'
  if (isQueryModeAll && labelIds.length < labels.length)
  // all the required labels don't exist, impossible to satisfy.
  { return r }

  if (!isQueryModeAll && labelIds.length === 0 && labels.length > 0)
  // any and only non-existing labels, impossible to satisfy.
  { return r }

  // Legacy status values produced by specOp or default
  const legacyStati: string[] = (specOp?.setStatusFilter == null)
    ? ['completed', 'unprocessed', 'sending', 'unproven', 'unsigned', 'nosend', 'nonfinal']
    : specOp.setStatusFilter()

  // Map legacy TransactionStatus → V7 ProcessingStatus for the WHERE clause
  const processingFilter: ProcessingStatus[] = legacyStatiToProcessing(legacyStati)

  // Use V7TransactionService to execute the actions query with post-cutover layout
  const svc = new V7TransactionService(svcKnex)
  const { rows: svcRows, total: svcTotal } = await svc.listActionsForUser({
    userId: auth.userId!,
    statusFilter: processingFilter.length > 0 ? processingFilter : undefined,
    labelIds: labelIds.length > 0 ? labelIds : undefined,
    labelQueryMode: isQueryModeAll ? 'all' : 'any',
    createdAtFrom,
    createdAtTo,
    limit,
    offset
  })

  // Convert V7 service rows into the internal V7ActionRow shape.
  // NOTE: In this shape `transactionId` = V7 transactions.transactionId (for
  // outputs/inputs), and `actionId` = actions.actionId (for labels).
  const txs: V7ActionRow[] = svcRows.map(row => ({
    transactionId: row.transactionId,
    actionId: row.actionId,
    txid: row.txid,
    reference: row.reference,
    // satoshis_delta from actions maps to legacy `satoshis`
    satoshis: row.satoshisDelta,
    // Map V7 ProcessingStatus back to legacy ActionStatus for return compat
    status: processingToTransactionStatus(row.processing),
    isOutgoing: row.isOutgoing,
    description: row.description,
    created_at: row.created_at,
    // V7 gap: version and lockTime are not stored in V7.
    // Return undefined. Backfill later by parsing transactions.rawTx if needed.
    version: undefined,
    lockTime: undefined
  }))

  // specOp postProcess receives txs shaped as Partial<TableTransaction>.
  // We cast to satisfy the interface; note that status/transactionId/reference
  // are populated correctly for the two existing specOps (noSendActions /
  // failedActions) which only read tx.status, tx.reference, tx.transactionId.
  if ((specOp?.postProcess) != null) {
    // Cast: the specOp contract only accesses fields present on V7ActionRow
    await specOp.postProcess(storage, auth, vargs, specOpLabels, txs as any)
  }

  if (!limit) r.totalActions = txs.length
  else if (txs.length < limit) r.totalActions = (offset || 0) + txs.length
  else {
    // Use the total returned by listActionsForUser (already computed in the service)
    r.totalActions = svcTotal != null ? svcTotal : txs.length + (offset || 0)
  }

  for (const tx of txs) {
    r.actions.push({
      txid: tx.txid || '',
      satoshis: tx.satoshis || 0,
      status: tx.status! as ActionStatus,
      isOutgoing: !!tx.isOutgoing,
      description: tx.description || '',
      // V7 gap: version and lockTime are not stored. See file header comment.
      version: undefined as unknown as number,
      lockTime: undefined as unknown as number
    })
  }

  if (vargs.includeLabels || vargs.includeInputs || vargs.includeOutputs) {
    await Promise.all(
      txs.map(async (tx, i) => {
        const action = r.actions[i]
        if (vargs.includeLabels) await enrichActionLabels(storage, tx, action, timeFilterRequested)
        if (vargs.includeOutputs) await enrichActionOutputs(storage, tx, action, !!vargs.includeOutputLockingScripts)
        if (vargs.includeInputs) {
          await enrichActionInputs(storage, tx, action, !!vargs.includeInputSourceLockingScripts, !!vargs.includeInputUnlockingScripts)
        }
      })
    )
  }
  return r
}
