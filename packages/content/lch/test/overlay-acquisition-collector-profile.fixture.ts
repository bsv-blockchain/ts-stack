import { PrivateKey, Utils } from '@bsv/sdk'
import type { RevenueListingProfileDescriptor } from '@bsv/sdk/script/templates/RevenueListingProfile'
import { REVENUE_LISTING_FAMILY } from '@bsv/sdk/script/templates/RevenueListing'

export function collectorFixture(expiryHeight = 101, weight = 3) {
  const seller = new PrivateKey(91).toPublicKey().toString(),
    identity = new Uint8Array(Utils.toArray(seller, 'hex')),
    initialRevenue = { recipients: [{ identity: seller, weight }] },
    descriptor: RevenueListingProfileDescriptor = {
      version: 1,
      chain: { network: 'fixture', genesisHash: '09'.repeat(32) },
      seller,
      assetId: '11'.repeat(32),
      termsDigest: '12'.repeat(32),
      lineageAnchor: {
        chain: { network: 'fixture', genesisHash: '09'.repeat(32) },
        txid: '13'.repeat(32),
        outputIndex: 0
      },
      purchasePrice: '1000',
      reserve: '1',
      expiryHeight,
      scriptFamily: REVENUE_LISTING_FAMILY,
      metadataDigest: '14'.repeat(32),
      initialRevenue
    },
    collector = {
      version: 1,
      family: REVENUE_LISTING_FAMILY,
      expiryHeight,
      initialRevenue: { recipients: [{ identity, weight }] },
      schedule: 'immutable',
      derivation: 'brc29-anyone-fixed',
      withdrawal: 'permissionless-quanta',
      remainders: 'retain-until-payout',
      retirement: 'seller-child-or-expiry-height-exact-top-up'
    }
  return { seller, identity, descriptor, collector }
}
