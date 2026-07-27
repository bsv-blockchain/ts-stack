import { PrivateKey, Utils } from '@bsv/sdk'
import { createAuthMiddleware, ExpressTransport } from '../index'
import { MockWallet } from './MockWallet'

const IDENTITY_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const REQUEST_ID = Utils.toBase64(Array(32).fill(0))

function responseMock(): any {
  const response: any = {
    headersSent: false,
    status: jest.fn(),
    set: jest.fn(),
    send: jest.fn(),
    json: jest.fn(),
    text: jest.fn(),
    end: jest.fn(),
    sendFile: jest.fn()
  }
  response.status.mockReturnValue(response)
  response.set.mockReturnValue(response)
  response.send.mockReturnValue(response)
  response.json.mockReturnValue(response)
  response.text.mockReturnValue(response)
  response.end.mockReturnValue(response)
  response.sendFile.mockReturnValue(response)
  return response
}

function validGeneralRequest(overrides: Record<string, unknown> = {}): any {
  const request: any = {
    path: '/protected',
    method: 'POST',
    protocol: 'https',
    originalUrl: '/protected?q=one',
    body: { hello: 'world' },
    headers: {
      'content-type': 'application/json',
      'x-bsv-auth-request-id': REQUEST_ID,
      'x-bsv-auth-version': '1',
      'x-bsv-auth-identity-key': IDENTITY_KEY,
      'x-bsv-auth-nonce': 'AQ==',
      'x-bsv-auth-your-nonce': 'Ag==',
      'x-bsv-auth-signature': '00'
    },
    get: jest.fn((name: string) => (name === 'host' ? 'example.com' : undefined))
  }
  Object.assign(request, overrides)
  return request
}

function validHandshakeRequest(overrides: Record<string, unknown> = {}): any {
  const request: any = {
    path: '/.well-known/auth',
    method: 'POST',
    headers: {},
    body: {
      messageType: 'initialRequest',
      version: '1',
      identityKey: IDENTITY_KEY,
      initialNonce: 'AQ=='
    }
  }
  Object.assign(request, overrides)
  return request
}

