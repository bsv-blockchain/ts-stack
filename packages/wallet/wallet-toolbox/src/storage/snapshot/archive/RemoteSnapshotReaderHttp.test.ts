import { StorageClient } from '../../remoting/StorageClient'
import { StorageClient as StorageMobile } from '../../remoting/StorageMobile'
import type { WalletStorageServerOptions } from '../../remoting/StorageServer'
import { snapshotHttpFixture, gate } from '../../../../test/utils/snapshotArchiveHttpFixtures'
import type { WalletReadSnapshot } from '../WalletReadSnapshot'
import { SnapshotCancelledError } from '../SnapshotCancelledError'
import { snapshotArchiveTables } from './SnapshotArchive'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { StorageKnex } from '../../StorageKnex'
import { StorageProvider } from '../../StorageProvider'
import { WalletStorageManager } from '../../WalletStorageManager'
import { KnexSnapshotArchiveRpc } from './KnexSnapshotArchiveRpc'

afterEach(() => jest.restoreAllMocks())

// Opt this controlled HTTP fixture into the in-progress capability. Production
// advertisement stays disabled until the complete lifecycle qualification passes.
async function serveReader(
  fixture: Awaited<ReturnType<typeof snapshotHttpFixture>>,
  options: Partial<WalletStorageServerOptions> = {}
) {
  const result = await fixture.serve(options)
  const advertise = Reflect.get(result.server, 'snapshotArchiveSettings').bind(result.server)
  jest.spyOn(result.server as never, 'snapshotArchiveSettings' as never).mockImplementation((async () => {
    const settings = await advertise()
    return settings.snapshotArchive === undefined ? settings : { ...settings, snapshotArchiveReaderVersion: 1 }
  }) as never)
  return result
}

function rpcBody(init: RequestInit | undefined): { method: string; params: unknown[] } | undefined {
  if (typeof init?.body !== 'string') return undefined
  const body = JSON.parse(init.body)
  return typeof body.method === 'string' ? body : undefined
}

test.each([StorageClient, StorageMobile])(
  'authenticated %p cancellation waits for a second controller to confirm the original source cleanup',
  async Client => {
    const fixture = await snapshotHttpFixture()
    const peer = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      knex: knex({ ...fixture.storage.knex.client.config, pool: { min: 1, max: 1 } })
    })
    const replacement = new KnexSnapshotArchiveRpc(peer)
    const reading = gate()
    const allowRead = gate()
    const destroying = gate()
    const allowDestroy = gate()
    const pendingCancellation = gate()
    const outcomes: unknown[] = []
    let opening: Promise<WalletReadSnapshot | undefined> | undefined
    try {
      await peer.makeAvailable()
      const { server, url } = await serveReader(fixture)
      const originalRpc = Reflect.get(server, 'snapshotArchives') as KnexSnapshotArchiveRpc
      const dispatch = originalRpc.dispatch.bind(originalRpc)
      // Both clients use real authentication/framing through this HTTP edge.
      // Its cancellation handler is routed to an independent SQL/controller instance.
      jest.spyOn(originalRpc, 'dispatch').mockImplementation(async (method, params, identityKey) => {
        if (method !== 'cancelSnapshotArchiveRequest') return await dispatch(method, params, identityKey)
        const result = await replacement.dispatch(method, params, identityKey)
        outcomes.push(result)
        if (result !== true) pendingCancellation.resolve()
        return result
      })
      const originalOpen = fixture.storage.openSnapshotArchiveSource.bind(fixture.storage)
      const open = jest.spyOn(fixture.storage, 'openSnapshotArchiveSource').mockImplementation(async (...args) => {
        const source = (await originalOpen(...args))!
        const owned = Reflect.get(fixture.storage, 'snapshotSyncSource') as StorageKnex
        const destroy = owned.knex.client.destroyRawConnection.bind(owned.knex.client)
        jest.spyOn(owned.knex.client, 'destroyRawConnection').mockImplementation(async connection => {
          destroying.resolve()
          await allowDestroy.promise
          await destroy(connection)
        })
        const read = source.readPage
        source.readPage = async (table, cursor, limits) => {
          reading.resolve()
          await allowRead.promise
          return await read(table, cursor, limits)
        }
        return source
      })
      const foreignOpen = jest.spyOn(peer, 'openSnapshotArchiveSource')
      const controller = new AbortController()
      const client = new Client(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
      opening = client.getSnapshotSync()!.openSource(fixture.identityKey, { signal: controller.signal })
      let settled = false
      void opening.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      await reading.promise
      const request = await fixture.storage.knex('snapshot_archive_requests').first()
      controller.abort()
      await pendingCancellation.promise
      expect(outcomes[0]).toEqual({ version: 1, outcome: 'cleanup-pending', requestId: request.requestId })
      expect(settled).toBe(false)
      expect((await peer.knex('snapshot_archive_capacity').first()).archives).toBe(1)
      allowRead.resolve()
      await destroying.promise
      expect(settled).toBe(false)
      expect(await peer.knex('snapshot_archive_owners')).toHaveLength(1)
      expect(await peer.knex('snapshot_archive_pages')).toHaveLength(0)
      await peer.knex('tx_labels').where({ txLabelId: 1 }).update({ label: 'foreground while HTTP cleanup waits' })
      allowDestroy.resolve()
      await expect(opening).rejects.toBeInstanceOf(SnapshotCancelledError)
      expect(outcomes.at(-1)).toBe(true)
      expect(open).toHaveBeenCalledTimes(1)
      expect(foreignOpen).not.toHaveBeenCalled()
      expect(await peer.knex('snapshot_archive_owners')).toHaveLength(0)
      expect(await peer.knex('snapshot_archive_requests')).toHaveLength(0)
      expect(await peer.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
    } finally {
      allowRead.resolve()
      allowDestroy.resolve()
      await opening?.catch(() => undefined)
      await replacement.close()
      await peer.destroy()
      await fixture.close()
    }
  }
)

