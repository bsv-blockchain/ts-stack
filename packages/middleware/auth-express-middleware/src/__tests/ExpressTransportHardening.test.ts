import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey, Utils } from '@bsv/sdk'
import { createAuthMiddleware, ExpressTransport, InMemoryCertificateApprovalStore } from '../index'
import { MockWallet } from './MockWallet'

const IDENTITY_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const REQUEST_ID = Utils.toBase64(Array(32).fill(0))
const AUTH_NONCE = Utils.toBase64(Array(32).fill(1))
const HANDSHAKE_NONCE = Utils.toBase64(Array(48).fill(3))
const SESSION_NONCE = Utils.toBase64(Array(48).fill(2))

function responseMock(): any {
  const response: any = {
    headersSent: false,
    status: jest.fn(),
    set: jest.fn(),
    send: jest.fn(),
    json: jest.fn(),
    text: jest.fn(),
    end: jest.fn(),
    write: jest.fn(),
    writeHead: jest.fn(),
    flushHeaders: jest.fn(),
    sendFile: jest.fn(),
    once: jest.fn()
  }
  response.status.mockReturnValue(response)
  response.set.mockReturnValue(response)
  response.send.mockReturnValue(response)
  response.json.mockReturnValue(response)
  response.text.mockReturnValue(response)
  response.end.mockReturnValue(response)
  response.write.mockReturnValue(true)
  response.writeHead.mockReturnValue(response)
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
      'x-bsv-auth-version': '0.1',
      'x-bsv-auth-identity-key': IDENTITY_KEY,
      'x-bsv-auth-nonce': AUTH_NONCE,
      'x-bsv-auth-your-nonce': SESSION_NONCE,
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
    headers: { 'content-type': 'application/json' },
    body: {
      messageType: 'initialRequest',
      version: '0.1',
      identityKey: IDENTITY_KEY,
      initialNonce: HANDSHAKE_NONCE
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
    ...overrides
  }
}

