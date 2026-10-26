process.env.SERVER_PRIVATE_KEY = '11'.repeat(32)
process.env.BSV_NETWORK = 'testnet'
process.env.WALLET_STORAGE_URL = 'http://localhost:3000'

const {
  PrivateKey,
  ProtoWallet,
  Script,
  SHIPBroadcaster,
  Transaction
} = require('@bsv/sdk')

const serverKey = new PrivateKey(process.env.SERVER_PRIVATE_KEY, 'hex')
const cryptoWallet = new ProtoWallet(serverKey)
let partial

const mockWallet = {
  getPublicKey: async args => await cryptoWallet.getPublicKey(args),
  createSignature: async args => await cryptoWallet.createSignature(args),
  verifySignature: async args => await cryptoWallet.verifySignature(args),
  createAction: jest.fn(async args => {
    partial = new Transaction()
    partial.addInput({
      sourceTXID: '44'.repeat(32),
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
      signableTransaction: {
        reference: 'dWhycC1hZC10ZXN0',
        tx: partial.toAtomicBEEF(true)
      }
    }
  }),
  signAction: jest.fn(async () => ({
    tx: partial.toAtomicBEEF(true),
    txid: partial.id('hex')
  })),
  abortAction: jest.fn(async () => ({ aborted: true }))
}

jest.mock('../out/src/utils/walletSingleton', () => ({
  getWallet: jest.fn(async () => mockWallet)
}))

const {
  default: createUHRPAdvertisement,
  createUHRPAdvertisementWithResult
} = require('../out/src/utils/createUHRPAdvertisement')

const valid = {
  hash: Array.from({ length: 32 }, (_, index) => index),
  objectIdentifier: '2NEpo7TZRRrLZSi2U',
  url: 'https://files.example/cdn/2NEpo7TZRRrLZSi2U',
  expiryTime: 2_000_000_000,
  contentLength: 100,
  uploaderIdentityKey: PrivateKey.fromRandom().toPublicKey().toString(),
  contentType: 'application/octet-stream'
}

beforeEach(() => {
  jest.restoreAllMocks()
  jest.spyOn(SHIPBroadcaster.prototype, 'broadcast').mockImplementation(async tx => ({
    status: 'success',
    txid: tx.id('hex'),
    message: 'accepted'
  }))
})

test('returns an authenticated bound advertisement after positive overlay acknowledgement', async () => {
  const result = await createUHRPAdvertisement(valid)
  expect(result.txid).toMatch(/^[0-9a-f]{64}$/)
  expect(mockWallet.createAction).toHaveBeenCalledTimes(1)
  expect(mockWallet.signAction).toHaveBeenCalledTimes(1)
})

test('exposes a broadcast failure to CHIRP callers and fails the legacy success wrapper closed', async () => {
  const broadcastResult = {
    status: 'error',
    code: 'ERR_NO_HOSTS_INTERESTED',
    description: 'No hosts accepted the advertisement.'
  }
  jest.spyOn(SHIPBroadcaster.prototype, 'broadcast').mockResolvedValue(broadcastResult)

  await expect(createUHRPAdvertisementWithResult(valid)).resolves.toMatchObject({ broadcastResult })
  await expect(createUHRPAdvertisement(valid)).rejects.toThrow('was not accepted')
})

test('rejects malformed advertisement fields before asking the wallet to create an action', async () => {
  await expect(
    createUHRPAdvertisementWithResult({ ...valid, hash: [1, 2, 3] })
  ).rejects.toThrow('Invalid UHRP advertisement')
})