test.each([StorageClient, StorageMobile])(
  'authenticated %p reader negotiates its first open and keeps the original archive through replacement',
  async Client => {
    const fixture = await snapshotHttpFixture()
    let view: WalletReadSnapshot | undefined
    try {
      const { server, url } = await serveReader(fixture)
      const client = new Client(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
      const source = client.getSnapshotSync()!
      expect(client.isAvailable()).toBe(false)
      const opening = jest.spyOn(fixture.storage, 'openSnapshotArchiveSource')
      view = (await source.openSource(fixture.identityKey))!
      expect(view.sourceStorage.storageIdentityKey).toBe('http-snapshot-source')
      expect(view.user.identityKey).toBe(fixture.identityKey)
      expect(view.user.created_at).toBeInstanceOf(Date)
      expect(opening).toHaveBeenCalledTimes(1)
      expect(Reflect.get(fixture.storage, 'snapshotSyncSource')).toBeUndefined()
      const first = await view.readPage('txLabels', undefined, { maxRows: 1 })
      expect(first.done).toBe(false)
      expect(first.cursor?.archivePosition).toMatchObject({ version: 1, rowOffset: 1 })
      const original = first.rows[0].label
      first.rows[0].label = 'caller mutation'
      await fixture.storage.knex('tx_labels').where({ txLabelId: 1 }).update({ label: 'foreground after capture' })
      expect((await view.readPage('txLabels', undefined, { maxRows: 1 })).rows[0].label).toBe(original)
      const next = await view.readPage('txLabels', first.cursor, { maxRows: 1 })
      expect(next.rows).toHaveLength(1)
      expect(next.rows[0].txLabelId).not.toBe(first.rows[0].txLabelId)
      await server.close()
      await serveReader(fixture, { port: Number(new URL(url).port) })
      const outputs = await view.readPage('outputs')
      expect(outputs.rows.length).toBeGreaterThan(0)
      expect(outputs.rows[0].lockingScript).toBeInstanceOf(Uint8Array)
      expect(outputs.rows[0]).not.toHaveProperty('outputDescription')
      for (const table of snapshotArchiveTables) {
        const page = await view.readPage(table)
        expect(page.done).toBe(true)
        for (const row of page.rows) {
          expect(row.created_at).toBeInstanceOf(Date)
          expect(row.updated_at).toBeInstanceOf(Date)
          if ('userId' in row) expect(row.userId).toBe(view.user.userId)
        }
      }
      expect(opening).toHaveBeenCalledTimes(1)
      await view.close()
      await view.close()
      expect(await fixture.storage.knex('snapshot_archive_requests')).toHaveLength(0)
      expect(await fixture.storage.knex('snapshot_archive_pages')).toHaveLength(0)
      expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
        archives: 0,
        reservedBytes: 0
      })
    } finally {
      await view?.close().catch(() => undefined)
      await fixture.close()
    }
  }
)

test.each(['before', 'after'] as const)(
  'native fetch loss %s admission retries the identical tuple once through real authentication',
  async lost => {
    const fixture = await snapshotHttpFixture()
    const nativeFetch = globalThis.fetch
    const admissions: unknown[][] = []
    let view: WalletReadSnapshot | undefined
    try {
      const { url } = await serveReader(fixture)
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const body = rpcBody(init)
        if (body?.method === 'admitSnapshotArchive') {
          admissions.push(body.params)
          if (admissions.length === 1) {
            if (lost === 'after') {
              const response = await nativeFetch(input, init)
              await response.body?.cancel()
            }
            throw new Error('synthetic native fetch connection loss')
          }
        }
        return await nativeFetch(input, init)
      })
      const client = new StorageClient(fixture.wallet, url)
      const opening = jest.spyOn(fixture.storage, 'openSnapshotArchiveSource')
      view = (await client.getSnapshotSync()!.openSource(fixture.identityKey))!
      expect(view.isOpen).toBe(true)
      expect(admissions).toHaveLength(2)
      expect(admissions[0]).toEqual(admissions[1])
      expect(opening).toHaveBeenCalledTimes(1)
      expect((await view.readPage('txLabels')).rows).toHaveLength(2)
      await view.close()
      expect(await fixture.storage.knex('snapshot_archive_requests')).toHaveLength(0)
    } finally {
      await view?.close().catch(() => undefined)
      await fixture.close()
    }
  }
)

