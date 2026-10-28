import { snapshotJournalRevision } from './SnapshotJournalRevision'
import type { SnapshotJournalSourceIdentity } from './SnapshotJournalTypes'
import { StorageClient } from '../../remoting/StorageClient'
import { StorageClient as StorageMobile } from '../../remoting/StorageMobile'
import { snapshotHttpFixture } from '../../../../test/utils/snapshotArchiveHttpFixtures'
import { runSnapshotJournalArchiveReconciliation } from './runSnapshotJournalArchiveReconciliation'
import type { RemoteSnapshotJournalArchive } from './openRemoteSnapshotJournalArchive'
import type { SnapshotJournalReconciliationProgress } from './runSnapshotJournalReconciliation'
import type { KnexRemoteSnapshotSyncRpc } from '../KnexRemoteSnapshotSyncRpc'
import { snapshotJournalDataCapabilities } from './SnapshotJournalDataProtocol'
import { SnapshotArchiveTransportFailure } from '../archive/SnapshotArchiveTransportFailure'
import {
  encodeSnapshotJournalArchiveFrame,
  encodeSnapshotJournalArchiveIdentities
} from './SnapshotJournalArchivePacket'

async function endpoints() {
  const source = await snapshotHttpFixture(true, false),
    target = await snapshotHttpFixture(true, false, 'test', 'http-journal-target')
  const { user } = await target.storage.findOrInsertUser(source.identityKey)
  await target.storage.updateUser(user.userId, { activeStorage: 'http-journal-target' })
  const close = async () => {
    const results = await Promise.allSettled([source.close(), target.close()])
    const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Real journal DATA HTTP endpoint cleanup failed')
  }
  return { source, target, close }
}
afterEach(() => jest.restoreAllMocks())

// Two real roots and many authenticated round trips per case. This finite
// orchestration bound is separate from unchanged30s runtime I/O/performance gates.
const twoEndpointCaseMs = 90000

test.each([StorageClient, StorageMobile])(
  'authenticated %p streams every journal frame into another actual endpoint and recovers the completed window after controller replacement',
  async Client => {
    const f = await endpoints()
    let archive: RemoteSnapshotJournalArchive | undefined
    try {
      const sourceUser = (await f.source.storage.findOrInsertUser(f.source.identityKey)).user
      await f.source.storage.findOrInsertTxLabel(sourceUser.userId, 'two endpoint journal label')
      const sourceServer = await f.source.serve(),
        targetServer = await f.target.serve()
      const from = new Client(f.source.wallet, sourceServer.url, { serverIdentityKey: f.source.serverIdentityKey })
      const to = new Client(f.source.wallet, targetServer.url, { serverIdentityKey: f.target.serverIdentityKey })
      expect((await to.makeAvailable()).snapshotJournalData).toEqual(snapshotJournalDataCapabilities)
      archive = await from.openSnapshotJournalArchive(f.source.identityKey)
      if (archive === undefined) throw new Error('Actual HTTP source artifact unavailable')
      const sourceBinding = archive.manifest.binding
      const destination = await to.openSnapshotJournalDataDestination(f.source.identityKey, sourceBinding)
      if (destination === undefined) throw new Error('Actual HTTP DATA target unavailable')
      let last: SnapshotJournalReconciliationProgress | undefined
      for await (const progress of runSnapshotJournalArchiveReconciliation(archive, async () => destination))
        last = progress
      expect(last?.state).toBe('complete')
      expect(last?.checkpoint.phase).toBe('acknowledged')
      expect(last?.progress.pages).toBe(archive.frameCount)
      const user = (await f.target.storage.findOrInsertUser(f.source.identityKey)).user
      expect(
        await f.target.storage.findTxLabels({ partial: { userId: user.userId, label: 'two endpoint journal label' } })
      ).toHaveLength(1)
      expect(user.activeStorage).toBe('http-journal-target')
      expect(archive.isOpen).toBe(false)
      await archive.closed
      expect(await f.source.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
        archives: 0,
        reservedBytes: 0
      })
      expect(await f.target.storage.knex('sync_transfers').whereNotNull('transferId')).toHaveLength(0)
      const vacant = await f.target.storage.knex('sync_transfers').whereNot('slot', 0).orderBy('slot')
      expect(vacant).toHaveLength(8)
      expect(
        vacant.map(row => ({
          slot: row.slot,
          transferId: row.transferId,
          identityKey: row.identityKey,
          state: row.state,
          expiresAt: row.expiresAt,
          receivedBytes: row.receivedBytes
        }))
      ).toEqual(
        Array.from({ length: 8 }, (_, index) => ({
          slot: index + 1,
          transferId: null,
          identityKey: null,
          state: null,
          expiresAt: 0,
          receivedBytes: 0
        }))
      )
      const before = await destination.status()
      await targetServer.server.close()
      const replacementServer = await f.target.serve(),
        replacementClient = new Client(f.source.wallet, replacementServer.url, {
          serverIdentityKey: f.target.serverIdentityKey
        })
      const replacement = await replacementClient.openSnapshotJournalDataDestination(
        f.source.identityKey,
        sourceBinding
      )
      if (replacement === undefined) throw new Error('Replacement did not admit the actual stored target window')
      expect(await replacement.status()).toEqual(before)
      expect(
        await f.target.storage.findTxLabels({ partial: { userId: user.userId, label: 'two endpoint journal label' } })
      ).toHaveLength(1)
    } finally {
      await archive?.close()
      await f.close()
    }
  },
  twoEndpointCaseMs
)

