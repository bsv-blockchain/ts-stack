import { encodeSyncTransfer, syncTransferDigest, type SyncTransferManifest } from '../remoting/SyncTransfer'
import { KnexRemoteSnapshotSyncRpc } from './KnexRemoteSnapshotSyncRpc'
import {
  remoteSnapshotSyncCapabilities,
  remoteSnapshotSyncPartBytes,
  remoteSnapshotSyncFrameBytes
} from './RemoteSnapshotSyncProtocol'
import type { KnexSyncTransferStore } from '../remoting/KnexSyncTransferStore'
import type { SnapshotSyncCheckpoint } from './SnapshotSync'
import { gate, snapshotHttpFixture } from '../../../test/utils/snapshotArchiveHttpFixtures'

async function requestSource(fixture: Awaited<ReturnType<typeof snapshotHttpFixture>>, index = 0) {
  const user = (await fixture.storage.findUserByIdentityKey(fixture.identityKey))!
  // Wire DATA for protocol/refusal cases. This helper does not issue a retained
  // source grant, authenticate a BRC archive or claim complete export closure.
  return JSON.parse(
    JSON.stringify({
      version: 1,
      snapshotId: index.toString(16).padStart(64, '0'),
      sourceStorage: { ...fixture.storage.getSettings(), storageIdentityKey: `source-${index}` },
      user,
      expiresAt: Date.now() + 60000
    })
  ) as {
    version: 1
    snapshotId: string
    sourceStorage: { storageIdentityKey: string; chain: 'main' | 'test' }
    user: { identityKey: string; userId: number; activeStorage: string }
    expiresAt: number
  }
}
const emptyPage = () => encodeSyncTransfer({ rows: [], payloadBytes: 0, done: true })

afterEach(() => jest.restoreAllMocks())

test('independent controllers read the actual committed checkpoint and reject a stale page', async () => {
  const fixture = await snapshotHttpFixture(true, false),
    first = new KnexRemoteSnapshotSyncRpc(fixture.storage),
    second = new KnexRemoteSnapshotSyncRpc(fixture.storage)
  try {
    expect(await first.capabilities()).toEqual(remoteSnapshotSyncCapabilities)
    const source = await requestSource(fixture)
    const before = (await first.dispatch(
      'beginSnapshotSync',
      [source, source.user.activeStorage],
      fixture.identityKey
    )) as SnapshotSyncCheckpoint
    const committed = await first.dispatch('commitSnapshotSyncPage', [before, emptyPage()], fixture.identityKey)
    expect(committed).toMatchObject({
      checkpoint: { sequence: 1, tableIndex: 1 },
      inserts: 0,
      updates: expect.any(Number)
    })
    expect(
      await second.dispatch(
        'getSnapshotSyncCheckpoint',
        [fixture.identityKey, source.sourceStorage.storageIdentityKey],
        fixture.identityKey
      )
    ).toEqual((committed as { checkpoint: SnapshotSyncCheckpoint }).checkpoint)
    await expect(second.dispatch('commitSnapshotSyncPage', [before, emptyPage()], fixture.identityKey)).rejects.toThrow(
      'changed'
    )
    expect(
      (await fixture.storage.knex('snapshot_sync_sessions').where({ sessionId: before.sessionId }).first()).sequence
    ).toBe(1)
  } finally {
    await first.close()
    await second.close()
    await fixture.close()
  }
})

test.each(['identity', 'network', 'expiry'] as const)(
  'refuses a changed source %s before any durable admission',
  async changed => {
    const fixture = await snapshotHttpFixture(true, false),
      rpc = new KnexRemoteSnapshotSyncRpc(fixture.storage)
    try {
      const source = await requestSource(fixture)
      if (changed === 'identity') source.user.identityKey = '03' + '99'.repeat(32)
      if (changed === 'network') source.sourceStorage.chain = 'main'
      if (changed === 'expiry') source.expiresAt = Date.now() - 1
      await expect(
        rpc.dispatch('beginSnapshotSync', [source, source.user.activeStorage], fixture.identityKey)
      ).rejects.toThrow()
      expect(await fixture.storage.knex('snapshot_sync_sessions')).toHaveLength(0)
    } finally {
      await rpc.close()
      await fixture.close()
    }
  }
)

