process.env.SERVER_PRIVATE_KEY = '55'.repeat(32)
const { PrivateKey, ProtoWallet, PushDrop, Utils, Transaction, Script } = require('@bsv/sdk')
const mockListOutputs = jest.fn()
jest.mock('../walletSingleton', () => ({ getWallet: async () => ({ listOutputs: mockListOutputs }) }))
const { listVerifiedAdvertisements } = require('../storedAdvertisements')
const { advertisementTags, createAdvertisementMetadata } = require('../advertisementMetadata')
const wallet = new ProtoWallet(PrivateKey.fromHex(process.env.SERVER_PRIVATE_KEY))
const owner = PrivateKey.fromRandom().toPublicKey().toString()

async function fixture() {
  const hash = Array(32).fill(12)
  const metadata = createAdvertisementMetadata({ objectIdentifier: '3mJr7AoUXx2Wqd', uploaderIdentityKey: owner,
    hostedFileLocation: 'https://files.example/cdn/3mJr7AoUXx2Wqd', hash,
    expiryTime: 2_000_000_000, fileSize: 100, contentType: 'application/octet-stream' })
  const script = await new PushDrop(wallet).lock([
    Utils.toArray((await wallet.getPublicKey({ identityKey: true })).publicKey, 'hex'), hash,
    Utils.toArray(metadata.metadata.hostedFileLocation, 'utf8'),
    new Utils.Writer().writeVarIntNum(2_000_000_000).toArray(), new Utils.Writer().writeVarIntNum(100).toArray()
  ], [2, 'uhrp advertisement'], '1', 'anyone', true)
  const tx = new Transaction()
  tx.addInput({ sourceTXID: '66'.repeat(32), sourceOutputIndex: 0, unlockingScript: Script.fromASM('OP_0') })
  tx.addOutput({ satoshis: 1, lockingScript: script })
  tx.addOutput({ satoshis: 1, lockingScript: script })
  const legacy = { outpoint: `${tx.id('hex')}.0`, spendable: true, satoshis: 1, tags: advertisementTags(metadata.metadata) }
  const signed = { ...legacy, outpoint: `${tx.id('hex')}.1`, customInstructions: metadata.customInstructions }
  return { BEEF: tx.toBEEF(true), legacy, signed }
}

beforeEach(() => jest.clearAllMocks())

test('reports unsigned legacy rows and pagination while returning verified rows', async () => {
  const f = await fixture()
  mockListOutputs.mockResolvedValue({ outputs: [f.legacy, f.signed], totalOutputs: 3, BEEF: f.BEEF })
  const result = await listVerifiedAdvertisements({ uploaderIdentityKey: owner, limit: 2, offset: 0 })
  expect(result.legacyAdvertisementsPending).toBe(1)
  expect(result.nextOffset).toBe(2)
  expect(result.advertisements.map(a => a.outpoint)).toEqual([f.signed.outpoint])
})

test('accepts recovered signed ownership with original lookup tags', async () => {
  const f = await fixture()
  f.signed.tags = f.signed.tags.slice(0, 4)
  mockListOutputs.mockResolvedValue({ outputs: [f.signed], totalOutputs: 1, BEEF: f.BEEF })
  const result = await listVerifiedAdvertisements({ uploaderIdentityKey: owner, limit: 2, offset: 0 })
  expect(result.advertisements).toHaveLength(1)
  expect(result.nextOffset).toBeUndefined()
})

test('preserves signature, owner-selector, descriptive-tag, and duplicate checks', async () => {
  const f = await fixture()
  mockListOutputs.mockResolvedValue({ outputs: [{ ...f.signed, customInstructions: '{}' }], totalOutputs: 1, BEEF: f.BEEF })
  await expect(listVerifiedAdvertisements({ limit: 2, offset: 0 })).rejects.toThrow('malformed')
  mockListOutputs.mockResolvedValue({ outputs: [f.signed], totalOutputs: 1, BEEF: f.BEEF })
  await expect(listVerifiedAdvertisements({ uploaderIdentityKey: PrivateKey.fromRandom().toPublicKey().toString(), limit: 2, offset: 0 })).rejects.toThrow('selector')
  mockListOutputs.mockResolvedValue({ outputs: [{ ...f.signed, tags: [...f.signed.tags, 'size_999'] }], totalOutputs: 1, BEEF: f.BEEF })
  await expect(listVerifiedAdvertisements({ limit: 2, offset: 0 })).rejects.toThrow('signed metadata')
  mockListOutputs.mockResolvedValue({ outputs: [f.legacy, f.legacy], totalOutputs: 2, BEEF: f.BEEF })
  await expect(listVerifiedAdvertisements({ limit: 2, offset: 0 })).rejects.toThrow('duplicate')
})
