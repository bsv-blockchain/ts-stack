import { KeyDeriver, LookupAnswer, LookupResolver, PrivateKey, Validation } from '@bsv/sdk'
import { Wallet } from '../Wallet'
import { WalletSettingsManager } from '../WalletSettingsManager'
import { WalletStorageManager } from '../storage/WalletStorageManager'
import { WalletServices } from '../sdk/WalletServices.interfaces'
import {
  createIdentityVerificationFixture,
  IdentityVerificationFixture
} from '../utility/__tests__/identityVerification.fixtures'

function walletFor(fixture: IdentityVerificationFixture) {
  const keyDeriver = new KeyDeriver(new PrivateKey(15))
  const trustSettings = {
    trustLevel: 1,
    trustedCertifiers: [
      { identityKey: fixture.certificate.certifier, name: 'Synthetic certifier', description: '', trust: 1 }
    ]
  }
  const query = jest.fn(async (): Promise<LookupAnswer> => ({
    type: 'output-list',
    outputs: [{ beef: fixture.certificateBEEF, outputIndex: 0 }]
  }))
  const getChainTracker = jest.fn(async () => fixture.confirmedTracker)
  const getSettings = jest.fn(async () => ({ trustSettings }))
  const wallet = new Wallet({
    chain: 'main',
    keyDeriver,
    storage: new WalletStorageManager(keyDeriver.identityKey),
    services: { getChainTracker } as unknown as WalletServices,
    lookupResolver: { query } as unknown as LookupResolver,
    settingsManager: { get: getSettings } as unknown as WalletSettingsManager
  })
  return { wallet, query, getChainTracker, getSettings, trustSettings }
}