test('a real primary-epoch change rejects the old session without advancing its ACK', async () => {
  const fixture = await snapshotHttpFixture(true, false),
    rpc = new KnexRemoteSnapshotSyncRpc(fixture.storage)
  try {
    const source = await requestSource(fixture)
    const checkpoint = (await rpc.dispatch(
      'beginSnapshotSync',
      [source, source.user.activeStorage],
      fixture.identityKey
    )) as SnapshotSyncCheckpoint
    const user = (await fixture.storage.findUserByIdentityKey(fixture.identityKey))!
    await fixture.storage.updateUser(user.userId, { activeStorage: 'changed-primary' })
    await expect(
      rpc.dispatch('commitSnapshotSyncPage', [checkpoint, emptyPage()], fixture.identityKey)
    ).rejects.toThrow('changed')
    expect(
      (await fixture.storage.knex('snapshot_sync_sessions').where({ sessionId: checkpoint.sessionId }).first()).sequence
    ).toBe(0)
  } finally {
    await rpc.close()
    await fixture.close()
  }
})

test('the ninth original source scope refuses atomically while existing scopes remain resumable', async () => {
  const fixture = await snapshotHttpFixture(true, false),
    rpc = new KnexRemoteSnapshotSyncRpc(fixture.storage)
  try {
    for (let index = 0; index < 8; index++) {
      const source = await requestSource(fixture, index)
      await rpc.dispatch('beginSnapshotSync', [source, source.user.activeStorage], fixture.identityKey)
    }
    const source = await requestSource(fixture, 8)
    await expect(
      rpc.dispatch('beginSnapshotSync', [source, source.user.activeStorage], fixture.identityKey)
    ).rejects.toThrow('quota')
    expect(await fixture.storage.knex('snapshot_sync_sessions')).toHaveLength(8)
    const first = await requestSource(fixture)
    // Same original scope, different fresh view: replacing its session is
    // permitted without allocating a ninth source identity or losing maps.
    first.snapshotId = 'a'.repeat(64)
    expect(
      await rpc.dispatch('beginSnapshotSync', [first, first.user.activeStorage], fixture.identityKey)
    ).toMatchObject({ snapshotId: first.snapshotId, sequence: 0 })
  } finally {
    await rpc.close()
    await fixture.close()
  }
})

test('closing drains actual preparation and prevents the already admitted page from starting its SQL writer', async () => {
  const fixture = await snapshotHttpFixture(true, false),
    rpc = new KnexRemoteSnapshotSyncRpc(fixture.storage),
    preparing = gate(),
    release = gate()
  let pending: Promise<unknown> | undefined, closing: Promise<void> | undefined
  try {
    const source = await requestSource(fixture)
    const checkpoint = (await rpc.dispatch(
      'beginSnapshotSync',
      [source, source.user.activeStorage],
      fixture.identityKey
    )) as SnapshotSyncCheckpoint
    const adapter = fixture.storage.getSnapshotSync()!,
      prepare = adapter.prepare.bind(adapter)
    jest.spyOn(fixture.storage, 'getSnapshotSync').mockReturnValue({
      ...adapter,
      prepare: async (...args) => {
        const apply = await prepare(...args)
        preparing.resolve()
        await release.promise
        return apply
      }
    })
    pending = rpc.dispatch('commitSnapshotSyncPage', [checkpoint, emptyPage()], fixture.identityKey)
    void pending.catch(() => undefined)
    await preparing.promise
    let drained = false
    closing = rpc.close().then(() => {
      drained = true
    })
    expect(drained).toBe(false)
    expect(() =>
      rpc.dispatch('getSnapshotSyncCheckpoint', [fixture.identityKey, 'source-0'], fixture.identityKey)
    ).toThrow('closed')
    release.resolve()
    await expect(pending).rejects.toThrow('closed')
    await closing
    expect(drained).toBe(true)
    expect(
      (await fixture.storage.knex('snapshot_sync_sessions').where({ sessionId: checkpoint.sessionId }).first()).sequence
    ).toBe(0)
  } finally {
    release.resolve()
    await pending?.catch(() => undefined)
    await closing
    await rpc.close()
    await fixture.close()
  }
})

