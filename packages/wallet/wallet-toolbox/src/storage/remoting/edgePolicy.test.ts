import express from 'express'
import type { Server } from 'node:http'
import {
  bodyParserErrorHandler,
  concurrencyLimit,
  configureHttpServer,
  corsPolicy,
  initialDoubleSlashCompatibility,
  profileValue,
  readAllowedOrigins,
  readBodyLimitBytes,
  readCorsOriginSetting,
  readResourceLimit,
  readResourceProfile,
  responseSizeLimit,
  securityHeaders
} from './edgePolicy'

async function listen(app: express.Express): Promise<{
  server: Server
  origin: string
}> {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('Expected TCP listener')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error != null) reject(error)
      else resolve()
    })
  })
}

describe('shared service edge policy', () => {
  const originalEnvironment = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnvironment }
  })

  it('keeps public protocol APIs browser-accessible by default', async () => {
    delete process.env.TEST_CORS_MODE
    delete process.env.TEST_CORS_ALLOWED_ORIGINS
    delete process.env.CORS_MODE
    delete process.env.CORS_ALLOWED_ORIGINS
    const app = express()
    app.use(
      corsPolicy({
        environmentPrefix: 'TEST',
        methods: ['GET', 'POST']
      })
    )
    app.get('/', (_req, res) => res.json({ ok: true }))
    const { server, origin } = await listen(app)

    try {
      const response = await fetch(origin, {
        headers: { Origin: 'https://previously-unknown-app.example' }
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('access-control-allow-credentials')).toBeNull()

      const opaqueOrigin = await fetch(origin, {
        headers: { Origin: 'null' }
      })
      expect(opaqueOrigin.status).toBe(200)
      expect(opaqueOrigin.headers.get('access-control-allow-origin')).toBe('*')

      const preflight = await fetch(origin, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://another-unknown-app.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'X-BSV-Action-Batch-Encoding'
        }
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
      expect(preflight.headers.get('access-control-allow-headers')).toContain(
        'X-BSV-Action-Batch-Encoding'
      )
    } finally {
      await close(server)
    }
  })

  it('allows only explicitly configured browser origins', async () => {
    process.env.TEST_CORS_ALLOWED_ORIGINS = 'https://wallet.example'
    const app = express()
    app.use(
      corsPolicy({
        environmentPrefix: 'TEST',
        methods: ['GET', 'POST']
      })
    )
    app.get('/', (_req, res) => res.json({ ok: true }))
    const { server, origin } = await listen(app)

    try {
      const allowed = await fetch(origin, {
        headers: { Origin: 'https://wallet.example' }
      })
      expect(allowed.status).toBe(200)
      expect(allowed.headers.get('access-control-allow-origin')).toBe('https://wallet.example')
      expect(allowed.headers.get('vary')).toContain('Origin')

      const denied = await fetch(origin, {
        headers: { Origin: 'https://attacker.example' }
      })
      expect(denied.status).toBe(403)
      await expect(denied.json()).resolves.toMatchObject({
        code: 'ERR_ORIGIN_NOT_ALLOWED'
      })

      const sameOrigin = await fetch(origin)
      expect(sameOrigin.status).toBe(200)
      expect(sameOrigin.headers.get('access-control-allow-origin')).toBeNull()
    } finally {
      await close(server)
    }
  })

  it('supports an explicit cross-origin disabled mode', async () => {
    process.env.TEST_CORS_MODE = 'disabled'
    delete process.env.TEST_CORS_ALLOWED_ORIGINS
    delete process.env.CORS_ALLOWED_ORIGINS
    const app = express()
    app.use(
      corsPolicy({
        environmentPrefix: 'TEST',
        methods: ['GET']
      })
    )
    app.get('/', (_req, res) => res.json({ ok: true }))
    const { server, origin } = await listen(app)

    try {
      const denied = await fetch(origin, {
        headers: { Origin: 'https://app.example' }
      })
      expect(denied.status).toBe(403)
      const sameOrigin = await fetch(origin)
      expect(sameOrigin.status).toBe(200)
    } finally {
      await close(server)
    }
  })

  it('answers allowed preflight without wildcard policy', async () => {
    process.env.TEST_CORS_ALLOWED_ORIGINS = 'https://wallet.example'
    const app = express()
    app.use(
      corsPolicy({
        environmentPrefix: 'TEST',
        methods: ['GET', 'POST']
      })
    )
    const { server, origin } = await listen(app)

    try {
      const response = await fetch(origin, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://wallet.example',
          'Access-Control-Request-Method': 'POST'
        }
      })
      expect(response.status).toBe(204)
      expect(response.headers.get('access-control-allow-origin')).toBe('https://wallet.example')
      expect(response.headers.get('access-control-allow-headers')).not.toContain('*')
    } finally {
      await close(server)
    }
  })

  it('rejects wildcard and malformed origin configuration', () => {
    process.env.TEST_CORS_ALLOWED_ORIGINS = '*'
    expect(() =>
      corsPolicy({
        environmentPrefix: 'TEST',
        methods: ['GET']
      })
    ).toThrow(/wildcard/)

    process.env.TEST_CORS_ALLOWED_ORIGINS = 'https://wallet.example/path'
    expect(() =>
      corsPolicy({
        environmentPrefix: 'TEST',
        methods: ['GET']
      })
    ).toThrow(/without paths/)
  })

  it('validates the complete CORS mode configuration matrix', () => {
    process.env.TEST_CORS_MODE = 'invalid'
    expect(() => readCorsOriginSetting('TEST')).toThrow(/public, allowlist, or disabled/)

    process.env.TEST_CORS_MODE = 'allowlist'
    delete process.env.TEST_CORS_ALLOWED_ORIGINS
    delete process.env.CORS_ALLOWED_ORIGINS
    expect(() => readCorsOriginSetting('TEST')).toThrow(/must list at least one/)

    process.env.TEST_CORS_MODE = 'public'
    process.env.TEST_CORS_ALLOWED_ORIGINS = 'https://wallet.example'
    expect(() => readCorsOriginSetting('TEST')).toThrow(/must be empty/)

    process.env.TEST_CORS_MODE = 'disabled'
    delete process.env.TEST_CORS_ALLOWED_ORIGINS
    expect(readCorsOriginSetting('TEST')).toEqual([])

    process.env.TEST_CORS_MODE = 'allowlist'
    process.env.TEST_CORS_ALLOWED_ORIGINS =
      'https://wallet.example, https://wallet.example, https://wui.example'
    expect(readAllowedOrigins('TEST')).toEqual(['https://wallet.example', 'https://wui.example'])
    expect(readCorsOriginSetting('TEST')).toEqual(['https://wallet.example', 'https://wui.example'])

    delete process.env.TEST_CORS_MODE
    delete process.env.TEST_CORS_ALLOWED_ORIGINS
    expect(readCorsOriginSetting('TEST')).toBe('*')
  })

  it('validates explicit origin and credential options', () => {
    expect(() =>
      corsPolicy({
        environmentPrefix: 'TEST',
        methods: ['GET'],
        allowedOrigins: ['null']
      })
    ).toThrow(/opaque/)
    expect(() =>
      corsPolicy({
        environmentPrefix: 'TEST',
        methods: ['GET'],
        allowedOrigins: ['not an origin']
      })
    ).toThrow(/invalid origin/)
    expect(() =>
      corsPolicy({
        environmentPrefix: 'TEST',
        methods: ['GET'],
        allowCredentials: true
      })
    ).toThrow(/cookie credentials/)

    const disabled = corsPolicy({
      environmentPrefix: 'TEST',
      methods: ['GET'],
      allowedOrigins: []
    })
    const status = jest.fn().mockReturnThis()
    const json = jest.fn()
    disabled(
      { get: () => 'https://wallet.example', method: 'GET' } as any,
      { status, json } as any,
      jest.fn()
    )
    expect(status).toHaveBeenCalledWith(403)
  })

  it('rejects malformed caller origins and supports credentialed exact origins', () => {
    const middleware = corsPolicy({
      environmentPrefix: 'TEST',
      methods: ['get', 'GET', 'post'],
      allowedOrigins: ['https://wallet.example'],
      allowedHeaders: ['Authorization'],
      exposedHeaders: ['ETag'],
      allowCredentials: true,
      maxAgeSeconds: 60
    })
    const malformed = {
      get: () => 'not an origin',
      method: 'GET'
    }
    const malformedResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    }
    middleware(malformed as any, malformedResponse as any, jest.fn())
    expect(malformedResponse.status).toHaveBeenCalledWith(403)

    const headers = new Map<string, string | string[]>()
    headers.set('Vary', ['Accept-Encoding'])
    const response = {
      getHeader: (name: string) => headers.get(name),
      setHeader: (name: string, value: string | string[]) => headers.set(name, value),
      sendStatus: jest.fn()
    }
    const next = jest.fn()
    middleware({ get: () => 'https://wallet.example', method: 'GET' } as any, response as any, next)
    expect(headers.get('Vary')).toBe('Accept-Encoding, Origin')
    expect(headers.get('Access-Control-Allow-Origin')).toBe('https://wallet.example')
    expect(headers.get('Access-Control-Allow-Credentials')).toBe('true')
    expect(headers.get('Access-Control-Allow-Methods')).toBe('GET, POST')
    expect(headers.get('Access-Control-Max-Age')).toBe('60')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('gives service-specific CORS settings precedence over global fallbacks', async () => {
    process.env.CORS_MODE = 'public'
    process.env.CORS_ALLOWED_ORIGINS = ''
    process.env.TEST_CORS_MODE = 'allowlist'
    process.env.TEST_CORS_ALLOWED_ORIGINS = 'https://wallet.example'
    const app = express()
    app.use(
      corsPolicy({
        environmentPrefix: 'TEST',
        methods: ['GET']
      })
    )
    app.get('/', (_req, res) => res.json({ ok: true }))
    const { server, origin } = await listen(app)

    try {
      const allowed = await fetch(origin, {
        headers: { Origin: 'https://wallet.example' }
      })
      expect(allowed.status).toBe(200)
      expect(allowed.headers.get('access-control-allow-origin')).toBe('https://wallet.example')
    } finally {
      await close(server)
    }
  })

  it('sets the API security-header baseline', async () => {
    const app = express()
    app.use(securityHeaders())
    app.get('/', (_req, res) => res.json({ ok: true }))
    const { server, origin } = await listen(app)

    try {
      const response = await fetch(origin)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('x-frame-options')).toBe('DENY')
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
      expect(response.headers.get('permissions-policy')).toContain('camera=()')
      expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
      expect(response.headers.get('strict-transport-security')).toBeNull()
    } finally {
      await close(server)
    }
  })

  it('supports deployment-specific browser security headers', async () => {
    process.env.TEST_CONTENT_SECURITY_POLICY = "default-src 'self'"
    process.env.TEST_CROSS_ORIGIN_RESOURCE_POLICY = 'same-site'
    process.env.TEST_CROSS_ORIGIN_OPENER_POLICY = 'same-origin-allow-popups'
    process.env.TEST_FRAME_OPTIONS = 'disabled'
    process.env.TEST_PERMISSIONS_POLICY = 'camera=(self)'
    process.env.TEST_STRICT_TRANSPORT_SECURITY = 'false'
    const app = express()
    app.enable('trust proxy')
    app.use(
      securityHeaders({
        environmentPrefix: 'TEST',
        contentSecurityPolicy: "default-src 'none'",
        crossOriginResourcePolicy: 'same-origin',
        crossOriginOpenerPolicy: 'same-origin',
        frameOptions: 'DENY',
        permissionsPolicy: 'camera=()',
        strictTransportSecurity: true
      })
    )
    app.get('/', (_req, res) => res.json({ ok: true }))
    const { server, origin } = await listen(app)

    try {
      const response = await fetch(origin, {
        headers: { 'X-Forwarded-Proto': 'https' }
      })
      expect(response.headers.get('content-security-policy')).toBe("default-src 'self'")
      expect(response.headers.get('cross-origin-resource-policy')).toBe('same-site')
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups')
      expect(response.headers.get('x-frame-options')).toBeNull()
      expect(response.headers.get('permissions-policy')).toBe('camera=(self)')
      expect(response.headers.get('strict-transport-security')).toBeNull()
    } finally {
      await close(server)
    }
  })

  it('keeps CORS accessibility independent from CSP configuration', async () => {
    process.env.TEST_CONTENT_SECURITY_POLICY = "default-src 'self'; connect-src https:"
    delete process.env.TEST_CORS_MODE
    delete process.env.TEST_CORS_ALLOWED_ORIGINS
    const app = express()
    app.use(securityHeaders({ environmentPrefix: 'TEST' }))
    app.use(
      corsPolicy({
        environmentPrefix: 'TEST',
        methods: ['GET']
      })
    )
    app.get('/', (_req, res) => res.json({ ok: true }))
    const { server, origin } = await listen(app)

    try {
      const response = await fetch(origin, {
        headers: { Origin: 'https://unknown-deployed-app.example' }
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('access-control-allow-credentials')).toBeNull()
      expect(response.headers.get('content-security-policy')).toBe(
        "default-src 'self'; connect-src https:"
      )
    } finally {
      await close(server)
    }
  })

  it('does not trust a raw forwarded-proto header for HSTS', async () => {
    const app = express()
    app.use(securityHeaders())
    app.get('/', (_req, res) => res.json({ ok: true }))
    const { server, origin } = await listen(app)

    try {
      const response = await fetch(origin, {
        headers: { 'X-Forwarded-Proto': 'https' }
      })
      expect(response.headers.get('strict-transport-security')).toBeNull()
    } finally {
      await close(server)
    }
  })

  it('sets HSTS only for a trusted secure request and can disable browser headers', async () => {
    const secureApp = express()
    secureApp.enable('trust proxy')
    secureApp.use(securityHeaders())
    secureApp.get('/', (_req, res) => res.json({ ok: true }))
    const secureListener = await listen(secureApp)

    process.env.TEST_CONTENT_SECURITY_POLICY = 'disabled'
    process.env.TEST_CROSS_ORIGIN_RESOURCE_POLICY = 'disabled'
    process.env.TEST_CROSS_ORIGIN_OPENER_POLICY = 'disabled'
    process.env.TEST_FRAME_OPTIONS = 'disabled'
    process.env.TEST_PERMISSIONS_POLICY = 'disabled'
    const disabledApp = express()
    disabledApp.use(securityHeaders({ environmentPrefix: 'TEST' }))
    disabledApp.get('/', (_req, res) => res.json({ ok: true }))
    const disabledListener = await listen(disabledApp)

    try {
      const secure = await fetch(secureListener.origin, {
        headers: { 'X-Forwarded-Proto': 'https' }
      })
      expect(secure.headers.get('strict-transport-security')).toContain('max-age=')

      const disabled = await fetch(disabledListener.origin)
      expect(disabled.headers.get('content-security-policy')).toBeNull()
      expect(disabled.headers.get('cross-origin-resource-policy')).toBeNull()
      expect(disabled.headers.get('cross-origin-opener-policy')).toBeNull()
      expect(disabled.headers.get('x-frame-options')).toBeNull()
      expect(disabled.headers.get('permissions-policy')).toBeNull()
    } finally {
      await close(secureListener.server)
      await close(disabledListener.server)
    }
  })

  it('rejects unsafe or invalid security-header configuration', () => {
    process.env.TEST_CONTENT_SECURITY_POLICY = "default-src 'none'\nX-Injected: yes"
    expect(() => securityHeaders({ environmentPrefix: 'TEST' })).toThrow(/single-line/)

    process.env.TEST_CONTENT_SECURITY_POLICY = "default-src 'none'"
    process.env.TEST_FRAME_OPTIONS = 'ALLOW-FROM https://example.com'
    expect(() => securityHeaders({ environmentPrefix: 'TEST' })).toThrow(/DENY, SAMEORIGIN/)

    process.env.TEST_FRAME_OPTIONS = 'DENY'
    process.env.TEST_STRICT_TRANSPORT_SECURITY = 'sometimes'
    expect(() => securityHeaders({ environmentPrefix: 'TEST' })).toThrow(/true or false/)
  })

  it('returns stable body-parser errors without leaking parser details', async () => {
    const app = express()
    app.use(express.json({ limit: 8 }))
    app.use(bodyParserErrorHandler)
    app.post('/', (_req, res) => res.json({ ok: true }))
    const { server, origin } = await listen(app)

    try {
      const tooLarge = await fetch(origin, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'too large' })
      })
      expect(tooLarge.status).toBe(413)
      await expect(tooLarge.json()).resolves.toEqual({
        status: 'error',
        code: 'ERR_BODY_TOO_LARGE',
        description: 'The request body exceeds the endpoint limit.'
      })

      const malformed = await fetch(origin, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{'
      })
      expect(malformed.status).toBe(400)
      await expect(malformed.json()).resolves.toMatchObject({
        code: 'ERR_INVALID_BODY'
      })
    } finally {
      await close(server)
    }
  })

  it('passes non-parser failures to the next error handler', () => {
    const error = new Error('unrelated')
    const next = jest.fn()
    bodyParserErrorHandler(
      error,
      {} as any,
      { status: jest.fn().mockReturnThis(), json: jest.fn() } as any,
      next
    )
    expect(next).toHaveBeenCalledWith(error)
  })

  it('bounds body limits, concurrency, and HTTP server timeouts', async () => {
    process.env.TEST_MAX_BODY_BYTES = '1024'
    expect(readBodyLimitBytes('TEST', 256)).toBe(1024)
    process.env.TEST_MAX_BODY_BYTES = '0'
    expect(() => readBodyLimitBytes('TEST', 256)).toThrow(/positive integer/)
    process.env.TEST_MAX_BODY_BYTES = '1025'
    expect(() => readBodyLimitBytes('TEST', 256, 1024)).toThrow(/must not exceed/)

    process.env.TEST_MAX_CONCURRENT_REQUESTS = '1'
    const app = express()
    app.use(concurrencyLimit('TEST', 10))
    let releaseFirst: (() => void) | undefined
    app.get('/', async (_req, res) => {
      await new Promise<void>(resolve => {
        releaseFirst = resolve
      })
      res.json({ ok: true })
    })
    const { server, origin } = await listen(app)
    configureHttpServer(server, 'TEST', {
      requestTimeoutMs: 30_000,
      headersTimeoutMs: 10_000,
      keepAliveTimeoutMs: 5_000,
      socketTimeoutMs: 30_000,
      maxRequestsPerSocket: 100,
      maxConnections: 50
    })

    try {
      const first = fetch(origin)
      while (releaseFirst == null) {
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      const busy = await fetch(origin)
      expect(busy.status).toBe(503)
      expect(busy.headers.get('retry-after')).toBe('1')
      releaseFirst()
      expect((await first).status).toBe(200)
      expect(server.requestTimeout).toBe(30_000)
      expect(server.headersTimeout).toBe(10_000)
      expect(server.keepAliveTimeout).toBe(5_000)
      expect(server.maxRequestsPerSocket).toBe(100)
      expect(server.maxConnections).toBe(50)
    } finally {
      await close(server)
    }
  })

  it('selects tested resource profiles and explicit operator limits', () => {
    expect(readResourceProfile('TEST')).toBe('standard')
    process.env.TEST_RESOURCE_PROFILE = 'high-throughput'
    expect(readResourceProfile('TEST')).toBe('high-throughput')
    expect(profileValue('small', { small: 1, standard: 2, highThroughput: 3 })).toBe(1)
    expect(profileValue('standard', { small: 1, standard: 2, highThroughput: 3 })).toBe(2)
    expect(profileValue('high-throughput', { small: 1, standard: 2, highThroughput: 3 })).toBe(3)

    process.env.TEST_MAX_ITEMS = '1000'
    expect(readResourceLimit('TEST', 'MAX_ITEMS', 100)).toBe(1_000)
    process.env.TEST_MAX_ITEMS = '-1'
    expect(readResourceLimit('TEST', 'MAX_ITEMS', 100)).toBe(-1)
    process.env.TEST_MAX_ITEMS = 'unlimited'
    expect(readResourceLimit('TEST', 'MAX_ITEMS', 100)).toBe(-1)
    process.env.TEST_MAX_ITEMS = '0'
    expect(() => readResourceLimit('TEST', 'MAX_ITEMS', 100)).toThrow(/positive integer/)

    process.env.TEST_RESOURCE_PROFILE = 'oversized'
    expect(() => readResourceProfile('TEST')).toThrow(/small, standard, or high-throughput/)
  })

  it('tolerates only repeated initial slashes for compatibility', () => {
    const next = jest.fn()
    const request = { url: '///auth/start?mode=test' }
    initialDoubleSlashCompatibility(request as any, {} as any, next)
    expect(request.url).toBe('/auth/start?mode=test')
    expect(next).toHaveBeenCalledTimes(1)

    const interior = { url: '/auth//start' }
    initialDoubleSlashCompatibility(interior as any, {} as any, jest.fn())
    expect(interior.url).toBe('/auth//start')
  })

  it('rejects materialized responses above the configured byte budget', async () => {
    process.env.TEST_MAX_RESPONSE_BYTES = '128'
    const app = express()
    app.use(responseSizeLimit('TEST', 1024))
    app.get('/small', (_req, res) => res.json({ ok: true }))
    app.get('/large', (_req, res) => res.json({ value: 'x'.repeat(512) }))
    const { server, origin } = await listen(app)

    try {
      const small = await fetch(`${origin}/small`)
      expect(small.status).toBe(200)
      await expect(small.json()).resolves.toEqual({ ok: true })

      const large = await fetch(`${origin}/large`)
      expect(large.status).toBe(413)
      await expect(large.json()).resolves.toMatchObject({ code: 'ERR_RESPONSE_TOO_LARGE' })
    } finally {
      await close(server)
    }
  })
})
