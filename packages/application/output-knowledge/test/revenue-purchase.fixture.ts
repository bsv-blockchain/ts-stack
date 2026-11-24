import {
  Beef,
  canonicalOutputJSON,
  LockingScript,
  P2PKH,
  PrivateKey,
  signOutputPacket,
  outputPacketDigest,
  Utils,
  type OutputEvidence,
  type OutputPurchasePrepare,
  type OutputSignedPurchaseTerms
} from '@bsv/sdk'
import { RevenueListingSpend } from '@bsv/sdk/script/templates/RevenueListingSpend'
import {
  REVENUE_LISTING_LINEAGE_SCHEMA,
  REVENUE_LISTING_PURCHASE_PROFILE
} from '../src/revenue-listing/RevenueListingPurchaseVerifier.js'
import type { RevenueListingLineagePackage } from '../src/revenue-listing/LineagePackage.js'
import { atListing, completeGenesis, family } from './revenue-lineage-fixture.js'
import { authorityFixture } from './revenue-authority-fixture.js'
import { assembleLineage, lineageLimits } from '../src/revenue-listing/LineagePackage.js'

/** Real disclosed synthetic funding and Script; no broadcast or customer keys. */
export async function purchaseFixture(
  preparedInput: RevenueListingLineagePackage = completeGenesis()
) {
  const prepared = structuredClone(preparedInput),
    historical = atListing('purchase'),
    assembly = assembleLineage(historical, lineageLimits({})),
    originalTx = assembly.beef.findTransactionForSigning(historical.target.txid)!,
    predecessor = assembleLineage(prepared, lineageLimits({})).beef.findTransactionForSigning(
      prepared.target.txid
    )!,
    seller = prepared.descriptor.seller,
    buyer = new PrivateKey(44),
    request: OutputPurchasePrepare = {
      version: 1,
      requestId: 'fixture-purchase-196',
      topic: 'tm_fixture_listing',
      listing: prepared.target,
      assetId: prepared.descriptor.assetId,
      termsDigest: prepared.descriptor.termsDigest,
      recipient: buyer.toPublicKey().toString(),
      request: 'AA=='
    },
    body = {
      version: 1 as const,
      acquisitionId: outputPacketDigest('purchase', {
        chain: request.listing.chain,
        seller,
        recipient: request.recipient,
        topic: request.topic,
        requestId: request.requestId
      }),
      requestDigest: outputPacketDigest('purchase-request', request),
      seller,
      recipient: request.recipient,
      topic: request.topic,
      listing: request.listing,
      assetId: request.assetId,
      termsDigest: request.termsDigest,
      domainProfile: REVENUE_LISTING_PURCHASE_PROFILE,
      domainEvidence: {
        schema: REVENUE_LISTING_LINEAGE_SCHEMA,
        bytes: Utils.toBase64(new TextEncoder().encode(canonicalOutputJSON(prepared)))
      },
      releasePolicy: { kind: 'local-admission' as const },
      purchaseUntil: '100',
      recoveryUntil: '86500'
    },
    terms: OutputSignedPurchaseTerms = signOutputPacket('purchase-terms', body, new PrivateKey(41)),
    action = {
      operation: 'purchase' as const,
      acquisitionId: body.acquisitionId,
      requestDigest: body.requestDigest,
      recipient: body.recipient
    },
    spend = new RevenueListingSpend(
      family,
      prepared.descriptor,
      [{ rawTransaction: predecessor.toHex(), outputIndex: prepared.target.outputIndex }],
      action
    ),
    funded = originalTx
  // Use retirement's separately funded synthetic output, which is outside
  // the prepared ancestor history. Reusing an earlier purchase's funding output
  // would create a genuine conflicting dependency, even with valid scripts.
  const funding = authorityFixture('retire').transaction.inputs[1].sourceTransaction!
  funding.inputs.forEach(input => {
    input.sourceTransaction = assembly.beef.findTransactionForSigning(input.sourceTXID!)
  })
  funded.inputs[1].sourceTXID = funding.id('hex')
  funded.inputs[1].sourceOutputIndex = 0
  funded.inputs[1].sourceTransaction = funding
  funded.inputs[0].sourceTXID = prepared.target.txid
  funded.inputs[0].sourceOutputIndex = prepared.target.outputIndex
  funded.inputs[0].sourceTransaction = predecessor
  funded.outputs = spend.plan().outputs.map(output => ({
    satoshis: Number(output.satoshis),
    lockingScript: LockingScript.fromHex(output.lockingScript)
  }))
  const completed = spend.prepare(funded).complete([{ recipients: [] }])
  completed.inputs.forEach((input, index) => {
    input.sourceTransaction = funded.inputs[index].sourceTransaction
  })
  completed.inputs[1].unlockingScriptTemplate = new P2PKH().unlock(buyer)
  await completed.sign()
  const purchase: OutputEvidence = {
    txid: completed.id('hex'),
    outputIndex: 0,
    beef: Utils.toBase64(completed.toAtomicBEEF())
  }
  return { prepared, original: { request, terms, seller }, purchase, completed, spend }
}
export function transactionEvidence(
  f: Awaited<ReturnType<typeof purchaseFixture>>
): OutputEvidence {
  return {
    txid: f.completed.id('hex'),
    outputIndex: 0,
    beef: Utils.toBase64(f.completed.toAtomicBEEF())
  }
}
export function purchaseBEEF(evidence: OutputEvidence) {
  return Beef.fromBinaryStrict(Utils.toArray(evidence.beef, 'base64'))
}
