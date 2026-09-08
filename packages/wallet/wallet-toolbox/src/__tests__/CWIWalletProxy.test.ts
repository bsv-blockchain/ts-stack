import { CWIStyleWalletManager, OverlayUMPTokenInteractor, UMPTokenLookupError } from '../CWIStyleWalletManager'

describe('CWI wallet proxy and UMP failure paths', () => {
  const proxyMethods = [
    'getPublicKey',
    'revealCounterpartyKeyLinkage',
    'revealSpecificKeyLinkage',
    'encrypt',
    'decrypt',
    'createHmac',
    'verifyHmac',
    'createSignature',
    'verifySignature',
    'createAction',
    'signAction',
    'abortAction',
    'listActions',
    'internalizeAction',
    'listOutputs',
    'relinquishOutput',
    'acquireCertificate',
    'listCertificates',
    'proveCertificate',
    'relinquishCertificate',
    'discoverByIdentityKey',
    'discoverByAttributes',
    'getHeight',
    'getHeaderForHeight',
    'getNetwork',
    'getVersion'
  ] as const

  function manager(authenticated = true) {
    const underlying = Object.fromEntries(proxyMethods.map(method => [method, jest.fn(async () => ({ method }))]))
    underlying.waitForAuthentication = jest.fn(async () => ({ authenticated: true }))
    const subject = Object.create(CWIStyleWalletManager.prototype) as CWIStyleWalletManager
    Object.assign(subject as any, {
      authenticated,
      underlying,
      adminOriginator: 'admin.example'
    })
    return { subject, underlying }
  }

  it('forwards every wallet method after applying the shared readiness boundary', async () => {
    const { subject, underlying } = manager()
    for (const method of proxyMethods) {
      await expect((subject as any)[method]({ value: method }, 'app.example')).resolves.toEqual({ method })
      expect((underlying as any)[method]).toHaveBeenCalledWith(
        method === 'getHeight' || method === 'getNetwork' || method === 'getVersion' ? {} : { value: method },
        'app.example'
      )
    }
    await expect(subject.isAuthenticated({}, 'app.example')).resolves.toEqual({ authenticated: true })
    await expect(subject.waitForAuthentication({}, 'app.example')).resolves.toEqual({ authenticated: true })
  })

  it('rejects unauthenticated, uninitialized, and reserved-originator proxy calls', async () => {
    const unauthenticated = manager(false).subject
    await expect(unauthenticated.getNetwork({})).rejects.toThrow('not authenticated')
    await expect(unauthenticated.isAuthenticated({})).rejects.toThrow('not authenticated')

    const missingWallet = manager().subject
    Object.assign(missingWallet as any, { underlying: undefined })
    await expect(missingWallet.getNetwork({})).rejects.toThrow('not initialized')

    const reserved = manager().subject
    await expect(reserved.getNetwork({}, 'admin.example')).rejects.toThrow('admin originator')
    await expect(reserved.isAuthenticated({}, 'admin.example')).rejects.toThrow('admin originator')
    await expect(reserved.waitForAuthentication({}, 'admin.example')).rejects.toThrow('admin originator')
  })

  it('classifies resolver failures for presentation and exact-outpoint lookups', async () => {
    const resolver = { queryDetailed: jest.fn(async () => Promise.reject(new Error('offline'))) }
    const subject = new OverlayUMPTokenInteractor(resolver as any, {} as any)

    await expect(subject.findByPresentationKeyHash(Array(32).fill(1))).rejects.toMatchObject<
      Partial<UMPTokenLookupError>
    >({ reason: 'lookup-unavailable' })
    await expect((subject as any).findByOutpoint(`${'a'.repeat(64)}.0`)).rejects.toMatchObject<
      Partial<UMPTokenLookupError>
    >({ reason: 'lookup-unavailable' })
  })

  it('refuses renewal when the previous token cannot be loaded and validates incomplete finalization', async () => {
    const subject = new OverlayUMPTokenInteractor({} as any, {} as any)
    jest.spyOn(subject as any, 'findByOutpoint').mockResolvedValue(undefined)
    await expect((subject as any).resolveOldInput({ currentOutpoint: `${'a'.repeat(64)}.0` })).rejects.toThrow(
      'Previous UMP token unavailable'
    )
    await expect((subject as any).broadcastFinal({})).rejects.toThrow('not finalized')
    await expect((subject as any).broadcastFinal({ txid: 'a'.repeat(64) })).rejects.toThrow('data missing')

    const wallet = { signAction: jest.fn(async () => ({})) }
    await expect((subject as any).broadcastNew(wallet, 'admin.example', 'reference')).rejects.toThrow('finalize new')
    wallet.signAction.mockResolvedValue({ txid: 'b'.repeat(64) } as any)
    await expect((subject as any).broadcastNew(wallet, 'admin.example', 'reference')).rejects.toThrow(
      'transaction data missing'
    )
  })
})
