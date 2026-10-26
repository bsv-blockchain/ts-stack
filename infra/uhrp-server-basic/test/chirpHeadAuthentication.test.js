process.env.BSV_NETWORK = 'testnet'
process.env.HOSTING_DOMAIN = 'storage.example.com'
process.env.NODE_ENV = 'test'
process.env.WALLET_STORAGE_URL = 'http://localhost:3000'

const mockHasStagedObject = jest.fn()
jest.mock('../out/src/chirp/store', () => ({
  getChirpStore: () => ({ hasStagedObject: mockHasStagedObject })
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
const { objectIdentifierForBytes } = require('../out/src/chirp/core/hash')

const present = objectIdentifierForBytes(Uint8Array.of(1))
const absent = objectIdentifierForBytes(Uint8Array.of(2))
let server
let origin
let clientWallet

beforeAll(async () => {
  const app = express()
  const serverWallet = new ProtoWallet(PrivateKey.fromRandom())
  clientWallet = new ProtoWallet(PrivateKey.fromRandom())
  app.use(express.json())
  app.use(rateLimit(rateLimitOptions('UHRP_PRE_AUTH_RATE_LIMIT', { windowMs: 60_000, limit: 300 })))
  app.use(createAuthMiddleware({ wallet: serverWallet, allowUnauthenticated: false }))
  app.use(
    rateLimit(
      rateLimitOptions(
        'UHRP_AUTHENTICATED_RATE_LIMIT',
        { windowMs: 60_000, limit: 1000 },
        { keyGenerator: authenticatedIdentityKey }
      )
    )
  )
  const route = chirpPostAuthRoutes.find(
    value => value.type === 'head' && value.path.includes('/uploads/')
  )
  app.head(route.path, route.func)
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  origin = `http://127.0.0.1:${server.address().port}`
})

beforeEach(() => {
  mockHasStagedObject.mockImplementation(async (_uploadId, identityKey, identifier) => {
    expect(identityKey).toBe((await clientWallet.getPublicKey({ identityKey: true })).publicKey)
    return identifier === present
  })
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
})

test.each([
  ['present staged object', present, 200],
  ['absent staged object', absent, 404],
  ['invalid object identifier', 'invalid-object', 400]
])(
  'authenticates a bodyless HEAD for %s',
  async (_name, identifier, status) => {
    const auth = new AuthFetch(clientWallet, undefined, undefined, undefined, {}, fetch)
    const response = await auth.fetch(
      `${origin}/chirp/v1/uploads/test-session/objects/${identifier}`,
      {
        method: 'HEAD'
      }
    )
    expect(response.status).toBe(status)
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  },
  15_000
)
