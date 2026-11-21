import { Transaction, LockingScript, UnlockingScript } from '@bsv/sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { WalletStorageManager } from '../WalletStorageManager'
import { StorageClient } from '../remoting/StorageClient'
import { StorageClient as StorageMobile } from '../remoting/StorageMobile'
import { gate, snapshotHttpFixture } from '../../../test/utils/snapshotArchiveHttpFixtures'
import { KnexRemoteSnapshotSyncRpc } from './KnexRemoteSnapshotSyncRpc'
import type { SnapshotSyncCheckpoint } from './SnapshotSync'
import type { Chain } from '../../sdk/types'

const when = new Date('2026-10-06T00:00:00.000Z')

/** Independent owners all drain, even if another owner's close rejects. */
async function closeFixtures(...fixtures: Array<{ close: () => Promise<void> } | undefined>): Promise<void> {
  const results = await Promise.allSettled(fixtures.map(fixture => Promise.resolve().then(() => fixture?.close())))
  const failures = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Remote destination fixtures retain independent cleanup')
}

async function sourceFixture(
  identityKey: string,
  storageIdentityKey = 'local-source',
  primaryStorage = storageIdentityKey,
  seed = true,
  chain: Chain = 'test'
) {
  const directory = await mkdtemp(join(tmpdir(), 'remote-snapshot-destination-'))
  const storage = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions(chain),
    snapshotJournalRetention: false,
    knex: knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'source.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
      acquireConnectionTimeout: 1000
    })
  })
  const database = storage.knex
  const close = async (): Promise<void> => {
    const failures: unknown[] = []
    try {
      await storage.destroy()
    } catch (cause) {
      failures.push(cause)
    }
    let drained = false
    try {
      await database.destroy()
      drained = true
    } catch (cause) {
      failures.push(cause)
    }
    // Preserve files if the original pool still owns them. A public close
    // failure does not prevent the independent actual root drain attempt.
    if (drained)
      try {
        await rm(directory, { recursive: true, force: true })
      } catch (cause) {
        failures.push(cause)
      }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Remote source fixture retains cleanup')
  }
  try {
    await storage.knex.raw('PRAGMA journal_mode = WAL')
    await storage.migrate('local source', storageIdentityKey)
    await storage.makeAvailable()
    const { user } = await storage.findOrInsertUser(identityKey)
    await storage.updateUser(user.userId, { activeStorage: primaryStorage, updated_at: when })
    for (let index = 0; seed && index < 130; index++)
      await storage.insertTxLabel({
        txLabelId: 0,
        userId: user.userId,
        created_at: when,
        updated_at: when,
        label: `source-${index}`,
        isDeleted: index % 3 === 0
      })
    const manager = new WalletStorageManager(identityKey, storage)
    await manager.makeAvailable()
    return { storage, manager, user, close }
  } catch (cause) {
    try {
      await close()
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Remote destination source fixture retains cleanup')
    }
    throw cause
  }
}

async function beforeDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Foreground work did not finish during the held remote commit')),
          2000
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

afterEach(() => jest.restoreAllMocks())

test.each([StorageClient, StorageMobile])(
  'actual %p regtest destination commits paged sync and a replacement server retains its checkpoint',
  async Client => {
    const destination = await snapshotHttpFixture(true, false, 'regtest')
    let source: Awaited<ReturnType<typeof sourceFixture>> | undefined
    try {
      source = await sourceFixture(destination.identityKey, 'local-source', 'local-source', true, 'regtest')
      const { server, url } = await destination.serve()
      const client = new Client(destination.wallet, url, { serverIdentityKey: destination.serverIdentityKey })
      expect(await client.getSnapshotSync()!.supportsDestination()).toBe(true)
      const legacy = jest.spyOn(destination.storage, 'processSyncChunk')
      const result = await source.manager.syncToWriterResumable(await source.manager.getAuth(), client, {
        maxItems: 128,
        maxRoughSize: 262144
      })
      expect(result).toMatchObject({ status: 'completed', mode: 'paged', snapshotCheckpoint: { done: true } })
      expect(legacy).not.toHaveBeenCalled()
      expect(await destination.storage.knex('tx_labels').select('label', 'isDeleted').orderBy('label')).toEqual(
        await source.storage.knex('tx_labels').select('label', 'isDeleted').orderBy('label')
      )
      await server.close()
      const replacement = await destination.serve()
      const fresh = new Client(destination.wallet, replacement.url, {
        serverIdentityKey: destination.serverIdentityKey
      })
      expect(await fresh.getSnapshotSync()!.checkpoint(destination.identityKey, 'local-source')).toEqual(
        result.snapshotCheckpoint
      )
    } finally {
      await closeFixtures(source, destination)
    }
  }
)

