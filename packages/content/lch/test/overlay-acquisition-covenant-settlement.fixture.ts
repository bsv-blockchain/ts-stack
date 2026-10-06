import {
  canonicalOutputJSON,
  outputPacketDigest,
  signOutputPacket,
  Utils,
  type OutputPurchaseEnvelope,
  type OutputReleaseEvidence
} from '@bsv/sdk'
import { revenueListingId } from '@bsv/sdk/script/templates/RevenueListing'
import {
  encodeLCHOverlayContext,
  LCH_OVERLAY_PROFILES,
  type UnverifiedLCHOverlayContext
} from '../src/overlayAcquisitionCodec.js'
import {
  type LCHCovenantSettlementBody,
  type LCHOverlayCovenantLineage,
  type LCHOverlayCovenantPurchaseEvidence
} from '../src/overlayAcquisitionCovenantSettlement.js'
import { validateLCHOverlayCovenantTerms } from '../src/overlayAcquisitionCovenantTerms.js'
import { lchCovenantFixture } from './overlay-acquisition-covenant.fixture.js'

/** Cryptographic/representation boundary only: the disclosed lineage/BEEF
 * placeholders must never pass the independent Bitcoin/Script verifier.
 */
export async function lchCovenantSettlementFixture() {
  const f = await lchCovenantFixture(),
    json = (value: unknown) => new TextEncoder().encode(canonicalOutputJSON(value)),
    chain = f.prepare.listing.chain,
    genesis = { chain, txid: '33'.repeat(32), outputIndex: 0 },
    listingId = revenueListingId(f.descriptor),
    lineage: LCHOverlayCovenantLineage = {
      version: 1,
      descriptor: f.descriptor,
      genesis: signOutputPacket(
        'sale-genesis',
        { version: 1 as const, listingId, genesis },
        f.sellerKey
      ),
      target: f.prepare.listing,
      transactions: [
        { txid: f.prepare.listing.txid, beef: 'AA==' },
        { txid: genesis.txid, beef: 'AA==' }
      ]
    },
    prepared = f.signedTerms({
      domainEvidence: {
        schema: 'https://bsv.brc.dev/tokens/0197#lineage-package-v1',
        bytes: Utils.toBase64(json(lineage))
      }
    }),
    terms = await validateLCHOverlayCovenantTerms(f.input),
    txid = '44'.repeat(32),
    purchaseCommitment = '65'.repeat(32),
    release: OutputReleaseEvidence = {
      chain,
      txid,
      policy: { kind: 'local-admission' },
      acceptedAt: '20'
    },
    evidence: LCHOverlayCovenantPurchaseEvidence = {
      version: 1,
      lineage,
      purchase: { txid, outputIndex: 0, beef: 'AA==' },
      terms: prepared,
      release
    },
    body: LCHCovenantSettlementBody = {
      version: 1,
      seller: f.descriptor.seller,
      buyer: f.prepare.recipient,
      requestId: f.prepare.requestId,
      offerId: f.prepare.termsDigest,
      assetId: f.prepare.assetId,
      dutyUid: terms.policy.dutyUid,
      acquisitionId: prepared.body.acquisitionId,
      listingId,
      previous: f.prepare.listing,
      successor: { chain, txid, outputIndex: 0 },
      txid,
      purchaseCommitment,
      satoshis: '100',
      releasePolicy: release.policy,
      releaseEvidenceDigest: outputPacketDigest('release-evidence', release),
      issuedAt: '21',
      recoveryUntil: prepared.body.recoveryUntil
    },
    packet = signOutputPacket('lch-covenant-settlement', body, f.sellerKey),
    context: UnverifiedLCHOverlayContext = {
      version: 1,
      license: { body: { version: 1 }, signatures: [Uint8Array.of(1)] },
      evidence: [{ type: 'offer', object: f.offer }],
      settlement: json(packet),
      purchaseEvidence: json(evidence)
    }
  async function deliver(
    selectedContext = context,
    releaseEvidence = release
  ): Promise<OutputPurchaseEnvelope> {
    const secret = await encodeLCHOverlayContext(selectedContext, 'listing-covenant'),
      potatoes = signOutputPacket(
        'potatoes',
        {
          version: 1 as const,
          acquisitionId: prepared.body.acquisitionId,
          requestDigest: prepared.body.requestDigest,
          seller: prepared.body.seller,
          recipient: prepared.body.recipient,
          topic: prepared.body.topic,
          txid,
          purchaseCommitment,
          assetId: prepared.body.assetId,
          termsDigest: prepared.body.termsDigest,
          releasePolicy: prepared.body.releasePolicy,
          evidenceDigest: outputPacketDigest('release-evidence', releaseEvidence),
          schema: LCH_OVERLAY_PROFILES.acquisition,
          secret: Utils.toBase64(secret),
          issuedAt: '22',
          recoveryUntil: prepared.body.recoveryUntil
        },
        f.sellerKey
      )
    return {
      result: {
        version: 1,
        status: 'delivered',
        acquisitionId: prepared.body.acquisitionId,
        txid,
        purchaseCommitment,
        recoveryUntil: prepared.body.recoveryUntil,
        steak: {
          [prepared.body.topic]: { outputsToAdmit: [], coinsToRetain: [], coinsRemoved: [] }
        },
        potatoes
      },
      releaseEvidence
    }
  }
  return {
    ...f,
    json,
    lineage,
    terms,
    prepared,
    txid,
    purchaseCommitment,
    release,
    evidence,
    body,
    packet,
    context,
    deliver,
    delivered: await deliver()
  }
}
