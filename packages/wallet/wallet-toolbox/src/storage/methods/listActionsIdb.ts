import {
  Transaction as BsvTransaction,
  ActionStatus,
  ListActionsResult,
  WalletAction,
  WalletActionOutput,
  WalletActionInput,
  Validation
} from '@bsv/sdk'
import { StorageIdb } from '../StorageIdb'
import { partitionActionLabels } from './ListActionsSpecOp'
import { AuthId } from '../../sdk/WalletStorage.interfaces'
import { TransactionStatus } from '../../sdk/types'
import { TableOutputX } from '../schema/tables/TableOutput'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { makeBrc114ActionTimeLabel, parseBrc114ActionTimeLabels } from '../../utility/brc114ActionTimeLabels'

async function enrichIdbActionLabels (
  storage: StorageIdb,
  tx: { transactionId: number, created_at?: any },
  action: WalletAction,
  timeFilterRequested: boolean
): Promise<void> {
  action.labels = (await storage.getLabelsForTransactionId(tx.transactionId)).map(l => l.label)
  if (timeFilterRequested) {
    const ts = tx.created_at ? new Date(tx.created_at as any).getTime() : Number.NaN
    if (!Number.isNaN(ts)) {
      const timeLabel = makeBrc114ActionTimeLabel(ts)
      if (!action.labels.includes(timeLabel)) action.labels.push(timeLabel)
    }
  }
}

async function enrichIdbActionOutputs (
  storage: StorageIdb,
  transactionId: number,
  action: WalletAction,
  includeOutputLockingScripts: boolean
): Promise<void> {
  const outputs: TableOutputX[] = await storage.findOutputs({
    partial: { transactionId },
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

async function enrichIdbActionInputs (
  storage: StorageIdb,
  tx: { transactionId: number, txid?: string },
  action: WalletAction,
  includeSourceLockingScripts: boolean,
  includeUnlockingScripts: boolean
): Promise<void> {
  const inputs: TableOutputX[] = await storage.findOutputs({
    partial: { spentBy: tx.transactionId },
    noScript: !includeSourceLockingScripts
  })
  action.inputs = []
  if (inputs.length === 0) return
  const rawTx = await storage.getRawTxOfKnownValidTransaction(tx.txid)
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

export async function listActionsIdb (
  storage: StorageIdb,
  auth: AuthId,
  vargs: Validation.ValidListActionsArgs
): Promise<ListActionsResult> {
  const offset = vargs.offset

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

  const labelIds: number[] = []
  if (labels.length > 0) {
    await storage.filterTxLabels({ partial: { userId: auth.userId, isDeleted: false } }, tl => {
      if (labels.includes(tl.label)) {
        labelIds.push(tl.txLabelId)
      }
    })
  }

  const isQueryModeAll = vargs.labelQueryMode === 'all'
  if (isQueryModeAll && labelIds.length < labels.length)
  // all the required labels don't exist, impossible to satisfy.
  { return r }

  if (!isQueryModeAll && labelIds.length === 0 && labels.length > 0)
  // any and only non-existing labels, impossible to satisfy.
  { return r }

  const stati: TransactionStatus[] = (specOp?.setStatusFilter == null)
    ? ['completed', 'unprocessed', 'sending', 'unproven', 'unsigned', 'nosend', 'nonfinal']
    : specOp.setStatusFilter()

  const txs = await storage.findTransactions(
    {
      partial: { userId: auth.userId },
      status: stati,
      from: createdAtFrom,
      to: createdAtTo,
      paged: { limit: vargs.limit, offset: vargs.offset },
      noRawTx: true
    },
    labelIds,
    isQueryModeAll
  )
  if (txs.length === vargs.limit) {
    r.totalActions = await storage.countTransactions(
      { partial: { userId: auth.userId }, status: stati, from: createdAtFrom, to: createdAtTo },
      labelIds,
      isQueryModeAll
    )
  } else {
    r.totalActions = (offset || 0) + txs.length
  }

  if ((specOp?.postProcess) != null) {
    await specOp.postProcess(storage, auth, vargs, specOpLabels, txs)
  }

  for (const tx of txs) {
    r.actions.push({
      txid: tx.txid || '',
      satoshis: tx.satoshis || 0,
      status: tx.status as ActionStatus,
      isOutgoing: !!tx.isOutgoing,
      description: tx.description || '',
      version: tx.version || 0,
      lockTime: tx.lockTime || 0
    })
  }

  if (vargs.includeLabels || vargs.includeInputs || vargs.includeOutputs) {
    await Promise.all(
      txs.map(async (tx, i) => {
        const action = r.actions[i]
        if (vargs.includeLabels) await enrichIdbActionLabels(storage, tx, action, timeFilterRequested)
        if (vargs.includeOutputs) await enrichIdbActionOutputs(storage, tx.transactionId, action, !!vargs.includeOutputLockingScripts)
        if (vargs.includeInputs) {
          await enrichIdbActionInputs(storage, tx, action, !!vargs.includeInputSourceLockingScripts, !!vargs.includeInputUnlockingScripts)
        }
      })
    )
  }
  return r
}
