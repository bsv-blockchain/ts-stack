import { preparePackedNativeSnapshotArchiveField } from '../preparePackedNativeSnapshotFieldNode'
import { Brc38WorkingAllocation } from '../../portable/Brc38WorkingAllocation'
import { StorageClient } from '../../remoting/StorageClient'
import { StorageClient as StorageMobile } from '../../remoting/StorageMobile'
import { snapshotHttpFixture, gate } from '../../../../test/utils/snapshotArchiveHttpFixtures'
import { runInSeries } from '../../../utility/runInSeries'
import { SnapshotCancelledError } from '../SnapshotCancelledError'
import { snapshotJournalFieldArchiveEncoding } from './SnapshotJournalArchivePacket'
import { snapshotJournalArchiveStreams } from './SnapshotJournalArchiveBinding'
import type { RemoteSnapshotJournalFieldArchive } from './openRemoteSnapshotJournalFieldArchive'
import type { KnexSnapshotArchiveRpc } from '../archive/KnexSnapshotArchiveRpc'
import { snapshotJournalFieldArchiveReaderRequestId } from './SnapshotJournalArchiveReaderRequest'
import { PrivateKey } from '@bsv/sdk'
import { StorageServer } from '../../remoting/StorageServer'
import type { Request, Response } from 'express'

afterEach(() => jest.restoreAllMocks())

