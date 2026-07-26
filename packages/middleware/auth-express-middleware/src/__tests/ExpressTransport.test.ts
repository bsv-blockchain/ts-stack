import { ExpressTransport } from '../index'

describe('ExpressTransport configuration', () => {
  it('exposes allowUnauthenticated and preserves the legacy alias', () => {
    const transport = new ExpressTransport(true)

    expect(transport.allowUnauthenticated).toBe(true)
    expect(transport.allowAuthenticated).toBe(true)

    transport.allowAuthenticated = false
    expect(transport.allowUnauthenticated).toBe(false)
  })

  it('uses allowUnauthenticated when requests have no authentication headers', () => {
    const transport = new ExpressTransport(true)
    const req: any = {}
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    }
    const next = jest.fn()

    ;(transport as any).handleUnauthenticated(req, res, next)

    expect(req.auth).toEqual({ identityKey: 'unknown' })
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it('dispatches only the exact BRC-104 path to the public handshake', async () => {
    const transport = new ExpressTransport()
    transport.peer = {} as any
    const handshake = jest
      .spyOn(transport as any, 'handleWellKnownAuth')
      .mockResolvedValue(undefined)
    const general = jest
      .spyOn(transport as any, 'handleGeneralMessage')
      .mockImplementation(() => {})
    const unauthenticated = jest
      .spyOn(transport as any, 'handleUnauthenticated')
      .mockImplementation(() => {})
    const res = {} as any
    const next = jest.fn()

    await transport.handleIncomingRequest(
      { path: '/.well-known/auth', headers: {} } as any,
      res,
      next
    )
    expect(handshake).toHaveBeenCalledTimes(1)
    expect(general).not.toHaveBeenCalled()
    expect(unauthenticated).not.toHaveBeenCalled()

    for (const path of [
      '/.well-known/auth/extra',
      '/.well-known/authentication',
      '/.well-known/Auth',
      '/protected'
    ]) {
      await transport.handleIncomingRequest({ path, headers: {} } as any, res, next)
    }
    expect(handshake).toHaveBeenCalledTimes(1)
    expect(general).not.toHaveBeenCalled()
    expect(unauthenticated).toHaveBeenCalledTimes(4)
  })

  it('requires an auth request ID before using signed general-message dispatch', async () => {
    const transport = new ExpressTransport()
    transport.peer = {} as any
    const handshake = jest
      .spyOn(transport as any, 'handleWellKnownAuth')
      .mockResolvedValue(undefined)
    const general = jest
      .spyOn(transport as any, 'handleGeneralMessage')
      .mockImplementation(() => {})
    const unauthenticated = jest
      .spyOn(transport as any, 'handleUnauthenticated')
      .mockImplementation(() => {})

    await transport.handleIncomingRequest(
      {
        path: '/protected',
        headers: { 'x-bsv-auth-request-id': 'signed-request-id' }
      } as any,
      {} as any,
      jest.fn()
    )

    expect(general).toHaveBeenCalledTimes(1)
    expect(handshake).not.toHaveBeenCalled()
    expect(unauthenticated).not.toHaveBeenCalled()
  })

  it('rejects malformed attacker-controlled request IDs before allocating state', async () => {
    const transport = new ExpressTransport()
    transport.peer = {
      sessionManager: {
        hasSession: jest.fn().mockResolvedValue(true)
      }
    } as any
    const req = {
      body: {
        messageType: 'initialRequest',
        version: '1',
        identityKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        initialNonce: 'initial-nonce'
      },
      headers: {
        'x-bsv-auth-request-id': '__proto__'
      }
    }

    await expect((transport as any).handleWellKnownAuth(req, {}, jest.fn())).rejects.toThrow(
      'request identifier'
    )
    expect(transport.openNonGeneralHandles.size).toBe(0)
  })

  it('rejects a general response that has no matching request handle', async () => {
    const transport = new ExpressTransport()

    await expect(
      (transport as any).sendGeneralMessage({
        payload: Array(32).fill(0)
      })
    ).rejects.toThrow('No response handle for this requestId')
  })

  it('removes completed non-general handles instead of retaining empty entries', async () => {
    const transport = new ExpressTransport()
    const res = {
      set: jest.fn(),
      send: jest.fn()
    }
    transport.openNonGeneralHandles.set('peer-nonce', [{ res: res as any, next: jest.fn() }])

    await (transport as any).sendNonGeneralMessage({
      version: '1',
      messageType: 'initialResponse',
      identityKey: 'identity-key',
      nonce: 'local-nonce',
      yourNonce: 'peer-nonce',
      signature: [1]
    })

    expect(transport.openNonGeneralHandles.has('peer-nonce')).toBe(false)
  })

  it('cleans up the waiting handler and timer after certificates arrive', () => {
    const transport = new ExpressTransport()
    const next = jest.fn()
    const timeout = setTimeout(() => {}, 60_000)
    transport.openNextHandlers.set('identity-key', next)
    transport.openNextHandlerTimeouts.set('identity-key', timeout)

    ;(transport as any).handleCertificatesForPeer(
      'identity-key',
      [{}],
      { headers: {} },
      {},
      jest.fn(),
      { identityKey: 'identity-key' }
    )

    expect(next).toHaveBeenCalledTimes(1)
    expect(transport.openNextHandlers.has('identity-key')).toBe(false)
    expect(transport.openNextHandlerTimeouts.has('identity-key')).toBe(false)
  })

  it('responds through the stored handle when a peer returns no certificates', () => {
    const transport = new ExpressTransport()
    const json = jest.fn()
    const status = jest.fn().mockReturnValue({ json })
    transport.openNonGeneralHandles.set('initial-nonce', [
      { res: { status } as any, next: jest.fn() }
    ])

    ;(transport as any).handleCertificatesForPeer(
      'identity-key',
      [],
      { headers: {} },
      {},
      jest.fn(),
      {
        identityKey: 'identity-key',
        initialNonce: 'initial-nonce'
      }
    )

    expect(status).toHaveBeenCalledWith(400)
    expect(json).toHaveBeenCalledWith({
      status: 'error',
      code: 'ERR_CERTIFICATES_REQUIRED',
      description: 'No certificates were provided.'
    })
  })

  it('ignores certificate events from a different peer without dropping the expected listener', () => {
    const transport = new ExpressTransport()
    let listener: ((senderPublicKey: string, certs: any[]) => void) | undefined
    const stopListeningForCertificatesReceived = jest.fn()
    transport.peer = {
      listenForCertificatesReceived: jest.fn(callback => {
        listener = callback
        return 7
      }),
      stopListeningForCertificatesReceived
    } as any
    transport.openNonGeneralHandles.set('request-id', [{ res: {} as any, next: jest.fn() }])

    ;(transport as any).registerCertificateListener(
      { body: { identityKey: 'expected-peer' } },
      {},
      jest.fn(),
      'request-id',
      { identityKey: 'expected-peer' }
    )
    listener?.('different-peer', [])

    expect(transport.openNonGeneralHandles.has('request-id')).toBe(true)
    expect(stopListeningForCertificatesReceived).not.toHaveBeenCalled()
  })

  it('replaces stale certificate waits and times out the current handler safely', async () => {
    jest.useFakeTimers()
    try {
      const transport = new ExpressTransport()
      transport.peer = {
        sessionManager: {
          hasSession: jest.fn().mockResolvedValue(false)
        },
        certificatesToRequest: {
          certifiers: ['certifier']
        }
      } as any
      const firstNext = jest.fn()
      const currentNext = jest.fn()
      const json = jest.fn()
      const wrapper = {
        status: jest.fn().mockReturnThis(),
        json
      }
      const buildAndSendResponse = jest.fn().mockResolvedValue(undefined)

      await (transport as any).scheduleNextOrCertificateWait(
        firstNext,
        'identity-key',
        wrapper,
        buildAndSendResponse
      )
      await (transport as any).scheduleNextOrCertificateWait(
        currentNext,
        'identity-key',
        wrapper,
        buildAndSendResponse
      )

      expect(transport.openNextHandlers.get('identity-key')).toBe(currentNext)
      expect(transport.openNextHandlerTimeouts.has('identity-key')).toBe(true)
      expect(firstNext).not.toHaveBeenCalled()
      expect(currentNext).not.toHaveBeenCalled()

      jest.advanceTimersByTime(30_000)
      await Promise.resolve()

      expect(transport.openNextHandlers.has('identity-key')).toBe(false)
      expect(transport.openNextHandlerTimeouts.has('identity-key')).toBe(false)
      expect(wrapper.status).toHaveBeenCalledWith(408)
      expect(json).toHaveBeenCalledWith({
        status: 'error',
        code: 'CERTIFICATE_TIMEOUT',
        message: 'Certificate request timed out'
      })
      expect(buildAndSendResponse).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })
})