function peerWithSignedResponse(): { peer: any; signed: Promise<void> } {
  let resolveSigned!: () => void
  const signed = new Promise<void>(resolve => {
    resolveSigned = resolve
  })
  return {
    peer: peerMock({
      toPeer: jest.fn().mockImplementation(async () => resolveSigned())
    }),
    signed
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
  it('bounds and refreshes process-local certificate approvals', async () => {
    expect(() => new InMemoryCertificateApprovalStore(0)).toThrow('positive safe integer')
    expect(() => new InMemoryCertificateApprovalStore(1.5)).toThrow('positive safe integer')

    const store = new InMemoryCertificateApprovalStore(2)
    await store.approve('oldest', IDENTITY_KEY)
    await store.approve('newer', IDENTITY_KEY)
    await store.approve('oldest', IDENTITY_KEY)
    await store.approve('newest', IDENTITY_KEY)

    expect(await store.isApproved('oldest', IDENTITY_KEY)).toBe(true)
    expect(await store.isApproved('newer', IDENTITY_KEY)).toBe(false)
    expect(await store.isApproved('newest', IDENTITY_KEY)).toBe(true)
    expect(await store.isApproved('newest', `03${'11'.repeat(32)}`)).toBe(false)
  })

  it.each([
    [{ requestTimeoutMs: 0 }, 'requestTimeoutMs'],
    [{ requestTimeoutMs: 1.5 }, 'requestTimeoutMs'],
    [{ maxPendingRequests: 0 }, 'maxPendingRequests'],
    [{ maxPendingRequests: Number.MAX_SAFE_INTEGER + 1 }, 'maxPendingRequests'],
    [{ maxRequestBytes: 0 }, 'maxRequestBytes'],
    [{ maxRequestBytes: -2 }, 'maxRequestBytes'],
    [{ maxRequestBytes: Number.MAX_SAFE_INTEGER + 1 }, 'maxRequestBytes'],
    [{ maxResponseBytes: 0 }, 'maxResponseBytes'],
    [{ maxResponseBytes: -2 }, 'maxResponseBytes'],
    [{ maxResponseBytes: Number.MAX_SAFE_INTEGER + 1 }, 'maxResponseBytes']
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

  it('rejects partial authentication headers instead of treating them as unauthenticated', async () => {
    const transport = new ExpressTransport(true)
    transport.peer = peerMock()
    const res = responseMock()
    const next = jest.fn()

    await transport.handleIncomingRequest(
      {
        path: '/public',
        method: 'GET',
        headers: { 'x-bsv-auth-identity-key': IDENTITY_KEY }
      } as any,
      res,
      next
    )

    expect(res.status).toHaveBeenCalledWith(400)
    expect(next).not.toHaveBeenCalled()
  })

  it.each([
    ['GET', 'application/json'],
    ['POST', 'text/plain']
  ])('requires the handshake to use JSON POST (%s, %s)', async (method, contentType) => {
    const transport = new ExpressTransport()
    transport.peer = peerMock()
    const res = responseMock()

    await transport.handleIncomingRequest(
      validHandshakeRequest({ method, headers: { 'content-type': contentType } }),
      res,
      jest.fn()
    )

    expect(res.status).toHaveBeenCalledWith(400)
    expect(transport.openNonGeneralHandles.size).toBe(0)
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

  it('rejects oversized or deeply nested authentication bodies before peer processing', async () => {
    const callback = jest.fn()
    for (const body of [
      {
        messageType: 'initialRequest',
        version: '0.1',
        identityKey: IDENTITY_KEY,
        initialNonce: HANDSHAKE_NONCE,
        padding: 'x'.repeat(256)
      },
      (() => {
        const root: Record<string, unknown> = {}
        let cursor = root
        for (let index = 0; index < 70; index += 1) {
          const child: Record<string, unknown> = {}
          cursor.child = child
          cursor = child
        }
        return root
      })()
    ]) {
      const transport = new ExpressTransport(false, undefined, undefined, { maxRequestBytes: 64 })
      transport.peer = peerMock()
      await transport.onData(async message => callback(message))
      const res = responseMock()

      await transport.handleIncomingRequest(validHandshakeRequest({ body }), res, jest.fn())

      expect(res.status).toHaveBeenCalledWith(400)
    }
    expect(callback).not.toHaveBeenCalled()
  })

  it.each([
    [
      'cycle',
      () => {
        const value: Record<string, unknown> = {}
        value.self = value
        return value
      }
    ],
    ['non-plain object', () => new Date()],
    ['symbol metadata', () => ({ [Symbol('hostile')]: true })],
    [
      'accessor',
      () => {
        const value = {}
        Object.defineProperty(value, 'secret', { enumerable: true, get: () => 'hostile' })
        return value
      }
    ],
    [
      'non-enumerable metadata',
      () => {
        const value = {}
        Object.defineProperty(value, 'secret', { enumerable: false, value: 'hostile' })
        return value
      }
    ],
    ['array metadata', () => Object.assign([1], { label: 'hostile' })],
    ['unsupported primitive', () => 1n],
    ['oversized array', () => Object.assign([], { length: 100_001 })]
  ])('rejects handshake %s before peer processing', async (_name, createValue) => {
    const peer = peerMock()
    const transport = new ExpressTransport()
    transport.peer = peer
    const body = validHandshakeRequest().body
    body.hostile = createValue()
    const res = responseMock()

    await transport.handleIncomingRequest(validHandshakeRequest({ body }), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(peer.toPeer).not.toHaveBeenCalled()
  })

  it('accepts bounded booleans and byte arrays in handshake extensions', async () => {
    const peer = peerMock()
    const transport = new ExpressTransport()
    transport.peer = peer
    const res = responseMock()
    const body = validHandshakeRequest().body
    body.booleanValue = true
    body.byteValue = new Uint8Array([1, 2, 3])

    await transport.handleIncomingRequest(validHandshakeRequest({ body }), res, jest.fn())

    expect(res.status).not.toHaveBeenCalledWith(400)
  })

  it('rejects malformed raw signed-header pairs before allocating listener state', async () => {
    const peer = peerMock()
    const transport = new ExpressTransport()
    transport.peer = peer
    const res = responseMock()

    await transport.handleIncomingRequest(
      validGeneralRequest({ rawHeaders: [4, 'value'] }),
      res,
      jest.fn()
    )

    expect(res.status).toHaveBeenCalledWith(400)
    expect(peer.listenForGeneralMessages).not.toHaveBeenCalled()
  })

  it('rejects an oversized signed general body before allocating listener state', async () => {
    const peer = peerMock()
    const transport = new ExpressTransport(false, undefined, undefined, { maxRequestBytes: 64 })
    transport.peer = peer
    const res = responseMock()

    await transport.handleIncomingRequest(
      validGeneralRequest({ body: { value: 'x'.repeat(256) } }),
      res,
      jest.fn()
    )

    expect(res.status).toHaveBeenCalledWith(400)
    expect(peer.listenForGeneralMessages).not.toHaveBeenCalled()
  })

  it.each([
    {
      body: { account: { role: 'admin' } },
      headers: {
        ...validGeneralRequest().headers,
        'content-type': 'application/x-www-form-urlencoded'
      }
    },
    { body: { amount: -0 } },
    { body: Object.assign(Array(2), { 1: 7 }) }
  ])('rejects a non-canonical parsed general body before listener allocation', async overrides => {
    const peer = peerMock()
    const transport = new ExpressTransport()
    transport.peer = peer
    const res = responseMock()

    await transport.handleIncomingRequest(validGeneralRequest(overrides), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      code: 'ERR_AUTH_MALFORMED',
      description: 'The authentication request is malformed.'
    })
    expect(peer.listenForGeneralMessages).not.toHaveBeenCalled()
  })

  it('rejects duplicate raw signed headers before listener allocation', async () => {
    const peer = peerMock()
    const transport = new ExpressTransport()
    transport.peer = peer
    const res = responseMock()
    const req = validGeneralRequest({
      rawHeaders: ['x-bsv-auth-request-id', REQUEST_ID, 'X-BSV-Auth-Request-Id', REQUEST_ID]
    })

    await transport.handleIncomingRequest(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(peer.listenForGeneralMessages).not.toHaveBeenCalled()
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
          version: '0.1',
          identityKey: IDENTITY_KEY,
          initialNonce: Utils.toBase64(Array(48).fill(4))
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

  it('cleans handshake state when listener setup or peer processing fails', async () => {
    const listenerFailure = new ExpressTransport()
    listenerFailure.peer = peerMock({
      listenForCertificatesReceived: jest.fn(() => {
        throw new Error('listener setup secret')
      })
    })
    const sessionNext = jest.fn()
    await listenerFailure.handleIncomingRequest(
      validHandshakeRequest(),
      responseMock(),
      sessionNext
    )
    expect(sessionNext).toHaveBeenCalledWith(expect.any(Error))
    expect(listenerFailure.openNonGeneralHandles.size).toBe(0)

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

    const synchronousFailure = new ExpressTransport()
    synchronousFailure.peer = peerMock()
    await synchronousFailure.onData((() => {
      throw new Error('synchronous private detail')
    }) as never)
    const synchronousResponse = responseMock()
    await synchronousFailure.handleIncomingRequest(
      validHandshakeRequest(),
      synchronousResponse,
      jest.fn()
    )
    await flushPromises()
    expect(synchronousResponse.status).toHaveBeenCalledWith(500)
    expect(synchronousResponse.json).toHaveBeenCalledWith({
      status: 'error',
      code: 'ERR_INTERNAL_SERVER_ERROR',
      description: 'Authentication processing failed.'
    })
  })

  it('clears a certificate listener before awaiting its callback and continues once', async () => {
    let listener: ((sender: string, certificates: any[], sessionNonce?: string) => void) | undefined
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
    transport.openNextHandlers.set(IDENTITY_KEY, next)
    const callback = jest.fn(async (_sender, _certs, _req, _res, continueRequest) => {
      continueRequest('route')
      continueRequest()
    })
    await transport.handleIncomingRequest(validHandshakeRequest(), responseMock(), next, callback)

    listener?.(IDENTITY_KEY, [{}], IDENTITY_KEY)
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

  it('does not write a certificate error after the response settles', async () => {
    let listener: ((sender: string, certificates: any[]) => void) | undefined
    const peer = peerMock({
      sessionManager: {
        hasSession: jest.fn().mockResolvedValue(false)
      },
      listenForCertificatesReceived: jest.fn(callback => {
        listener = callback
        return 9
      })
    })
    const transport = new ExpressTransport()
    transport.peer = peer
    let rejectProcessing!: (error: Error) => void
    const processing = new Promise<void>((_resolve, reject) => {
      rejectProcessing = reject
    })
    const res = responseMock()
    await transport.handleIncomingRequest(validHandshakeRequest(), res, jest.fn(), async () => {
      await processing
    })

    listener?.(IDENTITY_KEY, [{}])
    await flushPromises()
    res.headersSent = true
    rejectProcessing(new Error('late certificate failure'))
    await flushPromises()

    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
    expect(peer.stopListeningForCertificatesReceived).toHaveBeenCalledWith(9)
  })

  it('does not write a handshake timeout after the response settles', async () => {
    jest.useFakeTimers()
    try {
      const peer = peerMock({
        sessionManager: {
          hasSession: jest.fn().mockResolvedValue(false)
        }
      })
      const transport = new ExpressTransport(false, undefined, undefined, {
        requestTimeoutMs: 20
      })
      transport.peer = peer
      const res = responseMock()

      await transport.handleIncomingRequest(validHandshakeRequest(), res, jest.fn())
      res.destroyed = true
      jest.advanceTimersByTime(20)
      await flushPromises()

      expect(res.status).not.toHaveBeenCalled()
      expect(res.json).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
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

  it('does not write a general timeout after the response settles', async () => {
    jest.useFakeTimers()
    try {
      const peer = peerMock()
      const transport = new ExpressTransport(false, undefined, undefined, {
        requestTimeoutMs: 20
      })
      transport.peer = peer
      const res = responseMock()

      await transport.handleIncomingRequest(validGeneralRequest(), res, jest.fn())
      res.writableEnded = true
      jest.advanceTimersByTime(20)
      await flushPromises()

      expect(peer.stopListeningForGeneralMessages).toHaveBeenCalledWith(1)
      expect(res.status).not.toHaveBeenCalled()
      expect(res.json).not.toHaveBeenCalled()
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

  it('does not write a protocol error after the response settles', async () => {
    const peer = peerMock()
    const transport = new ExpressTransport()
    transport.peer = peer

    await transport.handleIncomingRequest(validGeneralRequest(), responseMock(), jest.fn())
    const duplicateResponse = responseMock()
    duplicateResponse.headersSent = true
    await transport.handleIncomingRequest(validGeneralRequest(), duplicateResponse, jest.fn())

    expect(duplicateResponse.status).not.toHaveBeenCalled()
    expect(duplicateResponse.json).not.toHaveBeenCalled()
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

    expect(peer.toPeer).toHaveBeenCalledWith(expect.any(Array), SESSION_NONCE)
    expect(transport.openGeneralHandles.has(REQUEST_ID)).toBe(true)

    await transport.send({
      messageType: 'general',
      version: '1',
      identityKey: IDENTITY_KEY,
      nonce: 'AQ==',
      yourNonce: 'Ag==',
      signature: new Uint8Array([1]) as any,
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

  it('replaces an oversized authenticated response before signing', async () => {
    const peer = peerMock()
    const transport = new ExpressTransport(false, undefined, undefined, {
      maxResponseBytes: 64
    })
    transport.peer = peer
    const res = responseMock()

    ;(transport as any).setupAuthenticatedResponse(
      validGeneralRequest(),
      res,
      jest.fn(),
      IDENTITY_KEY,
      REQUEST_ID
    )

    res.json({ value: 'x'.repeat(1_024) })
    await flushPromises()

    const expectedBody = Utils.toArray(
      JSON.stringify({
        status: 'error',
        code: 'ERR_RESPONSE_TOO_LARGE',
        description: 'The requested response exceeds the configured service limit.'
      }),
      'utf8'
    )
    expect(peer.toPeer).toHaveBeenCalledWith(responsePayload(413, {}, expectedBody), SESSION_NONCE)
  })

  it('signs status and bound headers set through native response properties', async () => {
    const peer = peerMock()
    const transport = new ExpressTransport()
    transport.peer = peer
    const nativeHeaders: Record<string, string> = { 'x-bsv-direct': 'bound' }
    const res = Object.assign(responseMock(), {
      statusCode: 202,
      getHeaders: jest.fn(() => ({ ...nativeHeaders }))
    })

    ;(transport as any).setupAuthenticatedResponse(
      validGeneralRequest(),
      res,
      jest.fn(),
      IDENTITY_KEY,
      REQUEST_ID
    )
    await flushPromises()
    res.send('native state')
    await flushPromises()

    expect(peer.toPeer).toHaveBeenCalledWith(
      responsePayload(202, nativeHeaders, Utils.toArray('native state', 'utf8')),
      SESSION_NONCE
    )
  })

  it.each([
    ['value', { 'x-bsv-large': 'v'.repeat(512 * 1024) }],
    ['name', { ['x-bsv-' + 'a'.repeat(2042)]: 'v' }],
    [
      'count',
      Object.fromEntries(
        Array.from({ length: 1024 }, (_, i) => [`x-bsv-${String(i).padStart(4, '0')}`, 'v'])
      )
    ],
    [
      'aggregate',
      Object.fromEntries(
        Array.from({ length: 64 }, (_, i) => [
          `x-bsv-${String(i).padStart(2, '0')}`,
          'v'.repeat(32 * 1024)
        ])
      )
    ]
  ])('signs and restores headers above the former %s ceiling', async (_name, headers) => {
    const peer = peerMock()
    const transport = new ExpressTransport()
    transport.peer = peer
    const res = Object.assign(responseMock(), {
      statusCode: 200,
      getHeaders: jest.fn(() => ({ ...headers }))
    })
    const originalSend = res.send
    const originalSet = res.set
    ;(transport as any).setupAuthenticatedResponse(
      validGeneralRequest(),
      res,
      jest.fn(),
      IDENTITY_KEY,
      REQUEST_ID
    )
    res.send('capacity')
    await flushPromises()
    const payload = responsePayload(200, headers, Utils.toArray('capacity', 'utf8'))
    expect(peer.toPeer).toHaveBeenCalledWith(payload, SESSION_NONCE)
    await transport.send({
      messageType: 'general',
      version: '1',
      identityKey: IDENTITY_KEY,
      nonce: 'AQ==',
      yourNonce: 'Ag==',
      signature: [1],
      payload
    })
    for (const [key, value] of Object.entries(headers)) {
      expect(originalSet).toHaveBeenCalledWith(key, value)
    }
    expect(originalSend).toHaveBeenCalledWith(Buffer.from('capacity'))
    expect(transport.openGeneralHandles.size).toBe(0)
  })

  it('retains invalid-header rejection independently of header capacity', async () => {
    const peer = peerMock()
    const transport = new ExpressTransport()
    transport.peer = peer
    const res = Object.assign(responseMock(), {
      getHeaders: jest.fn(() => ({ 'x-bsv-invalid': 'injected\r\nheader' }))
    })
    const originalJson = res.json
    ;(transport as any).setupAuthenticatedResponse(
      validGeneralRequest(),
      res,
      jest.fn(),
      IDENTITY_KEY,
      REQUEST_ID
    )
    res.send('capacity')
    await flushPromises()
    expect(peer.toPeer).not.toHaveBeenCalled()
    expect(originalJson).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_RESPONSE_SIGNING_FAILED' })
    )
  })

  it('does not charge received payment headers against the request-body budget', async () => {
    const transport = new ExpressTransport(false, undefined, undefined, { maxRequestBytes: 128 })
    const peer = peerMock()
    transport.peer = peer
    const received = jest.fn()
    await transport.onData(async message => {
      received(message)
    })
    const req = validGeneralRequest()
    req.headers['x-bsv-payment'] = 'p'.repeat(1024 * 1024)
    const res = responseMock()
    await transport.handleIncomingRequest(req, res, jest.fn())
    await flushPromises()
    expect(res.status).not.toHaveBeenCalledWith(400)
    expect(received).toHaveBeenCalledTimes(1)
    const message = received.mock.calls[0][0]
    expect(message.payload.length).toBeGreaterThan(1024 * 1024)
    ;(transport as any).clearActiveGeneralRequest(REQUEST_ID)
  })

  it('buffers write, writeHead, flushHeaders, and end data into one signed response', async () => {
    const peer = peerMock()
    const transport = new ExpressTransport()
    transport.peer = peer
    const res = responseMock()
    const originalWrite = res.write
    const callback = jest.fn()

    ;(transport as any).setupAuthenticatedResponse(
      validGeneralRequest(),
      res,
      jest.fn(),
      IDENTITY_KEY,
      REQUEST_ID
    )
    await flushPromises()

    res.writeHead(206, { 'x-bsv-stream': 'bounded' })
    expect(res.flushHeaders()).toBeUndefined()
    expect(res.write('part-', callback)).toBe(true)
    res.end(Buffer.from('end'))
    await flushPromises()

    expect(callback).toHaveBeenCalledTimes(1)
    expect(originalWrite).not.toHaveBeenCalled()
    expect(peer.toPeer).toHaveBeenCalledWith(
      responsePayload(206, { 'x-bsv-stream': 'bounded' }, Utils.toArray('part-end', 'utf8')),
      SESSION_NONCE
    )
  })

  it('supports Node response overloads while validating encoded chunks and raw header arrays', async () => {
    const peer = peerMock()
    const transport = new ExpressTransport()
    transport.peer = peer
    const res = responseMock()
    const writeCallback = jest.fn()
    const endCallback = jest.fn()

    ;(transport as any).setupAuthenticatedResponse(
      validGeneralRequest(),
      res,
      jest.fn(),
      IDENTITY_KEY,
      REQUEST_ID
    )
    await flushPromises()

    expect(() => res.write({}, 'utf8')).toThrow('strings or byte arrays')
    expect(() => res.write('value', 'not-an-encoding')).toThrow('encoding is invalid')
    expect(() => res.writeHead(200, ['x-valid'])).toThrow('writeHead headers are malformed')

    res.writeHead(201, 'Created', ['x-bsv-first', 'one', 'x-bsv-number', 2])
    res.write(Buffer.from('hex', 'utf8'), writeCallback)
    res.end(endCallback)
    await flushPromises()

    expect(writeCallback).toHaveBeenCalledTimes(1)
    expect(endCallback).toHaveBeenCalledTimes(1)
    expect(peer.toPeer).toHaveBeenCalledWith(
      responsePayload(
        201,
        { 'x-bsv-first': 'one', 'x-bsv-number': '2' },
        Utils.toArray('hex', 'utf8')
      ),
      SESSION_NONCE
    )
  })

  it('contains optional logger failures while enforcing authentication', async () => {
    const logger = {
      log: (): never => {
        throw new Error('logger failure')
      },
      warn: (): never => {
        throw new Error('logger failure')
      }
    } as unknown as typeof console
    const transport = new ExpressTransport(false, logger, 'warn')
    transport.peer = peerMock()
    const res = responseMock()

    await expect(
      transport.handleIncomingRequest(
        { path: '/', headers: {}, method: 'GET' } as any,
        res,
        jest.fn()
      )
    ).resolves.toBeUndefined()
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it.each([false, true])(
    'reads and signs an authenticated file within the response limit (unlimited: %s)',
    async unlimited => {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), 'auth-express-file-'))
      const filePath = join(temporaryDirectory, 'response.bin')
      const contents = Buffer.from('bounded authenticated file')
      writeFileSync(filePath, contents)
      const { peer, signed } = peerWithSignedResponse()
      const transport = new ExpressTransport(false, undefined, undefined, {
        maxResponseBytes: unlimited ? -1 : contents.length
      })
      transport.peer = peer
      const res = responseMock()

      try {
        ;(transport as any).setupAuthenticatedResponse(
          validGeneralRequest(),
          res,
          jest.fn(),
          IDENTITY_KEY,
          REQUEST_ID
        )
        res.sendFile(filePath)
        await signed

        expect(peer.toPeer).toHaveBeenCalledWith(
          responsePayload(200, {}, Array.from(contents)),
          SESSION_NONCE
        )
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true })
      }
    }
  )

  it('preserves sendFile root confinement and blocks traversal before reading', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'auth-express-root-'))
    const publicRoot = join(temporaryDirectory, 'public')
    mkdirSync(publicRoot)
    writeFileSync(join(temporaryDirectory, 'secret.txt'), 'must not be disclosed')
    const transport = new ExpressTransport()
    const peer = peerMock()
    transport.peer = peer
    const res = responseMock()

    try {
      ;(transport as any).setupAuthenticatedResponse(
        validGeneralRequest(),
        res,
        jest.fn(),
        IDENTITY_KEY,
        REQUEST_ID
      )
      const error = await new Promise<Error>(resolve => {
        res.sendFile('../secret.txt', { root: publicRoot }, (failure?: Error) => {
          if (failure !== undefined) resolve(failure)
        })
      })

      expect((error as NodeJS.ErrnoException).code).toBe('EACCES')
      expect(peer.toPeer).not.toHaveBeenCalled()
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('blocks a sendFile symlink that resolves outside the configured root', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'auth-express-symlink-'))
    const publicRoot = join(temporaryDirectory, 'public')
    const outside = join(temporaryDirectory, 'outside.txt')
    mkdirSync(publicRoot)
    writeFileSync(outside, 'must not be disclosed')
    symlinkSync(outside, join(publicRoot, 'link.txt'))
    const transport = new ExpressTransport()
    transport.peer = peerMock()
    const res = responseMock()

    try {
      ;(transport as any).setupAuthenticatedResponse(
        validGeneralRequest(),
        res,
        jest.fn(),
        IDENTITY_KEY,
        REQUEST_ID
      )
      const error = await new Promise<Error>(resolve => {
        res.sendFile('link.txt', { root: publicRoot }, (failure?: Error) => {
          if (failure !== undefined) resolve(failure)
        })
      })

      expect((error as NodeJS.ErrnoException).code).toBe('EACCES')
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('blocks a non-dot symlink that resolves to a dotfile inside the root', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'auth-express-dot-symlink-'))
    const publicRoot = join(temporaryDirectory, 'public')
    mkdirSync(publicRoot)
    writeFileSync(join(publicRoot, '.secret'), 'must not be disclosed')
    symlinkSync(join(publicRoot, '.secret'), join(publicRoot, 'public.txt'))
    const transport = new ExpressTransport()
    transport.peer = peerMock()
    const res = responseMock()

    try {
      ;(transport as any).setupAuthenticatedResponse(
        validGeneralRequest(),
        res,
        jest.fn(),
        IDENTITY_KEY,
        REQUEST_ID
      )
      const error = await new Promise<Error>(resolve => {
        res.sendFile('public.txt', { root: publicRoot, dotfiles: 'deny' }, (failure?: Error) => {
          if (failure !== undefined) resolve(failure)
        })
      })

      expect((error as NodeJS.ErrnoException).code).toBe('EACCES')
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('serves a bounded relative file inside sendFile root with range and headers applied', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'auth-express-root-file-'))
    const contents = Buffer.from('0123456789')
    writeFileSync(join(temporaryDirectory, 'response.bin'), contents)
    const { peer, signed } = peerWithSignedResponse()
    const transport = new ExpressTransport()
    transport.peer = peer
    const res = responseMock()

    try {
      ;(transport as any).setupAuthenticatedResponse(
        validGeneralRequest(),
        res,
        jest.fn(),
        IDENTITY_KEY,
        REQUEST_ID
      )
      res.sendFile('response.bin', {
        root: temporaryDirectory,
        start: 2,
        end: 5,
        headers: { 'x-bsv-file': 'bounded' }
      })
      await signed

      expect(peer.toPeer).toHaveBeenCalledWith(
        responsePayload(200, { 'x-bsv-file': 'bounded' }, Array.from(contents.subarray(2, 6))),
        SESSION_NONCE
      )
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('stops an authenticated file read at the response limit and signs a 413', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'auth-express-file-'))
    const filePath = join(temporaryDirectory, 'oversized.bin')
    writeFileSync(filePath, Buffer.alloc(65, 7))
    const { peer, signed } = peerWithSignedResponse()
    const transport = new ExpressTransport(false, undefined, undefined, {
      maxResponseBytes: 64
    })
    transport.peer = peer
    const res = responseMock()

    try {
      ;(transport as any).setupAuthenticatedResponse(
        validGeneralRequest(),
        res,
        jest.fn(),
        IDENTITY_KEY,
        REQUEST_ID
      )
      res.sendFile(filePath)
      await signed

      const expectedBody = Utils.toArray(
        JSON.stringify({
          status: 'error',
          code: 'ERR_RESPONSE_TOO_LARGE',
          description: 'The requested response exceeds the configured service limit.'
        }),
        'utf8'
      )
      expect(peer.toPeer).toHaveBeenCalledWith(
        responsePayload(413, {}, expectedBody),
        SESSION_NONCE
      )
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('signs a 500 when an authenticated response file cannot be read', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'auth-express-file-'))
    const filePath = join(temporaryDirectory, 'missing.bin')
    const { peer, signed } = peerWithSignedResponse()
    const transport = new ExpressTransport()
    transport.peer = peer
    const res = responseMock()

    try {
      ;(transport as any).setupAuthenticatedResponse(
        validGeneralRequest(),
        res,
        jest.fn(),
        IDENTITY_KEY,
        REQUEST_ID
      )
      res.sendFile(filePath)
      await signed

      expect(peer.toPeer).toHaveBeenCalledWith(responsePayload(500, {}), SESSION_NONCE)
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('forwards authenticated response file errors to the sendFile callback overload', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'auth-express-file-'))
    const filePath = join(temporaryDirectory, 'missing.bin')
    const transport = new ExpressTransport()
    const peer = peerMock()
    transport.peer = peer
    const res = responseMock()

    try {
      ;(transport as any).setupAuthenticatedResponse(
        validGeneralRequest(),
        res,
        jest.fn(),
        IDENTITY_KEY,
        REQUEST_ID
      )
      const callbackError = new Promise<Error>(resolve => res.sendFile(filePath, resolve))

      await expect(callbackError).resolves.toHaveProperty('name', 'Error')
      expect(peer.toPeer).not.toHaveBeenCalled()
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
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

    expect(peer.toPeer).toHaveBeenCalledWith(
      responsePayload(200, {}, Utils.toArray('authenticated response', 'utf8')),
      SESSION_NONCE
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
    ;(res as any).__write = res.write
    ;(res as any).__writeHead = res.writeHead
    ;(res as any).__flushHeaders = res.flushHeaders
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
      toPeer: jest.fn().mockRejectedValue(new Error('wallet signing secret'))
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
    ;(res as any).__write = res.write
    ;(res as any).__writeHead = res.writeHead
    ;(res as any).__flushHeaders = res.flushHeaders
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
        messageType: 'initialResponse',
        signature: [1]
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

  it('does not write a second handshake response when peer processing rejects late', async () => {
    const transport = new ExpressTransport()
    transport.peer = peerMock()
    let rejectProcessing!: (error: Error) => void
    const processing = new Promise<void>((_resolve, reject) => {
      rejectProcessing = reject
    })
    const callback = jest.fn(async () => await processing)
    await transport.onData(callback)
    const res = responseMock()

    await transport.handleIncomingRequest(validHandshakeRequest(), res, jest.fn())
    await flushPromises()
    expect(callback).toHaveBeenCalledTimes(1)

    res.writableEnded = true
    rejectProcessing(new Error('late handshake processing failure'))
    await flushPromises()

    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })

  it('does not write a second general response when peer processing rejects late', async () => {
    const transport = new ExpressTransport()
    transport.peer = peerMock()
    let rejectProcessing!: (error: Error) => void
    const processing = new Promise<void>((_resolve, reject) => {
      rejectProcessing = reject
    })
    const callback = jest.fn(async () => await processing)
    await transport.onData(callback)
    const res = responseMock()

    await transport.handleIncomingRequest(validGeneralRequest(), res, jest.fn())
    await flushPromises()
    expect(callback).toHaveBeenCalledTimes(1)

    res.destroyed = true
    rejectProcessing(new Error('late general processing failure'))
    await flushPromises()

    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
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

  it('emits a traceparent-linked auth span without request secrets', async () => {
    const events: any[] = []
    const middleware = createAuthMiddleware({
      wallet: new MockWallet(new PrivateKey(1)),
      allowUnauthenticated: true,
      telemetry: {
        sink: {
          capture: event => events.push(event)
        },
        traceIdFactory: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        spanIdFactory: () => 'bbbbbbbbbbbbbbbb'
      }
    })
    const req = {
      path: '/private/customer-record',
      method: 'GET',
      headers: {
        authorization: 'Bearer never-report-this',
        traceparent: '00-0123456789abcdef0123456789abcdef-fedcba9876543210-01'
      }
    } as any
    const res = responseMock()
    const next = jest.fn()

    middleware(req, res, next)
    await new Promise(resolve => setImmediate(resolve))

    expect(next).toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'span',
      name: 'wallet.auth.middleware',
      traceId: '0123456789abcdef0123456789abcdef',
      parentSpanId: 'fedcba9876543210',
      spanStatus: 'ok',
      attributes: {
        'http.request.method': 'GET',
        'auth.handshake': false,
        'auth.signed_request': false,
        'auth.disposition': 'continued'
      }
    })
    expect(JSON.stringify(events)).not.toContain('customer-record')
    expect(JSON.stringify(events)).not.toContain('never-report-this')
  })

  it('reports middleware errors and response completion without changing next semantics', async () => {
    const events: any[] = []
    const telemetry = {
      sink: { capture: (event: unknown) => events.push(event) },
      traceIdFactory: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      spanIdFactory: () => 'bbbbbbbbbbbbbbbb'
    }
    const handleIncomingRequest = jest.spyOn(ExpressTransport.prototype, 'handleIncomingRequest')

    handleIncomingRequest.mockImplementationOnce(async (_req, _res, next) => {
      next(new Error('continued with error'))
    })
    const continued = createAuthMiddleware({
      wallet: new MockWallet(new PrivateKey(1)),
      allowUnauthenticated: true,
      telemetry
    })
    const continuedNext = jest.fn()
    continued(
      {
        path: '/public',
        method: 'GET',
        headers: {
          traceparent: `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`
        }
      } as any,
      responseMock(),
      continuedNext
    )
    await flushPromises()
    expect(continuedNext).toHaveBeenCalledWith(expect.any(Error))
    expect(events.at(-1)).toMatchObject({
      spanStatus: 'error',
      attributes: { 'auth.disposition': 'continued' }
    })

    handleIncomingRequest.mockRejectedValueOnce(new Error('transport failed'))
    const rejected = createAuthMiddleware({
      wallet: new MockWallet(new PrivateKey(1)),
      allowUnauthenticated: true,
      telemetry
    })
    const rejectedNext = jest.fn()
    rejected(
      {
        path: '/public',
        method: 'GET',
        headers: { traceparent: 'not-a-traceparent' }
      } as any,
      responseMock(),
      rejectedNext
    )
    await flushPromises()
    expect(rejectedNext).toHaveBeenCalledWith(expect.any(Error))
    expect(events.at(-1)).toMatchObject({
      spanStatus: 'error',
      attributes: { 'auth.disposition': 'middleware_error' }
    })

    handleIncomingRequest.mockReturnValue(new Promise(() => {}))
    const pending = createAuthMiddleware({
      wallet: new MockWallet(new PrivateKey(1)),
      allowUnauthenticated: true,
      telemetry
    })
    for (const [statusCode, writableEnded, eventName, status, traceparent] of [
      [503, true, 'finish', 'error', 'x'.repeat(129)],
      [200, true, 'finish', 'ok', undefined],
      [200, true, 'close', 'ok', `00-0123456789abcdef0123456789abcdef-${'0'.repeat(16)}-01`],
      [200, false, 'close', 'cancelled', undefined]
    ] as const) {
      const res = responseMock()
      res.statusCode = statusCode
      res.writableEnded = writableEnded
      pending(
        {
          path: '/public',
          method: 'GET',
          headers: traceparent === undefined ? {} : { traceparent }
        } as any,
        res,
        jest.fn()
      )
      const callback = res.once.mock.calls.find(([name]: [string]) => name === eventName)?.[1]
      callback()
      callback()
      expect(events.at(-1)).toMatchObject({
        spanStatus: status,
        attributes: {
          'auth.disposition': eventName === 'finish' ? 'responded' : 'connection_closed',
          'http.response.status_code': statusCode
        }
      })
    }

    handleIncomingRequest.mockRestore()
  })

  it('enforces structural depth even when request byte accounting is delegated', async () => {
    const peer = peerMock()
    const transport = new ExpressTransport(false, undefined, undefined, {
      maxRequestBytes: -1
    })
    transport.peer = peer
    const body = validHandshakeRequest().body
    let cursor = body as Record<string, unknown>
    for (let index = 0; index < 66; index += 1) {
      const child: Record<string, unknown> = {}
      cursor.child = child
      cursor = child
    }
    const res = responseMock()

    await transport.handleIncomingRequest(validHandshakeRequest({ body }), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(peer.toPeer).not.toHaveBeenCalled()
  })

  it('rejects invalid methods and encoded bodies that exceed the post-serialization limit', async () => {
    for (const [method, maxRequestBytes] of [
      ['lowercase', -1],
      ['POST', 64]
    ] as const) {
      const peer = peerMock()
      const transport = new ExpressTransport(false, undefined, undefined, { maxRequestBytes })
      transport.peer = peer
      const res = responseMock()

      await transport.handleIncomingRequest(
        validGeneralRequest({ method, body: { value: '\u0001'.repeat(20) } }),
        res,
        jest.fn()
      )

      expect(res.status).toHaveBeenCalledWith(400)
      expect(peer.listenForGeneralMessages).not.toHaveBeenCalled()
    }
  })

  it('validates the injected certificate approval store contract', () => {
    expect(() => new ExpressTransport(false, undefined, undefined, {}, null as never)).toThrow(
      'certificateApprovalStore'
    )
    expect(
      () => new ExpressTransport(false, undefined, undefined, {}, { approve: jest.fn() } as never)
    ).toThrow('certificateApprovalStore')
  })

  it('reports every invalid authenticated sendFile option through callback or next', () => {
    const transport = new ExpressTransport()
    transport.peer = peerMock()
    const res = responseMock()
    const next = jest.fn()
    ;(transport as any).setupAuthenticatedResponse(
      validGeneralRequest(),
      res,
      next,
      IDENTITY_KEY,
      REQUEST_ID
    )

    res.sendFile('')
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('path argument') })
    )

    for (const [filePath, options, message] of [
      ['relative.txt', undefined, 'path must be absolute'],
      ['/tmp/file.txt', { root: 7 }, 'root must be a string'],
      ['/tmp/file.txt', { dotfiles: 'sometimes' }, 'dotfiles must be'],
      ['/tmp/file.txt', { start: -1 }, 'start must be'],
      ['/tmp/file.txt', { end: 1.5 }, 'end must be'],
      ['/tmp/file.txt', { start: 2, end: 1 }, 'end must not be before start'],
      ['/tmp/file.txt', { headers: null }, 'headers must be an object'],
      ['/tmp/file.txt', { headers: [] }, 'headers must be an object']
    ] as const) {
      const callback = jest.fn()
      res.sendFile(filePath, options, callback)
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining(message) })
      )
    }
  })

  it.each(['deny', 'ignore'] as const)(
    'applies the authenticated sendFile %s policy to direct dotfile paths',
    async dotfiles => {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), 'auth-express-dotfile-'))
      const filePath = join(temporaryDirectory, '.secret')
      writeFileSync(filePath, 'secret')
      const transport = new ExpressTransport()
      transport.peer = peerMock()
      const res = responseMock()

      try {
        ;(transport as any).setupAuthenticatedResponse(
          validGeneralRequest(),
          res,
          jest.fn(),
          IDENTITY_KEY,
          REQUEST_ID
        )
        const error = await new Promise<NodeJS.ErrnoException>(resolve => {
          res.sendFile(filePath, { dotfiles }, resolve)
        })

        expect(error.code).toBe(dotfiles === 'deny' ? 'EACCES' : 'ENOENT')
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true })
      }
    }
  )

  it('reports realpath failures for missing roots and candidates', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'auth-express-realpath-'))
    const transport = new ExpressTransport()
    transport.peer = peerMock()
    const res = responseMock()
    ;(transport as any).setupAuthenticatedResponse(
      validGeneralRequest(),
      res,
      jest.fn(),
      IDENTITY_KEY,
      REQUEST_ID
    )

    try {
      for (const [root, filePath] of [
        [join(temporaryDirectory, 'missing-root'), 'file.txt'],
        [temporaryDirectory, 'missing-file.txt']
      ]) {
        const error = await new Promise<NodeJS.ErrnoException>(resolve => {
          res.sendFile(filePath, { root }, resolve)
        })
        expect(error.code).toBe('ENOENT')
      }
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('captures native header variants and supports the end encoding-callback overload', async () => {
    const { peer, signed } = peerWithSignedResponse()
    const transport = new ExpressTransport()
    transport.peer = peer
    const res = Object.assign(responseMock(), {
      statusCode: 202,
      getHeaders: jest.fn(() => ({
        'x-bsv-native': ['one', 'two'],
        'x-undefined': undefined
      }))
    })
    res.status.mockImplementation((statusCode: number) => {
      res.statusCode = statusCode
      return res
    })
    const callback = jest.fn()
    ;(transport as any).setupAuthenticatedResponse(
      validGeneralRequest(),
      res,
      jest.fn(),
      IDENTITY_KEY,
      REQUEST_ID
    )

    res.writeHead(203, 'Accepted', {
      'x-bsv-written': ['three', 'four'],
      'x-undefined': undefined
    })
    res.end('ok', callback)
    await signed
    await flushPromises()

    expect(callback).toHaveBeenCalledTimes(1)
    expect(peer.toPeer).toHaveBeenCalledWith(
      responsePayload(
        203,
        { 'x-bsv-native': 'one, two', 'x-bsv-written': 'three, four' },
        Utils.toArray('ok', 'utf8')
      ),
      SESSION_NONCE
    )
  })

  it('uses the binary fallback MIME type for an authenticated file with an unknown extension', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'auth-express-mime-'))
    const filePath = join(temporaryDirectory, 'response.unknown-extension-for-test')
    writeFileSync(filePath, 'binary')
    const { peer, signed } = peerWithSignedResponse()
    const transport = new ExpressTransport()
    transport.peer = peer
    const res = responseMock()

    try {
      ;(transport as any).setupAuthenticatedResponse(
        validGeneralRequest(),
        res,
        jest.fn(),
        IDENTITY_KEY,
        REQUEST_ID
      )
      res.sendFile(filePath)
      await signed

      expect(peer.toPeer).toHaveBeenCalledWith(
        responsePayload(200, {}, Utils.toArray('binary', 'utf8')),
        SESSION_NONCE
      )
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
