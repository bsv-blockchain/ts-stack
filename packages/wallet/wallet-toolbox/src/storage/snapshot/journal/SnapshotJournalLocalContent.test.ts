import { gate } from '../../../../test/utils/snapshotArchiveHttpFixtures'
import { snapshotJournalDataManagerFixture as fixture } from '../../../../test/utils/snapshotJournalDataManagerFixture'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'

afterEach(() => jest.restoreAllMocks())
const composedCaseMs = 90000

test(
  'a local journal pull retains its actual SQL source fence and confirms an unchanged prior ACK without another data window',
  async () => {
    const f = await fixture()
    try {
      const { user } = await f.remote.storage.findOrInsertUser(f.remote.identityKey)
      await f.remote.storage.findOrInsertTxLabel(user.userId, 'local unchanged label')
      const original = f.remote.storage.openCurrentSnapshotJournalSource.bind(f.remote.storage)
      let fences = 0
      const open = jest
        .spyOn(f.remote.storage, 'openCurrentSnapshotJournalSource')
        .mockImplementation(async (...args) => {
          const source = await original(...args)
          const fence = source.withCommitFence.bind(source)
          jest.spyOn(source, 'withCommitFence').mockImplementation(async work => {
            fences++
            return await fence(work)
          })
          return source
        })
      const legacy = jest.spyOn(f.storage, 'processSyncChunk')
      const first = await f.manager.syncFromReaderResumable(f.remote.identityKey, f.remote.storage)
      expect(first.journalCheckpoint?.phase).toBe('acknowledged')
      expect(fences).toBeGreaterThan(0)
      expect(open).toHaveBeenCalledTimes(1)
      const before = await f.storage.knex('snapshot_reconciliation_windows').select('stateJson')
      const second = await f.manager.syncFromReaderResumable(f.remote.identityKey, f.remote.storage)
      expect(second).toMatchObject({
        status: 'completed',
        pages: 0,
        inserts: 0,
        updates: 0,
        journalCheckpoint: first.journalCheckpoint,
        noChangeJournalReceipt: { checkpoint: first.journalCheckpoint }
      })
      expect(await f.storage.knex('snapshot_reconciliation_windows').select('stateJson')).toEqual(before)
      expect(open).toHaveBeenCalledTimes(1)
      expect(legacy).not.toHaveBeenCalled()
      expect(await f.storage.findTxLabels({ partial: { label: 'local unchanged label' } })).toHaveLength(1)
      expect((await f.storage.findOrInsertUser(f.remote.identityKey)).user.activeStorage).toBe('local-journal-data')
      const failure = new SnapshotResourceLimitError('actual no-change observer failure')
      await expect(
        f.manager.syncFromReaderResumable(f.remote.identityKey, f.remote.storage, {
          onProgress: () => {
            throw failure
          }
        })
      ).rejects.toBe(failure)
      expect(legacy).not.toHaveBeenCalled()
      expect(await f.storage.knex('snapshot_reconciliation_windows').select('stateJson')).toEqual(before)
    } finally {
      await f.close()
    }
  },
  composedCaseMs
)

test.each([false, true])(
  'local journal target drift requires complete repair even with a new source delta: %p',
  async sourceChanged => {
    const f = await fixture()
    try {
      const { user } = await f.remote.storage.findOrInsertUser(f.remote.identityKey)
      await f.remote.storage.findOrInsertTxLabel(user.userId, 'local repair original')
      const first = await f.manager.syncFromReaderResumable(f.remote.identityKey, f.remote.storage)
      await f.storage.knex('tx_labels').where('label', 'local repair original').delete()
      if (sourceChanged) await f.remote.storage.findOrInsertTxLabel(user.userId, 'local repair delta')
      const result = await f.manager.syncFromReaderResumable(f.remote.identityKey, f.remote.storage)
      expect(result.status).toBe('completed')
      expect(result.noChangeJournalReceipt).toBeUndefined()
      expect(result.pages).toBeGreaterThan(0)
      expect(result.journalCheckpoint?.sessionId).not.toBe(first.journalCheckpoint?.sessionId)
      expect(await f.storage.findTxLabels({ partial: { label: 'local repair original' } })).toHaveLength(1)
      if (sourceChanged)
        expect(await f.storage.findTxLabels({ partial: { label: 'local repair delta' } })).toHaveLength(1)
      expect((await f.storage.findOrInsertUser(f.remote.identityKey)).user.activeStorage).toBe('local-journal-data')
    } finally {
      await f.close()
    }
  },
  composedCaseMs
)