test.each(['snapshot_sync_sessions', 'snapshot_sync_ids', 'snapshot_sync_primary_epochs'])(
  'partial destination %s cannot advertise support',
  async table => {
    const fixture = await snapshotHttpFixture(true, false),
      rpc = new KnexRemoteSnapshotSyncRpc(fixture.storage)
    try {
      expect(await rpc.capabilities()).toEqual(remoteSnapshotSyncCapabilities)
      await fixture.storage.knex.schema.dropTable(table)
      await expect(rpc.capabilities()).rejects.toThrow('incomplete')
    } finally {
      await rpc.close()
      await fixture.close()
    }
  }
)

test('a missing database-owned primary fence refuses advertisement and an already prepared writer', async () => {
  const fixture = await snapshotHttpFixture(true, false),
    rpc = new KnexRemoteSnapshotSyncRpc(fixture.storage)
  try {
    const source = await requestSource(fixture)
    const checkpoint = (await rpc.dispatch(
      'beginSnapshotSync',
      [source, source.user.activeStorage],
      fixture.identityKey
    )) as SnapshotSyncCheckpoint
    const adapter = fixture.storage.getSnapshotSync()!
    const apply = await adapter.prepare(checkpoint, { rows: [], payloadBytes: 0, done: true })
    await fixture.storage.knex.raw('DROP TRIGGER snapshot_sync_primary_change')
    await expect(rpc.capabilities()).rejects.toThrow('primary fence')
    await expect(apply()).rejects.toThrow('primary fence')
    expect(
      (await fixture.storage.knex('snapshot_sync_sessions').where({ sessionId: checkpoint.sessionId }).first()).sequence
    ).toBe(0)
  } finally {
    await rpc.close()
    await fixture.close()
  }
})

test('unknown runtime methods refuse before storage admission', async () => {
  const fixture = await snapshotHttpFixture(true, false),
    rpc = new KnexRemoteSnapshotSyncRpc(fixture.storage)
  try {
    const read = jest.spyOn(fixture.storage, 'getSnapshotSync')
    expect(() => rpc.dispatch('unknown' as Parameters<typeof rpc.dispatch>[0], [], fixture.identityKey)).toThrow(
      'Unknown'
    )
    expect(read).not.toHaveBeenCalled()
  } finally {
    await rpc.close()
    await fixture.close()
  }
})

test('preparation that outlives the server I/O deadline cannot start a SQL merge', async () => {
  const fixture = await snapshotHttpFixture(true, false),
    rpc = new KnexRemoteSnapshotSyncRpc(fixture.storage)
  try {
    const source = await requestSource(fixture)
    const checkpoint = (await rpc.dispatch(
      'beginSnapshotSync',
      [source, source.user.activeStorage],
      fixture.identityKey
    )) as SnapshotSyncCheckpoint
    const adapter = fixture.storage.getSnapshotSync()!,
      prepare = adapter.prepare.bind(adapter)
    let monotonic = performance.now()
    jest.spyOn(performance, 'now').mockImplementation(() => monotonic)
    jest.spyOn(fixture.storage, 'getSnapshotSync').mockReturnValue({
      ...adapter,
      prepare: async (...args) => {
        const apply = await prepare(...args)
        monotonic += 30000
        return apply
      }
    })
    await expect(
      rpc.dispatch('commitSnapshotSyncPage', [checkpoint, emptyPage()], fixture.identityKey)
    ).rejects.toThrow('I/O deadline')
    expect(
      (await fixture.storage.knex('snapshot_sync_sessions').where({ sessionId: checkpoint.sessionId }).first()).sequence
    ).toBe(0)
  } finally {
    jest.restoreAllMocks()
    await rpc.close()
    await fixture.close()
  }
})

