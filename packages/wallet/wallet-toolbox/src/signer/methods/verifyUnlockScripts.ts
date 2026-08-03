import {
  Beef,
  type BdkVerifierInterface,
  type DigestVerification,
  Hash,
  ScriptEvaluationError,
  Spend,
  Transaction,
  TransactionSignature,
  type SignatureHashCache,
  type SpendVerificationContext,
  type SpendVerifierInterface
} from '@bsv/sdk'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'

export interface UnlockScriptVerificationResult {
  verifiedInputs: number
  skippedInputs: number
}

type PendingSpendVerification = readonly [
  inputIndex: number,
  resultIndex: number,
  spend: Spend,
  context: SpendVerificationContext
]

type PendingTransactionVerification = readonly [
  resultIndex: number,
  params: Parameters<BdkVerifierInterface['verifyScripts']>[0]
]

type PendingDigestVerification = readonly [resultIndex: number, items: DigestVerification[]]

interface DigestBatchVerifier {
  isReady?: () => boolean
  supportsCrypto?: (operation: 'verifyDigestBatch') => boolean
  verifyDigestBatch: (items: readonly DigestVerification[]) => Promise<boolean[]>
}

const postChronicleHeightFallback = 943816
const canonicalP2PKHScope = TransactionSignature.SIGHASH_ALL + TransactionSignature.SIGHASH_FORKID

const javaScriptOnlyVerifier: SpendVerifierInterface = {
  shouldVerifySpend: () => false,
  verifySpend: async () => {
    throw new Error('JavaScript-only verifier unexpectedly selected its backend')
  }
}

function invalidUnlockingScript(inputIndex: number, detail?: string): WERR_INVALID_PARAMETER {
  const suffix = detail == null ? '' : ` ${detail}`
  return new WERR_INVALID_PARAMETER(`inputs[${inputIndex}].unlockScript`, `valid.${suffix}`)
}

async function verifyOneSpend(pending: PendingSpendVerification, verifier?: SpendVerifierInterface): Promise<void> {
  const [inputIndex, , spend, context] = pending
  try {
    const valid =
      verifier === undefined
        ? spend.validate(context)
        : await spend.validateWith(verifier, context)
    if (!valid) throw invalidUnlockingScript(inputIndex)
  } catch (error: unknown) {
    if (error instanceof ScriptEvaluationError) {
      throw invalidUnlockingScript(inputIndex, error.message)
    }
    throw error
  }
}

async function verifyPendingSpends(
  pending: PendingSpendVerification[],
  verifier?: SpendVerifierInterface
): Promise<void> {
  if (verifier?.verifySpendsBatch === undefined) {
    for (const item of pending) await verifyOneSpend(item, verifier)
    return
  }

  const batched: PendingSpendVerification[] = []
  for (const item of pending) {
    const selected = verifier.shouldVerifySpend?.(item[2], item[3]) !== false
    if (selected) batched.push(item)
    else await verifyOneSpend(item, javaScriptOnlyVerifier)
  }
  if (batched.length === 0) return

  let verdicts: boolean[]
  try {
    verdicts = await verifier.verifySpendsBatch(batched.map(item => ({ spend: item[2], ...item[3] })))
  } catch (error: unknown) {
    if (error instanceof ScriptEvaluationError) {
      throw invalidUnlockingScript(batched[0][0], error.message)
    }
    throw error
  }
  if (verdicts.length !== batched.length) {
    throw new Error('Script verifier returned an invalid batch result count')
  }
  verdicts.forEach((valid, index) => {
    if (!valid) throw invalidUnlockingScript(batched[index][0])
  })
}

function wholeTransactionVerifier(
  verifier?: SpendVerifierInterface
): (SpendVerifierInterface & BdkVerifierInterface) | undefined {
  const candidate = verifier as (SpendVerifierInterface & Partial<BdkVerifierInterface>) | undefined
  return typeof candidate?.verifyScripts === 'function'
    ? candidate as SpendVerifierInterface & BdkVerifierInterface
    : undefined
}

