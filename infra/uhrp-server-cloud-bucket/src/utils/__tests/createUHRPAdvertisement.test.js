process.env.SERVER_PRIVATE_KEY = '44'.repeat(32)
process.env.BSV_NETWORK = 'testnet'
process.env.WALLET_STORAGE_URL = 'http://localhost:3000'

const {
  PrivateKey,
  ProtoWallet,
  Script,
  SHIPBroadcaster,
  StorageUtils,
  Transaction
} = require('@bsv/sdk')

const cryptoWallet = new ProtoWallet(new PrivateKey(process.env.SERVER_PRIVATE_KEY, 'hex'))
let partial
const mockWallet = {
  getPublicKey: async args => await cryptoWallet.getPublicKey(args),
  createSignature: async args => await cryptoWallet.createSignature(args),
  verifySignature: async args => await cryptoWallet.verifySignature(args),
  createAction: jest.fn(async args => {
    partial = new Transaction()
    partial.addInput({
      sourceTXID: '66'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_0')
    })
    for (const output of args.outputs ?? []) {
      partial.addOutput({
        satoshis: output.satoshis,
        lockingScript: Script.fromHex(output.lockingScript)
      })
    }
    return {
      signableTransaction: { reference: 'Y2xvdWQtYWR2ZXJ0', tx: partial.toAtomicBEEF(true) }
    }
  }),
  signAction: jest.fn(async () => ({ tx: partial.toAtomicBEEF(true), txid: partial.id('hex') })),
  abortAction: jest.fn(async () => ({ aborted: true }))
}

jest.mock('@bsv/wallet-toolbox', () => ({
  Setup: { createWalletClientNoEnv: jest.fn(async () => mockWallet) }
}))

const {
  default: createUHRPAdvertisement,
  createUHRPAdvertisementWithResult
} = require('../createUHRPAdvertisement')

const hash = Array.from({ length: 32 }, (_, index) => index)
const valid = {
  hash,
  objectIdentifier: '5HueCGU8rMjxEXxiPuD5BDu',
  url: 'https://files.example/cdn/5HueCGU8rMjxEXxiPuD5BDu',
  expiryTime: 2_000_000_000,
  contentLength: 100,
  uploaderIdentityKey: PrivateKey.fromRandom().toPublicKey().toString(),
  contentType: 'application/octet-stream'
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.restoreAllMocks()
  jest.spyOn(SHIPBroadcaster.prototype, 'broadcast').mockImplementation(async tx => ({
    status: 'success',
    txid: tx.id('hex'),
    message: 'accepted'
  }))
})

afterEach(() => jest.restoreAllMocks())

it('creates a cryptographically authenticated, bound UHRP advertisement', async () => {
  await expect(createUHRPAdvertisement(valid)).resolves.toMatchObject({
    txid: expect.stringMatching(/^[0-9a-f]{64}$/)
  })
})

it('accepts the canonical UHRP URL form of a hash', async () => {
  await expect(
    createUHRPAdvertisement({ ...valid, hash: StorageUtils.getURLForHash(hash) })
  ).resolves.toMatchObject({ txid: expect.any(String) })
})

it('creates an authenticated advertisement for a CHIRP root at its real serving path', async () => {
  const root = StorageUtils.getURLForHash(hash)
  await expect(
    createUHRPAdvertisement({
      ...valid,
      objectIdentifier: root,
      url: `https://files.example/chirp/v1/${root}/objects/${root}`
    })
  ).resolves.toMatchObject({ txid: expect.stringMatching(/^[0-9a-f]{64}$/) })
})

it('exposes failure to CHIRP and fails the legacy success wrapper closed', async () => {
  const broadcastResult = {
    status: 'error',
    code: 'ERR_NO_HOSTS_INTERESTED',
    description: 'No host accepted.'
  }
  jest.spyOn(SHIPBroadcaster.prototype, 'broadcast').mockResolvedValue(broadcastResult)
  await expect(createUHRPAdvertisementWithResult(valid)).resolves.toMatchObject({ broadcastResult })
  await expect(createUHRPAdvertisement(valid)).rejects.toThrow('was not accepted')
})