test(
  'unchanged local pushes and registered backups retain the old ACK under a genuine current-source fence',
  async () => {
    const f = await fixture()
    try {
      const { user } = await f.storage.findOrInsertUser(f.remote.identityKey)
      await f.storage.findOrInsertTxLabel(user.userId, 'local push quiescent')
      const first = await f.manager.syncToWriterResumable(await f.manager.getAuth(), f.remote.storage)
      expect(first.journalCheckpoint?.phase).toBe('acknowledged')
      expect((await f.remote.storage.findOrInsertUser(f.remote.identityKey)).user.activeStorage).toBe(
        'local-journal-data'
      )
      const before = await f.remote.storage.knex('snapshot_reconciliation_windows').select('stateJson')
      let fences = 0,
        dataReads = 0
      const original = f.storage.openCurrentSnapshotJournalSource.bind(f.storage)
      jest.spyOn(f.storage, 'openCurrentSnapshotJournalSource').mockImplementation(async (...args) => {
        const source = await original(...args),
          current = source.withCurrentDataFence.bind(source),
          read = source.readDeltaPage.bind(source)
        jest.spyOn(source, 'withCurrentDataFence').mockImplementation(async (since, commit) => {
          fences++
          return await current(since, commit)
        })
        jest.spyOn(source, 'readDeltaPage').mockImplementation(async (...args) => {
          dataReads++
          return await read(...args)
        })
        return source
      })
      const second = await f.manager.syncToWriterResumable(await f.manager.getAuth(), f.remote.storage)
      expect(second).toMatchObject({
        status: 'completed',
        pages: 0,
        inserts: 0,
        updates: 0,
        journalCheckpoint: first.journalCheckpoint,
        noChangeJournalReceipt: { checkpoint: first.journalCheckpoint }
      })
      expect(fences).toBeGreaterThan(0)
      expect(dataReads).toBe(0)
      expect(await f.remote.storage.knex('snapshot_reconciliation_windows').select('stateJson')).toEqual(before)
      const { WalletStorageManager } = await import('../../WalletStorageManager')
      const replacement = new WalletStorageManager(f.remote.identityKey, f.storage, [f.remote.storage])
      await replacement.makeAvailable()
      await replacement.updateBackups()
      expect(dataReads).toBe(0)
      expect(await f.remote.storage.knex('snapshot_reconciliation_windows').select('stateJson')).toEqual(before)
      expect(await f.remote.storage.findTxLabels({ partial: { label: 'local push quiescent' } })).toHaveLength(1)
    } finally {
      await f.close()
    }
  },
  composedCaseMs
)

test(
  'a source write after the unchanged capture refuses reuse and is copied before returning',
  async () => {
    const f = await fixture()
    try {
      const { user } = await f.storage.findOrInsertUser(f.remote.identityKey)
      await f.storage.findOrInsertTxLabel(user.userId, 'before current fence')
      await f.manager.syncToWriterResumable(await f.manager.getAuth(), f.remote.storage)
      const original = f.storage.openCurrentSnapshotJournalSource.bind(f.storage)
      let inject = true
      jest.spyOn(f.storage, 'openCurrentSnapshotJournalSource').mockImplementation(async (...args) => {
        const source = await original(...args),
          read = source.readContentRevision?.bind(source)
        if (read !== undefined)
          jest.spyOn(source, 'readContentRevision').mockImplementation(async since => {
            const value = await read(since)
            if (inject) {
              inject = false
              await f.storage.findOrInsertTxLabel(user.userId, 'arrived before current fence')
            }
            return value
          })
        return source
      })
      const result = await f.manager.syncToWriterResumable(await f.manager.getAuth(), f.remote.storage)
      expect(inject).toBe(false)
      expect(result.status).toBe('completed')
      expect(result.noChangeJournalReceipt).toBeUndefined()
      expect(result.pages).toBeGreaterThan(0)
      expect(await f.remote.storage.findTxLabels({ partial: { label: 'arrived before current fence' } })).toHaveLength(
        1
      )
    } finally {
      await f.close()
    }
  },
  composedCaseMs
)

