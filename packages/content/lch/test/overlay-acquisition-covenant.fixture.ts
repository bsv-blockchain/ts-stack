import {
  canonicalOutputJSON,
  OUTPUT_PROFILES,
  outputPacketDigest,
  selectOutputCapability,
  signOutputPacket,
  Utils,
  type OutputCapabilities,
  type OutputChain,
  type OutputOutpoint,
  type OutputPurchasePrepare,
  type OutputPurchaseTerms
} from '@bsv/sdk'
import {
  REVENUE_LISTING_FAMILY,
  type RevenueListingDescriptor
} from '@bsv/sdk/script/templates/RevenueListing'
import {
  LCHBuyer,
  LCHReader,
  encodeDeterministicCbor,
  fromHex,
  objectId,
  signObject,
  toHex,
  type LCHSigner,
  type LCHValue,
  type SignedObject
} from '../src/index.js'
import { LCH_OVERLAY_PROFILES } from '../src/overlayAcquisitionCodec.js'
import { LCH_OVERLAY_COVENANT_MECHANISMS } from '../src/overlayAcquisitionCovenantTerms.js'
import { lchOverlayFixture } from './overlay-acquisition.fixture.js'

/** Real Header/Offer/Request signatures and encrypted content. Descriptor and
 * outpoints are representation fixtures; these tests make no Bitcoin claim.
 */
