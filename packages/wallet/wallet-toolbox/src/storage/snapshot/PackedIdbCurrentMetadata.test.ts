import 'fake-indexeddb/auto'
import { verifyPackedIdbCurrentRowAndExtentMetadata } from './PackedIdbCurrentMetadata.browser.case'

/** Emulated component contract only; real-browser qualification remains pending. */
test('occupied packed metadata stays payload-free and follows current native MVCC/profile ownership', async () => {
  await verifyPackedIdbCurrentRowAndExtentMetadata(Date.now() + 25000)
}, 30000)