test('actual field packet and EOF reads retry one genuine pre-response socket loss under the same fixed archive lease', async () => {
  const fixture = await snapshotHttpFixture(),
    bytes = Buffer.from('independent field socket reset 雪'.repeat(1200)),
    controller = new AbortController(),
    timer = setTimeout(() => controller.abort(new Error('Owned field socket test deadline')), 90000)
  let archive: RemoteSnapshotJournalFieldArchive | undefined,
    selected = 'readSnapshotJournalFieldArchivePage',
    armed = false,
    dropped = false,
    losses = 0
  type Handler = { handleRpcRequest: (this: StorageServer, request: Request, response: Response) => Promise<void> }
  const prototype = StorageServer.prototype as unknown as Handler,
    original = prototype.handleRpcRequest,
    hook = jest.spyOn(prototype, 'handleRpcRequest').mockImplementation(async function (
      this: StorageServer,
      request,
      response
    ) {
      if (armed && !dropped && request.body.method === selected) {
        dropped = true
        losses++
        response.destroy()
        return
      }
      return await original.call(this, request, response)
    })
  try {
    await fixture.storage.knex('transactions').where('transactionId', 1).update({ rawTx: bytes })
    const { url } = await fixture.serve(),
      client = new StorageClient(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
    archive = await client.openSnapshotJournalFieldArchive(fixture.identityKey, undefined, {
      signal: controller.signal,
      lifetimeMs: 90000
    })
    if (archive === undefined) throw new Error('Actual field artifact unavailable')
    const frame = await archive.readFrame(0, async () => {
        await fixture.storage.knex('users').first()
      }),
      index = frame.page.changes.findIndex(change => change.present && change.metadata.id1 === 1)
    expect(frame.tableId).toBe(0)
    expect(index).toBeGreaterThanOrEqual(0)
    armed = true
    const first = await archive.readFieldExtent(frame, index, 'rawTx', 0, 16384)
    try {
      expect(first).toEqual(bytes.subarray(0, 16384))
    } finally {
      first.fill(0)
    }
    expect(dropped).toBe(true)
    expect(losses).toBe(1)
    selected = 'getSnapshotJournalFieldArchiveStatus'
    dropped = false
    expect(await archive.readFieldExtent(frame, index, 'rawTx', bytes.length, 0)).toHaveLength(0)
    expect(dropped).toBe(true)
    expect(losses).toBe(2)
    expect(archive.isOpen).toBe(true)
  } finally {
    clearTimeout(timer)
    armed = false
    bytes.fill(0)
    try {
      await archive?.close()
      await fixture.close()
    } finally {
      hook.mockRestore()
    }
  }
}, 120000)

// These new whole-operation cases include field hashing plus authenticated
// reads. Their first run exceeded the generic 30s unit guard; give each a
// finite case allowance. Production I/O/expiry and original tests are unchanged.

test.each([StorageClient, StorageMobile])(
  'authenticated %p opens a bounded journal artifact and retries the same frame without a new capture',
  async Client => {
    const fixture = await snapshotHttpFixture()
    let archive: RemoteSnapshotJournalFieldArchive | undefined
    try {
      const { url } = await fixture.serve()
      const original = await fixture.storage.findOrInsertTxLabel(
        (await fixture.storage.findOrInsertUser(fixture.identityKey)).user.userId,
        'HTTP journal label'
      )
      const client = new Client(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
      expect((await client.makeAvailable()).snapshotJournalFieldArchive?.encoding).toBe(
        snapshotJournalFieldArchiveEncoding
      )
      archive = await client.openSnapshotJournalFieldArchive(fixture.identityKey)
      if (archive === undefined) throw new Error('Actual authenticated journal artifact unavailable')
      expect(archive.manifest.binding.version).toBe(4)
      expect(archive.manifest.binding.journal.bootstrap).toBe(true)
      expect(Reflect.get(archive, 'withCommitFence')).toBeUndefined()
      expect(Reflect.get(archive, 'readPage')).toBeUndefined()
      const seen: string[] = [],
        labels: unknown[] = [],
        identities: number[] = []
      await runInSeries(
        Array.from({ length: archive.frameCount }, (_, i) => i),
        async ordinal => {
          const frame = await archive!.readFrame(ordinal, async (_digest, _index, batch) => {
            for (const identity of batch.values()) if (identity.tableId === 3) identities.push(identity.incomingId)
            // This await is a real SQL read, rather than a fabricated writer grant.
            expect(
              await fixture.storage.knex('users').where({ identityKey: fixture.identityKey }).first()
            ).toBeDefined()
          })
          seen.push(frame.stream + '/' + frame.tableId)
          labels.push(
            ...frame.page.changes.flatMap(change =>
              change.present && change.row.label !== undefined ? [change.row.label] : []
            )
          )
          const retried = await archive!.readFrame(ordinal, async () => {
            await fixture.storage.knex('users').first()
          })
          expect(retried).toEqual(frame)
        }
      )
      expect([...new Set(seen)]).toEqual(snapshotJournalArchiveStreams.map(s => s.stream + '/' + s.tableId))
      expect(labels).toContain('HTTP journal label')
      expect(identities).toContain(original.txLabelId)
      expect(await fixture.storage.knex('snapshot_archive_requests')).toHaveLength(1)
      const binding = archive.manifest.binding
      Reflect.set(binding.journal.receipt, 'highWater', '0')
      expect(archive.manifest.binding.journal.receipt.highWater).not.toBe('0')
      await expect(
        archive.readFrame(-1, async () => {
          await fixture.storage.knex('users').first()
        })
      ).rejects.toThrow('frame request')
      await archive.close()
      await archive.closed
      const previous = archive.manifest.binding.journal.receipt
      await fixture.storage.knex('tx_labels').where('txLabelId', original.txLabelId).delete()
      await fixture.storage.findOrInsertTxLabel(
        (await fixture.storage.findOrInsertUser(fixture.identityKey)).user.userId,
        'HTTP incremental label'
      )
      archive = await client.openSnapshotJournalFieldArchive(fixture.identityKey, {
        binding: previous.binding,
        highWater: previous.highWater
      })
      if (archive === undefined) throw new Error('Actual incremental HTTP journal artifact unavailable')
      expect(archive.manifest.binding.journal).toMatchObject({ bootstrap: false, low: previous.highWater })
      const incremental = []
      for (let ordinal = 0; ordinal < archive.frameCount; ordinal++) {
        const frame = await archive.readFrame(ordinal, async () => {
          await fixture.storage.knex('users').first()
        })
        if (frame.stream === 'scope' && frame.tableId === 3) incremental.push(...frame.page.changes)
      }
      expect(incremental).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ present: false, metadata: expect.objectContaining({ id1: original.txLabelId }) }),
          expect.objectContaining({ present: true, row: expect.objectContaining({ label: 'HTTP incremental label' }) })
        ])
      )
      expect(incremental).toHaveLength(2)
      expect(incremental.every(change => BigInt(change.metadata.revision) > BigInt(previous.highWater))).toBe(true)
      await archive.close()

      expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
        archives: 0,
        reservedBytes: 0
      })
    } finally {
      await archive?.close()
      await fixture.close()
    }
  },
  90000
)

test.each([StorageClient, StorageMobile])(
  'authenticated %p keeps its exact journal owner until an in-flight identity consumer drains',
  async Client => {
    const fixture = await snapshotHttpFixture(),
      entered = gate(),
      release = gate()
    let archive: RemoteSnapshotJournalFieldArchive | undefined,
      reading: Promise<unknown> | undefined,
      closing: Promise<void> | undefined
    try {
      const { url } = await fixture.serve(),
        client = new Client(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
      const controller = new AbortController()
      archive = await client.openSnapshotJournalFieldArchive(fixture.identityKey, undefined, {
        signal: controller.signal
      })
      if (archive === undefined) throw new Error('Actual authenticated journal artifact unavailable')
      reading = archive.readFrame(0, async () => {
        entered.resolve()
        await release.promise
      })
      void reading.catch(() => undefined)
      await Promise.race([
        entered.promise,
        reading.then(() => {
          throw new Error('Identity consumer was not invoked')
        })
      ])
      controller.abort()
      closing = archive.close()
      expect(archive.isOpen).toBe(false)
      expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 1 })
      release.resolve()
      await expect(reading).rejects.toBeInstanceOf(SnapshotCancelledError)
      await closing
      expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
        archives: 0,
        reservedBytes: 0
      })
    } finally {
      release.resolve()
      await Promise.allSettled([reading, closing])
      await archive?.close()
      await fixture.close()
    }
  },
  60000
)

