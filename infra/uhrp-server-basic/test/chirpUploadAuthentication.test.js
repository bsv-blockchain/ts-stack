process.env.BSV_NETWORK = 'testnet'
process.env.HOSTING_DOMAIN = 'storage.example.com'
process.env.NODE_ENV = 'test'
process.env.WALLET_STORAGE_URL = 'http://localhost:3000'

const mockStageObject = jest.fn()
jest.mock('../out/src/chirp/store', () => ({
  getChirpStore: () => ({ stageObject: mockStageObject })
}))
jest.mock('../out/src/utils/createUHRPAdvertisement', () => ({
  createUHRPAdvertisementWithResult: jest.fn()
}))
jest.mock('../out/src/logger', () => ({ log: { error: jest.fn() } }))

const express = require('express')
const { createAuthMiddleware } = require('@bsv/auth-express-middleware')
const { rateLimit } = require('express-rate-limit')
const {
  rateLimitOptions,
  authenticatedIdentityKey
} = require('../out/src/security/rateLimitPolicy')
const { AuthFetch, PrivateKey, ProtoWallet } = require('@bsv/sdk')
const { chirpPostAuthRoutes } = require('../out/src/chirp/routes')
const {
  createChirpObjectBodyParser,
  CHIRP_STAGED_OBJECT_PATH
} = require('../out/src/chirp/bodyMiddleware')
const { bodyParserErrorHandler } = require('../out/src/security/edgePolicy')
const { objectIdentifierForBytes } = require('../out/src/chirp/core/hash')

let server
let origin
let clientWallet
let received

beforeAll(async () => {
  const app = express()
  clientWallet = new ProtoWallet(PrivateKey.fromRandom())
  app.use(rateLimit(rateLimitOptions('UHRP_PRE_AUTH_RATE_LIMIT', { windowMs: 60_000, limit: 300 })))
  app.put(CHIRP_STAGED_OBJECT_PATH, createChirpObjectBodyParser())
  app.use(express.json({ limit: 262144 }))
  app.use(bodyParserErrorHandler)
  app.use(
    createAuthMiddleware({
      wallet: new ProtoWallet(PrivateKey.fromRandom()),
      allowUnauthenticated: false
    })
  )
  app.use(
    rateLimit(
      rateLimitOptions(
        'UHRP_AUTHENTICATED_RATE_LIMIT',
        { windowMs: 60_000, limit: 1000 },
        { keyGenerator: authenticatedIdentityKey }
      )
    )
  )
  const route = chirpPostAuthRoutes.find(value => value.type === 'put')
  app.put(route.path, route.func)
  app.post('/json-compatibility', (req, res) => res.json(req.body))
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  origin = `http://127.0.0.1:${server.address().port}`
})

beforeEach(() => {
  received = []
  mockStageObject.mockReset()
  mockStageObject.mockImplementation(
    async (uploadId, identityKey, identifier, stream, declaredLength, limit) => {
      expect(uploadId).toBe('test-session')
      expect(identityKey).toBe((await clientWallet.getPublicKey({ identityKey: true })).publicKey)
      const chunks = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      expect(bytes.length).toBe(declaredLength)
      expect(bytes.length).toBeLessThanOrEqual(limit)
      expect(objectIdentifierForBytes(bytes)).toBe(identifier)
      received.push(bytes)
      return 'created'
    }
  )
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
})

// Hashing full chunks can outlast an idle pooled socket while the event loop is busy.
// Each fixture request uses a fresh HTTP connection; authentication bytes are unchanged.
const loopbackFetch = (url, options = {}) => {
  const headers = new Headers(options.headers)
  headers.set('Connection', 'close')
  return fetch(url, { ...options, headers })
}
const authFetch = () =>
  new AuthFetch(clientWallet, undefined, undefined, undefined, {}, loopbackFetch)
const objectURL = bytes =>
  `${origin}/chirp/v1/uploads/test-session/objects/${objectIdentifierForBytes(bytes)}`

test('authenticates and stages the exact non-text binary bytes', async () => {
  const bytes = Uint8Array.of(0, 1, 127, 128, 255)
  const response = await authFetch().fetch(objectURL(bytes), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes
  })
  expect(response.status).toBe(201)
  expect(mockStageObject).toHaveBeenCalledTimes(1)
  expect(received).toEqual([Buffer.from(bytes)])
}, 15000)

test('preserves authenticated JSON requests on other routes', async () => {
  const body = { retentionSeconds: '3600', logicalLength: '5' }
  const response = await authFetch().fetch(`${origin}/json-compatibility`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(body)
  expect(mockStageObject).not.toHaveBeenCalled()
}, 15000)

test('authenticates and stages a complete 4 MiB CHIRP chunk at the default boundary', async () => {
  const bytes = new Uint8Array(4194304).fill(255)
  const response = await authFetch().fetch(objectURL(bytes), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes
  })
  expect(response.status).toBe(201)
  expect(received).toEqual([Buffer.from(bytes)])
}, 30000)

test('rejects bytes changed after signing without staging an object', async () => {
  const bytes = Uint8Array.of(0, 1, 127, 128, 255)
  const statuses = []
  const tamper = async (url, options) => {
    if (options?.method === 'PUT') {
      const changed = Buffer.from(options.body)
      changed[0] ^= 1
      const response = await loopbackFetch(url, { ...options, body: changed })
      statuses.push(response.status)
      return response
    }
    return await loopbackFetch(url, options)
  }
  const auth = new AuthFetch(clientWallet, undefined, undefined, undefined, {}, tamper)
  await expect(
    auth.fetch(objectURL(bytes), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes
    })
  ).rejects.toThrow(/401/)
  expect(statuses.length).toBeGreaterThan(0)
  expect(statuses.every(status => status === 401)).toBe(true)
  expect(mockStageObject).not.toHaveBeenCalled()
  expect(received).toEqual([])
}, 15000)

test('rejects an oversized raw body before authentication or staging', async () => {
  const bytes = new Uint8Array(4194305)
  const response = await loopbackFetch(objectURL(bytes), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes
  })
  expect(response.status).toBe(413)
  expect((await response.json()).code).toBe('ERR_BODY_TOO_LARGE')
  expect(mockStageObject).not.toHaveBeenCalled()
})

test.each(['gzip', 'br', 'deflate'])(
  'rejects %s content encoding before authentication or staging',
  async encoding => {
    const bytes = Uint8Array.of(0, 255)
    const response = await loopbackFetch(objectURL(bytes), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': encoding },
      body: bytes
    })
    expect(response.status).toBe(415)
    expect((await response.json()).code).toBe('ERR_CHIRP_ENCODING')
    expect(mockStageObject).not.toHaveBeenCalled()
  }
)

test('authenticates and stages an explicitly empty binary body', async () => {
  const bytes = new Uint8Array(0)
  const response = await authFetch().fetch(objectURL(bytes), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes
  })
  expect(response.status).toBe(201)
  expect(received).toEqual([Buffer.from(bytes)])
}, 15000)

test('preserves exact staged-object bytes even with a JSON media type', async () => {
  const bytes = Buffer.from('{ "value" : 1 }\n')
  const response = await authFetch().fetch(objectURL(bytes), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: bytes
  })
  expect(response.status).toBe(201)
  expect(received).toEqual([bytes])
}, 15000)
