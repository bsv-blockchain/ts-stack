import type { WalletInterface } from '@bsv/sdk'
import { snapshotHttpFixture, gate } from '../../../../test/utils/snapshotArchiveHttpFixtures'
import { StorageClient } from '../../remoting/StorageClient'
import { snapshotArchiveRequestId } from './SnapshotArchiveRequest'

afterEach(() => jest.restoreAllMocks())

test.each(['sync-error', 'reject-error', 'reject-undefined', 'resolve-too-soon'] as const)(
  'fixture owns native resources and drains an opening capture when tested close is %s',
  async variant => {
    const fixture = await snapshotHttpFixture()
    const allowOpen = gate(),
      entered = gate(),
      failure = new Error('synthetic tested close failure')
    let pending: Promise<{ failed: boolean; reason?: unknown }> | undefined
    let restored: (() => void) | undefined
    let physicallyClosed = false,
      sourceClosureFailed = false
    try {
      const { server, url } = await fixture.serve(),
        second = await fixture.serve()
      const native = (await fixture.storage.knex.client.acquireConnection()) as { open: boolean }
      await fixture.storage.knex.client.releaseConnection(native)
      const client = new StorageClient(fixture.wallet as unknown as WalletInterface, url)
      const transport = (await client.getSnapshotArchiveTransport(fixture.identityKey))!
      const offer = await transport.offer()
      const fields = {
        version: 1 as const,
        nonce: 'e'.repeat(64),
        notAfter: offer.serverTime + 300000,
        maxBytes: 32768
      }
      const original = fixture.storage.openSnapshotArchiveSource.bind(fixture.storage)
      jest
        .spyOn(fixture.storage, 'openSnapshotArchiveSource')
        .mockImplementation(async (key, options, owner) => {
          const source = await original(key, { ...options, signal: undefined }, owner)
          if (source === undefined) throw new Error('Native archive source was unavailable')
          void source.closed.then(
            () => {
              physicallyClosed = true
            },
            () => {
              sourceClosureFailed = true
            }
          )
          entered.resolve()
          await allowOpen.promise
          return source
        })
      await transport.start({ ...fields, requestId: snapshotArchiveRequestId(fields) })
      await entered.promise
      const tested = jest.spyOn(server, 'close').mockImplementation(() => {
        if (variant === 'sync-error') throw failure
        if (variant === 'reject-error') return Promise.reject(failure)
        if (variant === 'reject-undefined') return Promise.reject(undefined)
        return Promise.resolve()
      })
      restored = () => tested.mockRestore()
      let settled = false
      pending = fixture.close().then(
        () => {
          settled = true
          return { failed: false }
        },
        reason => {
          settled = true
          return { failed: true, reason }
        }
      )
      await new Promise(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(physicallyClosed).toBe(false)
      expect(native.open).toBe(true)
      expect(server.server.listening).toBe(false)
      expect(second.server.server.listening).toBe(false)
      allowOpen.resolve()
      const result = await pending
      expect(result.failed).toBe(variant !== 'resolve-too-soon')
      if (variant === 'reject-undefined') expect(result.reason).toBeUndefined()
      else if (variant !== 'resolve-too-soon') expect(result.reason).toBe(failure)
      expect(sourceClosureFailed).toBe(false)
      expect(physicallyClosed).toBe(true)
      expect(native.open).toBe(false)
      expect(Reflect.get(fixture.storage, 'snapshotSyncSource')).toBeUndefined()
    } finally {
      allowOpen.resolve()
      restored?.()
      await pending
      await fixture.close()
    }
  }
)
