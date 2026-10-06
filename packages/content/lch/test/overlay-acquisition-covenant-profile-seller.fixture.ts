import {
  canonicalOutputJSON,
  decodeOutputBytes,
  outputAssert,
  signOutputPacket,
  Utils,
  type OutputPurchaseEnvelope
} from '@bsv/sdk'
import { PrivatePurchaseContracts } from '../../../application/output-knowledge/src/private/PrivatePurchaseContracts.js'
import { RevenueListingProfileLineageVerifier } from '../../../application/output-knowledge/src/revenue-listing/RevenueListingProfileLineageVerifier.js'
import { RevenueListingProfilePurchaseVerifier } from '../../../application/output-knowledge/src/revenue-listing/RevenueListingProfilePurchaseVerifier.js'
import {
  chains,
  context
} from '../../../application/output-knowledge/test/revenue-lineage-fixture.js'
import { decodeUnverifiedLCHOverlayContext } from '../src/overlayAcquisitionCodec.js'
import {
  LCHOverlayCovenantProfileSeller,
  type LCHOverlayCovenantProfileSellerListing,
  type LCHOverlayCovenantProfileSellerOptions,
  type LCHOverlayCovenantProfileSellerCustody
} from '../src/overlayAcquisitionCovenantProfileSeller.js'
import { lchNativeCovenantProfileFixture } from './overlay-acquisition-covenant-profile-native.fixture.js'

/** Current immutable reserve/activation/purchase Bitcoin validators and actual
 * protected buyer custody/playback. Topic admission is a separate local premise.
 * Retained topic acceptance is still the independently installed fixture
 * premise. Server/admission/HTTP and native wallet composition remain separate.
 */
export async function lchCovenantProfileSellerFixture(fixtureOptions: { detached?: boolean } = {}) {
  const f = await lchNativeCovenantProfileFixture({
      maximumRequestBytes: 524288,
      detached: fixtureOptions.detached
    }),
    signal = new AbortController().signal,
    listing: LCHOverlayCovenantProfileSellerListing = {
      header: f.input.header,
      offer: f.offer,
      descriptor: f.descriptor,
      lineage: f.lineage,
      keys: [...f.asset.keys].map(([key, cek]) => ({
        keyId: Uint8Array.from(Utils.toArray(key, 'hex')),
        cek
      }))
    },
    lineage = new RevenueListingProfileLineageVerifier(f.family, chains),
    purchase = new RevenueListingProfilePurchaseVerifier(f.family, chains),
    counts = { load: 0, lineage: 0, purchase: 0, release: 0 }
  let available = true
  f.setNow('20')
  const options: LCHOverlayCovenantProfileSellerOptions = {
      id: 'disclosed-covenant-seller',
      catalogue: {
        load: async () => {
          counts.load++
          outputAssert(available, 'Catalogue unavailable', 'unavailable')
          await Promise.resolve()
          return listing
        }
      },
      source: f.storage,
      sellerSigner: f.seller,
      issuerSigner: f.seller,
      issuerWallet: f.sellerWallet,
      authorityNetwork: 'testnet',
      maximumCiphertextBytes: 1048576,
      purchaseSeconds: '80',
      current: f.options.current,
      clock: f.options.clock,
      verification: {
        id: 'full-disclosed-genesis-script-and-selected-release',
        lineage: async (input, expected, abort) => {
          counts.lineage++
          const result = await lineage.verify(input, context(), abort)
          outputAssert(
            result.status === 'verified' &&
              canonicalOutputJSON(result.target) ===
                canonicalOutputJSON(expected.request.listing) &&
              canonicalOutputJSON(result.descriptor) === canonicalOutputJSON(expected.descriptor),
            'Independent complete genesis failed'
          )
          return {
            stage: result.stage,
            currentHeight: context().view.tipHeight,
            checkCurrent: () => {
              outputAssert(f.options.current(), 'Context changed', 'context-changed')
            }
          }
        },
        purchase: async (input, original, abort) => {
          counts.purchase++
          const result = await purchase.verify(input, original, context(), abort)
          outputAssert(
            result.status === 'verified',
            'Independent full purchase failed: ' + canonicalOutputJSON(result)
          )
          return {
            purchaseCommitment: result.purchaseCommitment,
            checkCurrent: () => {
              outputAssert(f.options.current(), 'Context changed', 'context-changed')
            }
          }
        },
        release: async (...args) => {
          counts.release++
          return f.options.verification.release(...args)
        }
      }
    },
    seller = new LCHOverlayCovenantProfileSeller(options),
    contracts = new PrivatePurchaseContracts(
      {
        chain: f.prepare.listing.chain,
        seller: f.descriptor.seller,
        baseURL: f.body.baseURL,
        topic: f.prepare.topic,
        rulesDigest: f.selection.service.rulesDigest,
        releasePolicy: f.release.policy,
        domainProfile: 'https://bsv.brc.dev/tokens/0197#listing-purchase-v1',
        domainSchema: 'https://bsv.brc.dev/tokens/0197#lineage-package-v1',
        maximumRequestBytes: 524288,
        maximumResponseBytes: 4194304,
        maximumPurchaseSeconds: '80',
        maximumRecoverySeconds: '172800'
      },
      {
        maximumAgeSeconds: '100',
        clockSkewSeconds: '0',
        rules: new Map([[f.selection.service.rules.id, () => {}]])
      }
    )
  async function prepare() {
    const ready = await seller.prepare(f.prepare, f.selection, signal)
    ready.validation.checkCurrent()
    const contract = contracts.prepare(
      f.prepare,
      f.selection.manifest,
      ready.preparation.terms,
      '20'
    )
    outputAssert(
      canonicalOutputJSON(contract.body) === canonicalOutputJSON(f.prepared.body),
      'Native fixture purchase terms differ'
    )
    const original = contracts.authenticate(contract, f.prepared),
      custody: LCHOverlayCovenantProfileSellerCustody = {
        original,
        schema: ready.preparation.schema,
        maximumSecretBytes: ready.preparation.maximumSecretBytes,
        material: ready.preparation.material
      }
    return custody
  }
  async function deliver(secret: string): Promise<OutputPurchaseEnvelope> {
    await decodeUnverifiedLCHOverlayContext(
      Uint8Array.from(decodeOutputBytes(secret, 2097152)),
      'listing-covenant'
    )
    const result = f.delivered.result
    if (result.status !== 'delivered') throw new Error('Missing delivery')
    // Sign the exact seller-generated bytes. Native coordinator retention and
    // packet signing are exercised by the complete server integration.
    return {
      releaseEvidence: f.release,
      result: {
        ...result,
        potatoes: signOutputPacket(
          'potatoes',
          { ...result.potatoes.body, secret, issuedAt: f.options.clock() },
          f.sellerKey
        )
      }
    }
  }
  return {
    ...f,
    sellerDomain: seller,
    sellerOptions: options,
    listing,
    sellerCounts: counts,
    contracts,
    prepareSeller: prepare,
    progress: {
      status: 'admitted-delivery-pending',
      txid: f.submission.txid,
      admission: { acceptedAt: '20' },
      recoveryUntil: f.prepared.body.recoveryUntil
    },
    sellerDeliver: deliver,
    setAvailable: (value: boolean) => {
      available = value
    }
  }
}