// Authored UNRUN. Real HTTP mutual authentication, compact frames, ordinary
// SQL writer/primary triggers and manager admission; no fabricated capability
// advertisement, sealed source, native profile or completion verdict.
test.each([StorageClient, StorageMobile])(
  'actual %p remote destination leaves foreground access free while HTTP waits',
  async Client => {
    const destination = await snapshotHttpFixture(true, false),
      entered = gate(),
      release = gate()
    let source: Awaited<ReturnType<typeof sourceFixture>> | undefined, copying: Promise<unknown> | undefined
    try {
      source = await sourceFixture(destination.identityKey)
      const destinationUser = (await destination.storage.findUserByIdentityKey(destination.identityKey))!
      await destination.storage.updateUser(destinationUser.userId, { activeStorage: 'local-source' })
      const { server, url } = await destination.serve()
      const rpc = Reflect.get(server, 'remoteSnapshotSync') as KnexRemoteSnapshotSyncRpc
      const dispatch = rpc.dispatch.bind(rpc)
      let held = false,
        released = false
      jest.spyOn(rpc, 'dispatch').mockImplementation(async (method, params, identity) => {
        if (method === 'commitSnapshotSyncPage' && (params[0] as SnapshotSyncCheckpoint).tableIndex === 3 && !held) {
          held = true
          entered.resolve()
          await release.promise
        }
        return await dispatch(method, params, identity)
      })
      const client = new Client(destination.wallet, url, { serverIdentityKey: destination.serverIdentityKey })
      expect(await client.getSnapshotSync()!.supportsDestination()).toBe(true)
      const legacy = jest.spyOn(destination.storage, 'processSyncChunk')
      copying = source.manager.syncToWriterResumable(await source.manager.getAuth(), client, {
        maxItems: 128,
        maxRoughSize: 262144
      })
      void copying.catch(() => undefined)
      await Promise.race([
        entered.promise,
        copying.then(() => {
          throw new Error('Copy bypassed the actual held commit')
        })
      ])
      await beforeDeadline(
        source.manager.runAsWriter(async () => {
          expect(released).toBe(false)
          await source!.storage.findOrInsertTxLabel(source!.user.userId, 'foreground-after-snapshot')
        })
      )
      released = true
      release.resolve()
      expect(await copying).toMatchObject({ status: 'completed', mode: 'paged', snapshotCheckpoint: { done: true } })
      expect(legacy).not.toHaveBeenCalled()
      const actual = await destination.storage.findTxLabels({ partial: { userId: destinationUser.userId } })
      expect(
        actual.map(row => ({ label: row.label, deleted: row.isDeleted })).sort((a, b) => a.label.localeCompare(b.label))
      ).toEqual(
        Array.from({ length: 130 }, (_, index) => ({ label: `source-${index}`, deleted: index % 3 === 0 })).sort(
          (a, b) => a.label.localeCompare(b.label)
        )
      )
      expect(actual.some(row => row.label === 'foreground-after-snapshot')).toBe(false)
      const checkpoint = await client.getSnapshotSync()!.checkpoint(destination.identityKey, 'local-source')
      expect(checkpoint).toMatchObject({ done: true, tableIndex: 12, identityKey: destination.identityKey })
    } finally {
      release.resolve()
      await copying?.catch(() => undefined)
      await closeFixtures(source, destination)
    }
  },
  30000
)

