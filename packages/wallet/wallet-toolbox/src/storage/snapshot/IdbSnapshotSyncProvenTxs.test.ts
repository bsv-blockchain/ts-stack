import 'fake-indexeddb/auto'
import { verifyIdbSnapshotSyncProvenTxs } from './IdbSnapshotSyncProvenTxs.browser.case'

// Emulated component only. Authored now; execute after all implementations.
test('occupied proof replacement uses complete active-header preparation and fresh atomic current-row fences', async () => {
  await verifyIdbSnapshotSyncProvenTxs(Date.now() + 30000)
}, 30000)
