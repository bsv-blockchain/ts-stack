import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { StorageClient } from '../../remoting/StorageClient'
import { StorageClient as StorageMobile } from '../../remoting/StorageMobile'
import { KnexSnapshotArchiveService } from './KnexSnapshotArchiveService'
import { snapshotArchiveRequestId } from './SnapshotArchiveRequest'
import { snapshotArchiveCapabilities } from './SnapshotArchiveProtocol'
import { snapshotHttpFixture, gate } from '../../../../test/utils/snapshotArchiveHttpFixtures'
import { decodeSyncTransfer } from '../../remoting/SyncTransfer'

afterEach(() => jest.restoreAllMocks())

test.each([StorageClient, StorageMobile])(
  'authenticated %p capture survives lost admission and server replacement without recapture',
  async Client => {
    const fixture = await snapshotHttpFixture()
    const allowOpen = gate()
    try {
      const { storage, identityKey, wallet, serve } = fixture
      let { server, url } = await serve()
      let client = new Client(wallet, url, {
        serverIdentityKey: fixture.serverIdentityKey,
        storageIdentityKey: 'http-snapshot-source'
      })
      const settings = await client.makeAvailable()
      const ordinaryRpc = Reflect.get(client, 'rpcCall').bind(client)
      await expect(ordinaryRpc('releaseSyncTransfer', [{ identityKey, transferId: 'e'.repeat(64) }])).rejects.toThrow(
        'Wallet sync transfer expired'
      )
      await expect(
        ordinaryRpc('readSyncTransferPart', [{ identityKey, transferId: 'e'.repeat(64), offset: 0 }])
      ).rejects.toThrow('Wallet sync transfer expired')
      expect(settings.snapshotArchive).toEqual(snapshotArchiveCapabilities)
      expect(storage.getSettings()).not.toHaveProperty('snapshotArchive')
      let transport = (await client.getSnapshotArchiveTransport(identityKey))!
      const offer = await transport.offer()
      expect(offer.sourceSchema).toBe('2026-10-01-001 add snapshot archive source owners')
      expect(Math.abs(offer.serverTime - Date.now())).toBeLessThan(5000)
      const fields = {
        version: 1 as const,
        nonce: 'a'.repeat(64),
        notAfter: offer.serverTime + 300000,
        maxBytes: 32768
      }
      const request = { ...fields, requestId: snapshotArchiveRequestId(fields) }
      const entered = gate()
      const original = storage.openSnapshotArchiveSource.bind(storage)
      const opening = jest.spyOn(storage, 'openSnapshotArchiveSource').mockImplementation(async (...args) => {
        entered.resolve()
        await allowOpen.promise
        return await original(...args)
      })
      const rpc = Reflect.get(client, 'snapshotRpcCall').bind(client)
      const lost = jest.spyOn(client as never, 'snapshotRpcCall' as never).mockImplementation((async (
        method: string,
        params: unknown[],
        signal?: AbortSignal
      ) => {
        const response = await rpc(method, params, signal)
        if (method === 'startSnapshotArchive') throw new Error('synthetic lost admission acknowledgement')
        return response
      }) as never)
      await expect(transport.start(request)).rejects.toThrow('lost admission')
      await entered.promise
      lost.mockRestore()
      expect((await transport.status(request)).state).toBe('building')
      expect((await transport.start(request)).state).toBe('building')
      expect(opening).toHaveBeenCalledTimes(1)
      // A foreground write is possible while the owned reader is opening.
      await storage.knex('tx_labels').where({ txLabelId: 1 }).update({ label: 'foreground' })
      const controller = Reflect.get(Reflect.get(server, 'snapshotArchives'), 'service') as KnexSnapshotArchiveService
      allowOpen.resolve()
      const ready = await controller.create(identityKey, request)
      expect(await transport.status(request)).toEqual(ready)
      const verified = await transport.directory(ready, offer, Date.now())
      expect(verified.manifest.pages).toBe(13)
      const page = await transport.page(verified, verified.tables.txLabels.first)
      const decoded = decodeSyncTransfer(page) as { table: string; rows: unknown[] }
      expect(decoded.table).toBe('txLabels')
      expect(decoded.rows).toEqual([
        expect.objectContaining({ txLabelId: 1, label: 'foreground', isDeleted: false }),
        expect.objectContaining({ txLabelId: 3, isDeleted: true })
      ])
      expect(JSON.stringify(ready)).not.toMatch(/claimToken|writerToken/)
      expect(JSON.stringify(verified)).not.toMatch(/claimToken|writerToken/)

      const strangerKey = PrivateKey.fromRandom()
      const stranger = new Client(new ProtoWallet(strangerKey), url)
      const foreignTransport = (await stranger.getSnapshotArchiveTransport(identityKey))!
      await expect(foreignTransport.offer()).rejects.toThrow('match authentication')
      await expect(foreignTransport.start(request)).rejects.toThrow('match authentication')
      await expect(foreignTransport.status(request)).rejects.toThrow('match authentication')
      await expect(foreignTransport.cancel(request.requestId)).rejects.toThrow('match authentication')
      const ownForeign = (await stranger.getSnapshotArchiveTransport(strangerKey.toPublicKey().toString()))!
      await expect(ownForeign.status(request)).rejects.toThrow('unavailable')
      await expect(ownForeign.page(verified, 0)).rejects.toThrow('unavailable')
      await ownForeign.cancel(request.requestId)
      expect(await transport.status(request)).toEqual(ready)

      await server.close()
      ;({ server, url } = await serve())
      client = new Client(wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
      transport = (await client.getSnapshotArchiveTransport(identityKey))!
      expect(await transport.start(request)).toEqual(ready)
      expect(opening).toHaveBeenCalledTimes(1)
      expect(
        await transport.page(await transport.directory(ready, offer, Date.now()), verified.tables.txLabels.first)
      ).toEqual(page)
      await transport.cancel(request.requestId)
      expect((await transport.start(request)).state).toBe('closed')
      await expect(transport.page(verified, 0)).rejects.toThrow('unavailable')
      expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
    } finally {
      allowOpen.resolve()
      await fixture.close()
    }
  }
)

test.each(['server-disabled', 'provider-disabled', 'small-response', 'old-schema'] as const)(
  'does not advertise snapshot transport for %s and legacy RPC still works',
  async variant => {
    const fixture = await snapshotHttpFixture(variant !== 'provider-disabled')
    try {
      if (variant === 'old-schema') await fixture.storage.knex.schema.dropTable('snapshot_archive_requests')
      const { url } = await fixture.serve({
        snapshotArchives: variant !== 'server-disabled',
        ...(variant === 'small-response' ? { maxRpcResponseBytes: 8192 } : {})
      })
      const client = new StorageClient(fixture.wallet, url)
      expect((await client.makeAvailable()).snapshotArchive).toBeUndefined()
      expect(await client.getSnapshotArchiveTransport(fixture.identityKey)).toBeUndefined()
      expect((await client.findOrInsertUser(fixture.identityKey)).user.identityKey).toBe(fixture.identityKey)
      const rpc = Reflect.get(client, 'rpcCall').bind(client)
      await expect(rpc('getSnapshotArchiveOffer', [{ version: 1, identityKey: fixture.identityKey }])).rejects.toThrow(
        variant === 'server-disabled' || variant === 'small-response' ? 'network error 400' : 'unavailable'
      )
    } finally {
      await fixture.close()
    }
  }
)

test('client rollback disables snapshots; small capture budget has a durable distinct resource-limit receipt', async () => {
  const fixture = await snapshotHttpFixture()
  try {
    const { server, url } = await fixture.serve()
    const disabled = new StorageMobile(fixture.wallet, url, { snapshotArchives: false })
    expect(await disabled.getSnapshotArchiveTransport(fixture.identityKey)).toBeUndefined()
    const client = new StorageClient(fixture.wallet, url)
    const transport = (await client.getSnapshotArchiveTransport(fixture.identityKey))!
    const offer = await transport.offer()
    const fields = { version: 1 as const, nonce: 'b'.repeat(64), notAfter: offer.serverTime + 300000, maxBytes: 4097 }
    const request = { ...fields, requestId: snapshotArchiveRequestId(fields) }
    expect((await transport.start(request)).state).toBe('building')
    const service = Reflect.get(Reflect.get(server, 'snapshotArchives'), 'service') as KnexSnapshotArchiveService
    await service.create(fixture.identityKey, request).catch(() => undefined)
    expect((await transport.status(request)).state).toBe('resource-limited')
    expect((await transport.start(request)).state).toBe('resource-limited')
    expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
      archives: 0,
      reservedBytes: 0
    })
  } finally {
    await fixture.close()
  }
})