test(
  'a lost actual frame ACK is recovered from destination SQL without recapture or duplicate logical rows',
  async () => {
    const f = await endpoints()
    let archive: RemoteSnapshotJournalArchive | undefined
    try {
      const sourceUser = (await f.source.storage.findOrInsertUser(f.source.identityKey)).user
      await f.source.storage.findOrInsertTxLabel(sourceUser.userId, 'lost frame ACK label')
      const fromServer = await f.source.serve(),
        targetServer = await f.target.serve()
      const from = new StorageClient(f.source.wallet, fromServer.url, { serverIdentityKey: f.source.serverIdentityKey })
      const to = new StorageClient(f.source.wallet, targetServer.url, { serverIdentityKey: f.target.serverIdentityKey })
      const capture = jest.spyOn(f.source.storage, 'openSnapshotSyncContentSource')
      archive = await from.openSnapshotJournalArchive(f.source.identityKey)
      if (archive === undefined) throw new Error('Actual HTTP artifact unavailable')
      const destination = await to.openSnapshotJournalDataDestination(f.source.identityKey, archive.manifest.binding)
      if (destination === undefined) throw new Error('Actual HTTP target unavailable')
      const rpc = Reflect.get(targetServer.server, 'remoteSnapshotSync') as KnexRemoteSnapshotSyncRpc,
        dispatch = rpc.dispatch.bind(rpc)
      let lost = false
      // The authenticated server really commits and observes its window first.
      // Discarding that response models an uncertain reply; it grants no ACK.
      jest.spyOn(rpc, 'dispatch').mockImplementation(async (method, params, identityKey) => {
        const result = await dispatch(method, params, identityKey)
        if (!lost && method === 'stageSnapshotJournalDataPacket') {
          lost = true
          throw new SnapshotArchiveTransportFailure(new Error('injected loss after actual frame ACK'))
        }
        return result
      })
      let last: SnapshotJournalReconciliationProgress | undefined
      for await (const progress of runSnapshotJournalArchiveReconciliation(archive, async () => destination))
        last = progress
      expect(lost).toBe(true)
      expect(last?.state).toBe('complete')
      expect(last?.checkpoint.phase).toBe('acknowledged')
      expect(await f.target.storage.findTxLabels({ partial: { label: 'lost frame ACK label' } })).toHaveLength(1)
      expect(capture).toHaveBeenCalledTimes(1)
      expect(await f.source.storage.knex('snapshot_archive_requests')).toHaveLength(0)
      expect(await f.source.storage.knex('snapshot_archive_owners')).toHaveLength(0)
      expect(await f.source.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
        archives: 0,
        reservedBytes: 0
      })
    } finally {
      await archive?.close()
      await f.close()
    }
  },
  twoEndpointCaseMs
)

