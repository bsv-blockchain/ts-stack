import { outputPacketDigest, type OutputPurchaseTerms } from '@bsv/sdk'
import { parseRevenueListingProfileDescriptor } from '@bsv/sdk/script/templates/RevenueListingProfile'
import { LCHReader } from '../src/core.js'
import { signObject } from '../src/objects.js'
import { objectId, fromHex, toHex } from '../src/hash.js'
import { LCH_OVERLAY_PROFILES } from '../src/overlayAcquisitionCodec.js'
import type { LCHValue, LCHSigner, SignedObject } from '../src/types.js'
import { lchCovenantFixture } from './overlay-acquisition-covenant.fixture.js'

/** Current C representation and real LCH signatures only. No Bitcoin or native
 * currentness claim is supplied by this terms fixture. */
export async function lchCovenantProfileFixture(
  options: Parameters<typeof lchCovenantFixture>[0] = {},
  expiryHeight = 1000
) {
  const f = await lchCovenantFixture(options),
    initialRevenue = { recipients: f.initialRevenue.recipients.map(value => ({ ...value })) },
    extensions = f.offer.body.extensions as Record<string, LCHValue>,
    offer = await signObject(
      'offer',
      {
        ...f.offer.body,
        extensions: {
          ...extensions,
          [LCH_OVERLAY_PROFILES.collectorSettlement]: {
            version: 1,
            family: f.descriptor.scriptFamily,
            expiryHeight,
            initialRevenue: {
              recipients: initialRevenue.recipients.map(recipient => ({
                identity: fromHex(recipient.identity),
                weight: recipient.weight
              }))
            },
            schedule: 'immutable',
            derivation: 'brc29-anyone-fixed',
            withdrawal: 'permissionless-quanta',
            remainders: 'retain-until-payout',
            retirement: 'seller-child-or-expiry-height-exact-top-up'
          }
        }
      },
      f.seller
    ),
    descriptor = parseRevenueListingProfileDescriptor({
      version: 1,
      chain: f.descriptor.chain,
      assetId: f.descriptor.assetId,
      seller: f.descriptor.seller,
      lineageAnchor: f.descriptor.lineageAnchor,
      purchasePrice: f.descriptor.purchasePrice,
      reserve: f.descriptor.reserve,
      expiryHeight,
      termsDigest: toHex(await objectId('offer', offer.body)),
      scriptFamily: f.descriptor.scriptFamily,
      metadataDigest: f.descriptor.metadataDigest,
      initialRevenue
    }),
    published = await f.publisher.publish(
      f.asset,
      [{ mode: 'inline', offer: offer as unknown as LCHValue }],
      options?.embedCiphertext ?? true
    )
  const requestFor = (buyer: LCHSigner = f.buyer, selectedOffer: SignedObject = offer) =>
    f.requestFor(buyer, selectedOffer)
  const original = await requestFor(),
    input = {
      ...f.input,
      reader: new LCHReader(f.storage),
      header: published.bytes,
      offer,
      request: original.requestBytes,
      prepare: original.prepare,
      descriptor
    }
  function signedTerms(changes: Partial<OutputPurchaseTerms> = {}) {
    const prepare = original.prepare
    return f.signedTerms({
      acquisitionId: outputPacketDigest('purchase', {
        chain: prepare.listing.chain,
        seller: descriptor.seller,
        recipient: prepare.recipient,
        topic: prepare.topic,
        requestId: prepare.requestId
      }),
      requestDigest: outputPacketDigest('purchase-request', prepare),
      recipient: prepare.recipient,
      listing: prepare.listing,
      assetId: prepare.assetId,
      termsDigest: prepare.termsDigest,
      ...changes
    })
  }
  return { ...f, ...original, offer, input, descriptor, initialRevenue, requestFor, signedTerms }
}
