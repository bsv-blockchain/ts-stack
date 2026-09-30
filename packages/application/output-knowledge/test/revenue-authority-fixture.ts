import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { BigNumber, Hash, Transaction, Utils } from '@bsv/sdk'
import { RevenueListingSpend } from '@bsv/sdk/script/templates/RevenueListingSpend'
import type { RevenueListingAction } from '@bsv/sdk/script/templates/RevenueListingPlan'
import { assembleLineage, lineageLimits } from '../src/revenue-listing/LineagePackage.js'
import { atListing, family, lineage } from './revenue-lineage-fixture.js'

const directory = new URL('./fixtures/revenue-listing/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('transactions.json', directory), 'utf8')) as {
  rawArchiveSHA256: string
  traces: { name: string; txid: string }[]
}
const compressed = readFileSync(new URL('raw-transactions.json.gz', directory))
if (createHash('sha256').update(compressed).digest('hex') !== manifest.rawArchiveSHA256)
  throw new Error('Frozen authority transaction archive hash mismatch')
const archive = JSON.parse(gunzipSync(compressed).toString('utf8')) as Record<string, string>
function transactionById(txid: string): Transaction {
  const transaction = Transaction.fromHex(archive[txid])
  if (transaction.id('hex') !== txid)
    throw new Error('Frozen authority transaction identity mismatch')
  return transaction
}

export function authorityFixture(name = 'amend-all-consent') {
  const packet = atListing(name === 'retire' ? 'amend-all-consent' : name)
  const assembly = assembleLineage(packet, lineageLimits({}))
  const transaction = transactionById(manifest.traces.find(trace => trace.name === name)!.txid)
  transaction.inputs.forEach(input => {
    input.sourceTransaction = transactionById(input.sourceTXID!)
  })
  const count = name === 'merge' ? 2 : 1
  const previous = transaction.inputs.slice(0, count).map(input => ({
    rawTransaction: input.sourceTransaction!.toHex(),
    outputIndex: input.sourceOutputIndex
  }))
  let action: RevenueListingAction
  if (name === 'split')
    action = { operation: 'split', firstAmount: String(transaction.outputs[0].satoshis) }
  else if (name === 'merge') action = { operation: 'merge' }
  else if (name === 'payout') {
    const argument = transaction.inputs[0].unlockingScript!.chunks[6]
    action = {
      operation: 'payout',
      units:
        argument.data === undefined
          ? String(argument.op - 0x50)
          : BigNumber.fromSm(argument.data, 'little').toString()
    }
  } else if (name === 'retire') action = { operation: 'retire' }
  else if (name === 'purchase') {
    const receipt = Utils.toHex(transaction.inputs[0].unlockingScript!.chunks[3].data!)
    action = {
      operation: 'purchase',
      acquisitionId: receipt.slice(84, 148),
      requestDigest: receipt.slice(148, 212),
      recipient: receipt.slice(212, 278)
    }
  } else
    action = {
      operation: 'amend',
      state: family.decode(transaction.outputs[0].lockingScript.toBinary(), lineage.descriptor)
    }
  const spend = new RevenueListingSpend(family, lineage.descriptor, previous, action)
  return { transaction, spend, prepared: spend.prepare(transaction), assembly }
}

/** Recompute data for a deliberately changed input preimage in ownership tests. */
export function changedAuthorityRequest() {
  const request = authorityFixture().prepared.signingRequests()[0]
  request.preimage[0] ^= 1
  request.data = Hash.sha256(request.preimage)
  return request
}