export async function lchCovenantFixture(
  options: {
    chain?: OutputChain
    anchor?: OutputOutpoint
    embedCiphertext?: boolean
    maximumRequestBytes?: number
    maximumResponseBytes?: number
  } = {}
) {
  const f = await lchOverlayFixture(options.chain),
    chain = f.acquire.listing.chain,
    topic = 'tm_licensed_asset',
    anchor = options.anchor ?? { chain, txid: '11'.repeat(32), outputIndex: 0 },
    releasePolicy = { kind: 'local-admission' as const },
    initialRevenue = {
      revision: '0',
      recipients: [
        { identity: toHex(f.seller.identityKey), weight: 2 },
        { identity: toHex(f.buyer.identityKey), weight: 1 }
      ].sort(
        (left, right) =>
          Number(left.identity > right.identity) - Number(left.identity < right.identity)
      )
    },
    paid = f.offer.body.payment as Record<string, LCHValue>,
    requirement = {
      dutyUid: 'urn:reference:compensation',
      payee: f.seller.identityKey,
      endpoint: f.body.baseURL + '/overlay/v1/purchases/prepare',
      satoshis: 100
    },
    offer = await signObject(
      'offer',
      {
        ...f.offer.body,
        payment: {
          ...paid,
          protocol: LCH_OVERLAY_PROFILES.collectorSettlement,
          endpoint: requirement.endpoint,
          recoveryPeriodSeconds: 172800,
          pricing: { kind: 'fixed', requirements: [requirement] }
        },
        critical: [
          LCH_OVERLAY_PROFILES.acquisition,
          LCH_OVERLAY_PROFILES.collectorSettlement,
          LCH_OVERLAY_PROFILES.standingOffer
        ],
        extensions: {
          [LCH_OVERLAY_PROFILES.acquisition]: {
            version: 1,
            mode: 'listing-covenant',
            seller: f.seller.identityKey,
            service: topic,
            endpoint: f.body.baseURL,
            chain: { network: chain.network, genesisHash: fromHex(chain.genesisHash) },
            lineageAnchor: { txid: fromHex(anchor.txid), outputIndex: anchor.outputIndex },
            releasePolicy: new TextEncoder().encode(canonicalOutputJSON(releasePolicy))
          },
          [LCH_OVERLAY_PROFILES.standingOffer]: { version: 1 },
          [LCH_OVERLAY_PROFILES.collectorSettlement]: {
            version: 1,
            family: REVENUE_LISTING_FAMILY,
            initialRevenue: {
              revision: 0,
              recipients: initialRevenue.recipients.map(recipient => ({
                identity: fromHex(recipient.identity),
                weight: recipient.weight
              }))
            },
            amendment: 'unanimous-current-recipients',
            remainders: 'retain-until-payout',
            retirement: 'externally-funded-exact-top-up'
          }
        }
      },
      f.seller
    ),
    rules = { id: 'urn:reference:lch-covenant-rules', parameters: { version: 1 } },
    body: OutputCapabilities = {
      ...f.body,
      services: [
        {
          kind: 'topic',
          name: topic,
          rules,
          rulesDigest: outputPacketDigest('service-rules', rules),
          profiles: [
            {
              id: OUTPUT_PROFILES.purchase,
              authentication: 'brc103',
              payment: 'covenant',
              maxRequestBytes: options.maximumRequestBytes ?? 4194304,
              maxResponseBytes: options.maximumResponseBytes ?? 4194304,
              parameters: {
                recoverySeconds: '86400',
                releasePolicies: [releasePolicy],
                domainProfiles: ['https://bsv.brc.dev/tokens/0197#listing-purchase-v1']
              }
            }
          ]
        }
      ],
      extensions: {
        [LCH_OVERLAY_PROFILES.acquisition]: {
          version: 1,
          bindings: [
            {
              kind: 'topic',
              service: topic,
              mode: 'listing-covenant',
              mechanisms: [...LCH_OVERLAY_COVENANT_MECHANISMS]
            }
          ]
        }
      }
    },
    selection = selectOutputCapability(signOutputPacket('capabilities', body, f.sellerKey), {
      identity: body.identity,
      baseURL: body.baseURL,
      chain,
      kind: 'topic',
      service: topic,
      profile: OUTPUT_PROFILES.purchase,
      maximumAgeSeconds: '100',
      clockSkewSeconds: '0',
      now: '20',
      rules: new Map([[rules.id, () => {}]])
    }),
    descriptor: RevenueListingDescriptor = {
      version: 1,
      chain,
      assetId: toHex(f.asset.assetId),
      seller: body.identity,
      lineageAnchor: anchor,
      purchasePrice: '100',
      reserve: '1',
      termsDigest: toHex(await objectId('offer', offer.body)),
      scriptFamily: REVENUE_LISTING_FAMILY,
      administration: 'seller-v1',
      metadataDigest: '00'.repeat(32),
      initialRevenue
    },
    published = await f.publisher.publish(
      f.asset,
      [{ mode: 'inline', offer: offer as unknown as LCHValue }],
      options.embedCiphertext ?? true
    )
  async function requestFor(buyer: LCHSigner = f.buyer, selectedOffer: SignedObject = offer) {
    const request = await new LCHBuyer(buyer).createRequest({
        assetId: f.asset.assetId,
        offerId: await objectId('offer', selectedOffer.body),
        action: 'play',
        selection: { type: 'all' },
        acceptedPolicyDigest: (selectedOffer.body.policy as Record<string, LCHValue>)
          .digest as Uint8Array,
        createdAt: 20
      }),
      requestBytes = encodeDeterministicCbor(request as unknown as LCHValue),
      prepare: OutputPurchasePrepare = {
        version: 1,
        topic,
        listing: { chain, txid: '22'.repeat(32), outputIndex: 0 },
        assetId: descriptor.assetId,
        termsDigest: toHex(await objectId('offer', selectedOffer.body)),
        recipient: toHex(buyer.identityKey),
        requestId: toHex(await objectId('license-request', request.body)),
        request: Utils.toBase64(requestBytes)
      }
    return { request, requestBytes, prepare }
  }
  const original = await requestFor(),
    input = {
      reader: new LCHReader(f.storage),
      header: published.bytes,
      offer,
      request: original.requestBytes,
      prepare: original.prepare,
      descriptor,
      selection,
      installedMechanisms: new Set(LCH_OVERLAY_COVENANT_MECHANISMS)
    }
  function signedTerms(changes: Partial<OutputPurchaseTerms> = {}) {
    const prepare = original.prepare,
      body: OutputPurchaseTerms = {
        version: 1,
        acquisitionId: outputPacketDigest('purchase', {
          chain,
          seller: descriptor.seller,
          recipient: prepare.recipient,
          topic,
          requestId: prepare.requestId
        }),
        requestDigest: outputPacketDigest('purchase-request', prepare),
        seller: descriptor.seller,
        recipient: prepare.recipient,
        topic,
        listing: prepare.listing,
        assetId: prepare.assetId,
        termsDigest: prepare.termsDigest,
        domainProfile: 'https://bsv.brc.dev/tokens/0197#listing-purchase-v1',
        domainEvidence: {
          schema: 'https://bsv.brc.dev/tokens/0197#lineage-package-v1',
          bytes: 'e30='
        },
        releasePolicy,
        purchaseUntil: '100',
        recoveryUntil: '172900',
        ...changes
      }
    return signOutputPacket('purchase-terms', body, f.sellerKey)
  }
  return {
    ...f,
    ...original,
    offer,
    input,
    descriptor,
    initialRevenue,
    body,
    selection,
    requestFor,
    signedTerms
  }
}
