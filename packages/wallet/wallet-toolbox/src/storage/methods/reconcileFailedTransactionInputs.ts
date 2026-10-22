import { StorageReqWrite } from '../StorageReqWrite'
import { Transaction, WalletLoggerInterface } from '@bsv/sdk'
import type * as sdk from '../../sdk'
import { StorageProvider } from '../StorageProvider'
import { EntityProvenTxReq } from '../schema/entities'
import { TableOutput } from '../schema/tables'
import { verifyId } from '../../utility/utilityHelpers'
import {
  classifyOutputUtxo,
  mapWithConcurrency,
  UTXO_PROVIDER_MAX_CONCURRENCY
} from '../../services/classifyOutputUtxo'

export interface FailedInputReconciliationResult {
  checked: number
  staleConfirmed: number
  staleOutpoints: string[]
}

interface LocalInput {
  output: TableOutput
  outpoint: { txid: string; vout: number }
}

async function quarantineLocalInputs(
  localInputs: LocalInput[],
  storage: StorageProvider,
  trx?: sdk.TrxToken,
  skipUnchanged = false
): Promise<FailedInputReconciliationResult> {
  const staleOutpoints = new Set<string>()
  for (const { output, outpoint } of localInputs) {
    if (!skipUnchanged || output.spendable)
      await storage.updateOutput(verifyId(output.outputId), { spendable: false }, trx)
    staleOutpoints.add(`${outpoint.txid}.${outpoint.vout}`)
  }
  return {
    checked: localInputs.length,
    staleConfirmed: localInputs.length,
    staleOutpoints: [...staleOutpoints]
  }
}

