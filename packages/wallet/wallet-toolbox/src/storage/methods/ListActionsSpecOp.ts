import { Validation } from '@bsv/sdk'
import { specOpFailedActions, specOpNoSendActions, TransactionStatus, isListActionsSpecOp } from '../../sdk/types'
import { AuthId } from '../../sdk/WalletStorage.interfaces'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { StorageProvider } from '../StorageProvider'

export interface ListActionsSpecOp {
  name: string
  /**
   * undefined to intercept no labels from vargs,
   * empty array to intercept all labels,
   * or an explicit array of labels to intercept.
   */
  labelsToIntercept?: string[]
  setStatusFilter?: () => TransactionStatus[]
  postProcess?: (
    s: StorageProvider,
    auth: AuthId,
    vargs: Validation.ValidListActionsArgs,
    specOpLabels: string[],
    txs: Array<Partial<TableTransaction>>
  ) => Promise<void>
}

export function partitionActionLabels(ordinaryLabels: string[]): {
  specOp: ListActionsSpecOp | undefined
  specOpLabels: string[]
  labels: string[]
} {
  let specOp: ListActionsSpecOp | undefined
  let specOpLabels: string[] = []
  let labels: string[] = []
  for (const label of ordinaryLabels) {
    if (isListActionsSpecOp(label)) specOp = getLabelToSpecOp()[label]
    else labels.push(label)
  }
  if (specOp?.labelsToIntercept !== undefined) {
    const intercept = specOp.labelsToIntercept
    const labels2 = labels
    labels = []
    if (intercept.length === 0) specOpLabels = labels2
    for (const label of labels2) {
      if (intercept.includes(label)) specOpLabels.push(label)
      else labels.push(label)
    }
  }
  return { specOp, specOpLabels, labels }
}

async function findProtectedNoSendTxids(
  storage: StorageProvider,
  transactions: Array<Partial<TableTransaction>>
): Promise<Set<string>> {
  // One batched chain-status lookup avoids N network calls. Positive mined or
  // mempool knowledge protects a row; an unavailable service does not make
  // abort impossible and falls through to the per-row policy.
  const candidateTxids = transactions
    .filter(transaction => transaction.status === 'nosend' && !!transaction.txid)
    .map(transaction => transaction.txid as string)
  const protectedTxids = new Set<string>()
  if (candidateTxids.length === 0) return protectedTxids

  try {
    const result = await storage.getServices().getStatusForTxids(candidateTxids)
    if (result.status !== 'success') return protectedTxids
    for (const transaction of result.results) {
      if (transaction.status === 'mined' || transaction.status === 'known') {
        protectedTxids.add(transaction.txid)
      }
    }
  } catch {
    // Service-unreachable handling intentionally falls through to per-row
    // abortAction checks, which apply the same offline-fallback policy.
  }
  return protectedTxids
}

async function abortOffChainNoSendActions(
  storage: StorageProvider,
  auth: AuthId,
  transactions: Array<Partial<TableTransaction>>,
  protectedTxids: Set<string>
): Promise<void> {
  for (const transaction of transactions) {
    if (transaction.status !== 'nosend') continue
    // Protected rows remain "nosend" so callers can distinguish them from
    // successfully aborted rows.
    if (transaction.txid != null && protectedTxids.has(transaction.txid)) continue
    const result = await storage.abortAction(auth, { reference: transaction.reference! })
    // A false result closes the status-check/abort race without incorrectly
    // reporting the action as aborted.
    if (result.aborted) transaction.status = 'failed'
  }
}

async function postProcessNoSendActions(
  storage: StorageProvider,
  auth: AuthId,
  specOpLabels: string[],
  transactions: Array<Partial<TableTransaction>>
): Promise<void> {
  if (!specOpLabels.includes('abort')) return
  const protectedTxids = await findProtectedNoSendTxids(storage, transactions)
  await abortOffChainNoSendActions(storage, auth, transactions, protectedTxids)
}

export const getLabelToSpecOp: () => Record<string, ListActionsSpecOp> = () => {
  return {
    [specOpNoSendActions]: {
      name: 'noSendActions',
      labelsToIntercept: ['abort'],
      setStatusFilter: () => ['nosend'],
      postProcess: async (
        s: StorageProvider,
        auth: AuthId,
        vargs: Validation.ValidListActionsArgs,
        specOpLabels: string[],
        txs: Array<Partial<TableTransaction>>
      ): Promise<void> => {
        await postProcessNoSendActions(s, auth, specOpLabels, txs)
      }
    },
    [specOpFailedActions]: {
      name: 'failedActions',
      labelsToIntercept: ['unfail'],
      setStatusFilter: () => ['failed'],
      postProcess: async (
        s: StorageProvider,
        auth: AuthId,
        vargs: Validation.ValidListActionsArgs,
        specOpLabels: string[],
        txs: Array<Partial<TableTransaction>>
      ): Promise<void> => {
        if (specOpLabels.includes('unfail')) {
          for (const tx of txs) {
            if (tx.status === 'failed') {
              await s.updateTransaction(tx.transactionId!, { status: 'unfail' })
              // wallet wire does not support 'unfail' status, return as 'failed'.
            }
          }
        }
      }
    }
  }
}
