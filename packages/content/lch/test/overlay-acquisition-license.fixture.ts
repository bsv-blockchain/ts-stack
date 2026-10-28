import { Utils } from '@bsv/sdk'
import { WalletBRC78KeyDelivery, type KeyGrant } from '../src/index.js'
import { LCH_OVERLAY_PROFILES } from '../src/overlayAcquisitionCodec.js'
import { bindLCHOverlayCovenantSettlement } from '../src/overlayAcquisitionCovenantSettlement.js'
import { createLCHOverlayFixedRenderAgreement } from '../src/overlayAcquisitionPolicy.js'
import { lchOverlaySignatureBudget } from '../src/overlayAcquisitionVerification.js'
import type { LCHOverlayLicenseValidation } from '../src/overlayAcquisitionLicense.js'
import { lchCovenantSettlementFixture } from './overlay-acquisition-covenant-settlement.fixture.js'

/** Real License, Agreement, signatures, BRC78 grants and encrypted content.
 * Bitcoin/purchase truth is deliberately outside this License-stage fixture.
 */
export async function lchOverlayLicenseFixture() {
  const f = await lchCovenantSettlementFixture(),
    bound = bindLCHOverlayCovenantSettlement(f.context, f.terms, f.prepared, f.delivered, f.txid),
    delivery = new WalletBRC78KeyDelivery(f.sellerWallet),
    keyGrants: KeyGrant[] = []
  await [...f.asset.keys].reduce(
    (pending, [key, cek]) =>
      pending.then(async () => {
        const keyId = Uint8Array.from(Utils.toArray(key, 'hex'))
        keyGrants.push({
          keyId,
          delivery: 'https://bsv.brc.dev/apps/0170#brc78-key-v1',
          payload: await delivery.deliver(f.prepare.recipient, keyId, cek)
        })
      }),
    Promise.resolve()
  )
  const license = await f.issuer.issueLicense({
      assetId: f.asset.assetId,
      offerId: Uint8Array.from(Utils.toArray(f.prepare.termsDigest, 'hex')),
      requestId: Uint8Array.from(Utils.toArray(f.prepare.requestId, 'hex')),
      issuer: f.seller.identityKey,
      subject: f.buyer.identityKey,
      issuedAt: 22,
      agreement: await createLCHOverlayFixedRenderAgreement(f.terms.policy),
      selection: { type: 'all' },
      keyGrants,
      encryption: f.terms.encryption,
      fulfillments: [
        {
          dutyUid: f.terms.policy.dutyUid,
          settlementProfile: LCH_OVERLAY_PROFILES.collectorSettlement,
          receiptIds: [Uint8Array.from(Utils.toArray(bound.id, 'hex'))]
        }
      ],
      critical: [LCH_OVERLAY_PROFILES.acquisition, LCH_OVERLAY_PROFILES.collectorSettlement],
      extensions: {
        [LCH_OVERLAY_PROFILES.acquisition]: {
          version: 1,
          mode: 'listing-covenant',
          settlementId: Uint8Array.from(Utils.toArray(bound.id, 'hex'))
        },
        [LCH_OVERLAY_PROFILES.collectorSettlement]: { version: 1 }
      }
    }),
    context = { ...f.context, license },
    input: LCHOverlayLicenseValidation = {
      terms: f.terms,
      paths: [],
      verifier: lchOverlaySignatureBudget(() => {}),
      context,
      requestId: f.prepare.requestId,
      mode: 'listing-covenant',
      settlement: { id: bound.id, issuedAt: f.body.issuedAt, acceptedAt: f.release.acceptedAt },
      selectedAt: '20',
      authorityNetwork: 'testnet',
      keyDelivery: new WalletBRC78KeyDelivery(f.buyerWallet),
      locallyVerified: false,
      clock: () => '22',
      current: () => {}
    }
  return { ...f, license, context, input, bound, delivered: await f.deliver(context) }
}
