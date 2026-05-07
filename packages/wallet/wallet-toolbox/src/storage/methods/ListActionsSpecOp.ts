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

export function partitionActionLabels (
  ordinaryLabels: string[]
): { specOp: ListActionsSpecOp | undefined, specOpLabels: string[], labels: string[] } {
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
        if (specOpLabels.includes('abort')) {
          for (const tx of txs) {
            if (tx.status === 'nosend') {
              await s.abortAction(auth, { reference: tx.reference! })
              tx.status = 'failed'
            }
          }
        }
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