describe('Wallet final identity verification and compatibility', () => {
  let fixture: IdentityVerificationFixture
  beforeEach(async () => {
    fixture = await createIdentityVerificationFixture()
  })

  it.each(['identity', 'attributes'] as const)('verifies evidence again on a cached %s discovery', async method => {
    const { wallet, query, getChainTracker } = walletFor(fixture)
    const discover = () =>
      method === 'identity'
        ? wallet.discoverByIdentityKey({ identityKey: fixture.certificate.subject }, 'app.example')
        : wallet.discoverByAttributes({ attributes: { name: 'Alice' } }, 'app.example')

    await expect(discover()).resolves.toMatchObject({ totalCertificates: 1 })
    const checked = fixture.confirmedTracker.checkedRoots.length
    await expect(discover()).resolves.toMatchObject({ totalCertificates: 1 })
    expect(query).toHaveBeenCalledTimes(1)
    expect(getChainTracker).toHaveBeenCalledTimes(2)
    expect(fixture.confirmedTracker.checkedRoots.length).toBeGreaterThan(checked)

    // The configured source changes its verdict. This tests the wallet cache, not
    // reorg detection/invalidation inside a particular ChainTracker implementation.
    const roots = [...fixture.confirmedTracker.roots]
    fixture.confirmedTracker.roots.clear()
    await expect(discover()).resolves.toEqual({ totalCertificates: 0, certificates: [] })
    roots.forEach(root => fixture.confirmedTracker.roots.add(root))
    await expect(discover()).resolves.toMatchObject({ totalCertificates: 1 })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('does not let host or returned-certificate mutation change cached evidence', async () => {
    const { wallet, query } = walletFor(fixture)
    const args = { identityKey: fixture.certificate.subject }
    const first = await wallet.discoverByIdentityKey(args)
    fixture.certificateBEEF.fill(0)
    first.certificates[0].decryptedFields.name = 'Changed locally'
    const second = await wallet.discoverByIdentityKey(args)
    expect(second.certificates[0].decryptedFields).toEqual({ name: 'Alice' })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('keeps trust filtering and forceRefresh on the final Promise API', async () => {
    const { wallet, query, trustSettings } = walletFor(fixture)
    const args = { identityKey: fixture.certificate.subject }
    const promise = wallet.discoverByIdentityKey(args)
    expect(promise).toBeInstanceOf(Promise)
    await expect(promise).resolves.toMatchObject({ totalCertificates: 1 })
    trustSettings.trustLevel = 2
    await expect(wallet.discoverByIdentityKey(args)).resolves.toEqual({ totalCertificates: 0, certificates: [] })
    trustSettings.trustLevel = 1
    await expect(wallet.discoverByIdentityKey({ ...args, forceRefresh: true })).resolves.toMatchObject({
      totalCertificates: 1
    })
    expect(query).toHaveBeenCalledTimes(2)
    trustSettings.trustedCertifiers = []
    await expect(wallet.discoverByIdentityKey(args)).resolves.toEqual({ totalCertificates: 0, certificates: [] })
  })

  it('preserves local contact provenance and bypasses chain/network work for contacts', async () => {
    const { wallet, query, getChainTracker, getSettings } = walletFor(fixture)
    const contact = { identityKey: fixture.certificate.subject, decryptedFields: { name: 'Local Alice' } }
    wallet.contactSource = {
      findByIdentityKey: async () => contact,
      findByAttributes: async () => [contact]
    }
    wallet.services = undefined
    for (const result of [
      await wallet.discoverByIdentityKey({ identityKey: contact.identityKey }),
      await wallet.discoverByAttributes({ attributes: { name: 'Local Alice' } })
    ]) {
      expect(result).toMatchObject({
        totalCertificates: 1,
        certificates: [
          {
            type: 'contact',
            signature: '',
            decryptedFields: { name: 'Local Alice' },
            certifierInfo: { trust: Infinity }
          }
        ]
      })
    }
    expect(query).not.toHaveBeenCalled()
    expect(getChainTracker).not.toHaveBeenCalled()
    expect(getSettings).not.toHaveBeenCalled()
    await expect(
      wallet.discoverByIdentityKey({ identityKey: contact.identityKey, forceRefresh: true })
    ).rejects.toThrow()
  })

  it('rejects missing chain configuration before overlay lookup', async () => {
    const { wallet, query, getChainTracker } = walletFor(fixture)
    getChainTracker.mockRejectedValueOnce(new Error('Canonical source unavailable'))
    await expect(wallet.discoverByIdentityKey({ identityKey: fixture.certificate.subject })).rejects.toThrow(
      'Canonical source unavailable'
    )
    expect(query).not.toHaveBeenCalled()
  })

  it('fails closed for a non-output-list response without caching it or throwing a TypeError', async () => {
    const { wallet, query } = walletFor(fixture)
    query.mockResolvedValueOnce({ type: 'freeform', result: { untrusted: true } } as unknown as LookupAnswer)
    const args = { identityKey: fixture.certificate.subject }
    await expect(wallet.discoverByIdentityKey(args)).resolves.toEqual({ totalCertificates: 0, certificates: [] })
    await expect(wallet.discoverByIdentityKey(args)).resolves.toMatchObject({ totalCertificates: 1 })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('characterizes legacy pagination and seekPermission without changing forwarding', async () => {
    const { wallet, query } = walletFor(fixture)
    const identityArgs = { identityKey: fixture.certificate.subject, limit: 1, offset: 3 }
    expect(Validation.validateDiscoverByIdentityKeyArgs({ identityKey: fixture.certificate.subject })).toMatchObject({
      limit: 10,
      offset: 0,
      seekPermission: false
    })
    expect(Validation.validateDiscoverByAttributesArgs({ attributes: { name: 'Alice' } })).toMatchObject({
      limit: 10,
      offset: 0,
      seekPermission: false
    })
    await expect(wallet.discoverByIdentityKey(identityArgs)).resolves.toMatchObject({ totalCertificates: 1 })
    expect(query).toHaveBeenLastCalledWith(
      {
        service: 'ls_identity',
        query: { identityKey: fixture.certificate.subject, certifiers: [fixture.certificate.certifier] }
      },
      undefined,
      { graceMs: 300 }
    )
    await wallet.discoverByAttributes({ attributes: { name: 'Alice' }, limit: 1, offset: 3, seekPermission: true })
    expect(query).toHaveBeenLastCalledWith(
      { service: 'ls_identity', query: { attributes: { name: 'Alice' }, certifiers: [fixture.certificate.certifier] } },
      undefined,
      { graceMs: 300 }
    )
    await expect(wallet.discoverByIdentityKey({ ...identityArgs, limit: 10_001 })).rejects.toThrow()
    await expect(wallet.discoverByAttributes({ attributes: {}, offset: -1 })).rejects.toThrow()
    expect(query).toHaveBeenCalledTimes(2)
  })
})