test(
  'DATA HTTP refuses foreign authentication and stale checkpoints before staging wallet data',
  async () => {
    const f = await endpoints()
    let archive: RemoteSnapshotJournalArchive | undefined
    try {
      const fromServer = await f.source.serve(),
        targetServer = await f.target.serve(),
        from = new StorageClient(f.source.wallet, fromServer.url, { serverIdentityKey: f.source.serverIdentityKey }),
        to = new StorageClient(f.source.wallet, targetServer.url, { serverIdentityKey: f.target.serverIdentityKey })
      archive = await from.openSnapshotJournalArchive(f.source.identityKey)
      if (archive === undefined) throw new Error('Actual artifact unavailable')
      const destination = await to.openSnapshotJournalDataDestination(f.source.identityKey, archive.manifest.binding)
      if (destination === undefined) throw new Error('Actual target unavailable')
      const before = await destination.status(),
        frame = await archive.readFrame(0, async () => {
          await f.target.storage.knex('users').first()
        })
      await expect(
        destination.stagePacket(
          { ...before.checkpoint, sequence: before.checkpoint.sequence + 1 },
          encodeSnapshotJournalArchiveFrame({ stream: 'scope', tableId: 0 }, frame.page)
        )
      ).rejects.toThrow('checkpoint')
      expect(await destination.status()).toEqual(before)
      expect(await f.target.storage.knex('snapshot_reconciliation_stage_pages')).toHaveLength(0)
      const rpc = Reflect.get(targetServer.server, 'remoteSnapshotSync') as KnexRemoteSnapshotSyncRpc
      await expect(
        rpc.dispatch(
          'beginSnapshotJournalData',
          [{ version: 1, identityKey: f.source.identityKey, source: archive.manifest.binding }],
          f.target.identityKey
        )
      ).rejects.toThrow()
      expect(await f.target.storage.knex('snapshot_reconciliation_windows')).toHaveLength(1)
    } finally {
      await archive?.close()
      await f.close()
    }
  },
  twoEndpointCaseMs
)

test(
  'multipart journal DATA prefix stays bounded, releases actual parts, and never advances a financial frame ACK',
  async () => {
    const f = await endpoints()
    let archive: RemoteSnapshotJournalArchive | undefined
    try {
      const fromServer = await f.source.serve(),
        targetServer = await f.target.serve()
      const from = new StorageClient(f.source.wallet, fromServer.url, {
          serverIdentityKey: f.source.serverIdentityKey
        }),
        to = new StorageClient(f.source.wallet, targetServer.url, { serverIdentityKey: f.target.serverIdentityKey })
      archive = await from.openSnapshotJournalArchive(f.source.identityKey)
      if (archive === undefined) throw new Error('Actual source artifact unavailable')
      const destination = await to.openSnapshotJournalDataDestination(f.source.identityKey, archive.manifest.binding)
      if (destination === undefined) throw new Error('Actual DATA target unavailable')
      const before = await destination.status(),
        identities = new Map<string, SnapshotJournalSourceIdentity>()
      // Adversarial bounded prefix DATA deliberately has no completing financial
      // frame. Authenticated staging must not mistake upload for a wallet ACK.
      for (let index = 1; index <= 80; index++)
        identities.set('2:' + index, {
          tableId: 2,
          incomingId: index,
          generation: snapshotJournalRevision('1'),
          revision: snapshotJournalRevision('1'),
          naturalIdentity: 'a'.repeat(64),
          required: false,
          naturalKey: { tableId: 2, serialNumber: '\u0000'.repeat(600) + index, certifier: '\u0000'.repeat(600) }
        })
      const packet = encodeSnapshotJournalArchiveIdentities(
        { stream: 'scope', tableId: 0 },
        'f'.repeat(64),
        0,
        identities,
        destination.binding.receipt.highWater
      )
      expect(packet.byteLength).toBeGreaterThan(snapshotJournalDataCapabilities.inlinePacketBytes)
      expect(packet.byteLength).toBeLessThanOrEqual(snapshotJournalDataCapabilities.maxPacketBytes)
      expect((await destination.stagePacket(before.checkpoint, packet)).checkpoint).toEqual(before.checkpoint)
      expect(await destination.status()).toEqual(before)
      expect(await f.target.storage.knex('snapshot_reconciliation_captured_identities')).toHaveLength(80)
      expect((await destination.stagePacket(before.checkpoint, packet)).checkpoint).toEqual(before.checkpoint)
      expect(await f.target.storage.knex('snapshot_reconciliation_captured_identities')).toHaveLength(80)
      expect(await f.target.storage.knex('snapshot_reconciliation_stage_pages')).toHaveLength(0)
      expect(await f.target.storage.knex('certificates')).toHaveLength(0)
      expect(await f.target.storage.knex('sync_transfer_parts')).toHaveLength(0)
      expect(await f.target.storage.knex('sync_transfers').whereNotNull('transferId')).toHaveLength(0)
    } finally {
      await archive?.close()
      await f.close()
    }
  },
  twoEndpointCaseMs
)

