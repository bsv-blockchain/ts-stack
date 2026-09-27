import { expect, test } from '@jest/globals'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { CHIRPUploader, objectIdentifierForBytes } from '../src/index.js'

// Full-chunk hashing can outlast an idle socket while the loopback event loop is busy.
// Use fresh fixture connections beneath the default AuthFetch authentication path.
const loopbackFetch: typeof fetch = (url, options = {}) => {
  const headers = new Headers(options.headers)
  headers.set('Connection', 'close')
  return fetch(url, { ...options, headers })
}

test.each<[string, Uint8Array]>([
  ['non-text bytes', Uint8Array.of(0, 1, 127, 128, 255)],
  ['complete 4 MiB chunk', new Uint8Array(4_194_304).fill(255)]
])(
  'default AuthFetch uploads %s with exact identity bytes and HTTP-managed length',
  async (_name, source) => {
    const clientWallet = new ProtoWallet(PrivateKey.fromRandom())
    const identity = (await clientWallet.getPublicKey({ identityKey: true })).publicKey
    const staged = new Map<string, Buffer>()
    const lengths: number[] = []
    const identities: string[] = []
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use(express.raw({ type: 'application/octet-stream', limit: 4_194_304 }))
    app.use(rateLimit({ windowMs: 60_000, limit: 300 }))
    app.use(
      createAuthMiddleware({
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        allowUnauthenticated: false
      })
    )
    app.use(rateLimit({ windowMs: 60_000, limit: 1000 }))
    app.use((req, _res, next) => {
      identities.push((req as typeof req & { auth: { identityKey: string } }).auth.identityKey)
      next()
    })
    app.post('/chirp/v1/uploads', (_req, res) => {
      res.status(201).json({ uploadId: 'authenticated-session', stagingExpiresAt: '4000000000' })
    })
    const objectRoute = '/chirp/v1/uploads/:uploadId/objects/:objectIdentifier'
    app.head(objectRoute, (req, res) => {
      res.status(staged.has(req.params.objectIdentifier) ? 200 : 404).end()
    })
    app.put(objectRoute, (req, res) => {
      const bytes: unknown = req.body
      expect(Buffer.isBuffer(bytes)).toBe(true)
      if (!Buffer.isBuffer(bytes)) throw new Error('Expected authenticated raw bytes')
      const byteLength = Buffer.byteLength(bytes)
      expect(req.get('content-encoding') ?? 'identity').toBe('identity')
      expect(req.get('content-type')).toBe('application/octet-stream')
      expect(Number(req.get('content-length'))).toBe(byteLength)
      expect(objectIdentifierForBytes(bytes)).toBe(req.params.objectIdentifier)
      staged.set(req.params.objectIdentifier, bytes)
      lengths.push(byteLength)
      res.status(201).end()
    })
    let origin = ''
    app.post('/chirp/v1/uploads/:uploadId/commit', (req, res) => {
      const root = (req.body as { rootIdentifier: string }).rootIdentifier
      expect(staged.has(root)).toBe(true)
      res.status(201).json({
        chirpURL: `chirp://${root}`,
        uhrpURL: `uhrp://${root}`,
        hostedFileLocation: `${origin}/chirp/v1/${root}/objects/${root}`,
        expiryTime: 4_000_000_000
      })
    })
    const server = app.listen(0, '127.0.0.1')
    try {
      await new Promise<void>(resolve => server.once('listening', resolve))
      const address = server.address()
      if (address == null || typeof address === 'string')
        throw new Error('Expected loopback listener')
      origin = `http://127.0.0.1:${address.port}`
      const result = await new CHIRPUploader({
        wallet: clientWallet,
        storageURL: origin,
        allowPrivateHosts: true,
        allowInsecureHTTP: true,
        fetchClient: loopbackFetch,
        retriesPerRequest: 0
      }).publish({ source, retentionSeconds: 60 })
      expect(result.commits).toHaveLength(1)
      expect(lengths).toHaveLength(2)
      expect(lengths).toContain(source.length)
      expect(staged.get(objectIdentifierForBytes(source))).toEqual(Buffer.from(source))
      expect(identities.length).toBeGreaterThanOrEqual(6)
      expect(identities.every(value => value === identity)).toBe(true)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error == null ? resolve() : reject(error)))
      )
    }
  },
  60_000
)