test('server close fences admission and awaits opening capture, physical pool cleanup and HTTP callback', async () => {
  const fixture = await snapshotHttpFixture()
  const allowOpen = gate()
  try {
    const { server, url } = await fixture.serve()
    const client = new StorageClient(fixture.wallet, url)
    const transport = (await client.getSnapshotArchiveTransport(fixture.identityKey))!
    const offer = await transport.offer()
    const fields = { version: 1 as const, nonce: 'c'.repeat(64), notAfter: offer.serverTime + 300000, maxBytes: 32768 }
    const request = { ...fields, requestId: snapshotArchiveRequestId(fields) }
    const entered = gate()
    const original = fixture.storage.openSnapshotArchiveSource.bind(fixture.storage)
    jest.spyOn(fixture.storage, 'openSnapshotArchiveSource').mockImplementation(async (key, options) => {
      const source = await original(key, { ...options, signal: undefined })
      entered.resolve()
      await allowOpen.promise
      return source
    })
    await transport.start(request)
    await entered.promise
    let closed = false
    const pending = server.close().then(() => {
      closed = true
    })
    expect(server.close()).toBe(Reflect.get(server, 'closing'))
    expect(() => server.start()).toThrow('closing')
    await new Promise(resolve => setImmediate(resolve))
    expect(closed).toBe(false)
    expect(server.server.listening).toBe(false)
    allowOpen.resolve()
    await pending
    expect(closed).toBe(true)
    expect(Reflect.get(fixture.storage, 'snapshotSyncSource')).toBeUndefined()
    expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
      archives: 0,
      reservedBytes: 0
    })
    // The historical reusable-server lifecycle still works after completed close.
    server.start()
    if (!server.server.listening) await new Promise(resolve => server.server.once('listening', resolve))
    expect(server.server.listening).toBe(true)
  } finally {
    allowOpen.resolve()
    await fixture.close()
  }
})
