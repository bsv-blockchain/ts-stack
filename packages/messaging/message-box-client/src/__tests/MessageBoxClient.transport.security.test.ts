import {
  PrivateKey,
  ProtoWallet,
  PushDrop,
  Transaction,
  Utils,
  type WalletInterface
} from '@bsv/sdk'
import { jest } from '@jest/globals'
import { MessageBoxClient } from '../MessageBoxClient.js'

const WALLET_IDENTITY_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const SERVER_A = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const SERVER_B = '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'

function wallet(publicKey: unknown = WALLET_IDENTITY_KEY): WalletInterface {
  return {
    getPublicKey: jest.fn().mockResolvedValue({ publicKey })
  } as unknown as WalletInterface
}

function response(identityKey?: string): Response {
  const headers = new Headers()
  if (identityKey !== undefined) headers.set('x-bsv-auth-identity-key', identityKey)
  return new Response(JSON.stringify({ status: 'success', messages: [], hasMore: false }), {
    status: 200,
    headers
  })
}

async function advertisement(
  signer: PrivateKey,
  advertisedIdentityKey: string,
  host = 'https://messages.example.org'
): Promise<{ beef: number[]; outputIndex: number }> {
  const signerWallet = new ProtoWallet(signer)
  const script = await new PushDrop(signerWallet).lock(
    [Utils.toArray(advertisedIdentityKey, 'hex'), Utils.toArray(host, 'utf8')],
    [1, 'messagebox advertisement'],
    '1',
    'anyone',
    true
  )
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: script })
  return { beef: tx.toBEEF(), outputIndex: 0 }
}

describe('MessageBoxClient authenticated transport boundary', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('rejects an ordinary AuthFetch fallback response', async () => {
    const client = new MessageBoxClient({
      host: 'https://message-box.example/api',
      walletClient: wallet()
    })
    jest.spyOn(client.authFetch, 'fetch').mockResolvedValue(response())

    await expect(
      client.listMessagesLite({ messageBox: 'inbox', host: 'https://message-box.example/api' })
    ).rejects.toThrow('mutually authenticated response')
  })

  it('pins the first authenticated identity independently for each origin', async () => {
    const client = new MessageBoxClient({ walletClient: wallet() })
    const fetch = jest
      .spyOn(client.authFetch, 'fetch')
      .mockResolvedValueOnce(response(SERVER_A))
      .mockResolvedValueOnce(response(SERVER_B))
      .mockResolvedValueOnce(response(SERVER_B))

    await expect(
      client.listMessagesLite({ messageBox: 'inbox', host: 'https://one.example/api' })
    ).resolves.toEqual([])
    await expect(
      client.listMessagesLite({ messageBox: 'inbox', host: 'https://one.example/other' })
    ).rejects.toThrow('identity changed')
    await expect(
      client.listMessagesLite({ messageBox: 'inbox', host: 'https://two.example/api' })
    ).resolves.toEqual([])
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('enforces explicit per-origin identity pins and rejects conflicting configuration', async () => {
    const client = new MessageBoxClient({
      walletClient: wallet(),
      serverIdentityKeysByHost: {
        'https://message-box.example/api': SERVER_A
      }
    })
    jest.spyOn(client.authFetch, 'fetch').mockResolvedValue(response(SERVER_B))

    await expect(
      client.listMessagesLite({ messageBox: 'inbox', host: 'https://message-box.example/other' })
    ).rejects.toThrow('does not match the pin')

    expect(
      () =>
        new MessageBoxClient({
          walletClient: wallet(),
          serverIdentityKeysByHost: {
            'https://message-box.example/a': SERVER_A,
            'https://message-box.example/b': SERVER_B
          }
        })
    ).toThrow('Conflicting Message Box server identity pins')
  })

  it('rejects malformed server pins and wallet identity results', async () => {
    const hostilePins = Object.defineProperty({}, 'https://message-box.example', {
      enumerable: true,
      get: () => SERVER_A
    })
    expect(
      () =>
        new MessageBoxClient({
          walletClient: wallet(),
          serverIdentityKeysByHost: hostilePins as Record<string, string>
        })
    ).toThrow('plain own-data record')

    const client = new MessageBoxClient({ walletClient: wallet('02not-a-key') })
    await expect(client.getIdentityKey()).rejects.toThrow('Identity key retrieval failed')
  })
})

describe('MessageBoxClient advertisement authority', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('accepts only a canonical advertisement independently signed by the requested identity', async () => {
    const identity = PrivateKey.fromRandom()
    const identityKey = identity.toPublicKey().toString()
    const client = new MessageBoxClient({ walletClient: wallet(identityKey) })
    jest.spyOn((client as any).lookupResolver, 'query').mockResolvedValue({
      type: 'output-list',
      outputs: [await advertisement(identity, identityKey)]
    })

    await expect(client.queryAdvertisements(identityKey)).resolves.toEqual([
      expect.objectContaining({
        host: 'https://messages.example.org',
        outputIndex: 0
      })
    ])
  })

  it('rejects identity substitution and invalid advertisement signatures', async () => {
    const requested = PrivateKey.fromRandom()
    const attacker = PrivateKey.fromRandom()
    const requestedIdentityKey = requested.toPublicKey().toString()
    const attackerIdentityKey = attacker.toPublicKey().toString()
    const client = new MessageBoxClient({ walletClient: wallet(requestedIdentityKey) })
    const query = jest.spyOn((client as any).lookupResolver, 'query')

    query.mockResolvedValueOnce({
      type: 'output-list',
      outputs: [await advertisement(attacker, attackerIdentityKey)]
    })
    await expect(client.queryAdvertisements(requestedIdentityKey)).resolves.toEqual([])

    query.mockResolvedValueOnce({
      type: 'output-list',
      outputs: [await advertisement(attacker, requestedIdentityKey)]
    })
    await expect(client.queryAdvertisements(requestedIdentityKey)).resolves.toEqual([])
  })

  it('bounds output count and rejects sparse, malformed, and out-of-range entries', async () => {
    const identity = PrivateKey.fromRandom()
    const identityKey = identity.toPublicKey().toString()
    const client = new MessageBoxClient({ walletClient: wallet(identityKey) })
    const query = jest.spyOn((client as any).lookupResolver, 'query')

    query.mockResolvedValueOnce({
      type: 'output-list',
      outputs: Array.from({ length: 257 }, () => ({ beef: [0], outputIndex: 0 }))
    })
    await expect(client.queryAdvertisements(identityKey)).resolves.toEqual([])

    const sparse: unknown[] = []
    sparse.length = 1
    query.mockResolvedValueOnce({ type: 'output-list', outputs: sparse })
    await expect(client.queryAdvertisements(identityKey)).resolves.toEqual([])

    const valid = await advertisement(identity, identityKey)
    query.mockResolvedValueOnce({
      type: 'output-list',
      outputs: [
        { ...valid, outputIndex: 1 },
        { beef: [0], outputIndex: 0 }
      ]
    })
    await expect(client.queryAdvertisements(identityKey)).resolves.toEqual([])
  })
})
