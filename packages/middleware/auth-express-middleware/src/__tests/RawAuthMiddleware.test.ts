import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { PrivateKey } from '@bsv/sdk'
import type { NextFunction, Response } from 'express'
import { createAuthMiddleware, ExpressTransport, type AuthRequest } from '../index.js'
import { RawRequestBodyError } from '../rawRequestBody.js'
import { MockWallet } from './MockWallet.js'

const identityKey = new PrivateKey(1).toPublicKey().toString()

function request(headers: Record<string, string> = {}, path = '/paid') {
  return Object.assign(new PassThrough(), { headers, path, method: 'POST', body: undefined })
}

function response() {
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    destroyed: false,
    setHeader: jest.fn(),
    status: jest.fn(),
    json: jest.fn()
  })
  res.status.mockReturnValue(res)
  res.json.mockReturnValue(res)
  return res
}

async function flush() {
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('raw authentication middleware composition', () => {
  afterEach(() => jest.restoreAllMocks())

  it('rejects a truthy non-boolean raw-capture option', () => {
    expect(() =>
      createAuthMiddleware({
        wallet: new MockWallet(new PrivateKey(1)),
        captureRawBody: 'true' as unknown as boolean
      })
    ).toThrow('captureRawBody must be a boolean')
  })

  it('preserves exact bytes until verification completes, then decodes and advertises support', async () => {
    let verified!: NextFunction
    const transport = jest
      .spyOn(ExpressTransport.prototype, 'handleIncomingRequest')
      .mockImplementation(async (req, _res, next) => {
        expect(req.body).toEqual(Buffer.from(' { "message": "hello ☃" }\n'))
        expect(req.rawBody).toBeUndefined()
        expect(req.auth).toBeUndefined()
        verified = next
      })
    const middleware = createAuthMiddleware({
      wallet: new MockWallet(new PrivateKey(1)),
      captureRawBody: true
    })
    const req = request({ 'content-type': 'application/json' })
    const res = response()
    const next = jest.fn()
    middleware(req as unknown as AuthRequest, res as unknown as Response, next)
    req.end(Buffer.from(' { "message": "hello ☃" }\n'))
    await flush()
    expect(transport).toHaveBeenCalledTimes(1)
    expect(next).not.toHaveBeenCalled()
    const authRequest = req as unknown as AuthRequest
    authRequest.auth = { identityKey }
    verified()
    expect(next).toHaveBeenCalledWith()
    expect(authRequest.body).toEqual({ message: 'hello ☃' })
    expect(authRequest.rawBody).toEqual(Buffer.from(' { "message": "hello ☃" }\n'))
    expect(authRequest.auth).toEqual({ identityKey, supportsMultipart: true })
    res.emit('finish')
  })

  it.each([undefined, 'unknown'])(
    'never advertises verified support for identity %s',
    async identity => {
      jest
        .spyOn(ExpressTransport.prototype, 'handleIncomingRequest')
        .mockImplementation(async (req, _res, next) => {
          if (identity !== undefined) req.auth = { identityKey: identity }
          next()
        })
      const middleware = createAuthMiddleware({
        wallet: new MockWallet(new PrivateKey(1)),
        captureRawBody: true
      })
      const req = request({ 'content-type': 'text/plain' })
      const res = response()
      const next = jest.fn()
      middleware(req as unknown as AuthRequest, res as unknown as Response, next)
      req.end(Buffer.from('public body'))
      await flush()
      expect(next).toHaveBeenCalledWith()
      expect(req.body).toBe('public body')
      expect((req as unknown as AuthRequest).auth?.supportsMultipart).toBeUndefined()
      res.emit('finish')
    }
  )

  it.each([
    [
      'multipart/form-data; boundary="outer"',
      Buffer.from('--outer\r\nopaque payload\r\n--outer--\r\n')
    ],
    ['application/octet-stream', Buffer.from([0, 255, 1])],
    [undefined, Buffer.from([0, 255, 1])],
    [undefined, undefined]
  ])('retains an opaque or absent body for %s (case %#)', async (contentType, bytes) => {
    jest
      .spyOn(ExpressTransport.prototype, 'handleIncomingRequest')
      .mockImplementation(async (req, _res, next) => {
        req.auth = { identityKey }
        next()
      })
    const middleware = createAuthMiddleware({
      wallet: new MockWallet(new PrivateKey(1)),
      captureRawBody: true
    })
    const req = request(contentType === undefined ? {} : { 'content-type': contentType as string })
    const res = response()
    const next = jest.fn()
    middleware(req as unknown as AuthRequest, res as unknown as Response, next)
    req.end(bytes)
    await flush()
    expect(next).toHaveBeenCalledWith()
    expect(req.body).toEqual(bytes)
    expect((req as unknown as AuthRequest).rawBody).toEqual(bytes)
    res.emit('finish')
  })

  it('applies configured raw-byte limits before authentication or application dispatch', async () => {
    const transport = jest.spyOn(ExpressTransport.prototype, 'handleIncomingRequest')
    const middleware = createAuthMiddleware({
      wallet: new MockWallet(new PrivateKey(1)),
      captureRawBody: true,
      transportLimits: { maxRequestBytes: 3, requestTimeoutMs: 100, maxPendingRequests: 1 }
    })
    const req = request({ 'content-length': '4' })
    const res = response()
    const next = jest.fn()
    middleware(req as unknown as AuthRequest, res as unknown as Response, next)
    await flush()
    expect(transport).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(413)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ERR_AUTH_BODY' }))
    expect((req as unknown as AuthRequest).auth).toBeUndefined()
    req.destroy()
  })

  it('rejects malformed authenticated JSON before calling the application', async () => {
    jest
      .spyOn(ExpressTransport.prototype, 'handleIncomingRequest')
      .mockImplementation(async (req, _res, next) => {
        req.auth = { identityKey }
        next()
      })
    const middleware = createAuthMiddleware({
      wallet: new MockWallet(new PrivateKey(1)),
      captureRawBody: true
    })
    const req = request({ 'content-type': 'application/json' })
    const res = response()
    const next = jest.fn()
    middleware(req as unknown as AuthRequest, res as unknown as Response, next)
    req.end(Buffer.from('{'))
    await flush()
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ERR_AUTH_MALFORMED' }))
    res.emit('finish')
  })

  it('decodes the bounded handshake envelope without marking it as an application payload', async () => {
    const transport = jest
      .spyOn(ExpressTransport.prototype, 'handleIncomingRequest')
      .mockImplementation(async (req, _res, next) => {
        expect(req.body).toEqual({ messageType: 'initialRequest' })
        next()
      })
    const middleware = createAuthMiddleware({
      wallet: new MockWallet(new PrivateKey(1)),
      captureRawBody: true
    })
    const req = request({ 'content-type': 'application/json' }, '/.well-known/auth')
    const res = response()
    const next = jest.fn()
    middleware(req as unknown as AuthRequest, res as unknown as Response, next)
    req.end(Buffer.from('{"messageType":"initialRequest"}'))
    await flush()
    expect(transport).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith()
    expect((req as unknown as AuthRequest).rawBody).toBeUndefined()
    expect((req as unknown as AuthRequest).auth).toBeUndefined()
    res.emit('finish')
  })

  it('forwards failed verification without decoding bytes or granting capability', async () => {
    const failure = new Error('signature rejected')
    jest
      .spyOn(ExpressTransport.prototype, 'handleIncomingRequest')
      .mockImplementation(async (_req, _res, next) => next(failure))
    const middleware = createAuthMiddleware({
      wallet: new MockWallet(new PrivateKey(1)),
      captureRawBody: true
    })
    const req = request({ 'content-type': 'application/json' })
    const res = response()
    const next = jest.fn()
    middleware(req as unknown as AuthRequest, res as unknown as Response, next)
    req.end(Buffer.from('{"private":true}'))
    await flush()
    expect(next).toHaveBeenCalledWith(failure)
    expect(req.body).toEqual(Buffer.from('{"private":true}'))
    expect((req as unknown as AuthRequest).rawBody).toBeUndefined()
    expect((req as unknown as AuthRequest).auth).toBeUndefined()
    res.emit('finish')
  })

  it.each(['open', 'sent', 'destroyed'] as const)(
    'handles raw-body refusal with a %s response',
    async state => {
      const transport = jest.spyOn(ExpressTransport.prototype, 'handleIncomingRequest')
      const middleware = createAuthMiddleware({
        wallet: new MockWallet(new PrivateKey(1)),
        captureRawBody: true
      })
      const req = request({ 'content-encoding': 'gzip' })
      const res = response()
      res.headersSent = state === 'sent'
      res.destroyed = state === 'destroyed'
      const next = jest.fn()
      middleware(req as unknown as AuthRequest, res as unknown as Response, next)
      await flush()
      expect(transport).not.toHaveBeenCalled()
      if (state === 'open') {
        expect(next).not.toHaveBeenCalled()
        expect(res.setHeader).toHaveBeenCalledWith('Connection', 'close')
        expect(res.status).toHaveBeenCalledWith(415)
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ERR_AUTH_BODY' }))
      } else {
        expect(next).toHaveBeenCalledWith(expect.any(RawRequestBodyError))
        expect(res.json).not.toHaveBeenCalled()
        expect(res.setHeader).not.toHaveBeenCalled()
      }
      req.destroy()
    }
  )
})
