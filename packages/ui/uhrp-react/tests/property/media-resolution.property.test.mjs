import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { StorageDownloader, StorageUtils } from '@bsv/sdk'
import fc from 'fast-check'
import { propertyReplayOptions } from '../../../../../config/testing/property-replay.mjs'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal(
  propertyReplayOptions(MIN_PROPERTY_RUNS, {
    runs: process.env.FAST_CHECK_NUM_RUNS,
    seed: process.env.FAST_CHECK_SEED,
    path: process.env.FAST_CHECK_PATH
  })
)

const session = new Map()
Object.defineProperty(globalThis, 'sessionStorage', {
  value: {
    getItem: key => session.get(key) ?? null,
    setItem: (key, value) => session.set(key, value),
    removeItem: key => session.delete(key)
  }
})

const { useStore } = await import('../../src/store.ts')
const resolve = url => useStore.getState().setResolvedURL(url)

test('passes generated ordinary HTTPS URLs through without discovery', async () => {
  const lookup = vi.spyOn(StorageDownloader.prototype, 'resolve').mockResolvedValue([])

  await fc.assert(
    fc.asyncProperty(fc.stringMatching(/^[a-zA-Z0-9_-]{1,32}$/), async path => {
      useStore.setState({ urls: {} })
      const url = 'https://media.example/' + path
      await resolve(url)
      assert.deepEqual(useStore.getState().urls, { [url]: url })
      assert.equal(lookup.mock.calls.length, 0)
    })
  )
})

test('deduplicates pending callers and never mixes distinct content addresses', async () => {
  let responses
  const lookup = vi
    .spyOn(StorageDownloader.prototype, 'resolve')
    .mockImplementation(async url => [responses[url]])

  await fc.assert(
    fc.asyncProperty(fc.uint8Array({ minLength: 32, maxLength: 32 }), async hash => {
      useStore.setState({ urls: {} })
      lookup.mockClear()
      const alternateHash = hash.slice()
      alternateHash[0] ^= 128
      const first = StorageUtils.getURLForHash(Array.from(hash))
      const second = StorageUtils.getURLForHash(Array.from(alternateHash))
      responses = {
        [first]: 'https://media.example/first',
        [second]: 'https://media.example/second'
      }

      await Promise.all([resolve(first), resolve(second), resolve(first), resolve(second)])
      await Promise.all([resolve(first), resolve(second)])
      assert.deepEqual(
        lookup.mock.calls.map(([url]) => url),
        [first, second]
      )
      assert.deepEqual(useStore.getState().urls, responses)
      assert.deepEqual(JSON.parse(session.get('uhrp-react-session')).state.urls, responses)
    })
  )
})
