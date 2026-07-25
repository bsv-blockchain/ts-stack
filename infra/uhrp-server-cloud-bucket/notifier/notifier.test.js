const assert = require('node:assert/strict')
const { test } = require('node:test')
const { StorageUtils } = require('@bsv/sdk')
const { buildAdvertiseRequest, hashToUhrpUrl } = require('./notifier')

test('hashToUhrpUrl uses the maintained SDK Base58Check implementation', () => {
  const hash = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
  assert.equal(
    hashToUhrpUrl(hash),
    StorageUtils.getURLForHash([...hash])
  )
})

test('advertise requests keep the admin token out of the body', () => {
  const token = 'a'.repeat(32)
  const request = buildAdvertiseRequest({
    hostingDomain: 'https://uhrp.example',
    adminToken: token,
    uhrpUrl: 'uhrp://example',
    uploaderIdentityKey: 'identity',
    objectIdentifier: 'object',
    expiryTime: 123,
    fileSize: 456
  })

  assert.equal(request.url, 'https://uhrp.example/advertise')
  assert.equal(request.config.headers.Authorization, `Bearer ${token}`)
  assert.equal(Object.hasOwn(request.body, 'adminToken'), false)
})

test('advertise requests reject short admin tokens', () => {
  assert.throws(
    () => buildAdvertiseRequest({
      hostingDomain: 'https://uhrp.example',
      adminToken: 'short',
      uhrpUrl: 'uhrp://example',
      uploaderIdentityKey: 'identity',
      objectIdentifier: 'object',
      expiryTime: 123,
      fileSize: 456
    }),
    /at least 32/
  )
})
