process.env.SERVER_PRIVATE_KEY = '44'.repeat(32)
process.env.BSV_NETWORK = 'testnet'
process.env.GCP_BUCKET_NAME = 'synthetic-bucket'

const {
  PrivateKey,
  ProtoWallet,
  PushDrop,
  SHIPBroadcaster,
  StorageUtils,
  Utils
} = require('@bsv/sdk')
const mockWallet = new ProtoWallet(new PrivateKey(process.env.SERVER_PRIVATE_KEY, 'hex'))
const mockFile = { getMetadata: jest.fn(), setMetadata: jest.fn() }
const mockBucket = { file: jest.fn(() => mockFile) }
const mockExtendRootLease = jest.fn()
const mockListAdvertisements = jest.fn()

jest.mock('../../utils/googleCloudStorage', () => ({
  createGoogleCloudStorage: () => ({ bucket: () => mockBucket })
}))
jest.mock('../../utils/walletSingleton', () => ({ getWallet: async () => mockWallet }))
jest.mock('../../utils/storedAdvertisements', () => ({
  listVerifiedAdvertisements: mockListAdvertisements
}))
jest.mock('../../utils/getPriceForFile', () => ({ __esModule: true, default: async () => 1 }))
jest.mock('../../chirp/store', () => ({
  getChirpStore: () => ({ extendRootLease: mockExtendRootLease })
}))
jest.mock('../../logger', () => ({ log: { error: jest.fn() } }))
jest.mock('../../utils/completeUhrpAction', () => ({
  completeUhrpAction: async (_wallet, args) => {
    const { Script, Transaction } = require('@bsv/sdk')
    const tx = new Transaction()
    for (const output of args.outputs)
      tx.addOutput({
        satoshis: output.satoshis,
        lockingScript: Script.fromHex(output.lockingScript)
      })
    return tx
  }
}))

const { createAdvertisementMetadata } = require('../../utils/advertisementMetadata')
const renew = require('../renew').default.func
const hash = Array.from({ length: 32 }, (_, index) => index)
const identifier = StorageUtils.getURLForHash(hash).replace(/^uhrp:\/\//, '')
const identityKey = new PrivateKey('45'.repeat(32), 'hex').toPublicKey().toString()
const expiry = 2_000_000_000

function response() {
  const res = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}

async function advertisement(chirpRoot) {
  const hostedFileLocation = chirpRoot
    ? `https://storage.example/chirp/v1/${identifier}/objects/${identifier}`
    : `https://storage.example/cdn/${identifier}`
  const lockingScript = await new PushDrop(mockWallet).lock(
    [
      Utils.toArray(
        new PrivateKey(process.env.SERVER_PRIVATE_KEY, 'hex').toPublicKey().toString(),
        'hex'
      ),
      hash,
      Utils.toArray(hostedFileLocation, 'utf8'),
      new Utils.Writer().writeVarIntNum(expiry).toArray(),
      new Utils.Writer().writeVarIntNum(100).toArray()
    ],
    [2, 'uhrp advertisement'],
    '1',
    'anyone',
    true
  )
  const { metadata } = createAdvertisementMetadata({
    objectIdentifier: identifier,
    uploaderIdentityKey: identityKey,
    hostedFileLocation,
    hash,
    expiryTime: expiry,
    fileSize: 100,
    contentType: 'application/vnd.bsv.chirp-node'
  })
  mockListAdvertisements.mockResolvedValue({
    advertisements: [{ metadata, lockingScript, outpoint: '66'.repeat(32) + '.0' }],
    BEEF: {}
  })
}

beforeEach(async () => {
  jest.clearAllMocks()
  jest.restoreAllMocks()
  await advertisement(false)
  mockFile.getMetadata.mockResolvedValue([
    { size: '100', customTime: new Date((expiry + 300) * 1000).toISOString(), metageneration: '7' }
  ])
  mockFile.setMetadata.mockResolvedValue([])
  mockExtendRootLease.mockResolvedValue(true)
  jest
    .spyOn(SHIPBroadcaster.prototype, 'broadcast')
    .mockImplementation(async tx => ({ status: 'success', txid: tx.id('hex') }))
})

afterEach(() => jest.restoreAllMocks())

test.each([true, false])('renews the actual storage object for CHIRP root %p', async chirpRoot => {
  await advertisement(chirpRoot)
  const res = response()
  await renew(
    {
      auth: { identityKey },
      body: { uhrpUrl: StorageUtils.getURLForHash(hash), additionalMinutes: 1 }
    },
    res
  )
  expect(mockBucket.file).toHaveBeenCalledWith(
    chirpRoot ? `chirp/v1/objects/${identifier}` : `cdn/${identifier}`
  )
  if (chirpRoot) {
    expect(mockExtendRootLease).toHaveBeenCalledWith(identifier, expiry + 60)
    expect(mockFile.setMetadata).not.toHaveBeenCalled()
  } else {
    expect(mockExtendRootLease).not.toHaveBeenCalled()
    expect(mockFile.setMetadata).toHaveBeenCalledWith(
      { customTime: new Date((expiry + 360) * 1000).toISOString() },
      { ifMetagenerationMatch: '7' }
    )
  }
  expect(res.status).toHaveBeenCalledWith(200)
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'success', newExpiryTime: expiry + 60 })
  )
})

test('does not acknowledge renewal when ordinary object retention fails', async () => {
  mockFile.setMetadata.mockRejectedValue(new Error('Synthetic storage failure'))
  const res = response()
  await renew(
    {
      auth: { identityKey },
      body: { uhrpUrl: StorageUtils.getURLForHash(hash), additionalMinutes: 1 }
    },
    res
  )
  expect(res.status).toHaveBeenCalledWith(500)
  expect(SHIPBroadcaster.prototype.broadcast).not.toHaveBeenCalled()
})

test('does not acknowledge renewal or use a CDN fallback after a closure failure', async () => {
  await advertisement(true)
  mockExtendRootLease.mockRejectedValue(new Error('Synthetic closure failure'))
  const res = response()
  await renew(
    {
      auth: { identityKey },
      body: { uhrpUrl: StorageUtils.getURLForHash(hash), additionalMinutes: 1 }
    },
    res
  )
  expect(res.status).toHaveBeenCalledWith(500)
  expect(mockFile.setMetadata).not.toHaveBeenCalled()
  expect(SHIPBroadcaster.prototype.broadcast).not.toHaveBeenCalled()
})

test('does not acknowledge renewal for an inactive CHIRP root', async () => {
  await advertisement(true)
  mockExtendRootLease.mockResolvedValue(false)
  const res = response()
  await renew(
    {
      auth: { identityKey },
      body: { uhrpUrl: StorageUtils.getURLForHash(hash), additionalMinutes: 1 }
    },
    res
  )
  expect(res.status).toHaveBeenCalledWith(500)
  expect(mockFile.setMetadata).not.toHaveBeenCalled()
  expect(SHIPBroadcaster.prototype.broadcast).not.toHaveBeenCalled()
})