async function stagePage(
  rpc: KnexRemoteSnapshotSyncRpc,
  identityKey: string,
  checkpoint: SnapshotSyncCheckpoint,
  bytes: Uint8Array
): Promise<SyncTransferManifest> {
  const manifest = (await rpc.dispatch(
    'beginSnapshotSyncPageTransfer',
    [checkpoint, { digest: syncTransferDigest(bytes), totalBytes: bytes.length }],
    identityKey
  )) as SyncTransferManifest
  expect(manifest.partBytes).toBe(remoteSnapshotSyncPartBytes)
  for (let offset = 0; offset < bytes.length; offset += manifest.partBytes) {
    const part = bytes.subarray(offset, Math.min(offset + manifest.partBytes, bytes.length))
    expect(
      await rpc.dispatch(
        'writeSnapshotSyncPageTransferPart',
        [checkpoint, { transferId: manifest.transferId, offset, bytes: part }],
        identityKey
      )
    ).toBe(offset + part.length)
  }
  return manifest
}

test('staged entity/map/checkpoint/result writes roll back together and another controller resumes actual stored parts', async () => {
  const fixture = await snapshotHttpFixture(true, false),
    first = new KnexRemoteSnapshotSyncRpc(fixture.storage),
    second = new KnexRemoteSnapshotSyncRpc(fixture.storage)
  try {
    const source = await requestSource(fixture)
    let checkpoint = (await first.dispatch(
      'beginSnapshotSync',
      [source, source.user.activeStorage],
      fixture.identityKey
    )) as SnapshotSyncCheckpoint
    for (let index = 0; index < 3; index++)
      checkpoint = (
        (await first.dispatch('commitSnapshotSyncPage', [checkpoint, emptyPage()], fixture.identityKey)) as {
          checkpoint: SnapshotSyncCheckpoint
        }
      ).checkpoint
    const page = {
      rows: [
        {
          created_at: '2026-10-06T00:00:00.000Z',
          updated_at: '2026-10-06T00:00:00.000Z',
          txLabelId: 44,
          userId: source.user.userId,
          label: 'durable-staged-label',
          isDeleted: true
        }
      ],
      payloadBytes: 512,
      done: true,
      cursor: { version: 1, snapshotId: checkpoint.snapshotId, table: 'txLabels', after: [44] }
    }
    const bytes = encodeSyncTransfer({ checkpoint, page }),
      manifest = await stagePage(first, fixture.identityKey, checkpoint, bytes)
    const store = Reflect.get(first, 'transfers') as KnexSyncTransferStore,
      save = Reflect.get(store, 'saveResult').bind(store) as (...args: unknown[]) => Promise<number>,
      fault = new Error('Injected AFTER entity/map/checkpoint effects BEFORE transfer result')
    const injection = jest
      .spyOn(store as unknown as { saveResult: (...args: unknown[]) => Promise<number> }, 'saveResult')
      .mockImplementation(async (...args) => {
        if ((args[2] as { state?: string }).state === 'complete') throw fault
        return await save(...args)
      })
    await expect(
      first.dispatch(
        'commitSnapshotSyncPageTransfer',
        [checkpoint, { transferId: manifest.transferId }],
        fixture.identityKey
      )
    ).rejects.toBe(fault)
    expect(await fixture.storage.knex('tx_labels')).toHaveLength(0)
    expect(await fixture.storage.knex('snapshot_sync_ids').where({ entity: 'txLabel' })).toHaveLength(0)
    expect(
      (await fixture.storage.knex('snapshot_sync_sessions').where({ sessionId: checkpoint.sessionId }).first()).sequence
    ).toBe(3)
    expect(
      (await fixture.storage.knex('sync_transfers').where({ transferId: manifest.transferId }).first()).state
    ).toBe('ready')
    injection.mockRestore()
    const result = await second.dispatch(
      'commitSnapshotSyncPageTransfer',
      [checkpoint, { transferId: manifest.transferId }],
      fixture.identityKey
    )
    expect(result).toMatchObject({ checkpoint: { sequence: 4, tableIndex: 4 }, inserts: 1 })
    expect(await fixture.storage.knex('tx_labels').select('label', 'isDeleted')).toEqual([
      { label: 'durable-staged-label', isDeleted: 1 }
    ])
    expect(await fixture.storage.knex('snapshot_sync_ids').where({ entity: 'txLabel', incomingId: 44 })).toHaveLength(1)
    expect(
      (await fixture.storage.knex('sync_transfers').where({ transferId: manifest.transferId }).first()).state
    ).toBe('complete')
    expect(await fixture.storage.knex('sync_transfer_parts')).toHaveLength(0)
    expect(
      await second.dispatch(
        'getSnapshotSyncCheckpoint',
        [fixture.identityKey, source.sourceStorage.storageIdentityKey],
        fixture.identityKey
      )
    ).toEqual((result as { checkpoint: SnapshotSyncCheckpoint }).checkpoint)
    expect(
      await second.dispatch(
        'releaseSnapshotSyncPageTransfer',
        [checkpoint, { transferId: manifest.transferId }],
        fixture.identityKey
      )
    ).toBe(true)
  } finally {
    jest.restoreAllMocks()
    await first.close()
    await second.close()
    await fixture.close()
  }
})