test.each([StorageClient, StorageMobile])(
  'authenticated field %p uploads real immutable bytes, recovers a lost stage reply and drains both actual roots',
  async Client => {
    const f = await endpoints(),
      controller = new AbortController(),
      timer = setTimeout(() => controller.abort(new Error('Owned remote field integration deadline')), 180000)
    let archive: import('./openRemoteSnapshotJournalFieldArchive').RemoteSnapshotJournalFieldArchive | undefined,
      destination: import('./RemoteSnapshotJournalFieldDestination').RemoteSnapshotJournalFieldDestination | undefined,
      lost = false,
      failure: { cause: unknown } | undefined
    try {
      const user = (await f.source.storage.findOrInsertUser(f.source.identityKey)).user
      await f.source.storage.findOrInsertTxLabel(user.userId, 'actual remote field upload')
      const { Transaction, LockingScript } = await import('@bsv/sdk'),
        script = [0x6a, 0x4e, 0x70, 0x11, 0x01, 0x00, ...Array.from({ length: 70000 }, (_value, index) => index % 251)],
        transaction = new Transaction(1, [], [{ satoshis: 1, lockingScript: LockingScript.fromBinary(script) }], 0),
        raw = Buffer.from(transaction.toBinary()),
        stamp = Date.now(),
        description = 'remote immutable field 雪\u0000'.repeat(1200)
      await f.source.storage.knex('transactions').insert({
        created_at: stamp,
        updated_at: stamp,
        transactionId: 11,
        userId: user.userId,
        status: 'unprocessed',
        reference: 'actual-remote-field',
        isOutgoing: 0,
        satoshis: 1,
        txid: transaction.id('hex'),
        version: 1,
        lockTime: 0,
        description,
        rawTx: raw
      })

      const sourceServer = await f.source.serve(),
        targetServer = await f.target.serve(),
        from = new Client(f.source.wallet, sourceServer.url, { serverIdentityKey: f.source.serverIdentityKey }),
        to = new Client(f.source.wallet, targetServer.url, { serverIdentityKey: f.target.serverIdentityKey }),
        { snapshotJournalFieldRpcCapabilities } = await import('./SnapshotJournalFieldRpcProtocol'),
        { runSnapshotJournalFieldArchiveReconciliation } = await import('./runSnapshotJournalArchiveReconciliation')
      expect((await to.makeAvailable()).snapshotJournalFields).toEqual(snapshotJournalFieldRpcCapabilities)
      // Keep actual dispatch/SQL behavior. Only the post-commit response is lost.
      const controllerType = await import('./KnexSnapshotJournalFieldRpc'),
        original = controllerType.KnexSnapshotJournalFieldRpc.prototype.dispatch
      jest.spyOn(controllerType.KnexSnapshotJournalFieldRpc.prototype, 'dispatch').mockImplementation(async function (
        this: import('./KnexSnapshotJournalFieldRpc').KnexSnapshotJournalFieldRpc,
        method,
        params,
        identity
      ) {
        const result = await original.call(this, method, params, identity)
        if (!lost && method === 'stageSnapshotJournalFieldFrame') {
          lost = true
          throw new SnapshotArchiveTransportFailure('Synthetic lost real field stage response')
        }
        return result
      })
      archive = await from.openSnapshotJournalFieldArchive(f.source.identityKey, undefined, {
        signal: controller.signal,
        lifetimeMs: 180000
      })
      if (archive === undefined) throw new Error('Actual remote field source unavailable')
      const binding = archive.manifest.binding
      destination = await to.openSnapshotJournalFieldDestination(f.source.identityKey, binding, {
        signal: controller.signal
      })
      if (destination === undefined) throw new Error('Actual remote field destination unavailable')
      const actual = destination
      const admitted = await actual.status(),
        { parseSnapshotJournalDataStatus } = await import('./SnapshotJournalDataProtocol')
      expect(() =>
        parseSnapshotJournalDataStatus(
          admitted,
          f.source.identityKey,
          binding.sourceStorage.storageIdentityKey,
          'http-journal-target'
        )
      ).toThrow()
      expect(
        parseSnapshotJournalDataStatus(
          admitted,
          f.source.identityKey,
          binding.sourceStorage.storageIdentityKey,
          'http-journal-target',
          'wallet-journal-fields/1'
        )
      ).toEqual(admitted)
      let last: SnapshotJournalReconciliationProgress | undefined
      for await (const progress of runSnapshotJournalFieldArchiveReconciliation(archive, async () => actual, {
        signal: controller.signal
      }))
        last = progress
      expect(last?.state).toBe('complete')
      expect(last?.checkpoint.phase).toBe('acknowledged')
      expect(lost).toBe(true)
      const targetUser = (await f.target.storage.findOrInsertUser(f.source.identityKey)).user
      expect(
        await f.target.storage.findTxLabels({
          partial: { userId: targetUser.userId, label: 'actual remote field upload' }
        })
      ).toHaveLength(1)
      expect(targetUser.activeStorage).toBe('http-journal-target')
      expect(await f.target.storage.knex('transactions').where('txid', transaction.id('hex')).first()).toMatchObject({
        rawTx: raw,
        description
      })

      expect(
        await to.getSnapshotJournalFieldStatus(f.source.identityKey, binding.sourceStorage.storageIdentityKey)
      ).toMatchObject({ checkpoint: last?.checkpoint })
      for (const storage of [f.source.storage, f.target.storage]) {
        expect(await storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
        expect(await storage.knex('sync_transfers').whereNotNull('transferId')).toHaveLength(0)
      }
      expect(archive.isOpen).toBe(false)
      await archive.closed
      // A new authenticated controller reads the same actual durable financial
      // ACK after the separate transient upload has been physically deleted.
      await targetServer.server.close()
      const replacement = await f.target.serve(),
        client = new Client(f.source.wallet, replacement.url, { serverIdentityKey: f.target.serverIdentityKey })
      expect(
        await client.getSnapshotJournalFieldStatus(f.source.identityKey, binding.sourceStorage.storageIdentityKey)
      ).toMatchObject({ checkpoint: last?.checkpoint })
    } catch (cause) {
      failure = { cause }
    }
    clearTimeout(timer)
    const owners = await Promise.allSettled([destination?.close(), archive?.close()]),
      roots = await Promise.allSettled([f.close()]),
      results = [...owners, ...roots],
      failures = [
        ...(failure === undefined ? [] : [failure.cause]),
        ...results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
      ]
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1)
      throw new AggregateError(failures, 'Actual remote field test and owner cleanup failed', { cause: failures[0] })
  },
  210000
)

