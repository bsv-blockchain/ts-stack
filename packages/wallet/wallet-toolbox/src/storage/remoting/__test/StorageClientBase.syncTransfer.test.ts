import type { WalletInterface } from '@bsv/sdk'
import type { RequestSyncChunkArgs, SyncChunk } from '../../../sdk/WalletStorage.interfaces'
import { StorageClientBase } from '../StorageClientBase'
import { encodeSyncTransfer, syncTransferDigest } from '../SyncTransfer'

const identityKey = `02${'11'.repeat(32)}`
const fromStorageIdentityKey = `02${'22'.repeat(32)}`
const toStorageIdentityKey = `02${'33'.repeat(32)}`
const capabilities = { version: 1, maxBytes: 64 * 1024 * 1024, partBytes: 1024, inlineBytes: 1024 }
const args = (): RequestSyncChunkArgs => ({
  identityKey,
  fromStorageIdentityKey,
  toStorageIdentityKey,
  maxItems: 250,
  maxRoughSize: 1000000,
  offsets: []
})
const chunk = (): SyncChunk => ({
  userIdentityKey: identityKey,
  fromStorageIdentityKey,
  toStorageIdentityKey,
  transactions: [
    {
      transactionId: 1,
      userId: 1,
      created_at: new Date(0),
      updated_at: new Date(0),
      reference: 'synthetic-transfer-validation',
      status: 'nosend',
      isOutgoing: true,
      satoshis: 0,
      description: 'synthetic transfer validation',
      inputBEEF: Array(2048).fill(173)
    }
  ]
})

class TransferClient extends StorageClientBase {
  readonly request = jest.fn<Promise<unknown>, [string, unknown[]]>()
  constructor() {
    super({} as WalletInterface, 'https://storage.example.test', { binaryRequests: true })
    Reflect.set(this, 'settings', { syncTransfer: capabilities })
    this.serverSupportsBinary = true
  }
  protected async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    return (await this.request(method, params)) as T
  }
}

function manifest(digest: string, totalBytes: number) {
  return { transferId: 'a'.repeat(64), digest, totalBytes, partBytes: 1024, expiresAt: Date.now() + 60000 }
}

test.each([
  ['digest', { digest: '0'.repeat(64) }],
  ['length', { totalBytes: 9999 }],
  ['fractional offset', { receivedBytes: 0.5 }],
  ['negative offset', { receivedBytes: -1 }],
  ['offset beyond the frame', { receivedBytes: 99999 }],
  ['unaligned offset', { receivedBytes: 1 }]
])('rejects a mismatched upload %s before writing or committing', async (_name, invalid) => {
  const client = new TransferClient()
  client.request.mockImplementation(async (_method, params) => {
    const input = params[0] as { digest: string; totalBytes: number }
    return { ...manifest(input.digest, input.totalBytes), receivedBytes: 0, ...invalid }
  })
  await expect(client.processSyncChunk(args(), chunk())).rejects.toThrow('Invalid wallet sync upload checkpoint')
  expect(client.request.mock.calls.map(call => call[0])).toEqual(['beginWriteSyncTransfer'])
})

test('commits exactly the acknowledged frame and releases staging after a successful upload', async () => {
  const client = new TransferClient()
  const parts: Uint8Array[] = []
  const result = { done: true, inserts: 1, updates: 0 }
  let expectedDigest = ''
  client.request.mockImplementation(async (method, params) => {
    const input = params[0] as { digest: string; totalBytes: number; offset: number; bytes: Uint8Array }
    if (method === 'beginWriteSyncTransfer') {
      expectedDigest = input.digest
      return { ...manifest(input.digest, input.totalBytes), receivedBytes: 0 }
    }
    if (method === 'writeSyncTransferPart') {
      expect(input.offset).toBe(parts.reduce((size, part) => size + part.length, 0))
      parts.push(input.bytes)
      return input.offset + input.bytes.length
    }
    if (method === 'commitSyncTransfer') {
      expect(syncTransferDigest(Uint8Array.from(parts.flatMap(part => Array.from(part))))).toBe(expectedDigest)
      return result
    }
    if (method === 'releaseSyncTransfer') return true
    throw new Error('Unexpected RPC')
  })
  await expect(client.processSyncChunk(args(), chunk())).resolves.toEqual(result)
  expect(parts.length).toBeGreaterThan(1)
  expect(client.request.mock.calls.slice(-2).map(call => call[0])).toEqual([
    'commitSyncTransfer',
    'releaseSyncTransfer'
  ])
  expect(client.request.mock.calls.filter(call => call[0] === 'commitSyncTransfer')).toHaveLength(1)
})

test('rejects an invalid part acknowledgement without committing or removing resumable staging', async () => {
  const client = new TransferClient()
  client.request.mockImplementation(async (method, params) => {
    const input = params[0] as { digest: string; totalBytes: number }
    return method === 'beginWriteSyncTransfer' ? { ...manifest(input.digest, input.totalBytes), receivedBytes: 0 } : -1
  })
  await expect(client.processSyncChunk(args(), chunk())).rejects.toThrow('Invalid wallet sync upload acknowledgement')
  expect(client.request.mock.calls.map(call => call[0])).toEqual(['beginWriteSyncTransfer', 'writeSyncTransferPart'])
})

test('rejects a frame above the provider ceiling before allocating remote staging', async () => {
  const client = new TransferClient()
  Reflect.set(client, 'settings', { syncTransfer: { ...capabilities, maxBytes: 1024 } })
  await expect(client.processSyncChunk(args(), chunk())).rejects.toThrow('negotiated transfer size limit')
  expect(client.request).not.toHaveBeenCalled()
})

test.each(['userIdentityKey', 'fromStorageIdentityKey', 'toStorageIdentityKey'] as const)(
  'rejects a hash-valid download with a different %s and releases its staging',
  async field => {
    const client = new TransferClient()
    const bytes = encodeSyncTransfer({
      userIdentityKey: identityKey,
      fromStorageIdentityKey,
      toStorageIdentityKey,
      [field]: `02${'44'.repeat(32)}`
    })
    client.request.mockImplementation(async method => {
      if (method === 'getSyncChunk') return { syncTransfer: manifest(syncTransferDigest(bytes), bytes.length) }
      if (method === 'readSyncTransferPart') return { offset: 0, bytes }
      if (method === 'releaseSyncTransfer') return true
      throw new Error('Unexpected RPC')
    })
    await expect(client.getSyncChunk(args())).rejects.toThrow('Wallet sync transfer identities changed')
    expect(client.request.mock.calls.at(-1)?.[0]).toBe('releaseSyncTransfer')
  }
)
