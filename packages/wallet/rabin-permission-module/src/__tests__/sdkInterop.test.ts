import {
  CachedKeyDeriver,
  PrivateKey,
  validateWalletArgs,
  validateWalletResult,
  WalletClient,
  WalletWireProcessor,
  WalletWireTransceiver,
  type WalletInterface
} from '@bsv/sdk'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'
import { RabinPermissionModule } from '../index.js'
import { fromHex, keyVector, ORIGINATOR, toHex, vectors } from './helpers.js'

const K1 = keyVector('K1 2048 self')
const S1 = vectors.signatures[0]

const hostWallet = (): WalletInterface => {
  const rabin = new RabinPermissionModule({
    keyDeriver: new CachedKeyDeriver(PrivateKey.fromHex(vectors.parameters.walletA)),
    authorize: async () => true
  })
  const underlying = {} as WalletInterface
  return new WalletPermissionsManager(underlying, 'admin.wallet.example', {
    encryptWalletMetadata: false,
    permissionModules: { rabin }
  } as never) as unknown as WalletInterface
}

describe('BRC-100 carriage of p rabin results', () => {
  it('passes the SDK result validator that every WalletClient applies', () => {
    for (const vector of [...vectors.keys, ...vectors.signatures]) {
      const result = { ciphertext: fromHex(vector.response.ciphertext) }
      expect(validateWalletResult('encrypt', result)).toEqual(result)
    }
  })

  it('passes SDK argument validation at the empty, 1 MiB and 290-byte boundaries', () => {
    const longest = `p rabin sign 3072 ${'a'.repeat(272)}`
    expect(longest).toHaveLength(290)
    for (const [protocolName, plaintext] of [
      ['p rabin key 2048 example oracle', []],
      ['p rabin sign 2048 example oracle', Array.from({ length: 1024 * 1024 }, () => 0)],
      [longest, [0x61, 0x62, 0x63]]
    ] as const) {
      expect(() =>
        validateWalletArgs('encrypt', {
          protocolID: [2, protocolName],
          keyID: 'feed 1',
          counterparty: 'self',
          plaintext
        })
      ).not.toThrow()
    }
  }, 30_000)

  it('round-trips through an unmodified WalletClient', async () => {
    const client = new WalletClient(hostWallet(), ORIGINATOR)
    const key = await client.encrypt({ ...K1.request, plaintext: [] } as never)
    const signed = await client.encrypt({
      ...S1.request,
      plaintext: fromHex(S1.request.plaintext)
    } as never)
    expect(toHex(key.ciphertext)).toBe(K1.response.ciphertext)
    expect(toHex(signed.ciphertext)).toBe(S1.response.ciphertext)
  }, 30_000)

  it('round-trips through the Wallet Wire substrate', async () => {
    const wire = new WalletWireTransceiver(new WalletWireProcessor(hostWallet()))
    const signed = await wire.encrypt(
      { ...S1.request, plaintext: fromHex(S1.request.plaintext) } as never,
      ORIGINATOR
    )
    expect(toHex(signed.ciphertext)).toBe(S1.response.ciphertext)
  }, 30_000)

  it('round-trips through JSON as an HTTP substrate carries it', async () => {
    const wallet = hostWallet()
    const body = JSON.stringify({ ...S1.request, plaintext: fromHex(S1.request.plaintext) })
    const result = await wallet.encrypt(JSON.parse(body), ORIGINATOR)
    const received = JSON.parse(JSON.stringify(result)) as { ciphertext: number[] }
    expect(validateWalletResult('encrypt', received)).toEqual(received)
    expect(toHex(received.ciphertext)).toBe(S1.response.ciphertext)
  }, 30_000)

  it('documents why encrypt is the carrier: Rabin values fail getPublicKey and createSignature', () => {
    const n = K1.response.ciphertext.slice(4)
    expect(() => validateWalletResult('getPublicKey', { publicKey: n })).toThrow()
    expect(() =>
      validateWalletResult('createSignature', { signature: fromHex(S1.response.ciphertext) })
    ).toThrow()
  })
})
