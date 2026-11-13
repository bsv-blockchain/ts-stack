import { expect, it } from '@jest/globals'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  PublicBRC77Verifier,
  WalletBRC77Signer,
  signObject,
  objectId,
  type LCHValue
} from '../src/index.js'
import {
  validateLCHOverlayAuthority,
  validateLCHOverlayAuthoritySelection,
  type LCHOverlayAuthorityPath
} from '../src/overlayAcquisitionAuthority.js'
import { validateLCHOverlayPaidTerms } from '../src/overlayAcquisitionTerms.js'
import { lchOverlayFixture } from './overlay-acquisition.fixture.js'

async function fixture() {
  const f = await lchOverlayFixture(),
    terms = await validateLCHOverlayPaidTerms(f.input),
    delegate = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(85)) }),
    capability = 'https://bsv.brc.dev/apps/0170#issueLicense',
    authority = await signObject(
      'authority',
      {
        version: 1,
        assetId: terms.inspected.assetId,
        grantor: f.seller.identityKey,
        grantee: delegate.identityKey,
        interests: ['sound-recording'],
        capabilities: [capability],
        policyActions: [terms.policy.action],
        usageProfiles: [terms.offer.body.usageProfile],
        notBefore: 1,
        notAfter: 100,
        mayDelegate: false,
        revocationOutpoint: 'a1'.repeat(32) + '.0',
        revocationMaxAgeSeconds: 10,
        nonce: new Uint8Array(16).fill(1)
      },
      f.seller
    ),
    path: LCHOverlayAuthorityPath = {
      controller: f.seller.identityKey,
      actor: delegate.identityKey,
      interest: 'sound-recording',
      capability,
      chain: [authority]
    },
    verifier = new PublicBRC77Verifier()
  return { ...f, terms, delegate, capability, authority, path, verifier }
}
it('requires exactly one finite authenticated delegation and a fresh retained revocation assessment', async () => {
  const f = await fixture(),
    status = {
      status: () =>
        Promise.resolve({
          status: 'unspent' as const,
          network: 'testnet' as const,
          observedAt: 20n
        })
    },
    check = (paths: LCHOverlayAuthorityPath[], source = status) =>
      validateLCHOverlayAuthority(f.terms, f.delegate.identityKey, f.capability, paths, {
        now: 20n,
        network: 'testnet',
        verifier: f.verifier,
        revocationSource: source
      })
  await expect(check([f.path])).resolves.toBeUndefined()
  await expect(check([])).rejects.toThrow('missing or ambiguous')
  await expect(check([f.path, f.path])).rejects.toThrow('missing or ambiguous')
  await expect(
    check([f.path], {
      status: () => Promise.resolve({ status: 'unspent', network: 'testnet', observedAt: 1n })
    })
  ).rejects.toThrow()
  await expect(
    validateLCHOverlayAuthority(f.terms, f.delegate.identityKey, f.capability, [f.path], {
      now: 20n,
      network: 'testnet',
      verifier: f.verifier
    })
  ).rejects.toThrow('No revocation-status')
  const forged = { ...f.path, chain: [{ ...f.authority, signatures: [Uint8Array.of(1)] }] }
  await expect(check([forged])).rejects.toThrow()
})
it('does not mistake an Offer authority reference or unrelated path for complete role evidence', async () => {
  const f = await fixture(),
    source = {
      status: () =>
        Promise.resolve({
          status: 'unspent' as const,
          network: 'testnet' as const,
          observedAt: 20n
        })
    }
  f.terms.offer.body.authorityIds = [await objectId('authority', f.authority.body)]
  await expect(
    validateLCHOverlayAuthoritySelection(f.terms, [f.path], 20n, 'testnet', f.verifier, source)
  ).resolves.toBeUndefined()
  await expect(
    validateLCHOverlayAuthoritySelection(f.terms, [], 20n, 'testnet', f.verifier, source)
  ).rejects.toThrow('not in the finite selection')
  for (const change of [
    { interest: 'unrelated' },
    { capability: 'urn:unknown' },
    { controller: f.delegate.identityKey },
    { chain: [] }
  ])
    await expect(
      validateLCHOverlayAuthoritySelection(
        f.terms,
        [{ ...f.path, ...change }],
        20n,
        'testnet',
        f.verifier,
        source
      )
    ).rejects.toThrow('outside the required Asset roles')
  const wrong = await signObject(
    'authority',
    { ...f.authority.body, assetId: new Uint8Array(32) } as Record<string, LCHValue>,
    f.seller
  )
  await expect(
    validateLCHOverlayAuthoritySelection(
      f.terms,
      [{ ...f.path, chain: [wrong] }],
      20n,
      'testnet',
      f.verifier,
      source
    )
  ).rejects.toThrow()
})
