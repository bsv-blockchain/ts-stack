import { signPurchaseFixturePacket } from './private-purchase-signing.fixture.js'
import {
  outputPacketDigest,
  type OutputPurchaseEnvelope,
  type OutputReleaseEvidence
} from '@bsv/sdk'
import {
  advancePrivatePurchaseProgress,
  createPrivatePurchaseProgress
} from '../src/private/PrivatePurchaseProgress.js'
import { purchaseContractFixture } from './private-purchase-contract.fixture.js'

/** Signed lifecycle representations; no transaction, actual admission or release-policy proof. */
export function purchaseProgressFixture() {
  const f = purchaseContractFixture(),
    original = f.original(),
    txid = '55'.repeat(32),
    steak = {
      [original.request.topic]: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [0] }
    },
    evidence: OutputReleaseEvidence = {
      chain: f.chain,
      txid,
      policy: original.terms.body.releasePolicy,
      acceptedAt: '30'
    }
  function initial() {
    return createPrivatePurchaseProgress(original)
  }
  function pinned(at = '29') {
    return advancePrivatePurchaseProgress(initial(), original, { type: 'pin', txid }, at)
  }
  function admitted() {
    return advancePrivatePurchaseProgress(
      pinned(),
      original,
      { type: 'admitted', steak, acceptedAt: '30', assessmentContextId: 'fixture-view' },
      '31'
    )
  }
  let retainedEnvelope: OutputPurchaseEnvelope | undefined
  function envelope(): OutputPurchaseEnvelope {
    if (retainedEnvelope !== undefined) return structuredClone(retainedEnvelope)
    const terms = original.terms.body
    retainedEnvelope = {
      result: {
        version: 1,
        status: 'delivered',
        acquisitionId: terms.acquisitionId,
        txid,
        recoveryUntil: terms.recoveryUntil,
        steak: structuredClone(steak),
        potatoes: signPurchaseFixturePacket(
          'potatoes',
          {
            version: 1,
            acquisitionId: terms.acquisitionId,
            requestDigest: terms.requestDigest,
            seller: terms.seller,
            recipient: terms.recipient,
            topic: terms.topic,
            txid,
            assetId: terms.assetId,
            termsDigest: terms.termsDigest,
            releasePolicy: terms.releasePolicy,
            evidenceDigest: outputPacketDigest('release-evidence', evidence),
            schema: 'urn:test:private-result',
            secret: 'cHVibGljLXRlc3Qtc2VjcmV0',
            issuedAt: '32',
            recoveryUntil: terms.recoveryUntil
          },
          f.key
        )
      },
      releaseEvidence: structuredClone(evidence)
    }
    return structuredClone(retainedEnvelope)
  }
  function delivered() {
    return advancePrivatePurchaseProgress(
      admitted(),
      original,
      { type: 'delivered', envelope: envelope() },
      '33'
    )
  }
  return { f, original, txid, steak, evidence, initial, pinned, admitted, envelope, delivered }
}