function digestBatchVerifier(
  verifier?: SpendVerifierInterface
): DigestBatchVerifier | undefined {
  const candidate = verifier as (SpendVerifierInterface & Partial<DigestBatchVerifier>) | undefined
  if (typeof candidate?.verifyDigestBatch !== 'function') return undefined
  if (candidate.isReady?.() === false) return undefined
  if (candidate.supportsCrypto?.('verifyDigestBatch') === false) return undefined
  return candidate as SpendVerifierInterface & DigestBatchVerifier
}

function equalBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function isCanonicalP2PKHLock(lock: Uint8Array): boolean {
  return lock.length === 25 &&
    lock[0] === 0x76 &&
    lock[1] === 0xa9 &&
    lock[2] === 0x14 &&
    lock[23] === 0x88 &&
    lock[24] === 0xac
}

function parseCanonicalP2PKHUnlock(
  unlock: Uint8Array,
  lock: Uint8Array
): [checksig: number[], publicKey: Uint8Array, signature: TransactionSignature] | undefined {
  const signatureLength = unlock[0]
  if (
    signatureLength == null ||
    signatureLength < 9 ||
    signatureLength > 73 ||
    unlock.length !== 1 + signatureLength + 1 + 33 ||
    unlock[1 + signatureLength] !== 33
  ) return undefined
  const checksig = Array.from(unlock.subarray(1, 1 + signatureLength))
  const publicKey = unlock.subarray(1 + signatureLength + 1)
  if (
    (publicKey[0] !== 0x02 && publicKey[0] !== 0x03) ||
    !equalBytes(Hash.hash160(publicKey), lock.subarray(3, 23))
  ) return undefined

  let signature: TransactionSignature
  try {
    signature = TransactionSignature.fromChecksigFormat(checksig)
  } catch {
    return undefined
  }
  if (
    signature.scope !== canonicalP2PKHScope ||
    !signature.hasLowS() ||
    !equalBytes(signature.toChecksigFormat(), checksig)
  ) return undefined
  return [checksig, publicKey, signature]
}

/**
 * Recognizes only the exact canonical P2PKH shape generated by this wallet.
 * Anything else retains the general-purpose script interpreter/backend path.
 */
function standardP2PKHDigests(tx: Transaction): DigestVerification[] | undefined {
  const cache: SignatureHashCache = { hashOutputsSingle: new Map() }
  const items: DigestVerification[] = []
  for (let inputIndex = 0; inputIndex < tx.inputs.length; inputIndex++) {
    const input = tx.inputs[inputIndex]
    const sourceTransaction = input.sourceTransaction
    const sourceTXID = input.sourceTXID
    const unlockingScript = input.unlockingScript
    if (sourceTransaction == null || sourceTXID == null || unlockingScript == null) return undefined
    const sourceOutput = sourceTransaction.outputs[input.sourceOutputIndex]
    if (sourceOutput == null) return undefined
    const lock = sourceOutput.lockingScript.toUint8Array()
    if (!isCanonicalP2PKHLock(lock)) return undefined
    const parsed = parseCanonicalP2PKHUnlock(unlockingScript.toUint8Array(), lock)
    if (parsed == null) return undefined
    const [checksig, publicKey, signature] = parsed

    const preimage = TransactionSignature.formatBytes({
      sourceTXID,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: sourceOutput.satoshis ?? 0,
      transactionVersion: tx.version,
      otherInputs: [],
      allInputs: tx.inputs,
      outputs: tx.outputs,
      inputIndex,
      subscript: sourceOutput.lockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
      scope: signature.scope,
      cache
    })
    items.push({
      publicKey,
      digest: Uint8Array.from(Hash.hash256(preimage)),
      signature: Uint8Array.from(checksig.slice(0, -1))
    })
  }
  return items
}

async function verifyStandardP2PKHDigests(
  pending: PendingDigestVerification[],
  verifier: DigestBatchVerifier
): Promise<Set<number>> {
  if (pending.length === 0) return new Set()
  const items = pending.flatMap(entry => entry[1])
  const verdicts = await verifier.verifyDigestBatch(items)
  if (verdicts.length !== items.length) {
    throw new Error('Script verifier returned an invalid digest batch result count')
  }
  const verified = new Set<number>()
  let offset = 0
  for (const entry of pending) {
    const end = offset + entry[1].length
    if (verdicts.slice(offset, end).every(Boolean)) verified.add(entry[0])
    offset = end
  }
  return verified
}

