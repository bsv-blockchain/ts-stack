import 'fake-indexeddb/auto'
import { verifyIdbSnapshotSyncProvenTxReqs } from './IdbSnapshotSyncProvenTxReqs.browser.case'

// Complete emulated component case, using the verifier's existing finite
// 120-second admission plus an outer cleanup window. Actual browser and full
// system qualification remain separate requirements.
const componentLifetimeMs = 120000
test(
  'occupied requests preserve legacy history, IDs, reset-only writes and durable atomic acknowledgement',
  async () => {
    const started = performance.now()
    await verifyIdbSnapshotSyncProvenTxReqs(Date.now() + componentLifetimeMs, phase =>
      console.info(`Request component ${Math.round(performance.now() - started)}ms: ${phase}`)
    )
  },
  componentLifetimeMs + 30000
)