test('expired staged transfer cannot commit but authenticated cleanup still releases the original stored owner', async () => {
  const fixture = await snapshotHttpFixture(true, false),
    rpc = new KnexRemoteSnapshotSyncRpc(fixture.storage)
  try {
    const source = await requestSource(fixture)
    const checkpoint = (await rpc.dispatch(
      'beginSnapshotSync',
      [source, source.user.activeStorage],
      fixture.identityKey
    )) as SnapshotSyncCheckpoint
    const manifest = await stagePage(
      rpc,
      fixture.identityKey,
      checkpoint,
      encodeSyncTransfer({ checkpoint, page: { rows: [], payloadBytes: 0, done: true } })
    )
    expect(manifest.expiresAt).toBeLessThanOrEqual(source.expiresAt)
    jest.spyOn(Date, 'now').mockReturnValue(source.expiresAt + 1)
    await expect(
      rpc.dispatch(
        'commitSnapshotSyncPageTransfer',
        [checkpoint, { transferId: manifest.transferId }],
        fixture.identityKey
      )
    ).rejects.toThrow('expired')
    expect(
      await rpc.dispatch(
        'releaseSnapshotSyncPageTransfer',
        [checkpoint, { transferId: manifest.transferId }],
        fixture.identityKey
      )
    ).toBe(true)
    expect(await fixture.storage.knex('sync_transfer_parts')).toHaveLength(0)
    expect(await fixture.storage.knex('sync_transfers').where({ transferId: manifest.transferId })).toHaveLength(0)
    expect(
      (await fixture.storage.knex('snapshot_sync_sessions').where({ sessionId: checkpoint.sessionId }).first()).sequence
    ).toBe(0)
  } finally {
    jest.restoreAllMocks()
    await rpc.close()
    await fixture.close()
  }
})

test('foreign/unregistered SQL transactions cannot execute the internal staged-page callback', async () => {
  const fixture = await snapshotHttpFixture(true, false),
    rpc = new KnexRemoteSnapshotSyncRpc(fixture.storage)
  try {
    const source = await requestSource(fixture)
    const checkpoint = (await rpc.dispatch(
      'beginSnapshotSync',
      [source, source.user.activeStorage],
      fixture.identityKey
    )) as SnapshotSyncCheckpoint
    const apply = await fixture.storage.prepareSnapshotSyncPageInTransaction(checkpoint, {
      rows: [],
      payloadBytes: 0,
      done: true
    })
    await expect(fixture.storage.knex.transaction(async trx => await apply(trx))).rejects.toThrow(
      'actual original SQL transaction'
    )
    expect(
      (await fixture.storage.knex('snapshot_sync_sessions').where({ sessionId: checkpoint.sessionId }).first()).sequence
    ).toBe(0)
  } finally {
    await rpc.close()
    await fixture.close()
  }
})

