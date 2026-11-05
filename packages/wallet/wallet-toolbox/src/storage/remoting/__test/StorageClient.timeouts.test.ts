import { AuthFetch, Utils, type WalletInterface } from '@bsv/sdk'
import { StorageClient } from '../StorageClient'
import { StorageClient as StorageMobile } from '../StorageMobile'

const endpoint = 'https://storage.example.test/rpc'
const identityKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

describe.each([
  ['Node/browser', StorageClient],
  ['mobile', StorageMobile]
] as const)('%s StorageClient authenticated options', (_name, Client) => {
  afterEach(() => jest.useRealTimers())

  it('forwards existing SDK response limits without changing the constructor contract', () => {
    expect(() => new Client({} as WalletInterface, endpoint)).not.toThrow()
    expect(() => new Client({} as WalletInterface, endpoint, { authFetchOptions: { maxResponseBytes: 0 } })).toThrow(
      'maxResponseBytes'
    )
  })

  it.each([
    ['default', undefined, 30_000],
    ['configured', { requestTimeoutMs: 60_000, responseTimeoutMs: 60_000 }, 60_000]
  ] as const)('uses the %s response deadline for a single RPC submission', async (_case, options, timeoutMs) => {
    jest.useFakeTimers()
    const client = new Client({} as WalletInterface, endpoint, { authFetchOptions: options })
    const auth = Reflect.get(client, 'authClient') as AuthFetch
    const peer = {
      listenForGeneralMessages: jest.fn(() => 1),
      stopListeningForGeneralMessages: jest.fn(),
      toPeer: jest.fn(async () => {})
    }
    Reflect.set(auth, 'peers', {
      'https://storage.example.test': { peer, identityKey, supportsMutualAuth: true, pendingCertificateRequests: [] }
    })
    const pending: Promise<unknown> = Reflect.get(client, 'rpcCall').call(client, 'internalizeAction', [])
    const rejected = expect(pending).rejects.toThrow('Timed out waiting for authenticated response.')

    await jest.advanceTimersByTimeAsync(timeoutMs - 1)
    expect(peer.stopListeningForGeneralMessages).not.toHaveBeenCalled()
    expect(peer.toPeer).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    await rejected
    expect(peer.stopListeningForGeneralMessages).toHaveBeenCalledWith(1)
    expect(peer.toPeer).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('accepts the authenticated RPC result after the old thirty-second deadline', async () => {
    jest.useFakeTimers()
    const client = new Client({} as WalletInterface, endpoint, {
      authFetchOptions: { requestTimeoutMs: 60_000, responseTimeoutMs: 60_000 }
    })
    const auth = Reflect.get(client, 'authClient') as AuthFetch
    let receive: ((sender: string, payload: number[]) => void) | undefined
    const peer = {
      listenForGeneralMessages: jest.fn(listener => {
        receive = listener
        return 1
      }),
      stopListeningForGeneralMessages: jest.fn(),
      toPeer: jest.fn(async (request: number[]) => {
        setTimeout(() => {
          const body = Utils.toArray(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { accepted: true } }), 'utf8')
          const response = new Utils.Writer()
          response.write(request.slice(0, 32))
          response.writeVarIntNum(200)
          response.writeVarIntNum(0)
          response.writeVarIntNum(body.length)
          response.write(body)
          receive?.(identityKey, response.toArray())
        }, 35_000)
      })
    }
    Reflect.set(auth, 'peers', {
      'https://storage.example.test': { peer, identityKey, supportsMutualAuth: true, pendingCertificateRequests: [] }
    })
    const pending: Promise<unknown> = Reflect.get(client, 'rpcCall').call(client, 'internalizeAction', [])
    await jest.advanceTimersByTimeAsync(35_000)
    await expect(pending).resolves.toEqual({ accepted: true })
    expect(peer.toPeer).toHaveBeenCalledTimes(1)
    expect(peer.stopListeningForGeneralMessages).toHaveBeenCalledWith(1)
    expect(jest.getTimerCount()).toBe(0)
  })
})
