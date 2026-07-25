const assert = require('node:assert/strict')
const { test } = require('node:test')
const { StorageUtils } = require('@bsv/sdk')
const { hashToUhrpUrl } = require('./notifier')

test('hashToUhrpUrl uses the maintained SDK Base58Check implementation', () => {
  const hash = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
  assert.equal(
    hashToUhrpUrl(hash),
    StorageUtils.getURLForHash([...hash])
  )
})