test('oversized staged declarations refuse before allocation or source-scope mutation', async () => {
  const fixture = await snapshotHttpFixture(true, false),
    rpc = new KnexRemoteSnapshotSyncRpc(fixture.storage)
  try {
    const source = await requestSource(fixture)
    const checkpoint = (await rpc.dispatch(
      'beginSnapshotSync',
      [source, source.user.activeStorage],
      fixture.identityKey
    )) as SnapshotSyncCheckpoint
    await expect(
      rpc.dispatch(
        'beginSnapshotSyncPageTransfer',
        [checkpoint, { digest: 'e'.repeat(64), totalBytes: remoteSnapshotSyncFrameBytes + 1 }],
        fixture.identityKey
      )
    ).rejects.toThrow()
    expect(await fixture.storage.knex('sync_transfers').whereNotNull('transferId')).toHaveLength(0)
  } finally {
    await rpc.close()
    await fixture.close()
  }
})

test('malformed new proof rows are refused by the existing RPC proof policy before any global insert', async () => {
  const fixture = await snapshotHttpFixture(true, false),
    rpc = new KnexRemoteSnapshotSyncRpc(fixture.storage)
  try {
    const source = await requestSource(fixture)
    const checkpoint = (await rpc.dispatch(
      'beginSnapshotSync',
      [source, source.user.activeStorage],
      fixture.identityKey
    )) as SnapshotSyncCheckpoint
    const page = {
      rows: [
        {
          provenTxId: 44,
          created_at: '2026-10-06T00:00:00.000Z',
          updated_at: '2026-10-06T00:00:00.000Z',
          txid: '1'.repeat(64),
          height: 1,
          index: 0,
          rawTx: new Uint8Array([1]),
          merklePath: new Uint8Array([1]),
          blockHash: '2'.repeat(64),
          merkleRoot: '3'.repeat(64)
        }
      ],
      payloadBytes: 4096,
      done: true,
      cursor: { version: 1, snapshotId: checkpoint.snapshotId, table: 'provenTxs', after: [44] }
    }
    await expect(
      rpc.dispatch('commitSnapshotSyncPage', [checkpoint, encodeSyncTransfer(page)], fixture.identityKey)
    ).rejects.toThrow('server-verified proof')
    expect(await fixture.storage.knex('proven_txs')).toHaveLength(0)
    expect(
      (await fixture.storage.knex('snapshot_sync_sessions').where({ sessionId: checkpoint.sessionId }).first()).sequence
    ).toBe(0)
  } finally {
    await rpc.close()
    await fixture.close()
  }
})

test('corrupted staged bytes fail integrity before effects and the original transfer can be released', async () => {
  const fixture = await snapshotHttpFixture(true, false),
    rpc = new KnexRemoteSnapshotSyncRpc(fixture.storage)
  try {
    const source = await requestSource(fixture)
    const checkpoint = (await rpc.dispatch(
      'beginSnapshotSync',
      [source, source.user.activeStorage],
      fixture.identityKey
    )) as SnapshotSyncCheckpoint
    const manifest = await stagePage(
      rpc,
      fixture.identityKey,
      checkpoint,
      encodeSyncTransfer({ checkpoint, page: { rows: [], payloadBytes: 0, done: true } })
    )
    const transfer = await fixture.storage.knex('sync_transfers').where({ transferId: manifest.transferId }).first(),
      part = await fixture.storage.knex('sync_transfer_parts').where({ slot: transfer.slot, offset: 0 }).first(),
      changed = Buffer.from(part.bytes)
    changed[changed.length - 1] ^= 1
    await fixture.storage
      .knex('sync_transfer_parts')
      .where({ slot: transfer.slot, offset: 0 })
      .update({ bytes: changed })
    await expect(
      rpc.dispatch(
        'commitSnapshotSyncPageTransfer',
        [checkpoint, { transferId: manifest.transferId }],
        fixture.identityKey
      )
    ).rejects.toThrow('integrity')
    expect(
      (await fixture.storage.knex('snapshot_sync_sessions').where({ sessionId: checkpoint.sessionId }).first()).sequence
    ).toBe(0)
    expect(
      await rpc.dispatch(
        'releaseSnapshotSyncPageTransfer',
        [checkpoint, { transferId: manifest.transferId }],
        fixture.identityKey
      )
    ).toBe(true)
    expect(await fixture.storage.knex('sync_transfer_parts')).toHaveLength(0)
  } finally {
    await rpc.close()
    await fixture.close()
  }
})