test('field journal HTTP authenticates before source work, rejects unissued DATA, and honors mixed-version disable', async () => {
  const fixture = await snapshotHttpFixture()
  try {
    const { server, url } = await fixture.serve(),
      client = new StorageClient(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
    await client.makeAvailable()
    const open = jest.spyOn(fixture.storage, 'openSnapshotSyncContentSource'),
      rpc = Reflect.get(server, 'snapshotArchives') as KnexSnapshotArchiveRpc
    const fields = {
        version: 4 as const,
        nonce: 'a'.repeat(64),
        notAfter: Date.now() + 300000,
        maxBytes: 524288,
        position: null
      },
      request = { ...fields, requestId: snapshotJournalFieldArchiveReaderRequestId(fields) }
    const call = Reflect.get(client, 'snapshotRpcCall').bind(client)
    await expect(
      call('admitSnapshotJournalFieldArchive', [{ version: 1, identityKey: fixture.identityKey, request }])
    ).rejects.toThrow()
    await expect(
      rpc.dispatch(
        'getSnapshotJournalFieldArchiveReaderOffer',
        [
          {
            version: 1,
            identityKey: PrivateKey.fromRandom().toPublicKey().toString(),
            options: { lifetimeMs: 300000, maxBytes: 524288 },
            position: null
          }
        ],
        fixture.identityKey
      )
    ).rejects.toThrow('authentication')
    expect(open).not.toHaveBeenCalled()
    const disabled = new StorageClient(fixture.wallet, url, {
      serverIdentityKey: fixture.serverIdentityKey,
      snapshotArchives: false
    })
    expect(await disabled.openSnapshotJournalFieldArchive(fixture.identityKey)).toBeUndefined()
    expect(open).not.toHaveBeenCalled()
    expect(await fixture.storage.knex('snapshot_archive_requests')).toHaveLength(0)
  } finally {
    await fixture.close()
  }
})

test('actual HTTP journal packet corruption cannot reach an identity consumer and still drains its owner', async () => {
  const fixture = await snapshotHttpFixture()
  let archive: RemoteSnapshotJournalFieldArchive | undefined
  try {
    const { server, url } = await fixture.serve(),
      client = new StorageClient(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
    archive = await client.openSnapshotJournalFieldArchive(fixture.identityKey)
    if (archive === undefined) throw new Error('Actual journal artifact unavailable')
    const rpc = Reflect.get(server, 'snapshotArchives') as KnexSnapshotArchiveRpc,
      dispatch = rpc.dispatch.bind(rpc)
    jest.spyOn(rpc, 'dispatch').mockImplementation(async (method, params, identityKey) => {
      const result = await dispatch(method, params, identityKey)
      if (method !== 'readSnapshotJournalFieldArchivePage') return result
      const bytes = new Uint8Array(Reflect.get(result as object, 'bytes'))
      bytes[bytes.length - 1] ^= 1
      return { ...(result as object), bytes }
    })
    const capture = jest.fn(async () => {
      await fixture.storage.knex('users').first()
    })
    await expect(archive.readFrame(0, capture)).rejects.toThrow()
    expect(capture).not.toHaveBeenCalled()
    await archive.close()
    expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
      archives: 0,
      reservedBytes: 0
    })
  } finally {
    await archive?.close()
    await fixture.close()
  }
})