test('authenticated READY field upload resumes with a fresh client/server after its actual source reader has physically closed', async () => {
  const f = await endpoints(),
    controller = new AbortController(),
    timer = setTimeout(() => controller.abort(new Error('Owned uploaded-field recovery deadline')), 180000)
  let archive: import('./openRemoteSnapshotJournalFieldArchive').RemoteSnapshotJournalFieldArchive | undefined,
    destination: import('./RemoteSnapshotJournalFieldDestination').RemoteSnapshotJournalFieldDestination | undefined,
    resumed: import('./RemoteSnapshotJournalFieldDestination').RemoteSnapshotJournalFieldDestination | undefined,
    failure: { cause: unknown } | undefined
  try {
    const user = (await f.source.storage.findOrInsertUser(f.source.identityKey)).user
    await f.source.storage.findOrInsertTxLabel(user.userId, 'durable field upload recovery')
    const targetServer = await f.target.serve(),
      to = new StorageClient(f.source.wallet, targetServer.url, { serverIdentityKey: f.target.serverIdentityKey })
    // This exercises the genuine local source provider, without an archive-
    // shaped stand-in or a source SQL fence manufactured from uploaded DATA.
    archive = await f.source.storage.openSnapshotJournalFieldArchive(f.source.identityKey, undefined, {
      lifetimeMs: 180000,
      signal: controller.signal
    })
    if (archive === undefined) throw new Error('Actual local field archive unavailable')
    destination = await to.openSnapshotJournalFieldDestination(f.source.identityKey, archive.manifest.binding, {
      signal: controller.signal
    })
    if (destination === undefined) throw new Error('Actual field upload destination unavailable')
    const before = await destination.status()
    await destination.stageArchiveFrame(before.checkpoint, archive)
    const copied = await destination.status(),
      recovery = destination.uploadResume
    expect(copied.checkpoint.sequence).toBeGreaterThan(before.checkpoint.sequence)
    expect(copied.checkpoint.phase).not.toBe('acknowledged')
    await archive.close()
    await archive.closed
    expect(archive.isOpen).toBe(false)
    await targetServer.server.close()
    // A real controller restart retains the public endpoint address. This also
    // lets the old authenticated client observe the new owner's idempotent cleanup.
    const replacement = await f.target.serve({ port: Number(new URL(targetServer.url).port) }),
      client = new StorageClient(f.source.wallet, replacement.url, { serverIdentityKey: f.target.serverIdentityKey })
    await expect(
      client.resumeSnapshotJournalFieldDestination(f.source.identityKey, {
        ...recovery,
        source: { ...recovery.source, snapshotId: '55'.repeat(32) }
      })
    ).rejects.toThrow('original source')
    resumed = await client.resumeSnapshotJournalFieldDestination(f.source.identityKey, recovery, {
      signal: controller.signal
    })
    expect(await resumed.status()).toEqual(copied)
    let last: SnapshotJournalReconciliationProgress | undefined
    for await (const progress of resumed.reconcileUploaded({ signal: controller.signal })) last = progress
    expect(last?.state).toBe('complete')
    expect(last?.checkpoint.phase).toBe('acknowledged')
    await resumed.closed
    const targetUser = (await f.target.storage.findOrInsertUser(f.source.identityKey)).user
    expect(
      await f.target.storage.findTxLabels({
        partial: { userId: targetUser.userId, label: 'durable field upload recovery' }
      })
    ).toHaveLength(1)
    expect(targetUser.activeStorage).toBe('http-journal-target')
    expect(await f.target.storage.knex('snapshot_archives')).toHaveLength(0)
    expect(await f.target.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
      archives: 0,
      reservedBytes: 0
    })
    await expect(client.resumeSnapshotJournalFieldDestination(f.source.identityKey, recovery)).rejects.toThrow('READY')
  } catch (cause) {
    failure = { cause }
  }
  clearTimeout(timer)
  const owners = await Promise.allSettled([resumed?.close(), destination?.close(), archive?.close()]),
    roots = await Promise.allSettled([f.close()]),
    failures = [
      ...(failure === undefined ? [] : [failure.cause]),
      ...[...owners, ...roots].flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    ]
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1)
    throw new AggregateError(failures, 'Actual field recovery and physical cleanup failed', { cause: failures[0] })
}, 210000)

