import { type WalletInterface } from '@bsv/sdk'
import { type RequestSyncChunkArgs, type SyncChunk } from '../../../sdk/WalletStorage.interfaces'
import { StorageClientBase } from '../StorageClientBase'

class RetryingStorageClient extends StorageClientBase {
  calls: RequestSyncChunkArgs[] = []
  failuresRemaining: number
  readonly failure: Error

  constructor (failures: number, failure = new Error('WalletStorageClient rpcCall: network error 413 413')) {
    super({} as WalletInterface, 'https://storage.example.test')
    this.failuresRemaining = failures
    this.failure = failure
  }

  protected async rpcCall<T> (method: string, params: unknown[]): Promise<T> {
    expect(method).toBe('getSyncChunk')
    const args = params[0] as RequestSyncChunkArgs
    this.calls.push({ ...args })
    if (this.failuresRemaining-- > 0) throw this.failure
    return {
      fromStorageIdentityKey: args.fromStorageIdentityKey,
      toStorageIdentityKey: args.toStorageIdentityKey,
      userIdentityKey: args.identityKey
    } as T
  }
}

function makeArgs (): RequestSyncChunkArgs {
  return {
    identityKey: `02${'11'.repeat(32)}`,
    fromStorageIdentityKey: `02${'22'.repeat(32)}`,
    toStorageIdentityKey: `02${'33'.repeat(32)}`,
    maxItems: 1000,
    maxRoughSize: 10_000_000,
    offsets: []
  }
}

describe('StorageClientBase sync response retry', () => {
  test('halves an oversized response budget and remembers the working limit', async () => {
    const client = new RetryingStorageClient(1)
    const args = makeArgs()

    const first = await client.getSyncChunk(args)
    const second = await client.getSyncChunk(args)

    expect(first).toMatchObject<Partial<SyncChunk>>({ userIdentityKey: args.identityKey })
    expect(second).toMatchObject<Partial<SyncChunk>>({ userIdentityKey: args.identityKey })
    expect(client.calls.map(call => call.maxRoughSize)).toEqual([10_000_000, 5_000_000, 5_000_000])
    expect(args.maxRoughSize).toBe(10_000_000)
  })

  test('does not retry unrelated network failures', async () => {
    const failure = new Error('WalletStorageClient rpcCall: network error 503 Service Unavailable')
    const client = new RetryingStorageClient(1, failure)

    await expect(client.getSyncChunk(makeArgs())).rejects.toBe(failure)
    expect(client.calls).toHaveLength(1)
  })

  test('stops after the bounded number of oversized-response retries', async () => {
    const client = new RetryingStorageClient(10)

    await expect(client.getSyncChunk(makeArgs())).rejects.toThrow('network error 413')
    expect(client.calls.map(call => call.maxRoughSize)).toEqual([
      10_000_000,
      5_000_000,
      2_500_000,
      1_250_000,
      625_000
    ])
  })
})
