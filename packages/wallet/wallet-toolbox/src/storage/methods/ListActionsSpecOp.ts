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
        if (!specOpLabels.includes('abort')) return

        // Pre-filter: which rows have txids the network already knows
        // about? Don't call abortAction for those — the abortAction
        // chain-check (in StorageProvider) will throw for chain-known
        // nosend rows, which would propagate out of the await below
        // and bail the entire bulk call halfway, leaving genuinely
        // off-chain nosend rows in the same page un-aborted.
        //
        // The pre-filter does one batched getStatusForTxids call for
        // the whole page, builds a protectedTxids set, then in the
        // loop below skips protected rows (leaving their tx.status as
        // 'nosend' so the caller sees clearly that those rows were
        // NOT aborted) and proceeds normally for off-chain rows.
        //
        // Service-unreachable handling is conservative-refuse: both
        // the thrown-error path AND the graceful r.status==='error'
        // return (with typically empty results[]) protect ALL
        // candidate rows. Better to leave nosend rows alone than risk
        // orphaning outputs of txs that may be on chain.
        const candidates = txs.filter(tx => tx.status === 'nosend' && !!tx.txid)
        const candidateTxids = candidates.map(tx => tx.txid as string)
        const protectedTxids = new Set<string>()
        if (candidateTxids.length > 0) {
          const services = s.getServices()
          let serviceFailed = false
          try {
            const r = await services.getStatusForTxids(candidateTxids)
            if (r.status !== 'success') {
              serviceFailed = true
            } else {
              for (const result of r.results) {
                if (result.status === 'mined' || result.status === 'known') {
                  protectedTxids.add(result.txid)
                }
              }
            }
          } catch {
            serviceFailed = true
          }
          if (serviceFailed) {
            for (const txid of candidateTxids) protectedTxids.add(txid)
          }
        }

        for (const tx of txs) {
          if (tx.status !== 'nosend') continue
          if (tx.txid && protectedTxids.has(tx.txid)) {
            // Skip: tx is on chain or in mempool. Leave the returned
            // row's status as 'nosend' so the caller sees clearly
            // that this row was NOT aborted. Monitor's TaskCheckNoSends
            // will retire the nosend lifecycle on the next block tick
            // (per the processNewBlockHeader nudge added in this PR).
            continue
          }
          await s.abortAction(auth, { reference: tx.reference! })
          tx.status = 'failed'
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