test('cancelled upload fences a retained actual target writer and a late financial BEGIN from another controller', async () => {
  const f = await endpoints()
  let archive: import('./openRemoteSnapshotJournalFieldArchive').RemoteSnapshotJournalFieldArchive | undefined,
    destination: import('./RemoteSnapshotJournalFieldDestination').RemoteSnapshotJournalFieldDestination | undefined
  try {
    const { KnexSnapshotArchiveRequestStore } = await import('../archive/KnexSnapshotArchiveRequestStore'),
      { KnexSnapshotJournalFieldDestination } = await import('./KnexSnapshotJournalFieldDestination'),
      { journalCopyLimits } = await import('./SnapshotJournalCopyLimits'),
      server = await f.target.serve(),
      client = new StorageClient(f.source.wallet, server.url, { serverIdentityKey: f.target.serverIdentityKey })
    archive = await f.source.storage.openSnapshotJournalFieldArchive(f.source.identityKey)
    if (archive === undefined) throw new Error('Actual source unavailable')
    destination = await client.openSnapshotJournalFieldDestination(f.source.identityKey, archive.manifest.binding)
    if (destination === undefined) throw new Error('Actual upload unavailable')
    const resume = destination.uploadResume,
      requests = new KnexSnapshotArchiveRequestStore(f.target.storage.knex),
      owner = await requests.journalFieldUploadOwner(f.source.identityKey, resume.request),
      admission: import('./SnapshotJournalProvider').SnapshotJournalWriterAdmission = operation => operation(),
      receiver = await KnexSnapshotJournalFieldDestination.resume(
        f.target.storage,
        f.source.identityKey,
        resume.source.sourceStorage.storageIdentityKey,
        journalCopyLimits(),
        admission,
        undefined,
        undefined,
        owner
      )
    if (receiver === undefined) throw new Error('Actual target window unavailable')
    const before = await receiver.status()
    // This is the original concrete receiver retaining its server-private SQL
    // owner, followed by cancellation through an independent real controller.
    await new KnexSnapshotArchiveRequestStore(f.target.storage.knex).cancelJournalFieldUpload(
      f.source.identityKey,
      resume.request
    )
    let entered = false
    const writer = Reflect.get(receiver, 'writer') as <T>(
      operation: (trx: import('knex').Knex) => Promise<T>
    ) => Promise<T>
    await expect(
      writer.call(receiver, async trx => {
        entered = true
        await trx('tx_labels').insert({
          userId: receiver.binding.destinationUserId,
          label: 'forbidden late upload write',
          created_at: new Date(),
          updated_at: new Date(),
          isDeleted: false
        })
      })
    ).rejects.toThrow('unavailable')
    expect(entered).toBe(false)
    expect(await f.target.storage.findTxLabels({ partial: { label: 'forbidden late upload write' } })).toHaveLength(0)
    await expect(
      KnexSnapshotJournalFieldDestination.begin(
        f.target.storage,
        f.source.identityKey,
        resume.source,
        journalCopyLimits(),
        admission,
        undefined,
        owner
      )
    ).rejects.toThrow('unavailable')
    expect(
      await client.getSnapshotJournalFieldStatus(f.source.identityKey, resume.source.sourceStorage.storageIdentityKey)
    ).toMatchObject({ checkpoint: before.checkpoint })
    expect(await f.target.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
      archives: 0,
      reservedBytes: 0
    })
  } finally {
    const drained = await Promise.allSettled([destination?.close(), archive?.close()])
    await f.close()
    const failures = drained.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (failures.length)
      await Promise.reject(new AggregateError(failures, 'Actual cancelled writer owners failed cleanup'))
  }
}, 90000)

