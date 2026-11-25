const assert = require('node:assert/strict')
const { test } = require('node:test')

test('keeps the main UI and protocol permission handler in the public entry', () => {
  const { UserInterface, ProtocolPermissionHandler } = require('..')
  assert.equal(typeof UserInterface, 'function')
  assert.equal(typeof ProtocolPermissionHandler, 'function')
})