test('a lost real commit reply is observed through another controller before a fresh full copy', async () => {
  const destination = await snapshotHttpFixture(true, false)
  let source: Awaited<ReturnType<typeof sourceFixture>> | undefined
  try {
    source = await sourceFixture(destination.identityKey)
    const { server, url } = await destination.serve()
    const rpc = Reflect.get(server, 'remoteSnapshotSync') as KnexRemoteSnapshotSyncRpc,
      dispatch = rpc.dispatch.bind(rpc)
    let lost = false
    jest.spyOn(rpc, 'dispatch').mockImplementation(async (method, params, identity) => {
      const result = await dispatch(method, params, identity)
      if (method === 'commitSnapshotSyncPage' && !lost) {
        lost = true
        throw new Error('Synthetic lost reply AFTER the actual SQL commit')
      }
      return result
    })
    const client = new StorageClient(destination.wallet, url, { serverIdentityKey: destination.serverIdentityKey })
    await expect(source.manager.syncToWriterResumable(await source.manager.getAuth(), client)).rejects.toThrow()
    expect(lost).toBe(true)
    const independent = await destination.serve()
    const reader = new StorageClient(destination.wallet, independent.url, {
      serverIdentityKey: destination.serverIdentityKey
    })
    const checkpoint = await reader.getSnapshotSync()!.checkpoint(destination.identityKey, 'local-source')
    expect(checkpoint).toMatchObject({ sequence: 1, tableIndex: 1, done: false })
    expect(await source.manager.syncToWriterResumable(await source.manager.getAuth(), reader)).toMatchObject({
      status: 'completed',
      mode: 'paged',
      snapshotCheckpoint: { done: true }
    })
    const user = (await destination.storage.findUserByIdentityKey(destination.identityKey))!
    expect(await destination.storage.findTxLabels({ partial: { userId: user.userId } })).toHaveLength(130)
  } finally {
    await closeFixtures(source, destination)
  }
}, 30000)

test('disabled new destination keeps the authenticated exclusive compatibility path', async () => {
  const destination = await snapshotHttpFixture(true, false)
  let source: Awaited<ReturnType<typeof sourceFixture>> | undefined
  try {
    source = await sourceFixture(destination.identityKey)
    const { url } = await destination.serve({ snapshotArchives: false })
    const client = new StorageClient(destination.wallet, url, { serverIdentityKey: destination.serverIdentityKey })
    expect(await client.getSnapshotSync()!.supportsDestination()).toBe(false)
    const legacy = jest.spyOn(destination.storage, 'processSyncChunk')
    expect(await source.manager.syncToWriterResumable(await source.manager.getAuth(), client)).toMatchObject({
      status: 'completed',
      mode: 'exclusive'
    })
    expect(legacy).toHaveBeenCalled()
  } finally {
    await closeFixtures(source, destination)
  }
}, 30000)

test('an actual provider registration fences a held remote reply without erasing its durable server outcome', async () => {
  const destination = await snapshotHttpFixture(true, false),
    entered = gate(),
    release = gate()
  let source: Awaited<ReturnType<typeof sourceFixture>> | undefined,
    backup: Awaited<ReturnType<typeof sourceFixture>> | undefined,
    copying: Promise<unknown> | undefined
  try {
    source = await sourceFixture(destination.identityKey)
    backup = await sourceFixture(destination.identityKey, 'new-backup', 'local-source', false)
    const user = (await destination.storage.findUserByIdentityKey(destination.identityKey))!
    await destination.storage.updateUser(user.userId, { activeStorage: 'local-source' })
    const { server, url } = await destination.serve()
    const rpc = Reflect.get(server, 'remoteSnapshotSync') as KnexRemoteSnapshotSyncRpc,
      dispatch = rpc.dispatch.bind(rpc)
    let held = false
    jest.spyOn(rpc, 'dispatch').mockImplementation(async (method, params, identity) => {
      if (method === 'commitSnapshotSyncPage' && (params[0] as SnapshotSyncCheckpoint).tableIndex === 3 && !held) {
        held = true
        entered.resolve()
        await release.promise
      }
      return await dispatch(method, params, identity)
    })
    const client = new StorageClient(destination.wallet, url, { serverIdentityKey: destination.serverIdentityKey })
    copying = source.manager.syncToWriterResumable(await source.manager.getAuth(), client)
    void copying.catch(() => undefined)
    await Promise.race([
      entered.promise,
      copying.then(() => {
        throw new Error('Copy bypassed the held remote commit')
      })
    ])
    await beforeDeadline(source.manager.addWalletStorageProvider(backup.storage))
    expect(source.manager.getActive()).toBe(source.storage)
    release.resolve()
    await expect(copying).rejects.toThrow('generation changed')
    expect(await client.getSnapshotSync()!.checkpoint(destination.identityKey, 'local-source')).toMatchObject({
      sequence: 4,
      tableIndex: 3,
      done: false
    })
  } finally {
    release.resolve()
    await copying?.catch(() => undefined)
    await closeFixtures(backup, source, destination)
  }
}, 30000)

