import assert from 'node:assert/strict'
import { test } from 'vitest'
import fc from 'fast-check'
import { propertyReplayOptions } from '../../../../../config/testing/property-replay.mjs'
import { normalizeAppMetadata } from '../../src/metadata.ts'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal(
  propertyReplayOptions(MIN_PROPERTY_RUNS, {
    runs: process.env.FAST_CHECK_NUM_RUNS,
    seed: process.env.FAST_CHECK_SEED,
    path: process.env.FAST_CHECK_PATH
  })
)

const text = fc.string({ maxLength: 60 })
const validMetadata = fc.record({
  version: fc.constant('0.1.0'),
  name: text,
  description: text,
  icon: text,
  domain: text,
  release_date: text,
  tags: fc.array(text, { maxLength: 8 }),
  screenshot_urls: fc.array(text, { maxLength: 8 }),
  publisher: text,
  httpURL: text
})

test('preserves canonical metadata byte values with either supported form of asset URL', () => {
  fc.assert(
    fc.property(validMetadata, data => {
      const { httpURL, ...rest } = data
      const uhrpOnly = { ...rest, uhrpURL: httpURL }
      assert.equal(JSON.stringify(normalizeAppMetadata(data)), JSON.stringify(data))
      assert.deepEqual(normalizeAppMetadata(uhrpOnly), uhrpOnly)
      assert.notStrictEqual(normalizeAppMetadata(data), data)
    })
  )
})

test('rejects invalid versions, required fields and arrays with typed errors', () => {
  fc.assert(
    fc.property(
      validMetadata,
      fc.constantFrom('name', 'description', 'icon', 'domain', 'release_date'),
      fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)),
      (data, requiredField, invalid) => {
        const { httpURL, ...withoutUrl } = data
        assert.equal(typeof httpURL, 'string')
        assert.throws(() => normalizeAppMetadata({ ...data, version: invalid }), {
          code: 'ERR_METADATA_UNSUPPORTED_SCHEMA'
        })
        for (const malformed of [
          { ...data, [requiredField]: invalid },
          { ...data, tags: [...data.tags, invalid] },
          withoutUrl
        ]) {
          assert.throws(() => normalizeAppMetadata(malformed), { code: 'ERR_METADATA_INVALID' })
        }
      }
    )
  )
})
