import { PrivateKey, ProtoWallet, type CreateSignatureArgs } from '@bsv/sdk'
import { RevenueListingProfileSpend } from '@bsv/sdk/script/templates/RevenueListingProfileSpend'
import { construct, fixture, profile, purchaseTransaction } from './revenue-profile.fixture.js'

/** Disclosed fixture actors only. All signatures stay behind the wallet API. */
export async function profileAuthorityFixture() {
  const previous = purchaseTransaction(),
    funded = await construct(previous, 0, { operation: 'split', firstAmount: '500' }),
    spend = new RevenueListingProfileSpend(
      profile,
      fixture.descriptor,
      [{ rawTransaction: previous.toHex(), outputIndex: 0 }],
      { operation: 'split', firstAmount: '500' }
    ),
    prepared = spend.prepare(funded),
    request = prepared.signingRequests()[0],
    wallet = new ProtoWallet(new PrivateKey(fixture.testActors.seller.scalar)),
    calls: { args: CreateSignatureArgs; originator?: string }[] = []
  let allowed = true,
    signer = wallet.createSignature.bind(wallet)
  const options = {
    identity: fixture.descriptor.seller,
    originator: 'current-authority.local',
    checkCurrent: () => {
      if (!allowed) throw new Error('Changed protected authority')
    },
    wallet: {
      getPublicKey: wallet.getPublicKey.bind(wallet),
      createSignature: (args: CreateSignatureArgs, originator?: string) => {
        calls.push({ args: structuredClone(args), originator })
        return signer(args)
      }
    }
  }
  return {
    previous,
    funded,
    spend,
    prepared,
    request,
    options,
    calls,
    wallet,
    deny: () => {
      allowed = false
    },
    setSigner: (selected: typeof signer) => {
      signer = selected
    }
  }
}
