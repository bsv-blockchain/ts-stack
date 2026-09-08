process.env.BSV_NETWORK = 'testnet'
process.env.HOSTING_DOMAIN = 'storage.example.com'
process.env.NODE_ENV = 'test'
process.env.WALLET_STORAGE_URL = 'http://localhost:3000'

const mockAdvertisement = jest.fn()
const mockGetChirpStore = jest.fn()
const mockValidateClosure = jest.fn()

jest.mock('../out/src/utils/createUHRPAdvertisement', () => ({
  createUHRPAdvertisementWithResult: mockAdvertisement
}))
jest.mock('../out/src/chirp/store', () => ({ getChirpStore: mockGetChirpStore }))
jest.mock('../out/src/chirp/core/validation', () => ({
  validateCHIRPClosure: mockValidateClosure
}))
jest.mock('../out/src/logger', () => ({
  log: { error: jest.fn() }
}))

const { chirpPostAuthRoutes } = require('../out/src/chirp/routes')
const { objectIdentifierForBytes } = require('../out/src/chirp/core/hash')

const rootBytes = Uint8Array.of(1)
const rootIdentifier = objectIdentifierForBytes(rootBytes)
const commitHandler = chirpPostAuthRoutes.find(
  route => route.path === '/chirp/v1/uploads/:uploadId/commit'
).func

function response() {
  const res = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}

function request() {
  return {
    auth: { identityKey: 'test-identity' },
    body: { rootIdentifier },
    params: { uploadId: 'test-upload' }
  }
}

function store() {
  return {
    withCommitLock: jest.fn(async (_uploadId, operation) => await operation()),
    getSession: jest.fn(async () => ({ retentionSeconds: '3600', logicalLength: null })),
    getCommit: jest.fn(async () => null),
    readStagedObject: jest.fn(),
    prepareCommit: jest.fn(async () => {}),
    activateCommit: jest.fn(async () => {}),
    abortCommit: jest.fn(async () => {})
  }
}

beforeEach(() => {
  mockValidateClosure.mockResolvedValue({
    rootBytes,
    logicalLength: 1n,
    closure: [rootIdentifier],
    nodeIdentifiers: [rootIdentifier]
  })
  mockAdvertisement.mockResolvedValue({
    txid: 'mock-txid',
    broadcastResult: { status: 'success', txid: 'mock-txid', message: 'accepted' }
  })
})

afterEach(() => {
  jest.clearAllMocks()
})

test('does not activate or report success for a returned broadcast failure', async () => {
  const chirpStore = store()
  mockGetChirpStore.mockReturnValue(chirpStore)
  mockAdvertisement.mockResolvedValue({
    txid: 'mock-txid',
    broadcastResult: {
      status: 'error',
      code: 'ERR_NO_HOSTS_INTERESTED',
      description: 'No hosts accepted the advertisement.'
    }
  })
  const res = response()

  await commitHandler(request(), res)

  expect(chirpStore.prepareCommit).toHaveBeenCalledWith(
    expect.objectContaining({ rootIdentifier, state: 'pending' })
  )
  expect(chirpStore.activateCommit).not.toHaveBeenCalled()
  expect(chirpStore.abortCommit).toHaveBeenCalledWith(rootIdentifier)
  expect(res.status).toHaveBeenCalledWith(400)
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'error', code: 'ERR_CHIRP_ADVERTISEMENT' })
  )
})

test('aborts prepared state when advertisement submission throws', async () => {
  const chirpStore = store()
  mockGetChirpStore.mockReturnValue(chirpStore)
  mockAdvertisement.mockRejectedValue(new Error('Ambiguous submit response'))
  const res = response()

  await commitHandler(request(), res)

  expect(chirpStore.prepareCommit).toHaveBeenCalled()
  expect(chirpStore.activateCommit).not.toHaveBeenCalled()
  expect(chirpStore.abortCommit).toHaveBeenCalledWith(rootIdentifier)
  expect(res.status).toHaveBeenCalledWith(400)
})

test('activates and reports success after an acknowledged advertisement', async () => {
  const chirpStore = store()
  mockGetChirpStore.mockReturnValue(chirpStore)
  const res = response()

  await commitHandler(request(), res)

  expect(chirpStore.activateCommit).toHaveBeenCalledWith(rootIdentifier)
  expect(chirpStore.abortCommit).not.toHaveBeenCalled()
  expect(res.status).toHaveBeenCalledWith(201)
})
