const assert = require('node:assert/strict')
const { test } = require('node:test')

test('keeps the main UI and protocol permission handler in the public entry', () => {
  const { UserInterface, ProtocolPermissionHandler } = require('..')
  assert.equal(typeof UserInterface, 'function')
  assert.equal(typeof ProtocolPermissionHandler, 'function')
})

test('shares the wallet context between Node import and require consumers', async () => {
  const esm = await import('@bsv/brc100-ui-react-components')
  const cjs = require('@bsv/brc100-ui-react-components')
  assert.equal(esm.WalletContext, cjs.WalletContext)
})
