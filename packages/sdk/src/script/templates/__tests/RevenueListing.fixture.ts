import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import Transaction from '../../../transaction/Transaction.js'
import BigNumber from '../../../primitives/BigNumber.js'
import { RevenueListing, type RevenueListingDescriptor } from '../RevenueListing.js'
import { type RevenueListingAction } from '../RevenueListingPlan.js'
import { toArray } from '../../../primitives/utils.js'

interface Trace {
  name: string
  operation: number
  sources: { txid: string; index: number }[]
  expected: 'accept' | 'reject'
  txid: string
}
export const corpus: {
  rawArchiveSHA256: string
  descriptor: RevenueListingDescriptor
  traces: Trace[]
} = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/revenue-listing-transactions.json'), 'utf8')
)
const compressed = readFileSync(resolve(__dirname, 'fixtures/raw-transactions.json.gz'))
if (createHash('sha256').update(compressed).digest('hex') !== corpus.rawArchiveSHA256)
  throw new Error('Frozen BRC archive hash mismatch')
const archive: Record<string, string> = JSON.parse(gunzipSync(compressed).toString('utf8'))
export function transaction(id: string): Transaction {
  const tx = Transaction.fromHex(archive[id])
  if (tx.id('hex') !== id) throw new Error('Frozen transaction identity mismatch')
  return tx
}
export function rawTransaction(id: string): string {
  return transaction(id).toHex()
}
export const accepted = corpus.traces.filter(item => item.expected === 'accept')
export function makeFamily(): RevenueListing {
  const source = transaction(accepted[0].sources[0].txid)
  return new RevenueListing(source.outputs[0].lockingScript.toBinary().slice(428))
}
export function previous(trace: Trace) {
  return trace.sources
    .slice(0, trace.operation === 3 ? 2 : 1)
    .map(item => ({ rawTransaction: rawTransaction(item.txid), outputIndex: item.index }))
}
export function action(trace: Trace, family: RevenueListing): RevenueListingAction {
  const tx = transaction(trace.txid)
  switch (trace.operation) {
    case 1: {
      const receipt = tx.inputs[0].unlockingScript!.chunks[3].data!
      const hex = Buffer.from(receipt).toString('hex')
      return {
        operation: 'purchase',
        acquisitionId: hex.slice(84, 148),
        requestDigest: hex.slice(148, 212),
        recipient: hex.slice(212, 278)
      }
    }
    case 2:
      return { operation: 'split', firstAmount: tx.outputs[0].satoshis!.toString() }
    case 3:
      return { operation: 'merge' }
    case 4: {
      const value = tx.inputs[0].unlockingScript!.chunks[6]
      return {
        operation: 'payout',
        units:
          value.data === undefined
            ? String(value.op - 0x50)
            : BigNumber.fromSm(value.data, 'little').toString()
      }
    }
    case 5:
      return { operation: 'retire' }
    case 6:
      return {
        operation: 'amend',
        state: family.decode(toArray(tx.outputs[0].lockingScript.toHex(), 'hex'), corpus.descriptor)
      }
    default:
      throw new Error('Unexpected fixture operation')
  }
}
