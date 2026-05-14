/**
 * listActionsKnex.ts — post-cutover rewrite
 *
 * ## Post-cutover layout changes
 *
 * After `runSchemaCutover`, the schema splits the old monolithic `transactions`
 * table into two tables:
 *
 *   - `transactions` (new-schema): per-txid on-chain state.
 *     Columns: transactionId, txid, processing, processingChangedAt, rawTx, …
 *     Notable ABSENCES: userId, status, satoshis, description, isOutgoing,
 *                        version, lockTime, reference — all gone from this table.
 *
 *   - `actions`: per-user view of a transaction.
 *     Columns: actionId, userId, transactionId (FK→transactions), reference,
 *              description, isOutgoing, satoshis_delta, …
 *
 * ## `version` and `lockTime` — schema gap (option b: return undefined)
 *
 * The legacy `transactions` table stored `version` and `lockTime` as columns.
 * The new schema does not persist them — they are derivable by parsing `transactions.rawTx`
 * but we do NOT do that here to avoid unnecessary deserialization overhead on
 * every list call.
 *
 * Decision: return `version: undefined, lockTime: undefined` for all new schema rows.
 * Callers that need the exact values can fetch `rawTx` from the new transaction
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
 * to it — NOT the new-schema `transactions.transactionId`. The helper's name is
 * intentionally left unchanged (renaming blast radius too large); callers
 * must pass the correct keyspace value.
 *
 * ## `transactionId` field in the internal row shape
 *
 * The `enrichActionOutputs` and `enrichActionInputs` helpers query the
 * `outputs` table via `outputs.transactionId`, which is a FK to the new
 * `transactions.transactionId` (not `actionId`). We therefore carry BOTH ids:
 *   - `newActionRow.transactionId` → new `transactions.transactionId` (for outputs/inputs)
 *   - `newActionRow.actionId`      → `actions.actionId` (for labels)
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
import { TransactionService } from '../schema/transactionService'

/**
 * Internal row shape combining new `actions` + `transactions` data.
 *
 * `transactionId` = `transactions.transactionId` — used to locate outputs
 *                   and inputs (both tables FK to this).
 * `actionId`      = `actions.actionId` — used to locate labels
 *                   (tx_labels_map.transactionId = actionId post-cutover).
 */
interface NewActionRow {
  /** new transactions.transactionId — FK target for outputs/inputs */
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
   * schema gap: version is not stored. Returns undefined.
   * Backfill by parsing transactions.rawTx if needed.
   */
  version: undefined
  /**
   * schema gap: lockTime is not stored. Returns undefined.
   * Backfill by parsing transactions.rawTx if needed.
   */
  lockTime: undefined
}

/**
 * Maps a `ProcessingStatus` back to the legacy `TransactionStatus` for
 * return-shape compatibility. This is the inverse of
 * `transactionStatusToProcessing`.
 *
 * The mapping is best-effort: the new schema has more granular states than the legacy API
 * exposes. States that have no direct legacy equivalent are mapped to the
 * nearest semantic equivalent.
 */
