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
        // about? Skip those in this bulk path — confirmed-on-chain
        // rows still cause `abortAction` to refuse, but doing the
        // batched chain check up-front saves N individual queries.
        //
        // The pre-filter does one batched getStatusForTxids call for
        // the whole page, builds a protectedTxids set, then in the
        // loop below skips protected rows (leaving their tx.status as
        // 'nosend' so the caller sees clearly that those rows were
        // NOT aborted) and proceeds normally for off-chain rows.
        //
        // Service-unreachable handling: proceed with per-row aborts.
        // Refusal is reserved for positive on-chain confirmation. If
        // the batched chain check is unavailable, fall through with
        // an empty protectedTxids set; the individual `abortAction`
        // calls below will each treat service-unreachable the same
        // way and proceed with the abort (with an offline-fallback
        // audit note on each row). Per BRC-100 contract (Tone Engel
        // review, PR #122 comment 4444566147 item 4), abort must
        // remain possible when network confirmation is impossible.
        //
        // Race window: a row that was off-chain at pre-filter time
        // may become chain-known by the time `s.abortAction` is
        // called. In that case the inner call returns aborted:false
        // and we leave the row's status as 'nosend' rather than
        // stamping it 'failed'.
        const candidates = txs.filter(tx => tx.status === 'nosend' && !!tx.txid)
        const candidateTxids = candidates.map(tx => tx.txid as string)
        const protectedTxids = new Set<string>()
        if (candidateTxids.length > 0) {
          const services = s.getServices()
          try {
            const r = await services.getStatusForTxids(candidateTxids)
            if (r.status === 'success') {
              for (const result of r.results) {
                if (result.status === 'mined' || result.status === 'known') {
                  protectedTxids.add(result.txid)
                }
              }
            }
            // On graceful r.status !== 'success' we leave protectedTxids
            // empty and let individual abortAction calls decide.
          } catch {
            // Same: service threw — leave protectedTxids empty and let
            // individual abortAction calls handle service-unreachable
            // per their own offline-fallback policy.
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
          const result = await s.abortAction(auth, { reference: tx.reference! })
          if (result.aborted) {
            tx.status = 'failed'
          }
          // result.aborted === false: race window between pre-filter
          // and per-row call observed positive on-chain confirmation.
          // Leave tx.status as 'nosend' — same outcome as if it had
          // been caught by the pre-filter.
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
