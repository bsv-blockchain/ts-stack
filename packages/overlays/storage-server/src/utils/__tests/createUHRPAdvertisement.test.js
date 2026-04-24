/* eslint-env jest */
// set up env vars before requiring
process.env.SERVER_PRIVATE_KEY = '5KU2L5qbkL5MPnUK1cuC5fWamjz7aoKCAZAbKdqmChed8TTbWCZ'
process.env.BSV_NETWORK = 'testnet'
process.env.WALLET_STORAGE_URL = 'http://localhost:3000'

const createUHRPAdvertisement = require('../createUHRPAdvertisement').default

// Mock all the BSV SDK components
jest.mock('@bsv/sdk', () => ({
  StorageUtils: {
    getHashFromURL: jest.fn(),
    getURLForHash: jest.fn(() => 'mock-uhrp-url')
  },
  PrivateKey: {
    fromHex: jest.fn(() => ({
      toPublicKey: jest.fn(() => ({
        toString: jest.fn(() => 'mock-public-key')
      }))
    }))
  },
  Utils: {
    toArray: jest.fn(() => [1, 2, 3]),
    toHex: jest.fn(() => 'mock-hex'),
    Writer: jest.fn(() => ({
      writeVarIntNum: jest.fn(() => ({
        toArray: jest.fn(() => [4, 5, 6])
      }))
    }))
  },
  PushDrop: jest.fn().mockImplementation(() => ({
    lock: jest.fn(() => Promise.resolve({
      toHex: jest.fn(() => 'mock-locking-script-hex')
    }))
  })),
  Transaction: {
    fromAtomicBEEF: jest.fn(() => ({
      id: jest.fn(() => 'mock-txid')
    }))
  },
  SHIPBroadcaster: jest.fn(() => ({
    broadcast: jest.fn()
  }))
}))

jest.mock('../walletSingleton', () => ({
  getWallet: jest.fn(() => ({
    createAction: jest.fn(() => Promise.resolve({
      tx: 'mock-beef'
    }))
  }))
}))

jest.mock('@bsv/wallet-toolbox', () => ({
  Setup: {
    createWalletClientNoEnv: jest.fn(() => Promise.resolve({
      createAction: jest.fn(() => Promise.resolve({
        tx: 'mock-beef'
      }))
    }))
  }
}))

const { StorageUtils } = require('@bsv/sdk')

let valid

describe('createUHRPAdvertisement', () => {
  beforeEach(() => {
    StorageUtils.getHashFromURL.mockReturnValue([1, 2, 3, 4])
    valid = {
      hash: 'MOCK_HASH',
      objectIdentifier: 'MOCK_IDENTIFIER',
      url: 'MOCK_HTTPS_URL',
      expiryTime: 1620253222257,
      contentLength: 100,
      uploaderIdentityKey: 'mock-uploader-key'
    }
  })
  
  afterEach(() => {
    jest.clearAllMocks()
  })
  
  it('Creates UHRP advertisement successfully', async () => {
    const result = await createUHRPAdvertisement(valid)
    expect(result).toEqual({ txid: 'mock-txid' })
  })
  
  it('Converts string hash to array using StorageUtils', async () => {
    await createUHRPAdvertisement(valid)
    expect(StorageUtils.getHashFromURL).toHaveBeenCalledWith('MOCK_HASH')
  })
})
