import { KnexSnapshotArchiveStore } from '../archive/KnexSnapshotArchiveStore'
import { snapshotJournalDataManagerFixture as fixture } from '../../../../test/utils/snapshotJournalDataManagerFixture'
import { StorageClient } from '../../remoting/StorageClient'
import { StorageClient as StorageMobile } from '../../remoting/StorageMobile'

afterEach(() => jest.restoreAllMocks())
const composedCaseMs = 90000

test.each([StorageClient, StorageMobile])(
  'ordinary %p unchanged pull confirms the previous actual journal ACK with zero pages or new source capture',
  async Client => {
    const f = await fixture()
    try {
      const { user } = await f.remote.storage.findOrInsertUser(f.remote.identityKey)
      await f.remote.storage.findOrInsertTxLabel(user.userId, 'quiescent DATA label')
      const client = new Client(f.remote.wallet, f.served.url, { serverIdentityKey: f.remote.serverIdentityKey })
      const capture = jest.spyOn(KnexSnapshotArchiveStore.prototype, 'beginJournal')
      const first = await f.manager.syncFromReaderResumable(f.remote.identityKey, client)
      expect(first.journalCheckpoint?.phase).toBe('acknowledged')
      expect(capture).toHaveBeenCalledTimes(1)
      const second = await f.manager.syncFromReaderResumable(f.remote.identityKey, client)
      expect(second).toMatchObject({
        status: 'completed',
        mode: 'paged',
        pages: 0,
        inserts: 0,
        updates: 0,
        journalCheckpoint: first.journalCheckpoint,
        noChangeJournalReceipt: {
          version: 1,
          kind: 'journal-data',
          checkpoint: first.journalCheckpoint,
          identityKey: f.remote.identityKey
        }
      })
      expect(capture).toHaveBeenCalledTimes(1)
      expect(await f.storage.knex('snapshot_sync_journal_data_receipts').where('complete', 1)).toHaveLength(1)
      expect(await f.storage.findTxLabels({ partial: { label: 'quiescent DATA label' } })).toHaveLength(1)
      await f.remote.storage.findOrInsertTxLabel(user.userId, 'changed DATA label')
      const changed = await f.manager.syncFromReaderResumable(f.remote.identityKey, client)
      expect(changed.noChangeJournalReceipt).toBeUndefined()
      expect(changed.pages).toBeGreaterThan(0)
      expect(capture).toHaveBeenCalledTimes(2)
      expect(await f.storage.findTxLabels({ partial: { label: 'changed DATA label' } })).toHaveLength(1)
    } finally {
      await f.close()
    }
  },
  composedCaseMs
)

test.each([false, true])(
  'a changed actual target requires a complete repair even when the source also changes: %p',
  async sourceChanged => {
    const f = await fixture()
    try {
      const { user } = await f.remote.storage.findOrInsertUser(f.remote.identityKey)
      await f.remote.storage.findOrInsertTxLabel(user.userId, 'target repair DATA label')
      const client = new StorageClient(f.remote.wallet, f.served.url, {
          serverIdentityKey: f.remote.serverIdentityKey
        }),
        capture = jest.spyOn(KnexSnapshotArchiveStore.prototype, 'beginJournal')
      await f.manager.syncFromReaderResumable(f.remote.identityKey, client)
      await f.storage.knex('tx_labels').where('label', 'target repair DATA label').delete()
      if (sourceChanged) await f.remote.storage.findOrInsertTxLabel(user.userId, 'concurrent new DATA label')
      const repair = await f.manager.syncFromReaderResumable(f.remote.identityKey, client)
      expect(repair.noChangeJournalReceipt).toBeUndefined()
      expect(repair.pages).toBeGreaterThan(0)
      expect(capture).toHaveBeenCalledTimes(sourceChanged ? 3 : 2)
      expect(await f.storage.findTxLabels({ partial: { label: 'target repair DATA label' } })).toHaveLength(1)
      if (sourceChanged)
        expect(await f.storage.findTxLabels({ partial: { label: 'concurrent new DATA label' } })).toHaveLength(1)
    } finally {
      await f.close()
    }
  },
  composedCaseMs
)

test(
  'bootstrap repair refuses a reused destination primary key and preserves its current row',
  async () => {
    const f = await fixture()
    try {
      const { user } = await f.remote.storage.findOrInsertUser(f.remote.identityKey)
      await f.remote.storage.findOrInsertTxLabel(user.userId, 'original DATA label')
      const client = new StorageClient(f.remote.wallet, f.served.url, { serverIdentityKey: f.remote.serverIdentityKey })
      await f.manager.syncFromReaderResumable(f.remote.identityKey, client)
      const [row] = await f.storage.knex('tx_labels').where('label', 'original DATA label')
      await f.storage.knex('tx_labels').where('txLabelId', row.txLabelId).update({ label: 'independent current label' })
      const before = await f.storage.knex('tx_labels').where('txLabelId', row.txLabelId)
      await expect(f.manager.syncFromReaderResumable(f.remote.identityKey, client)).rejects.toThrow(
        'Journal association no longer identifies'
      )
      expect(await f.storage.knex('tx_labels').where('txLabelId', row.txLabelId)).toEqual(before)
    } finally {
      await f.close()
    }
  },
  composedCaseMs
)
