import 'fake-indexeddb/auto'
import { verifyPackedIdbReplicaFieldOrderingAndRetainedExtents } from './PackedIdbSyncFieldSource.browser.case'

// Emulated component case only; does not qualify a native browser artifact.
test('replica keys, retained binary/text extents and primary changes use the actual provider', async () => {
  await verifyPackedIdbReplicaFieldOrderingAndRetainedExtents(Date.now() + 20000)
})