test('field source recovery preflight owns and drains its original timeout before any reader is issued', async () => {
  const f = await endpoints(),
    controller = new AbortController()
  let guard: ReturnType<typeof setTimeout> | undefined
  let archive: import('./openRemoteSnapshotJournalFieldArchive').RemoteSnapshotJournalFieldArchive | undefined
  try {
    const { SnapshotJournalFieldArchiveTransport } = await import('./SnapshotJournalFieldArchiveTransport'),
      { snapshotJournalFieldArchiveCapabilities } = await import('./SnapshotJournalFieldArchiveProtocol'),
      { openRemoteSnapshotJournalFieldArchive } = await import('./openRemoteSnapshotJournalFieldArchive'),
      { SnapshotCancelledError } = await import('../SnapshotCancelledError')
    archive = await f.source.storage.openSnapshotJournalFieldArchive(f.source.identityKey)
    if (archive === undefined) throw new Error('Actual source unavailable')
    const binding = archive.manifest.binding,
      calls: string[] = []
    guard = setTimeout(() => controller.abort(new Error('Owned stalled preflight cleanup')), 1000)
    let settled = false
    const transport = new SnapshotJournalFieldArchiveTransport(
      async (method, _params, signal) => {
        calls.push(method)
        if (signal === undefined) throw new Error('Recovery has no owned transport signal')
        return await new Promise((_, reject) => {
          const stop = () => {
            settled = true
            reject(new SnapshotCancelledError('Actual pending preflight aborted'))
          }
          if (signal.aborted) stop()
          else signal.addEventListener('abort', stop, { once: true })
        })
      },
      f.source.identityKey,
      binding.sourceStorage.storageIdentityKey,
      'test',
      snapshotJournalFieldArchiveCapabilities(300000)
    )
    await expect(
      openRemoteSnapshotJournalFieldArchive(
        transport,
        undefined,
        { lifetimeMs: 50, signal: controller.signal },
        { source: binding.journal.source, receipt: binding.journal.receipt }
      )
    ).rejects.toThrow('Remote snapshot expired')
    expect(settled).toBe(true)
    expect(controller.signal.aborted).toBe(false)
    expect(calls).toEqual(['reopenSnapshotJournalFieldArchive'])
    expect(archive.isOpen).toBe(true)
    expect(await f.source.storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 1 })
  } finally {
    clearTimeout(guard)
    controller.abort()
    await archive?.close()
    await archive?.closed
    await f.close()
  }
}, 30000)