function processingToTransactionStatus (p: ProcessingStatus): TransactionStatus {
  switch (p) {
    case 'confirmed': return 'completed'
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
 * `ListActionsSpecOp.setStatusFilter`) to `ProcessingStatus[]`.
 *
 * The legacy "completed" → "confirmed"; "unproven" → several processing states.
 * We expand each legacy status into the full set of processing states it covers so
 * that the query returns the same semantic set as the legacy query would have.
 */
function legacyStatiToProcessing (stati: string[]): ProcessingStatus[] {
  const result = new Set<ProcessingStatus>()
  for (const s of stati as TransactionStatus[]) {
    const p = transactionStatusToProcessing(s)
    result.add(p)
    // `unproven` covered several transitional states in the old model
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
    // `completed` → confirmed only
    // `sending` → sending only
    // `nosend` → nosend only
    // `nonfinal` → nonfinal only
    // `failed` → invalid + doubleSpend
    if (s === 'failed') result.add('doubleSpend')
    // `unsigned` maps to queued already via transactionStatusToProcessing
  }
  return [...result]
}

/**
 * Bulk-enrich all action rows in a fixed number of round-trips, replacing the
 * per-row N+1 fetches that previously dominated listActions latency.
 *
 * For N action rows:
 *   labels  : 1 query  (was N)
 *   outputs : 1 query for both action outputs (transactionId IN) and inputs
 *             (spentBy IN), 1 query for baskets, 1 query for tag map+labels
 *             (was up to 3·N queries via findOutputs + extendOutput)
 *   rawTx   : 1 union query for all distinct txids (was N)
 *
 * Total: ≤ 5 round-trips regardless of N.
 */
async function bulkEnrich (
  storage: StorageKnex,
  txs: NewActionRow[],
  actions: WalletAction[],
  vargs: Validation.ValidListActionsArgs,
  timeFilterRequested: boolean,
  userId: number
): Promise<void> {
  if (txs.length === 0) return

  const includeLabels = !!vargs.includeLabels
  const includeOutputs = !!vargs.includeOutputs
  const includeInputs = !!vargs.includeInputs
  const includeOutScripts = !!vargs.includeOutputLockingScripts
  const includeInScripts = !!vargs.includeInputSourceLockingScripts
  const includeUnlock = !!vargs.includeInputUnlockingScripts

  const k = storage.toDb(undefined)

  const actionIds = txs.map(t => t.actionId)
  const txIds = txs.map(t => t.transactionId)

  // 1) Labels: tx_labels_map.transactionId is actionId post-cutover.
  const labelsQuery = (includeLabels && actionIds.length > 0)
    ? k('tx_labels as l')
      .join('tx_labels_map as lm', 'lm.txLabelId', 'l.txLabelId')
      .whereIn('lm.transactionId', actionIds)
      .whereNot('lm.isDeleted', true)
      .whereNot('l.isDeleted', true)
      .select('lm.transactionId as actionId', 'l.label')
    : Promise.resolve([] as Array<{ actionId: number, label: string }>)

  // 2) Action outputs: WHERE transactionId IN (txIds)
  const outScriptCol = includeOutScripts ? ['lockingScript'] : []
  const outputsQuery = (includeOutputs && txIds.length > 0)
    ? k('outputs')
      .whereIn('transactionId', txIds)
      .select(
        'outputId', 'userId', 'transactionId', 'basketId', 'spendable',
        'change', 'outputDescription', 'vout', 'satoshis', 'providedBy',
        'purpose', 'type', 'txid', 'scriptLength', 'scriptOffset',
        ...outScriptCol
      )
    : Promise.resolve([] as TableOutputX[])

  // 3) Input outputs: WHERE spentBy IN (txIds)
  const inScriptCol = includeInScripts ? ['lockingScript'] : []
  const inputsQuery = (includeInputs && txIds.length > 0)
    ? k('outputs')
      .whereIn('spentBy', txIds)
      .select(
        'outputId', 'userId', 'transactionId', 'basketId', 'spendable',
        'change', 'outputDescription', 'vout', 'satoshis', 'providedBy',
        'purpose', 'type', 'txid', 'scriptLength', 'scriptOffset', 'spentBy',
        ...inScriptCol
      )
    : Promise.resolve([] as TableOutputX[])

  const [labelRows, outputRows, inputRows] = await Promise.all([labelsQuery, outputsQuery, inputsQuery])

  // 4) Baskets needed by either outputs or inputs
  const basketIds = new Set<number>()
  for (const o of outputRows) if (o.basketId != null) basketIds.add(o.basketId)
  for (const o of inputRows) if (o.basketId != null) basketIds.add(o.basketId)

  // 5) Tags map for both output and input outputIds
  const outputIdsForTags: number[] = []
  for (const o of outputRows) if (o.outputId != null) outputIdsForTags.push(o.outputId)
  for (const o of inputRows) if (o.outputId != null) outputIdsForTags.push(o.outputId)

  const basketsQuery = basketIds.size > 0
    ? k('output_baskets').whereIn('basketId', [...basketIds]).select('basketId', 'name')
    : Promise.resolve([] as Array<{ basketId: number, name: string }>)

  const tagsQuery = outputIdsForTags.length > 0
    ? k('output_tags as ot')
      .join('output_tags_map as om', 'om.outputTagId', 'ot.outputTagId')
      .whereIn('om.outputId', outputIdsForTags)
      .whereNot('om.isDeleted', true)
      .whereNot('ot.isDeleted', true)
      .select('om.outputId', 'ot.tag')
    : Promise.resolve([] as Array<{ outputId: number, tag: string }>)

  // 6) rawTx for each distinct txid (only needed for inputs to recover sequence/unlocking script)
  const distinctTxids = includeInputs && inputRows.length > 0
    ? [...new Set(txs.filter(t => t.txid).map(t => t.txid))]
    : []
  const rawTxQuery = distinctTxids.length > 0
    ? Promise.all(distinctTxids.map(async txid => ({ txid, rawTx: await storage.getRawTxOfKnownValidTransaction(txid) })))
    : Promise.resolve([] as Array<{ txid: string, rawTx?: number[] }>)

  const [baskets, tagRows, rawTxRows] = await Promise.all([basketsQuery, tagsQuery, rawTxQuery])

  /*
   * Recover lockingScript bytes for outputs whose scripts were offloaded to
   * rawTx storage (scriptLength > maxOutputScript at commit time). The original
   * per-row enrichment path went through findOutputs(noScript=false) →
   * validateOutputScript, which runs this same recovery on each row. We replicate
   * it here so the batch path returns identical locking-script content.
   *
   * Run all recoveries concurrently — they touch independent rows and the
   * downstream rawTx fetch is internally cached on most providers.
   */
  if (includeOutScripts || includeInScripts) {
    const targets: TableOutputX[] = []
    if (includeOutScripts) {
      for (const o of outputRows) {
        if (o.scriptLength != null && o.scriptOffset != null && o.txid != null &&
            (o.lockingScript == null || o.lockingScript.length !== o.scriptLength)) {
          targets.push(o)
        }
      }
    }
    if (includeInScripts) {
      for (const o of inputRows) {
        if (o.scriptLength != null && o.scriptOffset != null && o.txid != null &&
            (o.lockingScript == null || o.lockingScript.length !== o.scriptLength)) {
          targets.push(o)
        }
      }
    }
    if (targets.length > 0) {
      await Promise.all(targets.map(o => storage.validateOutputScript(o)))
    }
  }

  const basketName: Record<number, string> = {}
  for (const b of baskets) basketName[b.basketId] = b.name

  const tagsByOutputId: Record<number, string[]> = {}
  for (const r of tagRows) {
    const id = Number(r.outputId)
    if (!tagsByOutputId[id]) tagsByOutputId[id] = []
    tagsByOutputId[id].push(String(r.tag))
  }

  const labelsByActionId: Record<number, string[]> = {}
  for (const r of labelRows) {
    const id = Number(r.actionId)
    if (!labelsByActionId[id]) labelsByActionId[id] = []
    labelsByActionId[id].push(String(r.label))
  }

  const outputsByTxId = new Map<number, TableOutputX[]>()
  for (const o of outputRows) {
    const list = outputsByTxId.get(o.transactionId) || []
    list.push(o)
    outputsByTxId.set(o.transactionId, list)
  }

  const inputsByTxId = new Map<number, TableOutputX[]>()
  for (const o of inputRows) {
    if (o.spentBy == null) continue
    const list = inputsByTxId.get(o.spentBy) || []
    list.push(o)
    inputsByTxId.set(o.spentBy, list)
  }

  const rawTxByTxid: Record<string, number[] | undefined> = {}
  for (const r of rawTxRows) rawTxByTxid[r.txid] = r.rawTx

  // Stitch enrichment back onto each action.
  for (let i = 0; i < txs.length; i++) {
    const row = txs[i]
    const action = actions[i]

    if (includeLabels) {
      action.labels = labelsByActionId[row.actionId] ? [...labelsByActionId[row.actionId]] : []
      if (timeFilterRequested) {
        const ts = (row.created_at != null) ? new Date(row.created_at as any).getTime() : Number.NaN
        if (!Number.isNaN(ts)) {
          const timeLabel = makeBrc114ActionTimeLabel(ts)
          if (!action.labels.includes(timeLabel)) action.labels.push(timeLabel)
        }
      }
    }

    if (includeOutputs) {
      action.outputs = []
      const list = outputsByTxId.get(row.transactionId) || []
      for (const o of list) {
        const wo: WalletActionOutput = {
          satoshis: o.satoshis || 0,
          spendable: !!o.spendable,
          tags: (o.outputId != null && tagsByOutputId[o.outputId]) ? tagsByOutputId[o.outputId] : [],
          outputIndex: Number(o.vout),
          outputDescription: o.outputDescription || '',
          basket: (o.basketId != null && basketName[o.basketId]) ? basketName[o.basketId] : ''
        }
        if (includeOutScripts) wo.lockingScript = asString(o.lockingScript || [])
        action.outputs.push(wo)
      }
    }

    if (includeInputs) {
      action.inputs = []
      const list = inputsByTxId.get(row.transactionId) || []
      if (list.length === 0) continue
      const rawTx = rawTxByTxid[row.txid]
      let bsvTx: BsvTransaction | undefined
      if (rawTx != null) {
        try { bsvTx = BsvTransaction.fromBinary(rawTx) } catch { /* tolerate parse failure */ }
      }
      for (const o of list) {
        const input = bsvTx?.inputs.find(v => v.sourceTXID === o.txid && v.sourceOutputIndex === o.vout)
        const wo: WalletActionInput = {
          sourceOutpoint: `${o.txid}.${o.vout}`,
          sourceSatoshis: o.satoshis || 0,
          inputDescription: o.outputDescription || '',
          sequenceNumber: input?.sequence || 0
        }
        action.inputs.push(wo)
        if (includeInScripts) wo.sourceLockingScript = asString(o.lockingScript || [])
        if (includeUnlock) wo.unlockingScript = input?.unlockingScript?.toHex()
      }
    }
  }

  // Silence unused-param lint: kept on signature for future per-user filtering.
  void userId
}

export async function listActions (
  storage: StorageKnex,
  auth: AuthId,
  vargs: Validation.ValidListActionsArgs
): Promise<ListActionsResult> {
  const limit = vargs.limit
  const offset = vargs.offset

  const k = storage.toDb(undefined)
  // TransactionService takes a Knex instance (not a QueryBuilder).
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

  // Map legacy TransactionStatus → ProcessingStatus for the WHERE clause
  const processingFilter: ProcessingStatus[] = legacyStatiToProcessing(legacyStati)

  // Use TransactionService to execute the actions query with post-cutover layout
  const svc = new TransactionService(svcKnex)
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

  // Convert the transaction service rows into the internal NewActionRow shape.
  // NOTE: In this shape `transactionId` = new transactions.transactionId (for
  // outputs/inputs), and `actionId` = actions.actionId (for labels).
  const txs: NewActionRow[] = svcRows.map(row => ({
    transactionId: row.transactionId,
    actionId: row.actionId,
    txid: row.txid,
    reference: row.reference,
    // satoshis_delta from actions maps to legacy `satoshis`
    satoshis: row.satoshisDelta,
    // Map ProcessingStatus back to legacy ActionStatus for return compat
    status: processingToTransactionStatus(row.processing),
    isOutgoing: row.isOutgoing,
    description: row.description,
    created_at: row.created_at,
    // schema gap: version and lockTime are not stored in the new schema.
    // Return undefined. Backfill later by parsing transactions.rawTx if needed.
    version: undefined,
    lockTime: undefined
  }))

  // specOp postProcess receives txs shaped as Partial<TableTransaction>.
  // We cast to satisfy the interface; note that status/transactionId/reference
  // are populated correctly for the two existing specOps (noSendActions /
  // failedActions) which only read tx.status, tx.reference, tx.transactionId.
  if ((specOp?.postProcess) != null) {
    // Cast: the specOp contract only accesses fields present on NewActionRow
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
      // schema gap: version and lockTime are not stored. See file header comment.
      version: undefined as unknown as number,
      lockTime: undefined as unknown as number
    })
  }

  if (vargs.includeLabels || vargs.includeInputs || vargs.includeOutputs) {
    await bulkEnrich(storage, txs, r.actions, vargs, timeFilterRequested, auth.userId!)
  }
  return r
}
