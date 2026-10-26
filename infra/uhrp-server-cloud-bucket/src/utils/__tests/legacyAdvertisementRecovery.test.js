process.env.SERVER_PRIVATE_KEY = '55'.repeat(32)
const { createHash } = require('node:crypto')
const { Readable } = require('node:stream')
const { PrivateKey, ProtoWallet, PushDrop, Utils, Transaction, Script } = require('@bsv/sdk')
const { migrateLegacyAdvertisement } = require('../migrateLegacyAdvertisement')
const { advertisementTags, createAdvertisementMetadata, verifyAdvertisementMetadata } = require('../advertisementMetadata')
const cryptoWallet = new ProtoWallet(PrivateKey.fromHex(process.env.SERVER_PRIVATE_KEY))
const owner = PrivateKey.fromRandom().toPublicKey().toString()
const body = Buffer.from('synthetic legacy recovery fixture')
const hash = [...createHash('sha256').update(body).digest()]
const objectIdentifier = '3mJr7AoUXx2Wqd'
const location = `https://files.example/cdn/${objectIdentifier}`

async function fixture(overrides = {}) {
  const expiryTime = Math.floor(Date.now() / 1000) + 3600
  const script = await new PushDrop(cryptoWallet).lock([
    Utils.toArray((await cryptoWallet.getPublicKey({ identityKey: true })).publicKey, 'hex'), hash,
    Utils.toArray(location, 'utf8'), new Utils.Writer().writeVarIntNum(expiryTime).toArray(),
    new Utils.Writer().writeVarIntNum(body.length).toArray()
  ], [2, 'uhrp advertisement'], '1', 'anyone', true)
  const tx = new Transaction()
  tx.addInput({ sourceTXID: '66'.repeat(32), sourceOutputIndex: 0, unlockingScript: Script.fromASM('OP_0') })
  tx.addOutput({ satoshis: 1, lockingScript: script })
  const signed = createAdvertisementMetadata({ objectIdentifier, uploaderIdentityKey: owner,
    hostedFileLocation: location, hash, expiryTime, fileSize: body.length, contentType: 'text/plain' })
  const output = { outpoint: `${tx.id('hex')}.0`, spendable: true, satoshis: 1, lockingScript: script.toHex(),
    tags: advertisementTags(signed.metadata).slice(0, 4) }
  const receipt = { size: String(body.length), generation: '123', metageneration: '1',
    customTime: new Date((expiryTime + 300) * 1000).toISOString(), contentType: 'text/plain',
    metadata: { uploaderidentitykey: owner }, ...overrides }
  const getMetadata = jest.fn(async () => [receipt])
  const createReadStream = jest.fn(() => Readable.from([body]))
  const bucket = { file: jest.fn(() => ({ getMetadata, createReadStream })) }
  const wallet = { createAction: jest.fn(), internalizeAction: jest.fn(async args => {
    output.customInstructions = args.outputs[0].insertionRemittance.customInstructions
    return { accepted: true }
  }), listOutputs: jest.fn(async () => ({ outputs: [output], totalOutputs: 1 })) }
  return { wallet, bucket, output, BEEF: tx.toBEEF(true), hostingOrigin: 'https://files.example',
    script, receipt, getMetadata, createReadStream }
}

test('dry run verifies provider ownership and exact bytes without wallet mutation', async () => {
  const f = await fixture()
  await expect(migrateLegacyAdvertisement(f)).resolves.toBe('verified')
  expect(f.wallet.internalizeAction).not.toHaveBeenCalled()
  expect(f.wallet.createAction).not.toHaveBeenCalled()
  expect(f.bucket.file).toHaveBeenCalledWith(`cdn/${objectIdentifier}`, { generation: '123' })
})

test('merges signed metadata into the existing output without spending it', async () => {
  const f = await fixture()
  await expect(migrateLegacyAdvertisement({ ...f, apply: true })).resolves.toBe('migrated')
  expect(f.wallet.createAction).not.toHaveBeenCalled()
  expect(f.wallet.internalizeAction).toHaveBeenCalledTimes(1)
  expect(f.output.spendable).toBe(true)
  await expect(verifyAdvertisementMetadata(f.output.customInstructions, f.script)).resolves.toMatchObject({
    uploaderIdentityKey: owner, objectIdentifier, fileSize: body.length
  })
  await expect(migrateLegacyAdvertisement({ ...f, apply: true })).resolves.toBe('already-verified')
  expect(f.wallet.internalizeAction).toHaveBeenCalledTimes(1)
})

test.each([
  { metadata: {} },
  { metadata: { uploaderidentitykey: PrivateKey.fromRandom().toPublicKey().toString() } },
  { size: '9999' },
  { customTime: '2000-01-01T00:00:00Z' },
  { generation: '../object' }
])('rejects an unbound or invalid provider receipt before mutation: %j', async receipt => {
  const f = await fixture(receipt)
  await expect(migrateLegacyAdvertisement({ ...f, apply: true })).rejects.toThrow()
  expect(f.wallet.internalizeAction).not.toHaveBeenCalled()
})

test('rejects substituted bytes and a provider generation race', async () => {
  const f = await fixture()
  f.createReadStream.mockImplementation(() => Readable.from([Buffer.alloc(body.length)]))
  await expect(migrateLegacyAdvertisement({ ...f, apply: true })).rejects.toThrow('hash')
  f.createReadStream.mockImplementation(() => Readable.from([body]))
  f.getMetadata.mockResolvedValueOnce([f.receipt]).mockResolvedValueOnce([{ ...f.receipt, metageneration: '2' }])
  await expect(migrateLegacyAdvertisement({ ...f, apply: true })).rejects.toThrow('changed')
  expect(f.wallet.internalizeAction).not.toHaveBeenCalled()
})

test('rejects a foreign location or substituted source output before provider access', async () => {
  const f = await fixture()
  await expect(migrateLegacyAdvertisement({ ...f, hostingOrigin: 'https://other.example' })).rejects.toThrow('location')
  await expect(migrateLegacyAdvertisement({ ...f, output: { ...f.output, satoshis: 2 } })).rejects.toThrow('source transaction')
  expect(f.bucket.file).not.toHaveBeenCalled()
})
