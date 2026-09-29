import {
  Beef,
  Hash,
  Utils,
  OutputProtocolError,
  decodeOutputBytes,
  parseOutputChain,
  parseOutputEvidence,
  type OutputChain,
  type OutputEvidence,
  type OutputOutpoint
} from '@bsv/sdk'
import type { TransactionFact } from './ports.js'
import { outputPacketDigest } from '@bsv/sdk'

export interface EvidenceAssemblyLimits {
  bytes: number
  transactions: number
  dependencies: number
}
export interface AssembledRawTransaction {
  txid: string
  rawTransaction: string
  inputs: OutputOutpoint[]
  merkleRoot?: string
  blockHeight?: number
}
export interface EvidencePlan {
  variantId: string
  evidence: OutputEvidence
  chain: OutputChain
  transactions: AssembledRawTransaction[]
  target?: AssembledRawTransaction
  missing: OutputOutpoint[]
  atomicBeef?: number[]
}

/**
 * Inspect and target an exact received variant. This never declares transaction
 * validity. A txid-only entry remains missing even if the bundle has other rows.
 */
export function assembleOutputEvidence(
  input: OutputEvidence,
  selectedChain: OutputChain,
  limits: EvidenceAssemblyLimits
): EvidencePlan {
  const chain = parseOutputChain(selectedChain),
    evidence = parseOutputEvidence(input)
  for (const [key, value] of Object.entries(limits)) {
    const maximum =
      key === 'bytes' ? 4194304 : key === 'transactions' ? 4096 : key === 'dependencies' ? 16384 : 0
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new OutputProtocolError('invalid', 'Invalid evidence assembly limit')
  }
  if (Object.keys(limits).length !== 3)
    throw new OutputProtocolError('invalid', 'Missing evidence assembly limit')
  const bytes = decodeOutputBytes(evidence.beef, limits.bytes)
  const variantId = Utils.toHex(Hash.sha256(bytes))
  let beef: Beef
  try {
    beef = Beef.fromBinaryStrict(bytes)
  } catch {
    throw new OutputProtocolError('invalid', 'Malformed BEEF evidence')
  }
  if (beef.atomicTxid !== undefined && beef.atomicTxid !== evidence.txid)
    throw new OutputProtocolError('invalid', 'Atomic BEEF target differs from asserted txid')
  if (beef.txs.length > limits.transactions)
    throw new OutputProtocolError('limited', 'Evidence transaction limit')
  const transactions: AssembledRawTransaction[] = []
  const seen = new Set<string>()
  let inputs = 0
  for (const item of beef.txs) {
    if (seen.has(item.txid)) throw new OutputProtocolError('invalid', 'Duplicate BEEF transaction')
    seen.add(item.txid)
    const transaction = item.tx
    if (!transaction) continue
    if (transaction.id('hex') !== item.txid)
      throw new OutputProtocolError('invalid', 'BEEF raw transaction identity mismatch')
    inputs += transaction.inputs.length
    if (inputs > limits.dependencies)
      throw new OutputProtocolError('limited', 'Evidence dependency limit')
    const merkle = beef.findBump(item.txid)
    transactions.push({
      txid: item.txid,
      rawTransaction: Utils.toBase64(transaction.toBinary()),
      inputs: transaction.inputs.map(input => ({
        chain,
        txid: input.sourceTXID!,
        outputIndex: input.sourceOutputIndex
      })),
      ...(merkle
        ? { merkleRoot: merkle.computeRoot(item.txid), blockHeight: merkle.blockHeight }
        : {})
    })
  }
  const byId = new Map(transactions.map(transaction => [transaction.txid, transaction]))
  const target = byId.get(evidence.txid)
  const missing = new Map<string, OutputOutpoint>()
  if (!target)
    missing.set(`${evidence.txid}:${evidence.outputIndex}`, {
      chain,
      txid: evidence.txid,
      outputIndex: evidence.outputIndex
    })
  else if (evidence.outputIndex >= beef.findTxid(evidence.txid)!.tx!.outputs.length)
    throw new OutputProtocolError('invalid', 'Target output does not exist')
  const pending = target ? [target] : [],
    visited = new Set<string>()
  while (pending.length) {
    const current = pending.pop()!
    if (visited.has(current.txid)) continue
    visited.add(current.txid)
    if (current.merkleRoot !== undefined) continue
    for (const input of current.inputs) {
      const parent = byId.get(input.txid)
      if (!parent) missing.set(`${input.txid}:${input.outputIndex}`, input)
      else pending.push(parent)
    }
  }
  let atomicBeef: number[] | undefined
  if (target && missing.size === 0) {
    try {
      atomicBeef = beef.toBinaryAtomic(evidence.txid)
    } catch {
      throw new OutputProtocolError('invalid', 'Cannot construct target-specific BEEF')
    }
    if (atomicBeef.length > limits.bytes)
      throw new OutputProtocolError('limited', 'Target-specific evidence byte limit')
  }
  return {
    variantId,
    evidence,
    chain,
    transactions: transactions.sort((a, b) => (a.txid < b.txid ? -1 : 1)),
    ...(target ? { target } : {}),
    missing: [...missing.values()],
    ...(atomicBeef ? { atomicBeef } : {})
  }
}

export function factFromAssembly(
  chain: OutputChain,
  transaction: AssembledRawTransaction
): TransactionFact {
  return {
    chain: { ...chain },
    txid: transaction.txid,
    rawTransaction: transaction.rawTransaction,
    factId: outputPacketDigest('transaction-fact', { chain, txid: transaction.txid })
  }
}
