/**
 * listActionsKnex.ts — v3 schema
 *
 * Schema layout:
 *
 *   - `transactions` (PK `txid VARCHAR(64)`): per-txid on-chain state.
 *     No integer `transactionId` column. Columns: `txid`, `processing`,
 *     `processingChangedAt`, `rawTx`, `merklePath`, `merkleRoot`, `blockHash`,
 *     `height`, …
 *
 *   - `actions` (PK `actionId`): per-user view of a transaction.
 *     `txid` is a NULLABLE FK to `transactions.txid` (NULL while the action is
 *     still an unsigned draft).  Other columns: `userId`, `reference`,
 *     `description`, `isOutgoing`, `satoshis_delta`, optional `version` and
 *     `lockTime`, `userNosend`, `hidden`, `userAborted`, `notifyJson`,
 *     `rowVersion`, `rawTxDraft`, `inputBeefDraft`.
 *
 *   - `outputs.actionId` is the FK to the creating action (NOT
 *     `transactionId`).  `outputs.txid` is a denormalised on-chain txid copy.
 *     `outputs.spentByActionId` is the per-row spender pointer
 *     (FK to `actions.actionId`).
 *
 *   - `tx_labels_map.actionId` references `actions.actionId`.
 *
 * `version` and `lockTime` may be present on `actions` (chosen at create time)
 * but are also derivable from the rawTx.  We return whatever the actions row
 * stores (often undefined) without parsing rawTx — callers that need exact
 * values can fetch the rawTx and parse it themselves.
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
 * Internal row shape carrying the v3 `actions` + `transactions` data needed
 * to assemble a `WalletAction`.
 *
 *   - `actionId` — `actions.actionId` (the FK target for outputs/inputs via
 *                 `outputs.actionId` / `outputs.spentByActionId`, and for
 *                 labels via `tx_labels_map.actionId`).
 *   - `txid`     — `actions.txid`, copied from `transactions.txid` once the
 *                 action is signed.  Used to fetch rawTx for input enrichment.
 */
interface NewActionRow {
  /** actions.actionId — FK target for outputs, inputs, and labels. */
  actionId: number
  /** Canonical on-chain txid; undefined while the action is still a draft. */
  txid?: string
  reference: string
  /** actions.satoshis_delta mapped to satoshis for return-shape compat */
  satoshis: number
  /** transactions.processing mapped to legacy status for return-shape compat */
  status: TransactionStatus
  isOutgoing: boolean
  description: string
  created_at: Date
  /** `actions.version` if stored; otherwise undefined. */
  version: number | undefined
  /** `actions.lockTime` if stored; otherwise undefined. */
  lockTime: number | undefined
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
 *   outputs : 1 query for both action outputs (actionId IN) and inputs
 *             (spentByActionId IN), 1 query for baskets, 1 query for tag
 *             map+labels (was up to 3·N queries via findOutputs + extendOutput)
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

  // 1) Labels: tx_labels_map.actionId references actions.actionId (v3 layout).
  const labelsQuery = (includeLabels && actionIds.length > 0)
    ? k('tx_labels as l')
      .join('tx_labels_map as lm', 'lm.txLabelId', 'l.txLabelId')
      .whereIn('lm.actionId', actionIds)
      .whereNot('lm.isDeleted', true)
      .whereNot('l.isDeleted', true)
      .select('lm.actionId as actionId', 'l.label')
    : Promise.resolve([] as Array<{ actionId: number, label: string }>)

  // 2) Action outputs: outputs.actionId FK to actions.actionId.
  //    The TableOutput interface field `transactionId` carries the actionId
  //    value post-v3 (interface left as-is for back-compat).
  const outScriptCol = includeOutScripts ? ['lockingScript'] : []
  const outputsQuery = (includeOutputs && actionIds.length > 0)
    ? k('outputs')
      .whereIn('actionId', actionIds)
      .select(
        'outputId', 'userId',
        'actionId as transactionId',
        'basketId', 'spendable',
        'change', 'outputDescription', 'vout', 'satoshis', 'providedBy',
        'purpose', 'type', 'txid', 'scriptLength', 'scriptOffset',
        ...outScriptCol
      )
    : Promise.resolve([] as TableOutputX[])

  // 3) Input outputs: rows spent BY this action — outputs.spentByActionId IN (actionIds).
  //    The TableOutput interface field `spentBy` carries the spentByActionId
  //    value post-v3 (interface left as-is for back-compat).
  const inScriptCol = includeInScripts ? ['lockingScript'] : []
  const inputsQuery = (includeInputs && actionIds.length > 0)
    ? k('outputs')
      .whereIn('spentByActionId', actionIds)
      .select(
        'outputId', 'userId',
        'actionId as transactionId',
        'basketId', 'spendable',
        'change', 'outputDescription', 'vout', 'satoshis', 'providedBy',
        'purpose', 'type', 'txid', 'scriptLength', 'scriptOffset',
        'spentByActionId as spentBy',
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
    ? [...new Set(txs.map(t => t.txid).filter((s): s is string => typeof s === 'string' && s.length > 0))]
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

  // Outputs keyed by actionId. `o.transactionId` here is the renamed
  // `outputs.actionId` column (see SELECT above).
  const outputsByActionId = new Map<number, TableOutputX[]>()
  for (const o of outputRows) {
    const list = outputsByActionId.get(o.transactionId) || []
    list.push(o)
    outputsByActionId.set(o.transactionId, list)
  }

  // Inputs keyed by the spending action's actionId. `o.spentBy` carries the
  // `outputs.spentByActionId` value (see SELECT above).
  const inputsBySpenderActionId = new Map<number, TableOutputX[]>()
  for (const o of inputRows) {
    if (o.spentBy == null) continue
    const list = inputsBySpenderActionId.get(o.spentBy) || []
    list.push(o)
    inputsBySpenderActionId.set(o.spentBy, list)
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
      const list = outputsByActionId.get(row.actionId) || []
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
      const list = inputsBySpenderActionId.get(row.actionId) || []
      if (list.length === 0) continue
      const rawTx = row.txid != null ? rawTxByTxid[row.txid] : undefined
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

  // Use TransactionService to execute the actions query against the v3 layout.
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
  const txs: NewActionRow[] = svcRows.map(row => ({
    actionId: row.actionId,
    txid: row.txid,
    reference: row.reference,
    // satoshis_delta from actions maps to legacy `satoshis`
    satoshis: row.satoshisDelta,
    // Map ProcessingStatus back to legacy ActionStatus for return compat.
    // Drafts (txid is NULL) have no `processing`; treat as `unsigned`.
    status: row.processing != null ? processingToTransactionStatus(row.processing) : 'unsigned',
    isOutgoing: row.isOutgoing,
    description: row.description,
    created_at: row.created_at,
    version: row.version,
    lockTime: row.lockTime
  }))

  // specOp postProcess receives txs shaped as Partial<TableTransaction>.
  // We cast to satisfy the interface; the existing specOps (noSendActions /
  // failedActions) only read tx.status, tx.reference, and the action's id.
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
      version: tx.version as unknown as number,
      lockTime: tx.lockTime as unknown as number
    })
  }

  if (vargs.includeLabels || vargs.includeInputs || vargs.includeOutputs) {
    await bulkEnrich(storage, txs, r.actions, vargs, timeFilterRequested, auth.userId!)
  }
  return r
}
