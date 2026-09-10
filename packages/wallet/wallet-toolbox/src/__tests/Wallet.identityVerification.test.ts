import {
  KeyDeriver,
  LookupAnswer,
  LookupResolver,
  MerklePath,
  PrivateKey,
  Transaction,
  TransactionEvidenceError,
  Validation,
  VerifiableCertificate
} from '@bsv/sdk'
import { Wallet } from '../Wallet'
import { WalletSettingsManager } from '../WalletSettingsManager'
import { WalletStorageManager } from '../storage/WalletStorageManager'
import { WalletServices } from '../sdk/WalletServices.interfaces'
import { IdentityEvidenceVerifier } from '../utility/identityUtils'
import {
  createIdentityVerificationFixture,
  IdentityVerificationFixture
} from '../utility/__tests__/identityVerification.fixtures'

function walletFor(fixture: IdentityVerificationFixture, resolver?: LookupResolver) {
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
    lookupResolver: resolver ?? ({ query } as unknown as LookupResolver),
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

  it('recovers a valid alternate receipt before legacy resolver merging and keeps certificate/trust caches isolated', async () => {
    const badTransaction = Transaction.fromBEEF(fixture.certificateBEEF)
    badTransaction.merklePath = new MerklePath(700_000, [
      [
        { offset: 0, hash: badTransaction.id('hex'), txid: true },
        { offset: 1, hash: '42'.repeat(32) }
      ]
    ])
    const badReceipt = badTransaction.toBEEF()
    expect(Transaction.fromBEEF(badReceipt).id('hex')).toBe(fixture.certificateTransaction.id('hex'))
    const firstHost = 'https://first.invalid-proof.example'
    const secondHost = 'https://second.valid-proof.example'
    const lookup = jest.fn(async (host: string) =>
      host === firstHost
        ? { type: 'output-list' as const, outputs: [{ beef: badReceipt, outputIndex: 0 }] }
        : { type: 'output-list' as const, outputs: [{ beef: fixture.certificateBEEF, outputIndex: 0 }] }
    )
    const resolver = new LookupResolver({
      facilitator: { lookup },
      hostOverrides: { ls_identity: [firstHost, secondHost] }
    })
    const { wallet, trustSettings } = walletFor(fixture, resolver)
    const certificateVerify = jest.spyOn(VerifiableCertificate.prototype, 'verify')
    const args = { identityKey: fixture.certificate.subject }

    const initial = await wallet.discoverByIdentityKey(args)
    expect(initial).toMatchObject({ totalCertificates: 1 })
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(certificateVerify).toHaveBeenCalledTimes(1)

    initial.certificates[0].decryptedFields.name = 'Mutated caller copy'
    trustSettings.trustLevel = 2
    await expect(wallet.discoverByIdentityKey(args)).resolves.toEqual({ totalCertificates: 0, certificates: [] })
    expect(certificateVerify).toHaveBeenCalledTimes(1)

    trustSettings.trustLevel = 1
    const restored = await wallet.discoverByIdentityKey(args)
    expect(restored.certificates[0].decryptedFields).toEqual({ name: 'Alice' })
    // The rejected receipt makes the bounded raw-receipt cache retry, but the
    // verified certificate is still reused across trust-only refiltering.
    expect(lookup).toHaveBeenCalledTimes(6)
    expect(certificateVerify).toHaveBeenCalledTimes(1)
    certificateVerify.mockRestore()
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
      {
        graceMs: 300,
        evidenceLimits: { maxOutputs: 512, maxBytes: 16 * 1024 * 1024 },
        onEvidence: expect.any(Function)
      }
    )
    await wallet.discoverByAttributes({ attributes: { name: 'Alice' }, limit: 1, offset: 3, seekPermission: true })
    expect(query).toHaveBeenLastCalledWith(
      { service: 'ls_identity', query: { attributes: { name: 'Alice' }, certifiers: [fixture.certificate.certifier] } },
      undefined,
      {
        graceMs: 300,
        evidenceLimits: { maxOutputs: 512, maxBytes: 16 * 1024 * 1024 },
        onEvidence: expect.any(Function)
      }
    )
    await expect(wallet.discoverByIdentityKey({ ...identityArgs, limit: 10_001 })).rejects.toThrow()
    await expect(wallet.discoverByAttributes({ attributes: {}, offset: -1 })).rejects.toThrow()
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('returns no overlay certificates when services are omitted without forceRefresh', async () => {
    const { wallet, query } = walletFor(fixture)
    wallet.services = undefined
    await expect(wallet.discoverByIdentityKey({ identityKey: fixture.certificate.subject })).resolves.toEqual({
      totalCertificates: 0,
      certificates: []
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('returns no overlay certificates after destroy closes identity evidence', async () => {
    const { wallet, query } = walletFor(fixture)
    await wallet.destroy()
    await expect(wallet.discoverByIdentityKey({ identityKey: fixture.certificate.subject })).resolves.toEqual({
      totalCertificates: 0,
      certificates: []
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('drops an in-flight overlay lookup after destroy closes identity evidence', async () => {
    const { wallet, query } = walletFor(fixture)
    let resolveLookup: ((value: LookupAnswer) => void) | undefined
    const started = new Promise<void>(resolve => {
      query.mockImplementation(
        async () =>
          await new Promise<LookupAnswer>(resolveAnswer => {
            resolve()
            resolveLookup = resolveAnswer
          })
      )
    })
    const pending = wallet.discoverByIdentityKey({ identityKey: fixture.certificate.subject })
    await started
    await wallet.destroy()
    resolveLookup!({ type: 'output-list', outputs: [{ beef: fixture.certificateBEEF, outputIndex: 0 }] })
    await expect(pending).resolves.toEqual({ totalCertificates: 0, certificates: [] })
  })

  it('deletes overlay evidence when parseResults throws a bounded limit', async () => {
    const { wallet, query } = walletFor(fixture)
    const parse = jest
      .spyOn(IdentityEvidenceVerifier.prototype, 'parse')
      .mockRejectedValue(new TransactionEvidenceError('limit'))
    const args = { identityKey: fixture.certificate.subject }
    try {
      await expect(wallet.discoverByIdentityKey(args)).rejects.toMatchObject({ code: 'limit' })
    } finally {
      parse.mockRestore()
    }
    await expect(wallet.discoverByIdentityKey(args)).resolves.toMatchObject({ totalCertificates: 1 })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('expires overlay evidence through its scheduled prune', async () => {
    jest.useFakeTimers({ now: Date.now() })
    try {
      const { wallet, query } = walletFor(fixture)
      const args = { identityKey: fixture.certificate.subject }
      await expect(wallet.discoverByIdentityKey(args)).resolves.toMatchObject({ totalCertificates: 1 })
      expect(query).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(2 * 60 * 1000 + 1)
      await expect(wallet.discoverByIdentityKey(args)).resolves.toMatchObject({ totalCertificates: 1 })
      expect(query).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })
})
