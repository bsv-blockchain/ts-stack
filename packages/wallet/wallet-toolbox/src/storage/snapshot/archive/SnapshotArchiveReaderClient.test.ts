import type { WalletInterface } from '@bsv/sdk'
import { StorageClientBase, type StorageClientOptions } from '../../remoting/StorageClientBase'
import type { WalletReadSnapshot } from '../WalletReadSnapshot'
import { snapshotArchiveCapabilities } from './SnapshotArchiveProtocol'
import * as RemoteReader from './openRemoteSnapshot'
import { SnapshotCancelledError } from '../SnapshotCancelledError'

const identityKey = '02' + '11'.repeat(32)
class ReaderClient extends StorageClientBase {
  readonly request = jest.fn<Promise<unknown>, [string, unknown[]]>()
  constructor(options: StorageClientOptions = {}) {
    super({} as WalletInterface, 'https://storage.example.test', options)
  }
  protected async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    return (await this.request(method, params)) as T
  }
}
const settings = () => ({
  storageIdentityKey: 'reader-source',
  chain: 'test',
  snapshotArchive: { ...snapshotArchiveCapabilities },
  snapshotArchiveReaderVersion: 1
})
afterEach(() => jest.restoreAllMocks())

test('a source adapter exists before availability and negotiates the first open with detached capability state', async () => {
  const client = new ReaderClient()
  client.request.mockResolvedValue(settings())
  const source = client.getSnapshotSync()!
  expect(client.request).not.toHaveBeenCalled()
  expect(source.fallbackOnResourceError).toBe(false)
  expect(await source.supportsDestination()).toBe(false)
  const view = {} as WalletReadSnapshot
  const opening = jest.spyOn(RemoteReader, 'openRemoteSnapshot').mockResolvedValue(view)
  const options = { lifetimeMs: 1234, signal: new AbortController().signal }
  expect(await source.openSource(identityKey, options)).toBe(view)
  expect(client.request.mock.calls).toEqual([['makeAvailable', []]])
  expect(opening).toHaveBeenCalledWith(expect.objectContaining({ supportsReader: true }), options)
  client.settings!.snapshotArchiveReaderVersion = undefined
  expect((await client.getSnapshotArchiveTransport(identityKey))!.supportsReader).toBe(true)
  for (const operation of [
    source.begin(undefined as never, undefined),
    source.checkpoint('', ''),
    source.prepare(undefined as never, undefined as never)
  ])
    await expect(operation).rejects.toThrow('Remote snapshot destination is unavailable')
  expect(client.request).toHaveBeenCalledTimes(1)
})

test.each(['legacy', 'archive-only'] as const)(
  '%s peers decline before any reader request and cannot be upgraded by caller mutation',
  async variant => {
    const client = new ReaderClient()
    const advertised = settings()
    Reflect.deleteProperty(advertised, 'snapshotArchiveReaderVersion')
    if (variant === 'legacy') Reflect.deleteProperty(advertised, 'snapshotArchive')
    client.request.mockResolvedValue(advertised)
    expect(await client.getSnapshotSync()!.openSource(identityKey)).toBeUndefined()
    client.settings!.snapshotArchiveReaderVersion = 1
    const transport = await client.getSnapshotArchiveTransport(identityKey)
    expect(transport?.supportsReader).not.toBe(true)
    expect(client.request.mock.calls).toEqual([['makeAvailable', []]])
  }
)

test('the existing client rollback option disables the source adapter before network I/O', () => {
  const client = new ReaderClient({ snapshotArchives: false })
  expect(client.getSnapshotSync()).toBeUndefined()
  expect(client.request).not.toHaveBeenCalled()
})

test.each([undefined, null, 0, 2, '1', true])(
  'an invalid reader advertisement %p rejects availability',
  async version => {
    const client = new ReaderClient()
    client.request.mockResolvedValue({ ...settings(), snapshotArchiveReaderVersion: version })
    await expect(client.getSnapshotSync()!.openSource(identityKey)).rejects.toThrow('invalid settings')
    expect(client.isAvailable()).toBe(false)
  }
)

test('reader advertisement requires the original archive capability', async () => {
  const client = new ReaderClient()
  const advertised = settings()
  Reflect.deleteProperty(advertised, 'snapshotArchive')
  client.request.mockResolvedValue(advertised)
  await expect(client.makeAvailable()).rejects.toThrow('invalid settings')
})

test.each(['cancelled', 'live-signal', 'ordinary', 'inherited-code', 'accessor-code'] as const)(
  'authenticated transport %s classification preserves errors outside explicit local cancellation',
  async variant => {
    const client = new ReaderClient()
    client.request.mockResolvedValue(settings())
    const transport = (await client.getSnapshotArchiveTransport(identityKey))!
    const controller = new AbortController()
    const failure = new Error('synthetic authenticated transport refusal')
    const getter = jest.fn(() => 'ERR_PAYMENT_CANCELLED')
    if (variant === 'cancelled' || variant === 'live-signal')
      Object.defineProperty(failure, 'code', { value: 'ERR_PAYMENT_CANCELLED' })
    if (variant === 'inherited-code')
      Object.setPrototypeOf(failure, Object.create(Error.prototype, { code: { value: 'ERR_PAYMENT_CANCELLED' } }))
    if (variant === 'accessor-code') Object.defineProperty(failure, 'code', { get: getter })
    if (variant !== 'live-signal') controller.abort()
    const fetch = jest.fn().mockRejectedValue(failure)
    Reflect.set(client, 'snapshotAuthClient', { fetch })
    const opening = transport.readerOffer({ lifetimeMs: 300000, maxBytes: 32768 }, controller.signal)
    if (variant === 'cancelled') await expect(opening).rejects.toBeInstanceOf(SnapshotCancelledError)
    else await expect(opening).rejects.toBe(failure)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(getter).not.toHaveBeenCalled()
  }
)
