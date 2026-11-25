import assert from 'node:assert/strict'
import { test } from 'vitest'
import fc from 'fast-check'
import { propertyReplayOptions } from '../../../../../config/testing/property-replay.mjs'
import { isIdentityKey } from '../../src/utils/identityUtils.ts'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal(
  propertyReplayOptions(MIN_PROPERTY_RUNS, {
    runs: process.env.FAST_CHECK_NUM_RUNS,
    seed: process.env.FAST_CHECK_SEED,
    path: process.env.FAST_CHECK_PATH
  })
)

const hexBody = fc.stringMatching(/^[0-9a-fA-F]{64}$/)

test('recognizes exactly the supported widths and compressed-key prefixes', () => {
  fc.assert(
    fc.property(fc.constantFrom('02', '03'), hexBody, (prefix, body) => {
      assert.equal(isIdentityKey(prefix + body), true)
      assert.equal(isIdentityKey('04' + body), false)
      assert.equal(isIdentityKey(prefix + body.slice(1)), false)
      assert.equal(isIdentityKey(prefix + body + 'a'), false)
    })
  )
})

test('leaves whitespace and non-hex input on the attribute search path', () => {
  fc.assert(
    fc.property(
      fc.constantFrom('02', '03'),
      hexBody,
      fc.integer({ min: 0, max: 63 }),
      fc.constantFrom('g', '-', ' ', '.', '￥'),
      (prefix, body, offset, character) => {
        assert.equal(
          isIdentityKey(prefix + body.slice(0, offset) + character + body.slice(offset + 1)),
          false
        )
        assert.equal(isIdentityKey(' ' + prefix + body), false)
      }
    )
  )
})
