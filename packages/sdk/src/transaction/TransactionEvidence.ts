import { Beef } from './Beef.js'
import type Transaction from './Transaction.js'
import type LockingScript from '../script/LockingScript.js'
import ScriptResourceLimitError from '../script/ScriptResourceLimitError.js'
import { sha256 } from '../primitives/Hash.js'
import { toHex } from '../primitives/utils.js'

/** Untrusted transaction evidence. The optional txid is only a consistency hint. */
export interface TransactionEvidence {
  beef: number[]
  outputIndex: number
  txid?: string
}

/** Verified transaction inclusion/ancestry; no service relevance or unspentness claim. */
export interface VerifiedTransactionOutput {
  readonly txid: string
  readonly outputIndex: number
  readonly outpoint: string
  readonly lockingScript: LockingScript
}

export type TransactionEvidenceErrorCode =
  'invalid-evidence' | 'limit' | 'cancelled' | 'timeout' | 'context-changed' | 'disposed'

/** Bounded, payload-free outcome; rejected receipts never permanently reject a txid. */
export class TransactionEvidenceError extends Error {
  constructor(public readonly code: TransactionEvidenceErrorCode) {
    super(`Transaction evidence: ${code}`)
    this.name = 'TransactionEvidenceError'
  }
}

/** Keep bounded-work outcomes distinct without exposing errors containing evidence. */
export function evidenceError(error: unknown): TransactionEvidenceError {
  if (error instanceof TransactionEvidenceError) return error
  return new TransactionEvidenceError(
    error instanceof ScriptResourceLimitError ? 'limit' : 'invalid-evidence'
  )
}

/** Local admission policy, not consensus limits. Byte limits count serialized bytes. */
export interface TransactionEvidenceLimits {
  candidateBytes: number
  retainedBytes: number
  transactions: number
  inputs: number
  scriptBytes: number
  scriptMemoryBytes: number
  candidatesPerTransaction: number
  pendingTransactions: number
  concurrentTransactions: number
  pendingChainCalls: number
  consumers: number
  cacheEntries: number
  cacheAgeMs: number
  attemptTimeoutMs: number
  requestTimeoutMs: number
}

export const defaultTransactionEvidenceLimits: Readonly<TransactionEvidenceLimits> = Object.freeze({
  candidateBytes: 1024 * 1024,
  retainedBytes: 16 * 1024 * 1024,
  transactions: 256,
  inputs: 4096,
  scriptBytes: 256 * 1024,
  scriptMemoryBytes: 16 * 1024 * 1024,
  candidatesPerTransaction: 8,
  pendingTransactions: 32,
  concurrentTransactions: 4,
  pendingChainCalls: 8,
  consumers: 128,
  cacheEntries: 128,
  cacheAgeMs: 60_000,
  attemptTimeoutMs: 5000,
  requestTimeoutMs: 15_000
})

/** Internal owned candidate. Never constructed from a host's verification assertion. */
export interface EvidenceCandidate {
  tx: Transaction
  txid: string
  receipt: string
  byteLength: number
  outputIndex: number
  graphBinding: string
}

export function parseEvidence(
  evidence: TransactionEvidence,
  limits: TransactionEvidenceLimits
): EvidenceCandidate {
  const outputIndex = evidence.outputIndex
  const hint = evidence.txid
  if (!Array.isArray(evidence.beef) || !Number.isSafeInteger(outputIndex) || outputIndex < 0) {
    throw new TransactionEvidenceError('invalid-evidence')
  }
  if (evidence.beef.length > limits.candidateBytes) throw new TransactionEvidenceError('limit')
  // Snapshot and validate BEFORE either parsing or computing the receipt digest.
  const bytes = evidence.beef.slice()
  if (bytes.length === 0 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new TransactionEvidenceError('invalid-evidence')
  }
  const beef = Beef.fromBinary(bytes)
  if (beef.txs.length > limits.transactions) throw new TransactionEvidenceError('limit')
  const target = beef.atomicTxid ?? beef.txs.at(-1)?.txid
  const tx = target === undefined ? undefined : beef.findAtomicTransaction(target)
  if (tx === undefined) throw new TransactionEvidenceError('invalid-evidence')
  const txid = tx.id('hex')
  if (hint !== undefined && (typeof hint !== 'string' || hint.toLowerCase() !== txid)) {
    throw new TransactionEvidenceError('invalid-evidence')
  }
  if (outputIndex >= tx.outputs.length) throw new TransactionEvidenceError('invalid-evidence')

  // Always walk the COMPLETE unconfirmed graph, including on a positive cache hit.
  // A per-ancestor verdict cannot establish graph-wide spend consistency.
  const pending = [tx]
  const visited = new Set<string>()
  const spent = new Set<string>()
  let inputs = 0
  let scriptBytes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    const id = current.id('hex')
    if (visited.has(id)) continue
    visited.add(id)
    for (const output of current.outputs) scriptBytes += output.lockingScript.toBinary().length
    for (const input of current.inputs) scriptBytes += input.unlockingScript?.toBinary().length ?? 0
    inputs += current.inputs.length
    if (inputs > limits.inputs || scriptBytes > limits.scriptBytes)
      throw new TransactionEvidenceError('limit')
    if (current.merklePath != null) continue
    if (current.inputs.length === 0) throw new TransactionEvidenceError('invalid-evidence')
    for (const input of current.inputs) {
      if (input.sourceTransaction == null) throw new TransactionEvidenceError('invalid-evidence')
      const sourceTxid = input.sourceTransaction.id('hex')
      if (input.sourceTXID !== undefined && input.sourceTXID !== sourceTxid)
        throw new TransactionEvidenceError('invalid-evidence')
      const outpoint = `${sourceTxid}.${input.sourceOutputIndex}`
      if (spent.has(outpoint)) throw new TransactionEvidenceError('invalid-evidence')
      spent.add(outpoint)
      pending.push(input.sourceTransaction)
    }
  }
  return {
    tx,
    txid,
    receipt: toHex(sha256(bytes)),
    byteLength: bytes.length,
    outputIndex,
    graphBinding: toHex(sha256(tx.toBEEF()))
  }
}

/** Fence all owned transaction/proof bytes, including backend readiness callbacks. */
export function assertEvidenceUnchanged(candidate: EvidenceCandidate): void {
  if (
    candidate.tx.id('hex') !== candidate.txid ||
    toHex(sha256(candidate.tx.toBEEF())) !== candidate.graphBinding
  ) {
    throw new TransactionEvidenceError('invalid-evidence')
  }
}