test(
  'target drift between financial ACK and primary selection is repaired rather than restamped as copied data',
  async () => {
    const f = await fixture()
    try {
      const { user } = await f.storage.findOrInsertUser(f.remote.identityKey)
      await f.storage.findOrInsertTxLabel(user.userId, 'must survive selection')
      const original = f.remote.storage.openSnapshotJournalDestination.bind(f.remote.storage)
      let inject = true,
        selections = 0
      jest.spyOn(f.remote.storage, 'openSnapshotJournalDestination').mockImplementation(async (...args) => {
        const opened = await original(...args),
          select = opened.destination.selectPrimary.bind(opened.destination)
        jest.spyOn(opened.destination, 'selectPrimary').mockImplementation(async (...values) => {
          selections++
          if (inject) {
            inject = false
            await f.remote.storage.knex('tx_labels').where('label', 'must survive selection').delete()
          }
          return await select(...values)
        })
        return opened
      })
      const result = await f.manager.syncToWriterResumable(await f.manager.getAuth(), f.remote.storage)
      expect(result.status).toBe('completed')
      expect(selections).toBe(2)
      expect(await f.remote.storage.findTxLabels({ partial: { label: 'must survive selection' } })).toHaveLength(1)
      expect((await f.remote.storage.findOrInsertUser(f.remote.identityKey)).user.activeStorage).toBe(
        'local-journal-data'
      )
      expect((await f.manager.syncToWriterResumable(await f.manager.getAuth(), f.remote.storage)).pages).toBe(0)
    } finally {
      await f.close()
    }
  },
  composedCaseMs
)

test(
  'cancellation while the genuine unchanged source opens drains it, preserves the old ACK and leaves foreground work available',
  async () => {
    const f = await fixture(),
      entered = gate(),
      release = gate()
    try {
      const { user } = await f.storage.findOrInsertUser(f.remote.identityKey)
      await f.storage.findOrInsertTxLabel(user.userId, 'before cancellation')
      await f.manager.syncToWriterResumable(await f.manager.getAuth(), f.remote.storage)
      const before = await f.remote.storage.knex('snapshot_reconciliation_windows').select('stateJson')
      const original = f.storage.openCurrentSnapshotJournalSource.bind(f.storage)
      let captured: Awaited<ReturnType<typeof original>> | undefined
      const open = jest.spyOn(f.storage, 'openCurrentSnapshotJournalSource').mockImplementation(async (...args) => {
        captured = await original(...args)
        entered.resolve()
        await release.promise
        return captured
      })
      const controller = new AbortController()
      const pending = f.manager.syncToWriterResumable(await f.manager.getAuth(), f.remote.storage, {
        signal: controller.signal
      })
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('Copy ended before the real source opened')
        })
      ])
      await f.manager.runAsStorageProvider(async active => {
        expect(active).toBe(f.storage)
        await f.storage.findOrInsertTxLabel(user.userId, 'foreground during capture')
      })
      controller.abort()
      release.resolve()
      expect((await pending).status).toBe('cancelled')
      expect(captured?.isOpen).toBe(false)
      await captured?.closed
      expect(await f.remote.storage.knex('snapshot_reconciliation_windows').select('stateJson')).toEqual(before)
      expect(await f.storage.findTxLabels({ partial: { label: 'foreground during capture' } })).toHaveLength(1)
      open.mockRestore()
      expect((await f.manager.syncToWriterResumable(await f.manager.getAuth(), f.remote.storage)).status).toBe(
        'completed'
      )
      expect(await f.remote.storage.findTxLabels({ partial: { label: 'foreground during capture' } })).toHaveLength(1)
    } finally {
      release.resolve()
      await f.close()
    }
  },
  composedCaseMs
)
