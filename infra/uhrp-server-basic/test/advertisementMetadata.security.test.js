process.env.SERVER_PRIVATE_KEY = '22'.repeat(32)

const { PrivateKey, ProtoWallet, PushDrop, StorageUtils, Transaction, Utils } = require('@bsv/sdk')

let mockListResult
const mockWallet = {
  listOutputs: jest.fn(async () => mockListResult)
}

jest.mock('../out/src/utils/walletSingleton', () => ({
  getWallet: jest.fn(async () => mockWallet)
}))

const {
  advertisementTags,
  createAdvertisementMetadata,
  verifyAdvertisementMetadata,
  verifyStoredAdvertisementMetadata
} = require('../out/src/utils/advertisementMetadata')
const { getMetadata } = require('../out/src/utils/getMetadata')

const serverWallet = new ProtoWallet(new PrivateKey(process.env.SERVER_PRIVATE_KEY, 'hex'))
const uploaderIdentityKey = PrivateKey.fromRandom().toPublicKey().toString()
const hash = Array.from({ length: 32 }, (_, index) => 255 - index)
const objectIdentifier = '3mJr7AoUXx2Wqd'
const hostedFileLocation = `https://files.example/cdn/${objectIdentifier}`
const expiryTime = 2_000_000_000
const fileSize = 100

async function fixture() {
  const identity = await serverWallet.getPublicKey({ identityKey: true })
  const script = await new PushDrop(serverWallet).lock(
    [
      Utils.toArray(identity.publicKey, 'hex'),
      hash,
      Utils.toArray(hostedFileLocation, 'utf8'),
      new Utils.Writer().writeVarIntNum(expiryTime).toArray(),
      new Utils.Writer().writeVarIntNum(fileSize).toArray()
    ],
    [2, 'uhrp advertisement'],
    '1',
    'anyone',
    true
  )
  const signed = createAdvertisementMetadata({
    objectIdentifier,
    uploaderIdentityKey,
    hostedFileLocation,
    hash,
    expiryTime,
    fileSize,
    contentType: 'application/octet-stream'
  })
  const transaction = new Transaction()
  transaction.addOutput({ satoshis: 1, lockingScript: script })
  const outpoint = `${transaction.id('hex')}.0`
  return {
    script,
    signed,
    transaction,
    walletOutput: {
      outpoint,
      satoshis: 1,
      spendable: true,
      tags: advertisementTags(signed.metadata),
      customInstructions: signed.customInstructions
    }
  }
}

test('returns numeric content size only after signed metadata and token agree', async () => {
  const value = await fixture()
  mockListResult = {
    totalOutputs: 1,
    outputs: [value.walletOutput],
    BEEF: value.transaction.toBEEF()
  }
  await expect(
    getMetadata(StorageUtils.getURLForHash(hash), uploaderIdentityKey, 10, 0)
  ).resolves.toEqual({
    objectIdentifier,
    name: 'file',
    size: '100',
    contentType: 'application/octet-stream',
    expiryTime
  })
})

test('rejects relabeled signed ownership tags and preserves absent-metadata legacy outputs', async () => {
  const value = await fixture()
  mockListResult = {
    totalOutputs: 1,
    outputs: [
      {
        ...value.walletOutput,
        tags: value.walletOutput.tags.map(tag =>
          tag.startsWith('uploader_identity_key_')
            ? `uploader_identity_key_${PrivateKey.fromRandom().toPublicKey().toString()}`
            : tag
        )
      }
    ],
    BEEF: value.transaction.toBEEF()
  }
  await expect(
    getMetadata(StorageUtils.getURLForHash(hash), uploaderIdentityKey, 10, 0)
  ).rejects.toThrow(/tags|selector/)

  await expect(verifyAdvertisementMetadata(undefined, value.script)).rejects.toThrow(
    'metadata is missing'
  )

  mockListResult = {
    totalOutputs: 1,
    outputs: [{ ...value.walletOutput, customInstructions: undefined }],
    BEEF: value.transaction.toBEEF()
  }
  await expect(
    getMetadata(StorageUtils.getURLForHash(hash), uploaderIdentityKey, 10, 0)
  ).resolves.toEqual({
    objectIdentifier,
    name: 'file',
    size: '100',
    contentType: 'application/octet-stream',
    expiryTime
  })
})

test('does not downgrade malformed signed metadata to the legacy compatibility path', async () => {
  const value = await fixture()
  await expect(
    verifyStoredAdvertisementMetadata('{not-json', value.walletOutput.tags, value.script)
  ).rejects.toThrow('metadata is malformed')
})

test('rejects a signed envelope whose uploader field was edited', async () => {
  const value = await fixture()
  const envelope = JSON.parse(value.signed.customInstructions)
  envelope.metadata.uploaderIdentityKey = PrivateKey.fromRandom().toPublicKey().toString()
  await expect(verifyAdvertisementMetadata(JSON.stringify(envelope), value.script)).rejects.toThrow(
    'signature is invalid'
  )
})
