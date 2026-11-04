import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { IdentityService } from '../../identity/index.js'
import { DEFAULT_CIPHERSUITE } from '../../types.js'
import { walletAuthenticationService, clientConfigFor } from '../authentication.js'
import { resolveCiphersuite } from '../ciphersuite.js'

const mlsSignatureKey = new Uint8Array(32).fill(7)

const mintCredential = async () => {
  const identity = await IdentityService.open(new KeyDeriver(PrivateKey.fromRandom()))
  const { credential } = await identity.createCredential({
    ciphersuite: DEFAULT_CIPHERSUITE,
    mlsSignaturePublicKey: mlsSignatureKey
  })
  return credential
}

describe('resolveCiphersuite', () => {
  it('builds both supported suites', async () => {
    expect((await resolveCiphersuite(DEFAULT_CIPHERSUITE)).name).toBe(DEFAULT_CIPHERSUITE)
    expect((await resolveCiphersuite('MLS_128_DHKEMP256_AES128GCM_SHA256_P256')).name).toBe(
      'MLS_128_DHKEMP256_AES128GCM_SHA256_P256'
    )
  })

  it('returns the same instance for the same suite', async () => {
    expect(await resolveCiphersuite(DEFAULT_CIPHERSUITE)).toBe(
      await resolveCiphersuite(DEFAULT_CIPHERSUITE)
    )
  })
})

describe('walletAuthenticationService', () => {
  it('accepts a credential that attests to the signature key it is paired with', async () => {
    const service = walletAuthenticationService(DEFAULT_CIPHERSUITE)
    const identity = await mintCredential()

    expect(
      await service.validateCredential({ credentialType: 'basic', identity }, mlsSignatureKey)
    ).toBe(true)
  })

  it('rejects a credential paired with a different signature key', async () => {
    const service = walletAuthenticationService(DEFAULT_CIPHERSUITE)
    const identity = await mintCredential()

    expect(
      await service.validateCredential(
        { credentialType: 'basic', identity },
        new Uint8Array(32).fill(9)
      )
    ).toBe(false)
  })

  it('rejects a non-basic credential', async () => {
    const service = walletAuthenticationService(DEFAULT_CIPHERSUITE)

    expect(
      await service.validateCredential(
        { credentialType: 'x509', certificates: [new Uint8Array([1])] },
        mlsSignatureKey
      )
    ).toBe(false)
  })

  it('rejects malformed identity bytes without throwing', async () => {
    const service = walletAuthenticationService(DEFAULT_CIPHERSUITE)

    expect(
      await service.validateCredential(
        { credentialType: 'basic', identity: new Uint8Array([1, 2, 3]) },
        mlsSignatureKey
      )
    ).toBe(false)
  })
})

describe('clientConfigFor', () => {
  it('installs our authentication service, not the permissive default', async () => {
    const config = clientConfigFor(DEFAULT_CIPHERSUITE)

    expect(
      await config.authService.validateCredential(
        { credentialType: 'basic', identity: new Uint8Array([1]) },
        mlsSignatureKey
      )
    ).toBe(false)
  })
})
