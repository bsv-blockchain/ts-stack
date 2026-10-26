process.env.NODE_ENV = 'production'
process.env.GCP_BUCKET_NAME = 'uhrp-bucket'
process.env.GCP_PROJECT_ID = 'uhrp-project'
process.env.GCP_STORAGE_CREDS = '{}'

const mockGetSignedUrl = jest.fn(async () => ['https://storage.example/signed'])
const mockFile = jest.fn(() => ({ getSignedUrl: mockGetSignedUrl }))
const mockBucket = jest.fn(() => ({ file: mockFile }))

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(() => ({ bucket: mockBucket }))
}))

const { PrivateKey } = require('@bsv/sdk')
const getUploadURL = require('../getUploadURL').default

const uploaderIdentityKey = PrivateKey.fromRandom().toPublicKey().toString()

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
})

afterEach(() => jest.restoreAllMocks())

test('binds a short-lived signed write to paid bytes and one object generation', async () => {
  const result = await getUploadURL({
    size: 1234,
    expiryTime: 10_000,
    objectIdentifier: '3mJr7AoUXx2Wqd',
    uploaderIdentityKey
  })

  const requiredHeaders = {
    'content-length': '1234',
    'content-type': 'application/octet-stream',
    'content-disposition': 'attachment',
    'x-goog-if-generation-match': '0',
    'x-goog-meta-uploaderidentitykey': uploaderIdentityKey.toLowerCase(),
    'x-goog-custom-time': new Date((10_000 + 300) * 1000).toISOString()
  }
  expect(result).toEqual({
    uploadURL: 'https://storage.example/signed',
    requiredHeaders
  })
  expect(mockFile).toHaveBeenCalledWith('cdn/3mJr7AoUXx2Wqd')
  expect(mockGetSignedUrl).toHaveBeenCalledWith({
    version: 'v4',
    action: 'write',
    expires: 1_000_000 + (15 * 60 * 1000),
    extensionHeaders: requiredHeaders
  })
})

test('never lets the upload capability outlive a shorter purchased window', async () => {
  await getUploadURL({
    size: 1,
    expiryTime: 1100,
    objectIdentifier: '3mJr7AoUXx2Wqd',
    uploaderIdentityKey
  })

  expect(mockGetSignedUrl.mock.calls[0][0].expires).toBe(1_100_000)
})

test('rejects malformed billing and ownership inputs before signing', async () => {
  await expect(getUploadURL({
    size: 1.5,
    expiryTime: 10_000,
    objectIdentifier: '3mJr7AoUXx2Wqd',
    uploaderIdentityKey
  })).rejects.toThrow('Invalid upload size')
  await expect(getUploadURL({
    size: 1,
    expiryTime: 10_000,
    objectIdentifier: '../object',
    uploaderIdentityKey
  })).rejects.toThrow('Invalid upload object identifier')
  await expect(getUploadURL({
    size: 1,
    expiryTime: 10_000,
    objectIdentifier: '3mJr7AoUXx2Wqd',
    uploaderIdentityKey: 'not-a-key'
  })).rejects.toThrow('Invalid uploader identity key')
  expect(mockGetSignedUrl).not.toHaveBeenCalled()
})
