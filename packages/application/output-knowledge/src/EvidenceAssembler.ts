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

const assemblyMaximums: EvidenceAssemblyLimits = {
  bytes: 4194304,
  transactions: 4096,
  dependencies: 16384
}

function checkAssemblyLimits(limits: EvidenceAssemblyLimits): void {
  for (const [key, value] of Object.entries(limits)) {
    const maximum = Object.hasOwn(assemblyMaximums, key)
      ? assemblyMaximums[key as keyof EvidenceAssemblyLimits]
      : 0
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new OutputProtocolError('invalid', 'Invalid evidence assembly limit')
  }
  if (Object.keys(limits).length !== 3)
    throw new OutputProtocolError('invalid', 'Missing evidence assembly limit')
}

function parseBeef(
  bytes: number[],
  evidence: OutputEvidence,
  limits: EvidenceAssemblyLimits
): Beef {
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
  return beef
}

function readTransactions(
  beef: Beef,
  chain: OutputChain,
  limits: EvidenceAssemblyLimits
): AssembledRawTransaction[] {
  const transactions: AssembledRawTransaction[] = [],
    seen = new Set<string>()
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
  transactions.sort((a, b) => (a.txid < b.txid ? -1 : 1))
  return transactions
}

function missingPredecessors(
  target: AssembledRawTransaction,
  byId: ReadonlyMap<string, AssembledRawTransaction>
): OutputOutpoint[] {
  const missing = new Map<string, OutputOutpoint>(),
    pending = [target],
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
  return [...missing.values()]
}

function targetBeef(beef: Beef, txid: string, maximumBytes: number): number[] {
  let result: number[]
  try {
    result = beef.toBinaryAtomic(txid)
  } catch {
    throw new OutputProtocolError('invalid', 'Cannot construct target-specific BEEF')
  }
  if (result.length > maximumBytes)
    throw new OutputProtocolError('limited', 'Target-specific evidence byte limit')
  return result
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
  checkAssemblyLimits(limits)
  const bytes = decodeOutputBytes(evidence.beef, limits.bytes),
    variantId = Utils.toHex(Hash.sha256(bytes)),
    beef = parseBeef(bytes, evidence, limits),
    transactions = readTransactions(beef, chain, limits),
    byId = new Map(transactions.map(transaction => [transaction.txid, transaction])),
    target = byId.get(evidence.txid)
  if (target && evidence.outputIndex >= beef.findTxid(evidence.txid)!.tx!.outputs.length)
    throw new OutputProtocolError('invalid', 'Target output does not exist')
  const missing = target
    ? missingPredecessors(target, byId)
    : [{ chain, txid: evidence.txid, outputIndex: evidence.outputIndex }]
  const atomicBeef =
    target && missing.length === 0 ? targetBeef(beef, evidence.txid, limits.bytes) : undefined
  return {
    variantId,
    evidence,
    chain,
    transactions,
    ...(target ? { target } : {}),
    missing,
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
