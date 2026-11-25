import assert from 'node:assert/strict'
import { test } from 'vitest'
import fc from 'fast-check'
import { propertyReplayOptions } from '../../../../../../config/testing/property-replay.mjs'
import { parseDomain, validatePrivateKey } from '../../src/utils/miscHelpers.ts'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal(
  propertyReplayOptions(MIN_PROPERTY_RUNS, {
    runs: process.env.FAST_CHECK_NUM_RUNS,
    seed: process.env.FAST_CHECK_SEED,
    path: process.env.FAST_CHECK_PATH
  })
)

test('accepts the exact key input alphabet and rejects altered lengths or characters', () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[0-9a-f]{64}$/),
      fc.integer({ min: 0, max: 63 }),
      fc.constantFrom('G', 'A', '-', ' '),
      (key, offset, invalid) => {
        assert.equal(validatePrivateKey(key), '')
        assert.notEqual(validatePrivateKey(key + '0'), '')
        assert.notEqual(validatePrivateKey(key.slice(1)), '')
        assert.notEqual(
          validatePrivateKey(key.slice(0, offset) + invalid + key.slice(offset + 1)),
          ''
        )
      }
    )
  )
})

test('uses only the hostname for URL-shaped storage input', () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[a-z][0-9A-Za-z]{0,16}$/),
      fc.stringMatching(/^[A-Za-z0-9]{1,24}$/),
      fc.integer({ min: 1, max: 65_535 }),
      (hostLabel, path, port) => {
        const hostname = hostLabel + '.example'
        assert.equal(
          parseDomain('https://' + hostname + ':' + port + '/' + path),
          hostname.toLowerCase()
        )
        assert.equal(parseDomain(hostname), hostname)
      }
    )
  )
})
