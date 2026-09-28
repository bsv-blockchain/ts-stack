process.env.GCP_BUCKET_NAME = 'synthetic-bucket'

const { PrivateKey, StorageUtils } = require('@bsv/sdk')
const mockFile = { getMetadata: jest.fn() }
const mockBucket = { file: jest.fn(() => mockFile) }
const mockListAdvertisements = jest.fn()

jest.mock('../googleCloudStorage', () => ({
  createGoogleCloudStorage: () => ({ bucket: () => mockBucket })
}))
jest.mock('../storedAdvertisements', () => ({
  listVerifiedAdvertisements: mockListAdvertisements
}))

const { getMetadata } = require('../getMetadata')
const uhrpUrl = StorageUtils.getURLForHash(Array.from({ length: 32 }, (_, index) => index))
const identifier = uhrpUrl.replace(/^uhrp:\/\//, '')
const owner = new PrivateKey('45'.repeat(32), 'hex').toPublicKey().toString()

function advertisement(chirpRoot, expiryTime = 2_000_000_000) {
  return {
    metadata: {
      objectIdentifier: identifier,
      hostedFileLocation: chirpRoot
        ? `https://storage.example/chirp/v1/${identifier}/objects/${identifier}`
        : `https://storage.example/cdn/${identifier}`,
      fileSize: 100,
      contentType: 'application/octet-stream',
      expiryTime
    }
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockFile.getMetadata.mockResolvedValue([{ size: '100' }])
})

test.each([false, true])(
  'prices the actual verified storage object for CHIRP root %p',
  async chirpRoot => {
    mockListAdvertisements.mockResolvedValue({ advertisements: [advertisement(chirpRoot)] })
    const result = await getMetadata(uhrpUrl, owner.toUpperCase(), 2, 0)
    const objectName = `${chirpRoot ? 'chirp/v1/objects' : 'cdn'}/${identifier}`
    expect(mockListAdvertisements).toHaveBeenCalledWith({
      uhrpUrl,
      uploaderIdentityKey: owner,
      limit: 2,
      offset: 0
    })
    expect(mockBucket.file).toHaveBeenCalledTimes(1)
    expect(mockBucket.file).toHaveBeenCalledWith(objectName)
    expect(result).toEqual({
      objectIdentifier: identifier,
      name: objectName,
      size: '100',
      contentType: 'application/octet-stream',
      expiryTime: 2_000_000_000
    })
  }
)

test('prices the farthest authenticated advertisement', async () => {
  mockListAdvertisements.mockResolvedValue({
    advertisements: [advertisement(false), advertisement(true, 2_000_000_060)]
  })
  expect((await getMetadata(uhrpUrl, owner)).expiryTime).toBe(2_000_000_060)
  expect(mockBucket.file).toHaveBeenCalledWith(`chirp/v1/objects/${identifier}`)
})

test.each([false, true])(
  'rejects a provider size disagreement for CHIRP root %p',
  async chirpRoot => {
    mockListAdvertisements.mockResolvedValue({ advertisements: [advertisement(chirpRoot)] })
    mockFile.getMetadata.mockResolvedValue([{ size: '101' }])
    await expect(getMetadata(uhrpUrl, owner)).rejects.toThrow('size does not match')
  }
)

test('propagates a missing CHIRP root without falling back to a CDN copy', async () => {
  mockListAdvertisements.mockResolvedValue({ advertisements: [advertisement(true)] })
  mockFile.getMetadata.mockRejectedValue(new Error('Root object missing'))
  await expect(getMetadata(uhrpUrl, owner)).rejects.toThrow('Root object missing')
  expect(mockBucket.file).toHaveBeenCalledTimes(1)
  expect(mockBucket.file).toHaveBeenCalledWith(`chirp/v1/objects/${identifier}`)
})

test('requires a current authenticated advertisement before provider access', async () => {
  mockListAdvertisements.mockResolvedValue({ advertisements: [] })
  await expect(getMetadata(uhrpUrl, owner)).rejects.toThrow('No authenticated advertisement')
  mockListAdvertisements.mockResolvedValue({ advertisements: [advertisement(true, 1)] })
  await expect(getMetadata(uhrpUrl, owner)).rejects.toThrow('has expired')
  expect(mockBucket.file).not.toHaveBeenCalled()
})
