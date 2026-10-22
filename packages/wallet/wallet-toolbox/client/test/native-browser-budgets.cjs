'use strict'

// Test admission only. The unchanged request oracle measured 47.3 seconds
// for two complete preparations. Its selected 90-second bound stays within
// the original function's 120-second ceiling; all other cases retain 30s.
const nativeBrowserCaseTimeout = (id = '') => (id === 'verifyIdbSnapshotSyncProvenTxReqs' ? 90000 : 30000)
const nativeBrowserDriverTimeout = id => 30000 + nativeBrowserCaseTimeout(id) + 30000
const nativeBrowserTestTimeout = id => nativeBrowserDriverTimeout(id) + 10000
const nativeBrowserProtocolTimeout = 90000 + 30000
module.exports = Object.freeze({
  nativeBrowserCaseTimeout,
  nativeBrowserDriverTimeout,
  nativeBrowserTestTimeout,
  nativeBrowserProtocolTimeout
})
