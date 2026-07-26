import {
  Beef,
  ScriptEvaluationError,
  Spend,
  type SignatureHashCache,
  type SpendVerificationContext,
  type SpendVerifierInterface
} from '@bsv/sdk'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'

export interface UnlockScriptVerificationResult {
  verifiedInputs: number
  skippedInputs: number
}

interface PendingSpendVerification {
  inputIndex: number
  resultIndex: number
  spend: Spend
  context: SpendVerificationContext
}

const javaScriptOnlyVerifier: SpendVerifierInterface = {
  shouldVerifySpend: () => false,
  verifySpend: async () => {
    throw new Error('JavaScript-only verifier unexpectedly selected its backend')
  }
}

function invalidUnlockingScript (
  inputIndex: number,
  detail?: string
): WERR_INVALID_PARAMETER {
  const suffix = detail == null ? '' : ` ${detail}`
  return new WERR_INVALID_PARAMETER(`inputs[${inputIndex}].unlockScript`, `valid.${suffix}`)
}

async function verifyOneSpend (
  pending: PendingSpendVerification,
  verifier?: SpendVerifierInterface
): Promise<void> {
  try {
    const valid = verifier === undefined
      ? pending.spend.validate(pending.context)
      : await pending.spend.validateWith(verifier, pending.context)
    if (!valid) throw invalidUnlockingScript(pending.inputIndex)
  } catch (error: unknown) {
    if (error instanceof ScriptEvaluationError) {
      throw invalidUnlockingScript(pending.inputIndex, error.message)
    }
    throw error
  }
}

async function verifyPendingSpends (
  pending: PendingSpendVerification[],
  verifier?: SpendVerifierInterface
): Promise<void> {
  if (verifier?.verifySpendsBatch === undefined) {
    for (const item of pending) await verifyOneSpend(item, verifier)
    return
  }

  const batched: PendingSpendVerification[] = []
  for (const item of pending) {
    const selected = verifier.shouldVerifySpend?.(item.spend, item.context) !== false
    if (selected) batched.push(item)
    else await verifyOneSpend(item, javaScriptOnlyVerifier)
  }
  if (batched.length === 0) return

  let verdicts: boolean[]
  try {
    verdicts = await verifier.verifySpendsBatch(
      batched.map(item => ({ spend: item.spend, ...item.context }))
    )
  } catch (error: unknown) {
    if (error instanceof ScriptEvaluationError) {
      throw invalidUnlockingScript(batched[0].inputIndex, error.message)
    }
    throw error
  }
  if (verdicts.length !== batched.length) {
    throw new Error('Script verifier returned an invalid batch result count')
  }
  verdicts.forEach((valid, index) => {
    if (!valid) throw invalidUnlockingScript(batched[index].inputIndex)
  })
}

/**
 * Verifies every resolvable input from several transactions in one optional
 * backend batch while preserving per-transaction verification counts.
 */
export async function verifyUnlockScriptsBatch (
  txids: readonly string[],
  beef: Beef,
  verifier?: SpendVerifierInterface
): Promise<UnlockScriptVerificationResult[]> {
  const results = txids.map(() => ({ verifiedInputs: 0, skippedInputs: 0 }))
  const pending: PendingSpendVerification[] = []
  for (let resultIndex = 0; resultIndex < txids.length; resultIndex++) {
    const txid = txids[resultIndex]
    const tx = beef.findTxid(txid)?.tx
    if (tx == null) throw new WERR_INVALID_PARAMETER('txid', `contained in beef, txid ${txid}`)
    const sigHashCache: SignatureHashCache = { hashOutputsSingle: new Map() }
    for (let inputIndex = 0; inputIndex < tx.inputs.length; inputIndex++) {
      const input = tx.inputs[inputIndex]
      if (input.sourceTXID == null) {
        throw new WERR_INVALID_PARAMETER(`inputs[${inputIndex}].sourceTXID`, 'valid')
      }
      if (input.unlockingScript == null) {
        throw new WERR_INVALID_PARAMETER(`inputs[${inputIndex}].unlockingScript`, 'valid')
      }
      input.sourceTransaction = beef.findTxid(input.sourceTXID)?.tx
      if (input.sourceTransaction == null) {
        // knownTxids may intentionally omit a source transaction. Only that
        // input is skipped; every source that is present is still verified.
        results[resultIndex].skippedInputs++
        continue
      }
      const sourceOutput = input.sourceTransaction.outputs[input.sourceOutputIndex]
      if (sourceOutput == null) {
        throw new WERR_INVALID_PARAMETER(
          `inputs[${inputIndex}].sourceOutputIndex`,
          'reference an output in the source transaction'
        )
      }
      const utxoHeight = input.sourceTransaction.merklePath?.blockHeight
      const context: SpendVerificationContext = utxoHeight === undefined
        ? { consensus: true }
        : { consensus: true, utxoHeight }
      pending.push({
        inputIndex,
        resultIndex,
        context,
        spend: new Spend({
          sourceTXID: input.sourceTXID,
          sourceOutputIndex: input.sourceOutputIndex,
          lockingScript: sourceOutput.lockingScript,
          sourceSatoshis: sourceOutput.satoshis ?? 0,
          transactionVersion: tx.version,
          otherInputs: [],
          allInputs: tx.inputs,
          unlockingScript: input.unlockingScript,
          inputSequence: input.sequence ?? 0,
          inputIndex,
          outputs: tx.outputs,
          lockTime: tx.lockTime,
          sigHashCache
        })
      })
    }
  }
  await verifyPendingSpends(pending, verifier)
  for (const item of pending) results[item.resultIndex].verifiedInputs++
  return results
}

/**
 * @param txid The TXID of a transaction in the beef for which all unlocking scripts must be valid.
 * @param beef Must contain transactions for txid and all its inputs.
 * @throws WERR_INVALID_PARAMETER if any unlocking script is invalid, if sourceTXID is invalid, if beef doesn't contain required transactions.
 */
export async function verifyUnlockScripts (
  txid: string,
  beef: Beef,
  verifier?: SpendVerifierInterface
): Promise<UnlockScriptVerificationResult> {
  return (await verifyUnlockScriptsBatch([txid], beef, verifier))[0]
}
