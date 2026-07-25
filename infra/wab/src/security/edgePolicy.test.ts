import express from 'express'
import type { Server } from 'node:http'
import {
  bodyParserErrorHandler,
  concurrencyLimit,
  configureHttpServer,
  corsPolicy,
  readBodyLimitBytes,
  securityHeaders
} from './edgePolicy'

async function listen (app: express.Express): Promise<{
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

async function close (server: Server): Promise<void> {
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
    app.use(corsPolicy({
      environmentPrefix: 'TEST',
      methods: ['GET', 'POST']
    }))
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
    } finally {
      await close(server)
    }
  })

  it('allows only explicitly configured browser origins', async () => {
    process.env.TEST_CORS_ALLOWED_ORIGINS = 'https://wallet.example'
    const app = express()
    app.use(corsPolicy({
      environmentPrefix: 'TEST',
      methods: ['GET', 'POST']
    }))
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
    app.use(corsPolicy({
      environmentPrefix: 'TEST',
      methods: ['GET']
    }))
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
    app.use(corsPolicy({
      environmentPrefix: 'TEST',
      methods: ['GET', 'POST']
    }))
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
    expect(() => corsPolicy({
      environmentPrefix: 'TEST',
      methods: ['GET']
    })).toThrow(/wildcard/)

    process.env.TEST_CORS_ALLOWED_ORIGINS = 'https://wallet.example/path'
    expect(() => corsPolicy({
      environmentPrefix: 'TEST',
      methods: ['GET']
    })).toThrow(/without paths/)
  })

  it('gives service-specific CORS settings precedence over global fallbacks', async () => {
    process.env.CORS_MODE = 'public'
    process.env.CORS_ALLOWED_ORIGINS = ''
    process.env.TEST_CORS_MODE = 'allowlist'
    process.env.TEST_CORS_ALLOWED_ORIGINS = 'https://wallet.example'
    const app = express()
    app.use(corsPolicy({
      environmentPrefix: 'TEST',
      methods: ['GET']
    }))
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
    app.use(securityHeaders({
      environmentPrefix: 'TEST',
      contentSecurityPolicy: "default-src 'none'",
      crossOriginResourcePolicy: 'same-origin',
      crossOriginOpenerPolicy: 'same-origin',
      frameOptions: 'DENY',
      permissionsPolicy: 'camera=()',
      strictTransportSecurity: true
    }))
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

  it('bounds body limits, concurrency, and HTTP server timeouts', async () => {
    process.env.TEST_MAX_BODY_BYTES = '1024'
    expect(readBodyLimitBytes('TEST', 256)).toBe(1024)
    process.env.TEST_MAX_BODY_BYTES = '0'
    expect(() => readBodyLimitBytes('TEST', 256)).toThrow(/positive integer/)

    process.env.TEST_MAX_CONCURRENT_REQUESTS = '1'
    const app = express()
    app.use(concurrencyLimit('TEST', 10))
    let releaseFirst: (() => void) | undefined
    app.get('/', async (_req, res) => {
      await new Promise<void>(resolve => { releaseFirst = resolve })
      res.json({ ok: true })
    })
    const { server, origin } = await listen(app)
    configureHttpServer(server, 'TEST', {
      requestTimeoutMs: 30_000,
      headersTimeoutMs: 10_000,
      keepAliveTimeoutMs: 5_000,
      socketTimeoutMs: 30_000,
      maxRequestsPerSocket: 100
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
    } finally {
      await close(server)
    }
  })
})