test('an unauthenticated admission reply is not retried or treated as compatibility fallback', async () => {
  const fixture = await snapshotHttpFixture()
  const nativeFetch = globalThis.fetch
  let admissions = 0
  try {
    const { url } = await serveReader(fixture)
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await nativeFetch(input, init)
      if (rpcBody(init)?.method !== 'admitSnapshotArchive') return response
      admissions++
      const headers = new Headers(response.headers)
      headers.delete('x-bsv-auth-signature')
      return new Response(await response.arrayBuffer(), { status: response.status, headers })
    })
    const client = new StorageClient(fixture.wallet, url)
    await expect(client.getSnapshotSync()!.openSource(fixture.identityKey)).rejects.toThrow('authentication')
    expect(admissions).toBe(1)
    expect(await fixture.storage.knex('snapshot_archive_requests')).toHaveLength(0)
    expect(Reflect.get(fixture.storage, 'snapshotSyncSource')).toBeUndefined()
  } finally {
    await fixture.close()
  }
})

test.each(
  ['getSnapshotArchiveDirectory', 'readSnapshotArchivePage', 'cancelSnapshotArchiveRequest'].flatMap(method =>
    (['before', 'after'] as const).map(loss => ({ method, loss }))
  )
)('immutable $method recovers native loss $loss the request with one exact retry', async ({ method, loss }) => {
  const fixture = await snapshotHttpFixture()
  const nativeFetch = globalThis.fetch
  const calls: unknown[][] = []
  let view: WalletReadSnapshot | undefined
  try {
    const { url } = await serveReader(fixture)
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const body = rpcBody(init)
      if (body?.method === method) {
        calls.push(body.params)
        if (calls.length === 1) {
          if (loss === 'after') {
            const response = await nativeFetch(input, init)
            await response.body?.cancel()
          }
          throw new Error('synthetic native fetch connection loss')
        }
      }
      return await nativeFetch(input, init)
    })
    const opening = jest.spyOn(fixture.storage, 'openSnapshotArchiveSource')
    const client = new StorageClient(fixture.wallet, url)
    view = (await client.getSnapshotSync()!.openSource(fixture.identityKey))!
    const expiry = view.expiresAt
    expect((await view.readPage('txLabels')).rows).toHaveLength(2)
    expect(view.expiresAt).toBe(expiry)
    await view.close()
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(calls[1])
    expect(opening).toHaveBeenCalledTimes(1)
    expect(await fixture.storage.knex('snapshot_archive_requests')).toHaveLength(0)
    expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
      archives: 0,
      reservedBytes: 0
    })
  } finally {
    await view?.close().catch(() => undefined)
    await fixture.close()
  }
})

test('a page authentication failure closes the view without retrying its content request', async () => {
  const fixture = await snapshotHttpFixture()
  const nativeFetch = globalThis.fetch
  let pages = 0
  let view: WalletReadSnapshot | undefined
  try {
    const { url } = await serveReader(fixture)
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await nativeFetch(input, init)
      if (rpcBody(init)?.method !== 'readSnapshotArchivePage') return response
      pages++
      const headers = new Headers(response.headers)
      headers.delete('x-bsv-auth-signature')
      return new Response(await response.arrayBuffer(), { status: response.status, headers })
    })
    view = (await new StorageClient(fixture.wallet, url).getSnapshotSync()!.openSource(fixture.identityKey))!
    await expect(view.readPage('txLabels')).rejects.toThrow('authentication')
    expect(pages).toBe(1)
    expect(view.isOpen).toBe(false)
    await view.closed
    expect(await fixture.storage.knex('snapshot_archive_requests')).toHaveLength(0)
  } finally {
    await view?.close().catch(() => undefined)
    await fixture.close()
  }
})

