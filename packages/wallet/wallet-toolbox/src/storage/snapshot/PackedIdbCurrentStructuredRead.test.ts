import 'fake-indexeddb/auto'
import { verifyOccupiedPackedIdbStructuredField } from './PackedIdbCurrentStructuredRead.browser.case'
const { runPortableBrowserCase } = require('../../../client/test/portable-program-browser.cjs')
const { nativeBrowserTestTimeout } = require('../../../client/test/native-browser-driver.cjs')

test('occupied packed TEXT reads retain the original session, current row and resource owner', async () => {
  await verifyOccupiedPackedIdbStructuredField(Date.now() + 30000)
}, 30000)

// This case needs actual private Web Locks ownership. Execute its unchanged
// browser function in real Chrome; fake IndexedDB in Node cannot grant it.
test(
  'occupied history preparation stages the exact legacy UTF16 bytes without destination effects',
  async () => {
    const result = await runPortableBrowserCase('verifyOccupiedPackedIdbHistoryStaging')
    expect(result.reports).toHaveLength(1)
    expect(result.reports[0].passed).toBe(true)
    expect(result.browserChildClose).toEqual({ code: 0, signal: null })
    expect(result.completeCatalogueRun).toBe(false)
    expect(result.processTreeQualified).toBe(false)
  },
  nativeBrowserTestTimeout('verifyOccupiedPackedIdbHistoryStaging')
)
