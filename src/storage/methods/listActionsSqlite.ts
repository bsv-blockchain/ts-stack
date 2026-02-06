import {
  Transaction as BsvTransaction,
  ActionStatus,
  ListActionsResult,
  WalletAction,
  WalletActionOutput,
  WalletActionInput,
  Validation
} from '@bsv/sdk'
import { StorageSqlite } from '../StorageSqlite'
import { getLabelToSpecOp, ListActionsSpecOp } from './ListActionsSpecOp'
import { AuthId } from '../../sdk/WalletStorage.interfaces'
import { isListActionsSpecOp } from '../../sdk/types'
import { TableTxLabel } from '../schema/tables/TableTxLabel'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { TableOutputX } from '../schema/tables/TableOutput'
import { asString } from '../../utility/utilityHelpers.noBuffer'

export async function listActionsSqlite(
  storage: StorageSqlite,
  auth: AuthId,
  vargs: Validation.ValidListActionsArgs
): Promise<ListActionsResult> {
  const limit = vargs.limit
  const offset = vargs.offset

  const r: ListActionsResult = {
    totalActions: 0,
    actions: []
  }

  let specOp: ListActionsSpecOp | undefined = undefined
  let specOpLabels: string[] = []
  let labels: string[] = []
  for (const label of vargs.labels) {
    if (isListActionsSpecOp(label)) {
      specOp = getLabelToSpecOp()[label]
    } else {
      labels.push(label)
    }
  }
  if (specOp?.labelsToIntercept !== undefined) {
    const intercept = specOp.labelsToIntercept!
    const labels2 = labels
    labels = []
    if (intercept.length === 0) {
      specOpLabels = labels2
    }
    for (const label of labels2) {
      if (intercept.indexOf(label) >= 0) {
        specOpLabels.push(label)
      } else {
        labels.push(label)
      }
    }
  }

  let labelIds: number[] = []
  if (labels.length > 0) {
    const placeholders = labels.map(() => '?').join(',')
    const rows = await storage.getAll<{ txLabelId: number }>(
      `SELECT txLabelId FROM tx_labels WHERE userId = ? AND isDeleted = 0 AND txLabelId IS NOT NULL AND label IN (${placeholders})`,
      [auth.userId!, ...labels]
    )
    labelIds = rows.map(r => r.txLabelId)
  }

  const isQueryModeAll = vargs.labelQueryMode === 'all'
  if (isQueryModeAll && labelIds.length < labels.length) return r
  if (!isQueryModeAll && labelIds.length === 0 && labels.length > 0) return r

  const columns = [
    'transactionId',
    'reference',
    'txid',
    'satoshis',
    'status',
    'isOutgoing',
    'description',
    'version',
    'lockTime'
  ]
  const colsSql = columns.join(', ')

  const stati: string[] = specOp?.setStatusFilter
    ? specOp.setStatusFilter()
    : ['completed', 'unprocessed', 'sending', 'unproven', 'unsigned', 'nosend', 'nonfinal']
  const statiPlaceholders = stati.map(() => '?').join(',')

  const noLabels = labelIds.length === 0

  let txs: Partial<TableTransaction>[]
  let totalActions: number

  if (noLabels) {
    const baseSql = `FROM transactions WHERE userId = ? AND status IN (${statiPlaceholders})`
    const baseParams = [auth.userId!, ...stati]

    txs = await storage.getAll<Partial<TableTransaction>>(
      `SELECT ${colsSql} ${baseSql} ORDER BY transactionId ASC LIMIT ? OFFSET ?`,
      [...baseParams, limit, offset]
    )

    if (!limit || txs.length < limit) {
      totalActions = txs.length
    } else {
      const countRow = await storage.getOne<{ total: number }>(
        `SELECT COUNT(transactionId) as total ${baseSql}`,
        baseParams
      )
      totalActions = countRow?.total || 0
    }
  } else {
    const labelIdsList = labelIds.join(',')
    const labelCountCheck = isQueryModeAll ? `= ${labelIds.length}` : '> 0'

    const cteSql = `
      SELECT ${columns.map(c => 't.' + c).join(',')},
        (SELECT COUNT(*) FROM tx_labels_map AS m WHERE m.transactionId = t.transactionId AND m.txLabelId IN (${labelIdsList})) AS lc
      FROM transactions AS t
      WHERE t.userId = ? AND t.status IN (${statiPlaceholders})`
    const cteParams = [auth.userId!, ...stati]

    txs = await storage.getAll<Partial<TableTransaction>>(
      `WITH tlc AS (${cteSql}) SELECT ${colsSql} FROM tlc WHERE lc ${labelCountCheck} ORDER BY transactionId ASC LIMIT ? OFFSET ?`,
      [...cteParams, limit, offset]
    )

    if (!limit || txs.length < limit) {
      totalActions = txs.length
    } else {
      const countRow = await storage.getOne<{ total: number }>(
        `WITH tlc AS (${cteSql}) SELECT COUNT(transactionId) as total FROM tlc WHERE lc ${labelCountCheck}`,
        cteParams
      )
      totalActions = countRow?.total || 0
    }
  }

  if (specOp?.postProcess) {
    await specOp.postProcess(storage as any, auth, vargs, specOpLabels, txs)
  }

  r.totalActions = totalActions

  for (const tx of txs) {
    const wtx: WalletAction = {
      txid: tx.txid || '',
      satoshis: tx.satoshis || 0,
      status: <ActionStatus>tx.status!,
      isOutgoing: !!tx.isOutgoing,
      description: tx.description || '',
      version: tx.version || 0,
      lockTime: tx.lockTime || 0
    }
    r.actions.push(wtx)
  }

  if (vargs.includeLabels || vargs.includeInputs || vargs.includeOutputs) {
    await Promise.all(
      txs.map(async (tx, i) => {
        const action = r.actions[i]
        if (vargs.includeLabels) {
          action.labels = (await storage.getLabelsForTransactionId(tx.transactionId)).map(l => l.label)
        }
        if (vargs.includeOutputs) {
          const outputs: TableOutputX[] = await storage.findOutputs({
            partial: { transactionId: tx.transactionId },
            noScript: !vargs.includeOutputLockingScripts
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
            if (vargs.includeOutputLockingScripts) wo.lockingScript = asString(o.lockingScript || [])
            action.outputs.push(wo)
          }
        }
        if (vargs.includeInputs) {
          const inputs: TableOutputX[] = await storage.findOutputs({
            partial: { spentBy: tx.transactionId },
            noScript: !vargs.includeInputSourceLockingScripts
          })
          action.inputs = []
          if (inputs.length > 0) {
            const rawTx = await storage.getRawTxOfKnownValidTransaction(tx.txid)
            let bsvTx: BsvTransaction | undefined = undefined
            if (rawTx) {
              bsvTx = BsvTransaction.fromBinary(rawTx)
            }
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
              if (vargs.includeInputSourceLockingScripts) {
                wo.sourceLockingScript = asString(o.lockingScript || [])
              }
              if (vargs.includeInputUnlockingScripts) {
                wo.unlockingScript = input?.unlockingScript?.toHex()
              }
            }
          }
        }
      })
    )
  }
  return r
}
