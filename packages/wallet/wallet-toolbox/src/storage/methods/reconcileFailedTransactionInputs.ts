import { Transaction, Utils, WalletLoggerInterface } from '@bsv/sdk'
import * as sdk from '../../sdk'
import { StorageProvider } from '../StorageProvider'
import { EntityProvenTxReq } from '../schema/entities'
import { TableOutput } from '../schema/tables'
import { verifyId } from '../../utility/utilityHelpers'

export interface FailedInputReconciliationResult {
  checked: number
  staleConfirmed: number
  staleOutpoints: string[]
}

interface LocalInput {
  output: TableOutput
  outpoint: { txid: string; vout: number }
}

async function findLocalInputs (
  req: EntityProvenTxReq,
  storage: StorageProvider,
  trx?: sdk.TrxToken
): Promise<LocalInput[]> {
  const tx = Transaction.fromBinary(req.rawTx)
  const outpoints = tx.inputs
    .map(input => ({ txid: input.sourceTXID ?? '', vout: input.sourceOutputIndex ?? 0 }))
    .filter(outpoint => outpoint.txid !== '')
  if (outpoints.length === 0) return []

  // A transaction can be internalized by multiple users while the request's
  // notification list is racing. Resolve every local copy by txid so no user's
  // basket retains the same confirmed-stale outpoint.
  const transactions = await storage.findTransactions({
    partial: { txid: req.txid },
    noRawTx: true,
    trx
  })
  const userIds = [...new Set(transactions.map(transaction => transaction.userId))]
  const localInputs: LocalInput[] = []
  const localKeys = new Set<string>()
  for (const userId of userIds) {
    const byOutpoint = await storage.findOutputsByOutpoints(userId, outpoints, trx)
    for (const outpoint of outpoints) {
      const output = byOutpoint[`${outpoint.txid}.${outpoint.vout}`]
      const localKey = `${userId}:${outpoint.txid}.${outpoint.vout}`
      if (output != null && !localKeys.has(localKey)) {
        localKeys.add(localKey)
        localInputs.push({ output, outpoint })
      }
    }
  }
  return localInputs
}

/**
 * Conservatively quarantine every locally-owned input of a transaction after
 * Arcade supplies explicit missing-input/conflict evidence. This path is
 * deliberately independent of explorer or UTXO providers: a positive
 * broadcaster verdict is enough to stop the failed transaction from feeding
 * the same inputs into another action. A later validated mined proof remains
 * able to repair the transaction through the ordinary proof recovery path.
 */
export async function quarantineReqInputs (
  req: EntityProvenTxReq,
  storage: StorageProvider,
  trx?: sdk.TrxToken,
  logger?: WalletLoggerInterface
): Promise<FailedInputReconciliationResult> {
  const localInputs = await findLocalInputs(req, storage, trx)
  const staleOutpoints = new Set<string>()
  for (const { output, outpoint } of localInputs) {
    await storage.updateOutput(verifyId(output.outputId), { spendable: false }, trx)
    staleOutpoints.add(`${outpoint.txid}.${outpoint.vout}`)
  }
  const result = {
    checked: localInputs.length,
    staleConfirmed: localInputs.length,
    staleOutpoints: [...staleOutpoints]
  }
  if (result.staleConfirmed > 0) {
    logger?.log(
      `quarantineReqInputs: ${result.staleConfirmed} local input copy/copies quarantined for txid=${req.txid}`
    )
  }
  return result
}

/**
 * Ask the configured UTXO-provider collection to classify the request's local
 * inputs and mark only positively confirmed spent outputs unavailable.
 * Provider errors and a collection with no providers are inconclusive and
 * never count as spent.
 */
export async function markConfirmedStaleReqInputs (
  req: EntityProvenTxReq,
  storage: StorageProvider,
  services: sdk.WalletServices,
  trx?: sdk.TrxToken,
  logger?: WalletLoggerInterface
): Promise<FailedInputReconciliationResult> {
  const result = { checked: 0, staleConfirmed: 0, staleOutpoints: [] as string[] }
  const localInputs = await findLocalInputs(req, storage, trx)
  const verdicts = new Map<string, 'stale' | 'utxo' | 'inconclusive'>()
  const uniqueInputs = new Map<string, LocalInput>()
  for (const localInput of localInputs) {
    const key = `${localInput.outpoint.txid}.${localInput.outpoint.vout}`
    if (!uniqueInputs.has(key)) uniqueInputs.set(key, localInput)
  }

  await Promise.all(
    [...uniqueInputs.values()].map(async ({ output, outpoint }) => {
      const key = `${outpoint.txid}.${outpoint.vout}`
      if (output.lockingScript == null) {
        try {
          await storage.validateOutputScript(output, trx)
        } catch {
          verdicts.set(key, 'inconclusive')
          return
        }
      }
      if (output.lockingScript == null) {
        verdicts.set(key, 'inconclusive')
        return
      }
      try {
        const hash = services.hashOutputScript(Utils.toHex(output.lockingScript))
        const status = await services.getUtxoStatus(hash, undefined, key)
        if (status.status !== 'success' || status.isUtxo == null) {
          verdicts.set(key, 'inconclusive')
        } else {
          verdicts.set(key, status.isUtxo ? 'utxo' : 'stale')
        }
      } catch {
        verdicts.set(key, 'inconclusive')
      }
    })
  )

  const staleOutpoints = new Set<string>()
  for (const { output, outpoint } of localInputs) {
    const key = `${outpoint.txid}.${outpoint.vout}`
    const verdict = verdicts.get(key)
    if (verdict == null || verdict === 'inconclusive') continue
    result.checked++
    if (verdict === 'stale') {
      await storage.updateOutput(verifyId(output.outputId), { spendable: false }, trx)
      result.staleConfirmed++
      staleOutpoints.add(key)
    }
  }
  result.staleOutpoints = [...staleOutpoints]
  if (result.staleConfirmed > 0) {
    logger?.log(
      `markConfirmedStaleReqInputs: ${result.staleConfirmed} of ${result.checked} local input copy/copies confirmed spent for txid=${req.txid}`
    )
  }
  return result
}
