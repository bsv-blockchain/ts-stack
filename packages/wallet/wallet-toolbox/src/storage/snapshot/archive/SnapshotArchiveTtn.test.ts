import { PrivateKey } from '@bsv/sdk'
import { StorageClient } from '../../remoting/StorageClient'
import { StorageClient as StorageMobile } from '../../remoting/StorageMobile'
import { WalletStorageManager } from '../../WalletStorageManager'
import { snapshotHttpFixture } from '../../../../test/utils/snapshotArchiveHttpFixtures'
import { openRemoteSnapshot } from './openRemoteSnapshot'

async function closeFixtures(fixtures: Array<Awaited<ReturnType<typeof snapshotHttpFixture>> | undefined>) {
  const results = await Promise.allSettled(fixtures.map(fixture => fixture?.close()))
  const failures = results.filter(x => x.status === 'rejected').map(x => x.reason)
  if (failures.length) throw new AggregateError(failures, 'TTN fixture cleanup failed')
}

test.each([
  [StorageClient, StorageMobile],
  [StorageMobile, StorageClient]
])(
  'TTN archive and durable primary handoff work from %p to %p',
  async (Source, Target) => {
    const key = PrivateKey.fromRandom()
    const source = await snapshotHttpFixture(true, false, 'ttn', 'ttn-source', key)
    let target: Awaited<ReturnType<typeof snapshotHttpFixture>> | undefined
    try {
      // The target already owns unrelated users, so local numeric user IDs
      // differ. Only the authenticated profile identity may select its rows.
      target = await snapshotHttpFixture(true, false, 'ttn', 'ttn-target')
      const sourceHttp = await source.serve(),
        targetHttp = await target.serve()
      const a = new Source(source.wallet, sourceHttp.url, { serverIdentityKey: source.serverIdentityKey })
      const b = new Target(target.createWallet(key), targetHttp.url, { serverIdentityKey: target.serverIdentityKey })
      for (const client of [a, b]) {
        const settings = await client.makeAvailable()
        expect(settings.chain).toBe('ttn')
        expect(settings.snapshotArchive).toBeDefined()
        expect(settings.snapshotJournalArchive).toBeDefined()
        expect(settings.snapshotJournalFieldArchive).toBeDefined()
        expect(settings.primaryHandoff).toBeDefined()
        expect(await client.getPrimaryHandoffControl()).toBeDefined()
      }
      const user = (await source.storage.findOrInsertUser(source.identityKey)).user
      await source.storage.findOrInsertTxLabel(user.userId, 'TTN archive and handoff label')
      const transport = await a.getSnapshotArchiveTransport(source.identityKey)
      expect(transport).toBeDefined()
      const archive = await openRemoteSnapshot(transport!)
      try {
        expect(archive?.sourceStorage.chain).toBe('ttn')
        const page = await archive!.readPage('txLabels')
        expect(page.rows).toEqual(
          expect.arrayContaining([expect.objectContaining({ label: 'TTN archive and handoff label' })])
        )
      } finally {
        await archive?.close()
        await archive?.closed
      }
      const fields = await a.openSnapshotJournalFieldArchive(source.identityKey)
      expect(fields?.manifest.binding.sourceStorage.chain).toBe('ttn')
      try {
        await fields!.readFrame(0, async () => {
          await source.storage.findUsers({ partial: { identityKey: source.identityKey } })
        })
      } finally {
        await fields?.close()
        await fields?.closed
      }
      const initial = new WalletStorageManager(source.identityKey, a)
      await initial.makeAvailable()
      await initial.setActive('ttn-source')
      const manager = new WalletStorageManager(source.identityKey, a, [b])
      await manager.makeAvailable()
      const copied = await manager.syncToWriterResumable(await manager.getAuth(), b)
      expect(copied.status).toBe('completed')
      await manager.setActive('ttn-target')
      expect(manager.getActiveStore()).toBe('ttn-target')
      expect(manager.isActiveEnabled).toBe(true)
      for (const fixture of [source, target]) {
        const local = (await fixture.storage.findOrInsertUser(source.identityKey)).user
        expect(local.activeStorage).toBe('ttn-target')
        expect(
          await fixture.storage.findTxLabels({
            partial: { userId: local.userId, label: 'TTN archive and handoff label' }
          })
        ).toHaveLength(1)
        const control = await fixture.storage.getPrimaryHandoffControl()
        expect(await control!.status({ identityKey: source.identityKey, userId: local.userId })).toMatchObject({
          phase: 'complete'
        })
        expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
          archives: 0,
          reservedBytes: 0
        })
      }
      // A replacement manager observes the persisted selected primary rather than
      // relying on the first manager's cached selection or control replies.
      const replacement = new WalletStorageManager(source.identityKey, a, [b])
      await replacement.makeAvailable()
      expect(replacement.getActiveStore()).toBe('ttn-target')
      expect(replacement.isActiveEnabled).toBe(true)
      await replacement.setActive('ttn-source')
      expect(replacement.getActiveStore()).toBe('ttn-source')
      for (const fixture of [source, target]) {
        expect((await fixture.storage.findOrInsertUser(source.identityKey)).user.activeStorage).toBe('ttn-source')
      }
    } finally {
      await closeFixtures([source, target])
    }
  },
  120000
)
