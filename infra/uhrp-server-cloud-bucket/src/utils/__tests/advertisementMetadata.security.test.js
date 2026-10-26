process.env.SERVER_PRIVATE_KEY = '55'.repeat(32)

const { PrivateKey, ProtoWallet, PushDrop, StorageUtils, Utils } = require('@bsv/sdk')
const {
  advertisementTags,
  createAdvertisementMetadata,
  requireAdvertisementTags,
  verifyAdvertisementMetadata
} = require('../advertisementMetadata')

const serverWallet = new ProtoWallet(new PrivateKey(process.env.SERVER_PRIVATE_KEY, 'hex'))
const uploaderIdentityKey = PrivateKey.fromRandom().toPublicKey().toString()
const hash = Array.from({ length: 32 }, (_, index) => index)
const objectIdentifier = '3mJr7AoUXx2Wqd'
const hostedFileLocation = `https://files.example/cdn/${objectIdentifier}`

async function fixture(options = {}) {
  const selectedObject = options.objectIdentifier ?? objectIdentifier
  const selectedLocation = options.hostedFileLocation ?? hostedFileLocation
  const identity = await serverWallet.getPublicKey({ identityKey: true })
  const script = await new PushDrop(serverWallet).lock(
    [
      Utils.toArray(identity.publicKey, 'hex'),
      hash,
      Utils.toArray(selectedLocation, 'utf8'),
      new Utils.Writer().writeVarIntNum(2_000_000_000).toArray(),
      new Utils.Writer().writeVarIntNum(100).toArray()
    ],
    [2, 'uhrp advertisement'],
    '1',
    'anyone',
    true
  )
  const signed = createAdvertisementMetadata({
    objectIdentifier: selectedObject,
    uploaderIdentityKey,
    hostedFileLocation: selectedLocation,
    hash,
    expiryTime: 2_000_000_000,
    fileSize: 100,
    contentType: 'application/octet-stream'
  })
  return { script, signed }
}

test('accepts server-signed ownership metadata only when it matches the token', async () => {
  const { script, signed } = await fixture()
  await expect(verifyAdvertisementMetadata(signed.customInstructions, script)).resolves.toEqual(
    signed.metadata
  )
  expect(() =>
    requireAdvertisementTags(advertisementTags(signed.metadata), signed.metadata)
  ).not.toThrow()
})

test('rejects unsigned legacy metadata and edited owner fields', async () => {
  const { script, signed } = await fixture()
  await expect(verifyAdvertisementMetadata(undefined, script)).rejects.toThrow(
    'metadata is missing'
  )

  const envelope = JSON.parse(signed.customInstructions)
  envelope.metadata.uploaderIdentityKey = PrivateKey.fromRandom().toPublicKey().toString()
  await expect(verifyAdvertisementMetadata(JSON.stringify(envelope), script)).rejects.toThrow(
    'signature is invalid'
  )
})

test('rejects relabeled wallet tags after signature verification', async () => {
  const { signed } = await fixture()
  const tags = advertisementTags(signed.metadata).map(tag =>
    tag.startsWith('uploader_identity_key_')
      ? `uploader_identity_key_${PrivateKey.fromRandom().toPublicKey().toString()}`
      : tag
  )
  expect(() => requireAdvertisementTags(tags, signed.metadata)).toThrow('do not match')
})

test('binds signed CHIRP root ownership to its exact root path and hash identifier', async () => {
  const root = StorageUtils.getURLForHash(hash)
  const { script, signed } = await fixture({
    objectIdentifier: root,
    hostedFileLocation: `https://files.example/chirp/v1/${root}/objects/${root}`
  })
  await expect(verifyAdvertisementMetadata(signed.customInstructions, script)).resolves.toEqual(
    signed.metadata
  )
  expect(() =>
    requireAdvertisementTags(advertisementTags(signed.metadata), signed.metadata)
  ).not.toThrow()
})

test.each([
  root => `https://files.example/chirp/v1/${root}/objects/3mJr7AoUXx2Wqd`,
  root => `https://files.example/chirp/v1/3mJr7AoUXx2Wqd/objects/${root}`,
  root => `https://files.example/chirp/v1/${root}/objects/${root}?download=1`,
  root => `https://files.example/chirp/v1/${root}/objects/${root}#fragment`,
  root => `https://user:password@files.example/chirp/v1/${root}/objects/${root}`
])('rejects a CHIRP location that is not the exact credential-free root route', async location => {
  const root = StorageUtils.getURLForHash(hash)
  await expect(
    fixture({ objectIdentifier: root, hostedFileLocation: location(root) })
  ).rejects.toThrow('file location is invalid')
})

test('rejects a CHIRP route whose root does not identify the advertised hash', async () => {
  await expect(
    fixture({
      hostedFileLocation: `https://files.example/chirp/v1/${objectIdentifier}/objects/${objectIdentifier}`
    })
  ).rejects.toThrow('file location is invalid')
})