function hydrateTransactionSources(
  txid: string,
  transactions: ReadonlyMap<string, Transaction | undefined>
): Transaction | undefined {
  const tx = transactions.get(txid)
  if (tx == null) throw new WERR_INVALID_PARAMETER('txid', `contained in beef, txid ${txid}`)
  for (let inputIndex = 0; inputIndex < tx.inputs.length; inputIndex++) {
    const input = tx.inputs[inputIndex]
    if (input.sourceTXID == null) {
      throw new WERR_INVALID_PARAMETER(`inputs[${inputIndex}].sourceTXID`, 'valid')
    }
    if (input.unlockingScript == null) {
      throw new WERR_INVALID_PARAMETER(`inputs[${inputIndex}].unlockingScript`, 'valid')
    }
    input.sourceTransaction = transactions.get(input.sourceTXID)
    if (input.sourceTransaction == null) return undefined
    if (input.sourceTransaction.outputs[input.sourceOutputIndex] == null) {
      throw new WERR_INVALID_PARAMETER(
        `inputs[${inputIndex}].sourceOutputIndex`,
        'reference an output in the source transaction'
      )
    }
  }
  return tx
}

function transactionIndex(
  txids: readonly string[],
  beef: Beef
): Map<string, Transaction | undefined> {
  // One public lookup synchronizes nested transaction mutations and rebuilds
  // BEEF's internal indexes if necessary. Repeating that synchronization for
  // every input turns a large fragmented action into quadratic work.
  if (txids.length > 0) beef.findTxid(txids[0])
  return new Map(beef.txs.map(item => [item.txid, item.tx]))
}

async function verifyWholeTransactions(
  pending: PendingTransactionVerification[],
  verifier: BdkVerifierInterface
): Promise<Set<number>> {
  if (pending.length === 0) return new Set()
  let verdicts: boolean[]
  try {
    verdicts = verifier.verifyScriptsBatch === undefined
      ? await Promise.all(pending.map(async item => await verifier.verifyScripts(item[1])))
      : await verifier.verifyScriptsBatch(pending.map(item => item[1]))
  } catch (error: unknown) {
    // Whole-transaction backends cannot identify the failing input. Preserve
    // the historical per-input diagnostic lane for consensus script errors;
    // integration/runtime failures still propagate unchanged.
    if (error instanceof ScriptEvaluationError) return new Set()
    throw error
  }
  if (verdicts.length !== pending.length) {
    throw new Error('Script verifier returned an invalid transaction batch result count')
  }
  // A false verdict deliberately falls through to the historical per-input
  // lane so callers retain the exact failing input in their validation error.
  return new Set(pending.filter((_, index) => verdicts[index]).map(item => item[0]))
}

function collectTransactionSpends(
  txid: string,
  resultIndex: number,
  transactions: ReadonlyMap<string, Transaction | undefined>,
  result: UnlockScriptVerificationResult,
  pending: PendingSpendVerification[]
): void {
  const tx = transactions.get(txid)
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
    input.sourceTransaction = transactions.get(input.sourceTXID)
    if (input.sourceTransaction == null) {
      // knownTxids may intentionally omit a source transaction. Only that
      // input is skipped; every source that is present is still verified.
      result.skippedInputs++
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
    const context: SpendVerificationContext =
      utxoHeight === undefined ? { consensus: true } : { consensus: true, utxoHeight }
    pending.push([
      inputIndex,
      resultIndex,
      new Spend({
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
      }),
      context
    ])
  }
}