test.each([StorageClient, StorageMobile])(
  'actual %p HTTP transfer preserves a multi-part structured history and drains staging',
  async Client => {
    const destination = await snapshotHttpFixture(true, false)
    let source: Awaited<ReturnType<typeof sourceFixture>> | undefined
    try {
      source = await sourceFixture(destination.identityKey)
      // Structurally encoded, deliberately unfunded pending transaction. This
      // case proves HTTP/SQL/record fidelity, not a funded spend or chain proof.
      const tx = new Transaction(
          1,
          [
            {
              sourceTXID: '1'.repeat(64),
              sourceOutputIndex: 0,
              unlockingScript: UnlockingScript.fromHex('51'),
              sequence: 0xffffffff
            }
          ],
          [{ satoshis: 0, lockingScript: LockingScript.fromHex('006a') }],
          0
        ),
        txid = tx.id('hex'),
        history = { notes: [{ when: when.toISOString(), what: 'large-source-text', detail: 'x'.repeat(700000) }] }
      const transactionId = await source.storage.insertTransaction({
        transactionId: 0,
        userId: source.user.userId,
        created_at: when,
        updated_at: when,
        status: 'nosend',
        reference: 'large-source-request',
        isOutgoing: true,
        satoshis: 0,
        description: 'large-source-request',
        txid,
        rawTx: tx.toBinary()
      })
      await source.storage.insertProvenTxReq({
        provenTxReqId: 0,
        created_at: when,
        updated_at: when,
        txid,
        status: 'nosend',
        attempts: 0,
        notified: false,
        history: JSON.stringify(history),
        notify: JSON.stringify({ transactionIds: [transactionId] }),
        rawTx: tx.toBinary()
      })
      const user = (await destination.storage.findUserByIdentityKey(destination.identityKey))!
      await destination.storage.updateUser(user.userId, { activeStorage: 'local-source' })
      const { server, url } = await destination.serve()
      const rpc = Reflect.get(server, 'remoteSnapshotSync') as KnexRemoteSnapshotSyncRpc,
        dispatch = rpc.dispatch.bind(rpc),
        methods: string[] = []
      jest.spyOn(rpc, 'dispatch').mockImplementation(async (...args) => {
        methods.push(args[0])
        return await dispatch(...args)
      })
      const client = new Client(destination.wallet, url, { serverIdentityKey: destination.serverIdentityKey })
      expect(
        await source.manager.syncToWriterResumable(await source.manager.getAuth(), client, { maxRoughSize: 3000000 })
      ).toMatchObject({ status: 'completed', mode: 'paged', snapshotCheckpoint: { done: true } })
      expect(methods).toContain('commitSnapshotSyncPageTransfer')
      expect(methods.filter(method => method === 'writeSnapshotSyncPageTransferPart').length).toBeGreaterThan(1)
      const request = (await destination.storage.findProvenTxReqs({ partial: { txid } }))[0],
        actualTransaction = (await destination.storage.findTransactions({ partial: { userId: user.userId, txid } }))[0]
      expect(JSON.parse(request.history)).toEqual(history)
      expect(JSON.parse(request.notify).transactionIds).toEqual([actualTransaction.transactionId])
      expect(new Uint8Array(request.rawTx)).toEqual(new Uint8Array(tx.toBinary()))
      expect(await destination.storage.knex('sync_transfer_parts')).toHaveLength(0)
      expect(await destination.storage.knex('sync_transfers').whereNotNull('transferId')).toHaveLength(0)
    } finally {
      await closeFixtures(source, destination)
    }
  },
  30000
)