test('cancellation during authenticated admission preserves its local type and drains the owned source', async () => {
  const fixture = await snapshotHttpFixture()
  const entered = gate()
  const resume = gate()
  const controller = new AbortController()
  let pending: Promise<WalletReadSnapshot | undefined> | undefined
  try {
    const { url } = await serveReader(fixture)
    const open = fixture.storage.openSnapshotArchiveSource.bind(fixture.storage)
    jest.spyOn(fixture.storage, 'openSnapshotArchiveSource').mockImplementation(async (...args) => {
      entered.resolve()
      await resume.promise
      return await open(...args)
    })
    const client = new StorageMobile(fixture.wallet, url)
    pending = client.getSnapshotSync()!.openSource(fixture.identityKey, { signal: controller.signal })
    void pending.catch(() => undefined)
    await entered.promise
    controller.abort()
    resume.resolve()
    await expect(pending).rejects.toBeInstanceOf(SnapshotCancelledError)
    expect(Reflect.get(fixture.storage, 'snapshotSyncSource')).toBeUndefined()
    expect(await fixture.storage.knex('snapshot_archive_requests')).toHaveLength(0)
    expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
      archives: 0,
      reservedBytes: 0
    })
  } finally {
    resume.resolve()
    await pending?.then(
      view => view?.close(),
      () => undefined
    )
    await fixture.close()
  }
})

test.each([StorageClient, StorageMobile])(
  'authenticated %p sync commits archive positions and resumes cancellation into an occupied destination',
  async Client => {
    const fixture = await snapshotHttpFixture(true, false)
    const directory = await mkdtemp(join(tmpdir(), 'snapshot-http-destination-'))
    const destination = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      snapshotSync: true,
      knex: knex({
        client: 'better-sqlite3',
        connection: { filename: join(directory, 'wallet.sqlite') },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 }
      })
    })
    try {
      const { url } = await serveReader(fixture)
      const sourceUser = (await fixture.storage.findUserByIdentityKey(fixture.identityKey))!
      await fixture.storage.updateUser(sourceUser.userId, { activeStorage: 'http-snapshot-source' })
      for (let index = 0; index < 5; index++) {
        await fixture.storage.insertTxLabel({
          txLabelId: 0,
          userId: sourceUser.userId,
          label: `label-${index}`,
          isDeleted: index % 2 === 0,
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          updated_at: new Date('2026-01-01T00:00:00.000Z')
        })
      }
      await destination.knex.raw('PRAGMA journal_mode = WAL')
      await destination.migrate('HTTP destination', 'http-destination')
      await destination.makeAvailable()
      const { user: foreign } = await destination.findOrInsertUser(fixture.serverIdentityKey)
      await destination.findOrInsertTxLabel(foreign.userId, 'foreign-existing')
      const { user } = await destination.findOrInsertUser(fixture.identityKey)
      await destination.updateUser(user.userId, { activeStorage: 'http-destination' })
      const manager = new WalletStorageManager(fixture.identityKey, destination)
      await manager.makeAvailable()
      const reader = new Client(fixture.wallet, url)
      const legacy = jest.spyOn(destination, 'processSyncChunk')
      const controller = new AbortController()
      const partial = await manager.syncFromReaderResumable(fixture.identityKey, reader, {
        maxItems: 2,
        signal: controller.signal,
        onProgress: progress => {
          if (progress.snapshotCheckpoint?.cursor?.table === 'txLabels') controller.abort()
        }
      })
      expect(partial.status).toBe('cancelled')
      expect(partial.snapshotCheckpoint?.cursor?.archivePosition).toMatchObject({ version: 1, rowOffset: 2 })
      expect(partial.snapshotCheckpoint).toEqual(
        await destination.getSnapshotSync()!.checkpoint(fixture.identityKey, 'http-snapshot-source')
      )
      expect(await destination.findTxLabels({ partial: { userId: user.userId } })).toHaveLength(2)
      expect(await fixture.storage.knex('snapshot_archive_requests')).toHaveLength(0)
      const complete = await manager.syncFromReaderResumable(fixture.identityKey, reader, { maxItems: 2 })
      expect(complete.status).toBe('completed')
      expect(complete.snapshotCheckpoint?.done).toBe(true)
      expect(complete.snapshotCheckpoint?.snapshotId).not.toBe(partial.snapshotCheckpoint?.snapshotId)
      const labels = await destination.findTxLabels({ partial: { userId: user.userId } })
      expect(labels.map(row => [row.label, row.isDeleted]).sort()).toEqual(
        Array.from({ length: 5 }, (_, index) => [`label-${index}`, index % 2 === 0])
      )
      expect((await destination.findTxLabels({ partial: { userId: foreign.userId } })).map(row => row.label)).toEqual([
        'foreign-existing'
      ])
      expect((await destination.findUserByIdentityKey(fixture.identityKey))!.activeStorage).toBe('http-destination')
      expect(legacy).not.toHaveBeenCalled()
      expect(await fixture.storage.knex('snapshot_archive_requests')).toHaveLength(0)
      expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
        archives: 0,
        reservedBytes: 0
      })
    } finally {
      await destination.destroy()
      await fixture.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