function collectAcceleratedTransactions(
  txids: readonly string[],
  transactions: ReadonlyMap<string, Transaction | undefined>,
  digestVerifier: DigestBatchVerifier | undefined,
  enabled: boolean
): readonly [Map<number, Transaction>, PendingDigestVerification[]] {
  const hydrated = new Map<number, Transaction>()
  const digests: PendingDigestVerification[] = []
  if (!enabled) return [hydrated, digests]
  for (let resultIndex = 0; resultIndex < txids.length; resultIndex++) {
    const tx = hydrateTransactionSources(txids[resultIndex], transactions)
    if (tx == null) continue
    hydrated.set(resultIndex, tx)
    if (digestVerifier === undefined) continue
    const items = standardP2PKHDigests(tx)
    if (items != null) digests.push([resultIndex, items])
  }
  return [hydrated, digests]
}

function collectWholeTransactionVerifications(
  hydrated: ReadonlyMap<number, Transaction>,
  digestAttempted: ReadonlySet<number>,
  verifier: (SpendVerifierInterface & BdkVerifierInterface) | undefined
): PendingTransactionVerification[] {
  if (verifier === undefined) return []
  const pending: PendingTransactionVerification[] = []
  for (const [resultIndex, tx] of hydrated) {
    if (digestAttempted.has(resultIndex)) continue
    const params = { tx, blockHeight: postChronicleHeightFallback, consensus: true }
    if (verifier.shouldVerifyScripts?.(params) === false) continue
    pending.push([resultIndex, params])
  }
  return pending
}

function collectFallbackSpends(
  txids: readonly string[],
  transactions: ReadonlyMap<string, Transaction | undefined>,
  accelerated: ReadonlySet<number>,
  results: UnlockScriptVerificationResult[]
): PendingSpendVerification[] {
  const pending: PendingSpendVerification[] = []
  for (let resultIndex = 0; resultIndex < txids.length; resultIndex++) {
    if (!accelerated.has(resultIndex)) {
      collectTransactionSpends(txids[resultIndex], resultIndex, transactions, results[resultIndex], pending)
      continue
    }
    const tx = transactions.get(txids[resultIndex])
    if (tx == null) throw new WERR_INVALID_PARAMETER('txid', `contained in beef, txid ${txids[resultIndex]}`)
    results[resultIndex].verifiedInputs = tx.inputs.length
  }
  return pending
}

/**
 * Verifies every resolvable input from several transactions in one optional
 * backend batch while preserving per-transaction verification counts.
 */
export async function verifyUnlockScriptsBatch(
  txids: readonly string[],
  beef: Beef,
  verifier?: SpendVerifierInterface
): Promise<UnlockScriptVerificationResult[]> {
  const results = txids.map(() => ({ verifiedInputs: 0, skippedInputs: 0 }))
  const transactions = transactionIndex(txids, beef)
  const digestVerifier = digestBatchVerifier(verifier)
  const wholeVerifier = wholeTransactionVerifier(verifier)
  const [hydrated, digestPending] = collectAcceleratedTransactions(
    txids,
    transactions,
    digestVerifier,
    digestVerifier !== undefined || wholeVerifier !== undefined
  )
  const digestAttempted = new Set(digestPending.map(item => item[0]))
  const digestVerified = digestVerifier === undefined
    ? new Set<number>()
    : await verifyStandardP2PKHDigests(digestPending, digestVerifier)
  const wholePending = collectWholeTransactionVerifications(hydrated, digestAttempted, wholeVerifier)
  const wholeVerified = wholeVerifier === undefined
    ? new Set<number>()
    : await verifyWholeTransactions(wholePending, wholeVerifier)
  const accelerated = new Set([...digestVerified, ...wholeVerified])
  const pending = collectFallbackSpends(txids, transactions, accelerated, results)
  await verifyPendingSpends(pending, verifier)
  for (const item of pending) results[item[1]].verifiedInputs++
  return results
}

/**
 * @param txid The TXID of a transaction in the beef for which all unlocking scripts must be valid.
 * @param beef Must contain transactions for txid and all its inputs.
 * @throws WERR_INVALID_PARAMETER if any unlocking script is invalid, if sourceTXID is invalid, if beef doesn't contain required transactions.
 */
export async function verifyUnlockScripts(
  txid: string,
  beef: Beef,
  verifier?: SpendVerifierInterface
): Promise<UnlockScriptVerificationResult> {
  return (await verifyUnlockScriptsBatch([txid], beef, verifier))[0]
}