async function findLocalInputs(
  req: EntityProvenTxReq,
  storage: StorageProvider,
  trx?: sdk.TrxToken,
  onlyUserId?: number
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
    partial: { txid: req.txid, ...(onlyUserId == null ? {} : { userId: onlyUserId }) },
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
export async function quarantineReqInputs(
  req: EntityProvenTxReq,
  storage: StorageProvider,
  trx?: sdk.TrxToken,
  logger?: WalletLoggerInterface,
  onlyUserId?: number,
  onlyOutpoints?: ReadonlySet<string>,
  skipUnchanged = false
): Promise<FailedInputReconciliationResult> {
  const localInputs = (await findLocalInputs(req, storage, trx, onlyUserId)).filter(
    ({ outpoint }) => onlyOutpoints == null || onlyOutpoints.has(`${outpoint.txid}.${outpoint.vout}`)
  )
  const result = await quarantineLocalInputs(localInputs, storage, trx, skipUnchanged)
  if (result.staleConfirmed > 0) {
    logger?.log(
      `quarantineReqInputs: ${result.staleConfirmed} local input copy/copies quarantined for txid=${req.txid}`
    )
  }
  return result
}

/**
 * Keep only inputs created by a locally terminal parent unavailable after the
 * failed-child transition releases its allocations. Other inputs may still be
 * valid UTXOs and must remain reusable.
 */
export async function quarantineReqInputsFromFailedParents(
  req: EntityProvenTxReq,
  failedParentTxids: string[],
  storage: StorageProvider,
  trx?: sdk.TrxToken,
  logger?: WalletLoggerInterface,
  onlyUserId?: number,
  skipUnchanged = false
): Promise<FailedInputReconciliationResult> {
  const failedParents = new Set(failedParentTxids)
  const localInputs = (await findLocalInputs(req, storage, trx, onlyUserId)).filter(({ outpoint }) =>
    failedParents.has(outpoint.txid)
  )
  const result = await quarantineLocalInputs(localInputs, storage, trx, skipUnchanged)
  if (result.staleConfirmed > 0) {
    logger?.log(
      `quarantineReqInputsFromFailedParents: ${result.staleConfirmed} local parent output copy/copies quarantined for txid=${req.txid}`
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
export async function markConfirmedStaleReqInputs(
  req: EntityProvenTxReq,
  storage: StorageProvider,
  services: sdk.WalletServices,
  trx?: sdk.TrxToken,
  logger?: WalletLoggerInterface,
  capturedWrites?: StorageReqWrite
): Promise<FailedInputReconciliationResult> {
  const writes =
    capturedWrites ??
    (trx == null && typeof storage.activeWriteTransaction === 'function'
      ? await StorageReqWrite.capture(storage, [req.txid])
      : undefined)
  const result = { checked: 0, staleConfirmed: 0, staleOutpoints: [] as string[] }
  const localInputs = await findLocalInputs(req, storage, trx)
  const verdicts = new Map<string, 'stale' | 'utxo' | 'inconclusive'>()
  const uniqueInputs = new Map<string, LocalInput>()
  for (const localInput of localInputs) {
    const key = `${localInput.outpoint.txid}.${localInput.outpoint.vout}`
    if (!uniqueInputs.has(key)) uniqueInputs.set(key, localInput)
  }

  await mapWithConcurrency([...uniqueInputs.values()], UTXO_PROVIDER_MAX_CONCURRENCY, async ({ output, outpoint }) => {
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
    const classification = await classifyOutputUtxo(services, output)
    let verdict: 'inconclusive' | 'stale' | 'utxo'
    if (classification.verdict === 'unknown') verdict = 'inconclusive'
    else if (classification.verdict === 'unspent') verdict = 'utxo'
    else verdict = 'stale'
    verdicts.set(key, verdict)
  })

  const staleOutpoints = new Set<string>()
  for (const { output, outpoint } of localInputs) {
    const key = `${outpoint.txid}.${outpoint.vout}`
    const verdict = verdicts.get(key)
    if (verdict == null || verdict === 'inconclusive') continue
    result.checked++
    if (verdict === 'stale') {
      let changed = false
      const apply = async (token?: sdk.TrxToken) => {
        const current = await storage.findOutputs({
          partial: {
            outputId: verifyId(output.outputId),
            userId: output.userId,
            txid: outpoint.txid,
            vout: outpoint.vout
          },
          trx: token
        })
        if (current.length !== 1) return
        await storage.updateOutput(verifyId(output.outputId), { spendable: false }, token)
        changed = true
      }
      const committed = writes != null ? await writes.forUser(output.userId, apply) : (await apply(trx), true)
      if (committed && changed) {
        result.staleConfirmed++
        staleOutpoints.add(key)
      }
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

/** Original captures restrict each real profile. Failure bookkeeping and input
 * quarantine commit atomically; counts include only actual committed scopes. */
export async function applyCapturedTerminalFailure(
  req: EntityProvenTxReq,
  storage: StorageProvider,
  writes: StorageReqWrite,
  inputConflict: boolean,
  failedParentTxids: string[] = []
): Promise<FailedInputReconciliationResult> {
  writes.assertProvider(storage)
  const results = await writes.status(req, 'failed', async (userId, trx) => {
    if (inputConflict) return await quarantineReqInputs(req, storage, trx, undefined, userId)
    if (failedParentTxids.length)
      return await quarantineReqInputsFromFailedParents(req, failedParentTxids, storage, trx, undefined, userId)
    return { checked: 0, staleConfirmed: 0, staleOutpoints: [] }
  })
  return {
    checked: results.reduce((sum, result) => sum + result.checked, 0),
    staleConfirmed: results.reduce((sum, result) => sum + result.staleConfirmed, 0),
    staleOutpoints: [...new Set(results.flatMap(result => result.staleOutpoints))]
  }
}

/** Replay only recorded terminal evidence, under the caller's actual user
 * writer. History chooses comparison data, never a SQL actor or primary grant. */
export async function quarantineRecordedTerminalInputs(
  req: EntityProvenTxReq,
  storage: StorageProvider,
  userId: number,
  trx: sdk.TrxToken
): Promise<void> {
  if (!['invalid', 'doubleSpend'].includes(req.status)) return
  const notes = req.history.notes ?? []
  if (
    notes.some(
      note =>
        ['arcSSETerminalRejection', 'proactiveTerminalReconciliation'].includes(note.what ?? '') &&
        note.inputConflict === true
    )
  ) {
    await quarantineReqInputs(req, storage, trx, undefined, userId, undefined, true)
    return
  }
  const spent = new Set<string>()
  const parents = new Set<string>()
  for (const note of notes) {
    if (note.what === 'markStaleInputsAsSpent' && typeof note.outpoints === 'string')
      for (const point of note.outpoints.split(',')) spent.add(point)
    if (note.what === 'proactiveFailedParentQuarantine' && typeof note.parentTxids === 'string')
      for (const txid of note.parentTxids.split(',')) if (/^[a-f0-9]{64}$/.test(txid)) parents.add(txid)
  }
  if (spent.size) await quarantineReqInputs(req, storage, trx, undefined, userId, spent, true)
  const failed: string[] = []
  for (const txid of parents) {
    const current = await storage.findProvenTxReqs({ partial: { txid }, trx })
    if (current.some(parent => ['invalid', 'doubleSpend'].includes(parent.status))) failed.push(txid)
  }
  if (failed.length) await quarantineReqInputsFromFailedParents(req, failed, storage, trx, undefined, userId, true)
}
