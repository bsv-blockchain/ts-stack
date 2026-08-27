process.env.SERVER_PRIVATE_KEY = '5KU2L5qbkL5MPnUK1cuC5fWamjz7aoKCAZAbKdqmChed8TTbWCZ'
process.env.BSV_NETWORK = 'testnet'
process.env.WALLET_STORAGE_URL = 'http://localhost:3000'

const mockBroadcast = jest.fn()

jest.mock('@bsv/sdk', () => ({
  StorageUtils: {
    getURLForHash: jest.fn(() => 'mock-uhrp-url')
  },
  PrivateKey: {
    fromHex: jest.fn(() => ({
      toPublicKey: jest.fn(() => ({ toString: jest.fn(() => 'mock-public-key') }))
    }))
  },
  Utils: {
    toArray: jest.fn(() => [1, 2, 3]),
    toHex: jest.fn(() => 'mock-hex'),
    Writer: jest.fn(() => ({
      writeVarIntNum: jest.fn(() => ({ toArray: jest.fn(() => [4, 5, 6]) }))
    }))
  },
  PushDrop: jest.fn(() => ({
    lock: jest.fn(async () => ({ toHex: jest.fn(() => 'mock-locking-script-hex') }))
  })),
  Transaction: {
    fromAtomicBEEF: jest.fn(() => ({ id: jest.fn(() => 'mock-txid') }))
  },
  SHIPBroadcaster: jest.fn(() => ({ broadcast: mockBroadcast }))
}))

jest.mock('../out/src/utils/walletSingleton', () => ({
  getWallet: jest.fn(async () => ({
    createAction: jest.fn(async () => ({ tx: 'mock-beef' }))
  }))
}))

const {
  default: createUHRPAdvertisement,
  createUHRPAdvertisementWithResult
} = require('../out/src/utils/createUHRPAdvertisement')

const valid = {
  hash: [1, 2, 3, 4],
  objectIdentifier: 'MOCK_IDENTIFIER',
  url: 'MOCK_HTTPS_URL',
  expiryTime: 1_620_253_222,
  contentLength: 100,
  uploaderIdentityKey: 'mock-uploader-key',
  contentType: 'application/octet-stream'
}

beforeEach(() => {
  mockBroadcast.mockResolvedValue({
    status: 'success',
    txid: 'mock-txid',
    message: 'accepted'
  })
})

afterEach(() => {
  jest.clearAllMocks()
})

test('exposes returned broadcast failures without changing the legacy response', async () => {
  const broadcastResult = {
    status: 'error',
    code: 'ERR_NO_HOSTS_INTERESTED',
    description: 'No hosts accepted the advertisement.'
  }
  mockBroadcast.mockResolvedValue(broadcastResult)

  await expect(createUHRPAdvertisementWithResult(valid)).resolves.toEqual({
    txid: 'mock-txid',
    broadcastResult
  })
  await expect(createUHRPAdvertisement(valid)).resolves.toEqual({ txid: 'mock-txid' })
})
