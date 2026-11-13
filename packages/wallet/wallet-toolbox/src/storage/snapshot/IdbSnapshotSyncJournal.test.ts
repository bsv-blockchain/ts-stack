import 'fake-indexeddb/auto'
import { verifyOccupiedPackedIdbSnapshotJournal } from './IdbSnapshotSyncJournal.browser.case'

// Emulated component coverage only. The separately compiled browser entry
// must run under a fresh original native controller admission to qualify it.
test('occupied packed journal retains atomic rows/maps/checkpoint and rejects stale primary', async () => {
  await expect(verifyOccupiedPackedIdbSnapshotJournal(Date.now() + 30000)).resolves.toBeUndefined()
}, 30000)

test('occupied packed regtest journal retains the same commit, reopen, rollback and isolation contracts', async () => {
  await expect(verifyOccupiedPackedIdbSnapshotJournal(Date.now() + 30000, 'regtest')).resolves.toBeUndefined()
}, 30000)