function peerMock(overrides: Record<string, unknown> = {}): any {
  return {
    sessionManager: {
      hasSession: jest.fn().mockResolvedValue(true)
    },
    listenForGeneralMessages: jest.fn().mockReturnValue(1),
    stopListeningForGeneralMessages: jest.fn(),
    listenForCertificatesReceived: jest.fn().mockReturnValue(2),
    stopListeningForCertificatesReceived: jest.fn(),
    toPeer: jest.fn().mockResolvedValue(undefined),
    toSession: jest.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

function responsePayload(
  status: number,
  headers: Record<string, string>,
  body?: number[]
): number[] {
  const writer = new Utils.Writer()
  writer.write(Utils.toArray(REQUEST_ID, 'base64'))
  writer.writeVarIntNum(status)
  writer.writeVarIntNum(Object.keys(headers).length)
  for (const [key, value] of Object.entries(headers)) {
    const keyBytes = Utils.toArray(key, 'utf8')
    const valueBytes = Utils.toArray(value, 'utf8')
    writer.writeVarIntNum(keyBytes.length)
    writer.write(keyBytes)
    writer.writeVarIntNum(valueBytes.length)
    writer.write(valueBytes)
  }
  if (body !== undefined) {
    writer.writeVarIntNum(body.length)
    writer.write(body)
  } else {
    writer.writeVarIntNum(-1)
  }
  return writer.toArray()
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('ExpressTransport hardening', () => {
  it.each([
    [{ requestTimeoutMs: 0 }, 'requestTimeoutMs'],
    [{ requestTimeoutMs: 1.5 }, 'requestTimeoutMs'],
    [{ maxPendingRequests: 0 }, 'maxPendingRequests'],
    [{ maxPendingRequests: Number.MAX_SAFE_INTEGER + 1 }, 'maxPendingRequests']
  ])('rejects invalid transport limits', (limits, expected) => {
    expect(() => new ExpressTransport(false, undefined, undefined, limits)).toThrow(expected)
  })

  it('rejects a logger without the required fallback method', () => {
    expect(() => new ExpressTransport(false, {} as never)).toThrow('logger')
  })

  it('passes unexpected setup errors to Express next', async () => {
    const transport = new ExpressTransport()
    const next = jest.fn()

    await transport.handleIncomingRequest(
      { path: '/', headers: {}, method: 'GET' } as any,
      responseMock(),
      next
    )

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('set a Peer')
      })
    )
  })

  it.each([
    null,
    [],
    {},
    { messageType: '', version: '1', identityKey: IDENTITY_KEY },
    { messageType: 'initialRequest', version: '', identityKey: IDENTITY_KEY },
    { messageType: 'initialRequest', version: '1', identityKey: 'bad-key' },
    {
      messageType: 'initialRequest',
      version: '1',
      identityKey: IDENTITY_KEY,
      initialNonce: 'not base64'
    }
  ])('returns a stable malformed response for an invalid handshake body', async body => {
    const transport = new ExpressTransport()
    transport.peer = peerMock()
    const res = responseMock()

    await transport.handleIncomingRequest(validHandshakeRequest({ body }), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      code: 'ERR_AUTH_MALFORMED',
      description: 'The authentication request is malformed.'
    })
  })

  it.each([
    ['x-bsv-auth-request-id', ['duplicate']],
    ['x-bsv-auth-request-id', 'short'],
    ['x-bsv-auth-request-id', `${REQUEST_ID}\r`],
    ['x-bsv-auth-version', 'v'.repeat(33)],
    ['x-bsv-auth-identity-key', 'bad-key'],
    ['x-bsv-auth-nonce', 'not-base64'],
    ['x-bsv-auth-your-nonce', 'not-base64'],
    ['x-bsv-auth-signature', 'not-hex']
  ])('rejects malformed general header %s without allocating state', async (name, value) => {
    const transport = new ExpressTransport()
    transport.peer = peerMock()
    const req = validGeneralRequest()
    req.headers[name] = value
    const res = responseMock()

    await transport.handleIncomingRequest(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect((transport as any).activeGeneralRequests.size).toBe(0)
  })

  it.each([
    { protocol: 'ftp' },
    { originalUrl: 'relative' },
    { originalUrl: `/${'x'.repeat(8_192)}` },
    { get: () => '' },
    { get: () => `bad\rhost` }
  ])('rejects invalid authenticated request URLs', async override => {
    const transport = new ExpressTransport()
    transport.peer = peerMock()
    const res = responseMock()

    await transport.handleIncomingRequest(validGeneralRequest(override), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('rejects duplicate pending handshake IDs and enforces capacity', async () => {
    const transport = new ExpressTransport(false, undefined, undefined, {
      requestTimeoutMs: 1_000,
      maxPendingRequests: 1
    })
    transport.peer = peerMock()
    const firstResponse = responseMock()
    await transport.handleIncomingRequest(validHandshakeRequest(), firstResponse, jest.fn())

    const duplicateResponse = responseMock()
    await transport.handleIncomingRequest(validHandshakeRequest(), duplicateResponse, jest.fn())
    expect(duplicateResponse.status).toHaveBeenCalledWith(400)

    const capacityResponse = responseMock()
    await transport.handleIncomingRequest(
      validHandshakeRequest({
        body: {
          messageType: 'initialRequest',
          version: '1',
          identityKey: IDENTITY_KEY,
          initialNonce: 'Ag=='
        }
      }),
      capacityResponse,
      jest.fn()
    )
    expect(capacityResponse.status).toHaveBeenCalledWith(503)

    for (const handles of transport.openNonGeneralHandles.values()) {
      for (const handle of handles) clearTimeout(handle.timeout)
    }
    transport.openNonGeneralHandles.clear()
  })

  it('bounds handshake response handles and certificate listeners by time', async () => {
    jest.useFakeTimers()
    try {
      const peer = peerMock({
        sessionManager: {
          hasSession: jest.fn().mockResolvedValue(false)
        }
      })
      const transport = new ExpressTransport(false, undefined, undefined, {
        requestTimeoutMs: 20,
        maxPendingRequests: 10
      })
      transport.peer = peer
      const res = responseMock()

      await transport.handleIncomingRequest(validHandshakeRequest(), res, jest.fn())
      expect(transport.openNonGeneralHandles.size).toBe(1)
      expect((transport as any).activeCertificateRequests.size).toBe(1)

      jest.advanceTimersByTime(20)
      await flushPromises()

      expect(transport.openNonGeneralHandles.size).toBe(0)
      expect((transport as any).activeCertificateRequests.size).toBe(0)
      expect(peer.stopListeningForCertificatesReceived).toHaveBeenCalledWith(2)
      expect(res.status).toHaveBeenCalledWith(408)
    } finally {
      jest.useRealTimers()
    }
  })

  it('cleans handshake state when session lookup or peer processing fails', async () => {
    const sessionFailure = new ExpressTransport()
    sessionFailure.peer = peerMock({
      sessionManager: {
        hasSession: jest.fn().mockRejectedValue(new Error('database secret'))
      }
    })
    const sessionNext = jest.fn()
    await sessionFailure.handleIncomingRequest(validHandshakeRequest(), responseMock(), sessionNext)
    expect(sessionNext).toHaveBeenCalledWith(expect.any(Error))
    expect(sessionFailure.openNonGeneralHandles.size).toBe(0)

    const callbackFailure = new ExpressTransport()
    callbackFailure.peer = peerMock()
    await callbackFailure.onData(async () => {
      throw new Error('private signing detail')
    })
    const res = responseMock()
    await callbackFailure.handleIncomingRequest(validHandshakeRequest(), res, jest.fn())
    await flushPromises()
    expect(callbackFailure.openNonGeneralHandles.size).toBe(0)
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      code: 'ERR_INTERNAL_SERVER_ERROR',
      description: 'Authentication processing failed.'
    })
  })

  it('clears a certificate listener before awaiting its callback and continues once', async () => {
    let listener: ((sender: string, certificates: any[]) => void) | undefined
    const peer = peerMock({
      sessionManager: {
        hasSession: jest.fn().mockResolvedValue(false)
      },
      listenForCertificatesReceived: jest.fn(callback => {
        listener = callback
        return 7
      })
    })
    const transport = new ExpressTransport()
    transport.peer = peer
    const next = jest.fn()
    const callback = jest.fn(async (_sender, _certs, _req, _res, continueRequest) => {
      continueRequest('route')
      continueRequest()
    })
    await transport.handleIncomingRequest(validHandshakeRequest(), responseMock(), next, callback)

    listener?.(IDENTITY_KEY, [{}])
    await flushPromises()

    expect(peer.stopListeningForCertificatesReceived).toHaveBeenCalledWith(7)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith('route')
    expect(transport.openNonGeneralHandles.size).toBe(0)
  })

  it('returns a generic certificate error and cleans the listener', async () => {
    let listener: ((sender: string, certificates: any[]) => void) | undefined
    const peer = peerMock({
      sessionManager: {
        hasSession: jest.fn().mockResolvedValue(false)
      },
      listenForCertificatesReceived: jest.fn(callback => {
        listener = callback
        return 8
      })
    })
    const transport = new ExpressTransport()
    transport.peer = peer
    const res = responseMock()
    await transport.handleIncomingRequest(validHandshakeRequest(), res, jest.fn(), async () => {
      throw new Error('certificate secret')
    })

    listener?.(IDENTITY_KEY, [{}])
    await flushPromises()

    expect(peer.stopListeningForCertificatesReceived).toHaveBeenCalledWith(8)
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      code: 'ERR_CERTIFICATE_HANDLER',
      description: 'Certificate processing failed.'
    })
  })

  it('times out general verification and removes the SDK listener', async () => {
    jest.useFakeTimers()
    try {
      const peer = peerMock()
      const transport = new ExpressTransport(false, undefined, undefined, {
        requestTimeoutMs: 20
      })
      transport.peer = peer
      const res = responseMock()

      await transport.handleIncomingRequest(validGeneralRequest(), res, jest.fn())
      jest.advanceTimersByTime(20)
      await flushPromises()

      expect(peer.stopListeningForGeneralMessages).toHaveBeenCalledWith(1)
      expect(res.status).toHaveBeenCalledWith(408)
      expect(res.json).toHaveBeenCalledWith({
        status: 'error',
        code: 'ERR_AUTH_TIMEOUT',
        description: 'Authentication verification timed out.'
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects a duplicate pending general request identifier', async () => {
    const peer = peerMock()
    const transport = new ExpressTransport()
    transport.peer = peer

    await transport.handleIncomingRequest(validGeneralRequest(), responseMock(), jest.fn())
    const duplicateResponse = responseMock()
    await transport.handleIncomingRequest(validGeneralRequest(), duplicateResponse, jest.fn())

    expect(duplicateResponse.status).toHaveBeenCalledWith(400)
    expect(duplicateResponse.json).toHaveBeenCalledWith({
      status: 'error',
      code: 'ERR_AUTH_MALFORMED',
      description: 'The authentication request is malformed.'
    })
    expect(peer.listenForGeneralMessages).toHaveBeenCalledTimes(1)

    ;(transport as any).clearActiveGeneralRequest(REQUEST_ID)
  })

  it.each([
    [new Error('invalid signature'), 401, 'ERR_AUTH_FAILED', 'Authentication failed.'],
    [
      new Error('database unavailable'),
      500,
      'ERR_INTERNAL_SERVER_ERROR',
      'Authentication processing failed.'
    ],
    ['session invalid', 401, 'ERR_AUTH_FAILED', 'Authentication failed.']
  ])(
    'maps peer processing failures to stable public errors',
    async (error, status, code, description) => {
      const transport = new ExpressTransport()
      transport.peer = peerMock()
      await transport.onData(async () => {
        throw error
      })
      const res = responseMock()

      await transport.handleIncomingRequest(validGeneralRequest(), res, jest.fn())
      await flushPromises()

      expect(res.status).toHaveBeenCalledWith(status)
      expect(res.json).toHaveBeenCalledWith({ status: 'error', code, description })
    }
  )

  it('ignores unrelated and mismatched general events before dispatching the match', async () => {
    let listener: ((sender: string, payload: number[]) => void) | undefined
    const peer = peerMock({
      listenForGeneralMessages: jest.fn(callback => {
        listener = callback
        return 3
      })
    })
    const transport = new ExpressTransport()
    transport.peer = peer
    const setupAuthenticatedResponse = jest
      .spyOn(transport as any, 'setupAuthenticatedResponse')
      .mockImplementation(() => {})
    const next = jest.fn()
    await transport.handleIncomingRequest(validGeneralRequest(), responseMock(), next)

    listener?.('different-peer', [])
    expect(peer.stopListeningForGeneralMessages).not.toHaveBeenCalled()

    listener?.(IDENTITY_KEY, Utils.toArray(Utils.toBase64(Array(32).fill(1)), 'base64'))
    expect(peer.stopListeningForGeneralMessages).not.toHaveBeenCalled()

    listener?.(IDENTITY_KEY, Utils.toArray(REQUEST_ID, 'base64'))
    expect(peer.stopListeningForGeneralMessages).toHaveBeenCalledWith(3)
    expect(setupAuthenticatedResponse).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      next,
      IDENTITY_KEY,
      REQUEST_ID
    )
  })

  it('buffers, signs, and restores an authenticated JSON response', async () => {
    let listener: ((sender: string, payload: number[]) => void) | undefined
    const peer = peerMock({
      listenForGeneralMessages: jest.fn(callback => {
        listener = callback
        return 4
      })
    })
    const transport = new ExpressTransport()
    transport.peer = peer
    const req = validGeneralRequest()
    const res = responseMock()
    const originalStatus = res.status
    const originalSet = res.set
    const originalSend = res.send
    const next = jest.fn()

    await transport.handleIncomingRequest(req, res, next)
    listener?.(IDENTITY_KEY, Utils.toArray(REQUEST_ID, 'base64'))
    await flushPromises()

    expect(req.auth).toEqual({ identityKey: IDENTITY_KEY })
    expect(next).toHaveBeenCalledTimes(1)

    res.status(201).set({ 'x-bsv-result': 7, 'x-bsv-auth-ignore': 'private' }).json({ ok: true })
    await flushPromises()

    expect(peer.toSession).toHaveBeenCalledWith(expect.any(Array), 'Ag==')
    expect(transport.openGeneralHandles.has(REQUEST_ID)).toBe(true)

    await transport.send({
      messageType: 'general',
      version: '1',
      identityKey: IDENTITY_KEY,
      nonce: 'AQ==',
      yourNonce: 'Ag==',
      signature: [1],
      payload: responsePayload(201, { 'x-bsv-result': '7' }, Utils.toArray('{"ok":true}', 'utf8'))
    })

    expect(res.status).toBe(originalStatus)
    expect(res.set).toBe(originalSet)
    expect(res.send).toBe(originalSend)
    expect(originalStatus).toHaveBeenCalledWith(201)
    expect(originalSet).toHaveBeenCalledWith('x-bsv-result', '7')
    expect(originalSend).toHaveBeenCalledWith(Buffer.from('{"ok":true}'))
    expect(transport.openGeneralHandles.has(REQUEST_ID)).toBe(false)
  })

  it('buffers and signs an authenticated text response with its inferred content type', async () => {
    const debug = jest.fn()
    const logger = {
      log: jest.fn(),
      debug,
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    } as unknown as typeof console
    const peer = peerMock()
    const transport = new ExpressTransport(false, logger, 'debug')
    transport.peer = peer
    const res = responseMock()
    const originalSend = res.send

    ;(transport as any).setupAuthenticatedResponse(
      validGeneralRequest(),
      res,
      jest.fn(),
      IDENTITY_KEY,
      REQUEST_ID
    )
    await flushPromises()

    res.text('authenticated response')
    await flushPromises()

    expect(peer.toSession).toHaveBeenCalledWith(
      responsePayload(200, {}, Utils.toArray('authenticated response', 'utf8')),
      'Ag=='
    )
    expect(debug).toHaveBeenCalledWith(
      '[ExpressTransport] [DEBUG] Sending general message response',
      {
        responseStatus: 200,
        responseHeaderCount: 1,
        responseBodyLength: 22
      }
    )

    await transport.send({
      messageType: 'general',
      version: '1',
      identityKey: IDENTITY_KEY,
      nonce: 'AQ==',
      yourNonce: 'Ag==',
      signature: [1],
      payload: responsePayload(200, {}, Utils.toArray('authenticated response', 'utf8'))
    })

    expect(originalSend).toHaveBeenCalledWith(Buffer.from('authenticated response'))
  })

  it('restores and ends an authenticated response without a body', async () => {
    const transport = new ExpressTransport()
    const res = responseMock()
    const originalEnd = res.end
    ;(res as any).__status = res.status
    ;(res as any).__set = res.set
    ;(res as any).__json = res.json
    ;(res as any).__text = res.text
    ;(res as any).__send = res.send
    ;(res as any).__end = res.end
    ;(res as any).__sendFile = res.sendFile
    transport.openGeneralHandles.set(REQUEST_ID, { res, next: jest.fn() })

    await transport.send({
      messageType: 'general',
      version: '1',
      identityKey: IDENTITY_KEY,
      nonce: 'AQ==',
      yourNonce: 'Ag==',
      signature: [1],
      requestedCertificates: { certifiers: [], types: {} },
      payload: responsePayload(204, {})
    })

    expect(originalEnd).toHaveBeenCalledTimes(1)
  })

  it('reports response-signing failures without exposing internal details', async () => {
    const transport = new ExpressTransport()
    const peer = peerMock({
      toSession: jest.fn().mockRejectedValue(new Error('wallet signing secret'))
    })
    transport.peer = peer
    const res = responseMock()
    const originalStatus = res.status
    const originalJson = res.json
    const next = jest.fn()

    ;(transport as any).setupAuthenticatedResponse(
      validGeneralRequest(),
      res,
      next,
      IDENTITY_KEY,
      REQUEST_ID
    )
    await flushPromises()
    res.send('response')
    await flushPromises()

    expect(originalStatus).toHaveBeenCalledWith(500)
    expect(originalJson).toHaveBeenCalledWith({
      status: 'error',
      code: 'ERR_RESPONSE_SIGNING_FAILED',
      description: 'Failed to sign the authenticated response.'
    })
    expect(JSON.stringify(originalJson.mock.calls)).not.toContain('wallet signing secret')
  })

  it('sends a complete non-general response and restores a hijacked response', async () => {
    const transport = new ExpressTransport()
    const res = responseMock()
    const originalSet = res.set
    const originalSend = res.send
    ;(res as any).__status = res.status
    ;(res as any).__set = res.set
    ;(res as any).__json = res.json
    ;(res as any).__text = res.text
    ;(res as any).__send = res.send
    ;(res as any).__end = res.end
    ;(res as any).__sendFile = res.sendFile
    transport.openNonGeneralHandles.set('peer-nonce', [
      {
        res,
        next: jest.fn(),
        timeout: setTimeout(() => {}, 1_000)
      } as any
    ])

    await transport.send({
      version: '1',
      messageType: 'initialResponse',
      identityKey: IDENTITY_KEY,
      nonce: 'AQ==',
      yourNonce: 'peer-nonce',
      signature: [1],
      requestedCertificates: { certifiers: [], types: {} },
      payload: []
    })

    expect(res.set).toBe(originalSet)
    expect(res.send).toBe(originalSend)
    expect(originalSet).toHaveBeenCalledWith(
      'x-bsv-auth-requested-certificates',
      JSON.stringify({ certifiers: [], types: {} })
    )
    expect(originalSend).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: 'initialResponse'
      })
    )
  })

  it('validates createAuthMiddleware options before creating a peer', () => {
    expect(() => createAuthMiddleware(null as any)).toThrow('options are required')
    expect(() => createAuthMiddleware({ wallet: null } as any)).toThrow('wallet')
    const error = jest.fn()
    expect(() =>
      createAuthMiddleware({
        wallet: null,
        logger: { log: jest.fn(), error } as unknown as typeof console,
        logLevel: 'error'
      } as any)
    ).toThrow('wallet')
    expect(error).toHaveBeenCalledWith(
      '[createAuthMiddleware] No wallet provided in AuthMiddlewareOptions.'
    )
    expect(() =>
      createAuthMiddleware({
        wallet: {} as any,
        allowUnauthenticated: 'yes' as any
      })
    ).toThrow('allowUnauthenticated')
    expect(() =>
      createAuthMiddleware({
        wallet: {} as any,
        logLevel: 'trace' as any
      })
    ).toThrow('logLevel')
    expect(() =>
      createAuthMiddleware({
        wallet: {} as any,
        onCertificatesReceived: true as any
      })
    ).toThrow('onCertificatesReceived')
  })

  it('creates a configured middleware and logs only request metadata', () => {
    const debug = jest.fn()
    const info = jest.fn()
    const logger = {
      log: jest.fn(),
      debug,
      info,
      warn: jest.fn(),
      error: jest.fn()
    } as unknown as typeof console
    const middleware = createAuthMiddleware({
      wallet: new MockWallet(new PrivateKey(1)),
      logger,
      logLevel: 'debug',
      allowUnauthenticated: true
    })
    const req = {
      path: '/public',
      method: 'GET',
      headers: {}
    } as any

    middleware(req, responseMock(), jest.fn())

    expect(info).toHaveBeenCalledWith(expect.stringContaining('Session Manager: Default'))
    expect(debug).toHaveBeenCalledWith(
      '[createAuthMiddleware] Incoming request to auth middleware',
      {
        pathLength: 7,
        method: 'GET',
        hasAuthRequestId: false
      }
    )
    expect(JSON.stringify(debug.mock.calls)).not.toContain('/public')
  })
})
