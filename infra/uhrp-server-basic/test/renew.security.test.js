process.env.SERVER_PRIVATE_KEY = '33'.repeat(32)
process.env.BSV_NETWORK = 'testnet'
process.env.PRICE_PER_GB_MO = '1'

const {
  PrivateKey,
  ProtoWallet,
  PushDrop,
  Script,
  SHIPBroadcaster,
  StorageUtils,
  Transaction,
  Utils
} = require('@bsv/sdk')

let mockListResult
let partial
const serverWallet = new ProtoWallet(new PrivateKey(process.env.SERVER_PRIVATE_KEY, 'hex'))
const mockWallet = {
  getPublicKey: async args => await serverWallet.getPublicKey(args),
  createSignature: async args => await serverWallet.createSignature(args),
  verifySignature: async args => await serverWallet.verifySignature(args),
  listOutputs: jest.fn(async () => mockListResult),
  createAction: jest.fn(async args => {
    partial = new Transaction()
    partial.addInput({
      sourceTXID: '55'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_0')
    })
    for (const input of args.inputs ?? []) {
      const [sourceTXID, outputIndex] = input.outpoint.split('.')
      partial.addInput({
        sourceTXID,
        sourceOutputIndex: Number(outputIndex),
        unlockingScript: Script.fromASM('OP_0')
      })
    }
    for (const output of args.outputs ?? []) {
      partial.addOutput({ satoshis: output.satoshis, lockingScript: Script.fromHex(output.lockingScript) })
    }
    return {
      signableTransaction: {
        reference: 'cmVuZXctc2VjdXJpdHk=',
        tx: partial.toAtomicBEEF(true)
      }
    }
  }),
  signAction: jest.fn(async args => {
    const signed = Transaction.fromAtomicBEEF(partial.toAtomicBEEF(true))
    for (const [index, spend] of Object.entries(args.spends)) {
      signed.inputs[Number(index)].unlockingScript = Script.fromHex(spend.unlockingScript)
    }
    return { tx: signed.toAtomicBEEF(true), txid: signed.id('hex') }
  }),
  abortAction: jest.fn(async () => ({ aborted: true }))
}
const mockExtendRootLease = jest.fn(async () => true)

jest.mock('../out/src/utils/walletSingleton', () => ({
  getWallet: jest.fn(async () => mockWallet)
}))
jest.mock('../out/src/utils/getPriceForFile', () => ({
  __esModule: true,
  default: jest.fn(async () => 37)
}))
jest.mock('../out/src/chirp/store', () => ({
  getChirpStore: () => ({ extendRootLease: mockExtendRootLease })
}))

const {
  advertisementTags,
  createAdvertisementMetadata
} = require('../out/src/utils/advertisementMetadata')
const renewRoute = require('../out/src/routes/renew').default

const uploaderIdentityKey = PrivateKey.fromRandom().toPublicKey().toString()
const hash = Array.from({ length: 32 }, (_, index) => index + 1)
const uhrpUrl = StorageUtils.getURLForHash(hash)
const objectIdentifier = '4ERpjBqLFEgiyi'
const hostedFileLocation = `https://files.example/cdn/${objectIdentifier}`

async function prepareSource() {
  const identity = await serverWallet.getPublicKey({ identityKey: true })
  const expiryTime = Math.floor(Date.now() / 1000) + 3600
  const lockingScript = await new PushDrop(serverWallet).lock(
    [
      Utils.toArray(identity.publicKey, 'hex'),
      hash,
      Utils.toArray(hostedFileLocation, 'utf8'),
      new Utils.Writer().writeVarIntNum(expiryTime).toArray(),
      new Utils.Writer().writeVarIntNum(500).toArray()
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
    fileSize: 500,
    contentType: 'application/octet-stream'
  })
  const source = new Transaction()
  source.addOutput({ satoshis: 1, lockingScript })
  mockListResult = {
    totalOutputs: 1,
    outputs: [{
      outpoint: `${source.id('hex')}.0`,
      satoshis: 1,
      spendable: true,
      customInstructions: signed.customInstructions,
      tags: advertisementTags(signed.metadata)
    }],
    BEEF: source.toBEEF()
  }
  return expiryTime
}

function response() {
  return {
    statusCode: 0,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
}

beforeEach(async () => {
  jest.clearAllMocks()
  await prepareSource()
  jest.spyOn(SHIPBroadcaster.prototype, 'broadcast').mockImplementation(async tx => ({
    status: 'success',
    txid: tx.id('hex'),
    message: 'accepted'
  }))
})

afterEach(() => jest.restoreAllMocks())

test('prices authenticated size, signs the selected input index, and binds overlay success', async () => {
  const res = response()
  await renewRoute.func({
    auth: { identityKey: uploaderIdentityKey },
    body: { uhrpUrl, additionalMinutes: 60 }
  }, res)

  expect(res.statusCode).toBe(200)
  expect(res.body).toMatchObject({ status: 'success', amount: 37 })
  expect(mockWallet.signAction.mock.calls[0][0].spends).toHaveProperty('1')
  expect(mockExtendRootLease).toHaveBeenCalledWith(objectIdentifier, expect.any(Number))
})

test('does not report renewal success when the overlay rejects the replacement', async () => {
  jest.spyOn(SHIPBroadcaster.prototype, 'broadcast').mockResolvedValue({
    status: 'error',
    code: 'ERR_NO_HOSTS_INTERESTED',
    description: 'No host accepted the advertisement.'
  })
  const res = response()
  await renewRoute.func({
    auth: { identityKey: uploaderIdentityKey },
    body: { uhrpUrl, additionalMinutes: 60 }
  }, res)

  expect(res.statusCode).toBe(502)
  expect(res.body).toMatchObject({ status: 'error', code: 'ERR_ADVERTISEMENT_BROADCAST' })
})
