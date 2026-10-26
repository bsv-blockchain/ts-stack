import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSubmittedHeader } from '../resourceLimits'

function validHeader() {
  return {
    version: 1,
    previousHash: '00'.repeat(32),
    merkleRoot: '11'.repeat(32),
    time: 1,
    bits: 0x1d00ffff,
    nonce: 2
  }
}

test('parses and copies an exact submitted block header', () => {
  const input = validHeader()
  const parsed = parseSubmittedHeader(input)
  assert.deepEqual(parsed, input)
  assert.notEqual(parsed, input)
})

test('rejects malformed, extra, and out-of-range submitted header fields', () => {
  assert.throws(() => parseSubmittedHeader(null), /plain data object/)
  assert.throws(
    () => parseSubmittedHeader({ ...validHeader(), previousHash: 'zz'.repeat(32) }),
    /previousHash/
  )
  assert.throws(
    () => parseSubmittedHeader({ ...validHeader(), nonce: 0x1_0000_0000 }),
    /unsigned 32-bit integer/
  )
  assert.throws(
    () => parseSubmittedHeader({ ...validHeader(), constructor: 'unexpected' }),
    /exactly the required data properties/
  )
})

test('rejects accessors without invoking them', () => {
  let invoked = false
  const header = validHeader()
  Object.defineProperty(header, 'nonce', {
    enumerable: true,
    get: () => {
      invoked = true
      return 1
    }
  })
  assert.throws(() => parseSubmittedHeader(header), /data properties/)
  assert.equal(invoked, false)
})
