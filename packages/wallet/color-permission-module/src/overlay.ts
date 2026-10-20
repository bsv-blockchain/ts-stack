import { Transaction, type LockingScript, type LookupAnswer } from '@bsv/sdk'

export interface ListedOutput {
  outpoint: string
  lockingScript: LockingScript
  satoshis: number
}

/**
 * Reads a BRC-24 `output-list` answer to a `color-spendability` or `color-admission`
 * query. Every returned output must be one of the queried outpoints, at most once;
 * an unrelated, duplicate or malformed entry invalidates the whole answer.
 */
export function readOutputList(
  answer: LookupAnswer,
  queried: readonly string[]
): Map<string, ListedOutput> {
  if (answer?.type !== 'output-list' || !Array.isArray(answer.outputs)) {
    throw new Error('BRC-207: overlay answer is not an output list')
  }
  const listed = new Map<string, ListedOutput>()
  const wanted = new Set(queried)
  for (const item of answer.outputs) {
    let transaction: Transaction
    try {
      transaction = Transaction.fromBEEF(item.beef, item.txid)
    } catch {
      throw new Error('BRC-207: overlay answer carries invalid BEEF')
    }
    const output = Number.isSafeInteger(item.outputIndex)
      ? transaction.outputs[item.outputIndex]
      : undefined
    if (output?.satoshis === undefined)
      throw new Error('BRC-207: overlay answer names a missing output')
    const outpoint = `${transaction.id('hex')}.${item.outputIndex}`
    if (!wanted.has(outpoint))
      throw new Error(`BRC-207: overlay answered an unrelated output ${outpoint}`)
    if (listed.has(outpoint)) throw new Error(`BRC-207: overlay answered ${outpoint} twice`)
    listed.set(outpoint, {
      outpoint,
      lockingScript: output.lockingScript,
      satoshis: output.satoshis
    })
  }
  return listed
}
