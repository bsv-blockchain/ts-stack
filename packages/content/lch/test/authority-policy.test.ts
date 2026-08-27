import { describe, expect, it } from '@jest/globals'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  PublicBRC77Verifier,
  WalletBRC77Signer,
  objectIri,
  parsePinnedPolicy,
  sha256,
  signObject,
  validateAuthorityChain,
  type AuthorityBody,
  type LCHValue
} from '../src/index.js'

const bytes = (value: number, length: number): Uint8Array => new Uint8Array(length).fill(value)

describe('authority and pinned policy validation', () => {
  it('validates signatures, scope, and a fresh unspent observation', async () => {
    const wallet = new ProtoWallet(new PrivateKey(1))
    const signer = await WalletBRC77Signer.create({ wallet, random: length => bytes(7, length) })
    const body: AuthorityBody = {
      version: 1,
      assetId: bytes(2, 32),
      grantor: signer.identityKey,
      grantee: bytes(3, 33),
      interests: ['master'],
      capabilities: ['issueOffer'],
      notBefore: 1_000,
      mayDelegate: false,
      revocationOutpoint: `${'1'.repeat(64)}.0`,
      revocationMaxAgeSeconds: 60,
      nonce: bytes(4, 16)
    }
    const signed = await signObject(
      'authority',
      body as unknown as Record<string, LCHValue>,
      signer
    )
    await expect(
      validateAuthorityChain(
        [{ body, signatures: signed.signatures }],
        {
          controller: signer.identityKey,
          actor: body.grantee,
          assetId: body.assetId,
          interest: 'master',
          capability: 'issueOffer',
          now: 1_100n,
          network: 'mainnet'
        },
        new PublicBRC77Verifier(),
        { status: async () => ({ status: 'unspent', network: 'mainnet', observedAt: 1_050n }) }
      )
    ).resolves.toBeUndefined()
  })

  it('fails closed for a reorganization-affected observation', async () => {
    const wallet = new ProtoWallet(new PrivateKey(1))
    const signer = await WalletBRC77Signer.create({ wallet, random: length => bytes(8, length) })
    const body: AuthorityBody = {
      version: 1,
      assetId: bytes(2, 32),
      grantor: signer.identityKey,
      grantee: bytes(3, 33),
      interests: ['master'],
      capabilities: ['issueOffer'],
      notBefore: 1,
      mayDelegate: false,
      revocationOutpoint: `${'1'.repeat(64)}.0`,
      revocationMaxAgeSeconds: 60,
      nonce: bytes(4, 16)
    }
    const signed = await signObject(
      'authority',
      body as unknown as Record<string, LCHValue>,
      signer
    )
    await expect(
      validateAuthorityChain(
        [{ body, signatures: signed.signatures }],
        {
          controller: signer.identityKey,
          actor: body.grantee,
          assetId: body.assetId,
          interest: 'master',
          capability: 'issueOffer',
          now: 100n,
          network: 'mainnet'
        },
        new PublicBRC77Verifier(),
        {
          status: async () => ({
            status: 'unspent',
            network: 'mainnet',
            observedAt: 99n,
            reorganizationAffected: true
          })
        }
      )
    ).rejects.toMatchObject({ code: 'ERR_LCH_REVOCATION' })
  })

  it('rejects delegated scope and validity widening', async () => {
    const rootSigner = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(1)),
      random: length => bytes(9, length)
    })
    const delegateSigner = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(2)),
      random: length => bytes(10, length)
    })
    const assetId = bytes(2, 32)
    const root: AuthorityBody = {
      version: 1,
      assetId,
      grantor: rootSigner.identityKey,
      grantee: delegateSigner.identityKey,
      interests: ['master'],
      capabilities: ['issueOffer'],
      usageProfiles: ['fixed'],
      notBefore: 100,
      notAfter: 200,
      mayDelegate: true,
      remainingDepth: 1,
      nonce: bytes(11, 16)
    }
    const widened: AuthorityBody = {
      ...root,
      grantor: delegateSigner.identityKey,
      grantee: bytes(12, 33),
      usageProfiles: ['fixed', 'training'],
      notAfter: 201,
      mayDelegate: false,
      nonce: bytes(13, 16)
    }
    const signedRoot = await signObject(
      'authority',
      root as unknown as Record<string, LCHValue>,
      rootSigner
    )
    const signedChild = await signObject(
      'authority',
      widened as unknown as Record<string, LCHValue>,
      delegateSigner
    )
    await expect(
      validateAuthorityChain(
        [
          { body: root, signatures: signedRoot.signatures },
          { body: widened, signatures: signedChild.signatures }
        ],
        {
          controller: rootSigner.identityKey,
          actor: widened.grantee,
          assetId,
          interest: 'master',
          capability: 'issueOffer',
          usageProfile: 'fixed',
          now: 150n,
          network: 'mainnet'
        },
        new PublicBRC77Verifier()
      )
    ).rejects.toMatchObject({ code: 'ERR_LCH_AUTHORITY' })
  })

  it('virtualizes only the top-level policy uid', async () => {
    const policy = {
      '@context': ['http://www.w3.org/ns/odrl.jsonld'],
      '@type': 'Offer',
      uid: 'lch:offer:self',
      profile: 'https://bsv.brc.dev/apps/0170#odrl-profile',
      permission: [{ target: 'lch:offer:self', action: 'play' }]
    }
    const inline = new TextEncoder().encode(JSON.stringify(policy))
    const iri = await objectIri('offer', { version: 1 })
    const result = await parsePinnedPolicy(
      { mediaType: 'application/ld+json', digest: await sha256(inline), inline },
      'Offer',
      iri
    )
    expect(result.policy.uid).toBe(iri)
    expect(result.permissions[0].target).toBe('lch:offer:self')
  })

  it('rejects unsupported remote JSON-LD contexts and permissive conflict handling', async () => {
    const policy = {
      '@context': ['http://www.w3.org/ns/odrl.jsonld', 'https://untrusted.example/context.jsonld'],
      '@type': 'Offer',
      uid: 'lch:offer:self',
      profile: 'https://bsv.brc.dev/apps/0170#odrl-profile',
      conflict: 'perm'
    }
    const inline = new TextEncoder().encode(JSON.stringify(policy))
    await expect(
      parsePinnedPolicy(
        {
          mediaType: 'application/ld+json',
          digest: await sha256(inline),
          inline
        },
        'Offer',
        'lch:offer:sha256:test'
      )
    ).rejects.toMatchObject({ code: 'ERR_LCH_POLICY' })
  })
})
