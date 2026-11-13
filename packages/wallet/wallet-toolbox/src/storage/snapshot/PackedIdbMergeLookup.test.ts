import 'fake-indexeddb/auto'
import { verifyPackedIdbBoundedNaturalMergeLookup } from './PackedIdbMergeLookup.browser.case'

/** Emulated component contract only; real-browser qualification is pending. */
test('all12 packed natural identities remain payload-free with current mapped parents and profile boundaries', async () => {
  await verifyPackedIdbBoundedNaturalMergeLookup(Date.now() + 25000)
}, 30000)