test.each([StorageClient, StorageMobile])(
  'authenticated %p reads large fields on demand with exact cross-packet extents and an original-frame owner',
  async Client => {
    const fixture = await snapshotHttpFixture(),
      raw = Buffer.alloc(2097153)
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + 7) % 256
    await fixture.storage.knex('transactions').where('transactionId', 1).update({ rawTx: raw })
    await fixture.storage.knex('proven_tx_reqs').where('provenTxReqId', 1).update({ rawTx: raw })
    let archive: RemoteSnapshotJournalFieldArchive | undefined
    try {
      const { server, url } = await fixture.serve(),
        client = new Client(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey }),
        rpc = Reflect.get(server, 'snapshotArchives') as KnexSnapshotArchiveRpc,
        dispatch = rpc.dispatch.bind(rpc),
        pages: number[] = []
      jest.spyOn(rpc, 'dispatch').mockImplementation(async (method, params, identity) => {
        if (method === 'readSnapshotJournalFieldArchivePage') pages.push(Reflect.get(params[0] as object, 'sequence'))
        return await dispatch(method, params, identity)
      })
      expect(await client.supportsSnapshotJournalFieldArchive()).toBe(true)
      archive = await client.openSnapshotJournalFieldArchive(fixture.identityKey)
      if (archive === undefined) throw new Error('Actual authenticated field source unavailable')
      const content = new Set(
        (
          await fixture.storage
            .knex('snapshot_archive_pages')
            .where('tableName', 'like', 'journal-fields-content/%')
            .select('sequence')
        ).map(row => Number(row.sequence))
      )
      let selected:
        | { frame: import('./openRemoteSnapshotJournalFieldArchive').RemoteSnapshotJournalFieldFrame; index: number }
        | undefined
      const identities = new Set<number>()
      for (let ordinal = 0; ordinal < archive.frameCount; ordinal++) {
        const frame = await archive.readFrame(ordinal, (_digest, _index, values) => {
            for (const value of values.values()) if (value.tableId === 0) identities.add(value.incomingId)
          }),
          page = frame.page
        if (frame.stream === 'scope' && frame.tableId === 0) {
          const index = page.changes.findIndex(change => change.metadata.id1 === 1 && change.present)
          if (index >= 0) selected = { frame, index }
        }
      }
      expect(pages.every(sequence => !content.has(sequence))).toBe(true)
      expect(identities.has(1)).toBe(true)
      expect(identities.has(2)).toBe(false)
      if (selected === undefined) throw new Error('Actual field frame missing')
      const chosen = selected,
        data = chosen.frame.page.changes[chosen.index]
      if (!data.present) throw new Error('Actual field row missing')
      expect(data.row).not.toHaveProperty('rawTx')
      expect(data.fields.rawTx.bytes).toBe(raw.length)
      expect(await archive.readFieldExtent(chosen.frame, chosen.index, 'rawTx', 65530, 65536)).toEqual(
        new Uint8Array(raw.subarray(65530, 65530 + 65536))
      )
      const beforeZero = pages.length
      expect(await archive.readFieldExtent(chosen.frame, chosen.index, 'rawTx', raw.length, 0)).toEqual(
        new Uint8Array()
      )
      expect(pages.length).toBe(beforeZero)
      const detached = chosen.frame.page.changes[chosen.index]
      if (detached.present) Reflect.set(detached.row, 'transactionId', 999)
      expect(chosen.frame.page.changes[chosen.index].metadata.id1).toBe(1)
      await expect(archive.readFieldExtent(structuredClone(chosen.frame), chosen.index, 'rawTx', 0, 1)).rejects.toThrow(
        'actual opened artifact'
      )
      // A real authenticated artifact/frame still cannot enroll an ordinary
      // SQL connection as the separate native destination producer.
      const nativeWorking = new Brc38WorkingAllocation(1048576),
        nativePolicy = {
          workingAllocation: nativeWorking,
          maximumFieldBytes: raw.length,
          maximumReadBytes: 65536,
          expiresAt: archive.expiresAt
        }
      await expect(
        preparePackedNativeSnapshotArchiveField(
          fixture.storage,
          archive,
          structuredClone(chosen.frame),
          chosen.index,
          'rawTx',
          nativePolicy
        )
      ).rejects.toThrow('actual opened artifact')
      await expect(
        preparePackedNativeSnapshotArchiveField(
          fixture.storage,
          archive,
          chosen.frame,
          chosen.index,
          'rawTx',
          nativePolicy
        )
      ).rejects.toThrow('original source, producer or prepared content')
      expect(nativeWorking.used).toBe(0)
      const getter = jest.fn(() => 'rawTx')
      await expect(
        archive.readFieldExtent(chosen.frame, chosen.index, { toString: getter } as unknown as string, 0, 1)
      ).rejects.toThrow('coordinates')
      expect(getter).not.toHaveBeenCalled()
      const { createHash } = await import('node:crypto'),
        actual = createHash('sha256')
      for (let offset = 0; offset < raw.length; offset += 65536) {
        const bytes = await archive.readFieldExtent(
          chosen.frame,
          chosen.index,
          'rawTx',
          offset,
          Math.min(65536, raw.length - offset)
        )
        actual.update(bytes)
        bytes.fill(0)
      }
      expect(actual.digest('hex')).toBe(createHash('sha256').update(raw).digest('hex'))
      expect(pages.some(sequence => content.has(sequence))).toBe(true)
      await archive.close()
      await archive.closed
      expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
        archives: 0,
        reservedBytes: 0
      })
      expect(await fixture.storage.knex('snapshot_archive_requests')).toHaveLength(0)
      await expect(archive.readFieldExtent(chosen.frame, chosen.index, 'rawTx', 0, 1)).rejects.toThrow()
    } finally {
      await archive?.close()
      await fixture.close()
    }
  },
  120000
)
