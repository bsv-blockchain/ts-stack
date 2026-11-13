import 'fake-indexeddb/auto'
import { verifyPackedIdbSnapshotContentReceipts } from './IdbSnapshotSyncContent.browser.case'

// Emulated edit feedback only; the same case is registered for actual browsers.
test('packed content receipts retain actual copy/reopen/current-data/primary/legacy boundaries', async () => {
  await verifyPackedIdbSnapshotContentReceipts(Date.now() + 30000)
}, 30000)
