import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { canonicalOutputJSON } from '@bsv/sdk'
import {
  rootConfiguration,
  rootBytes,
  rootDecimal,
  rootPosition
} from '../src/root-eviction/RootEvictionCodec.js'
import { root, chain } from './root-eviction-fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
const propertyRuns = Number.isSafeInteger(requestedRuns)
  ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
  : MIN_PROPERTY_RUNS
fc.configureGlobal({
  numRuns: propertyRuns,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

it('seals generated finite capacities and exact U64 positions without aliasing caller configuration', () => {
  fc.assert(
    fc.property(
      fc.record({
        requests: fc.integer({ min: 1, max: 4096 }),
        requestBytes: fc.integer({ min: 1, max: 67108864 }),
        targets: fc.integer({ min: 1, max: 65536 }),
        blockers: fc.integer({ min: 1, max: 64 }),
        assessments: fc.integer({ min: 1, max: 4096 })
      }),
      fc.option(fc.integer({ min: 1, max: 67108864 }), { nil: undefined }),
      fc.bigInt({ min: 0n, max: 18446744073709551615n }),
      fc.array(fc.constantFrom('a', 'é', '😀', '\u0000'), { maxLength: 64 }),
      (capacity, contractBytes, revision, characters) => {
        const original = {
          root,
          chain: { ...chain },
          capacity: { ...capacity },
          ...(contractBytes === undefined ? {} : { coordination: { contractBytes } })
        }
        const configured = rootConfiguration(original)
        const expected = {
          format: contractBytes === undefined ? 'root-eviction/1' : 'root-eviction/2',
          root,
          chain,
          capacity,
          ...(contractBytes === undefined ? {} : { coordination: { contractBytes } })
        }
        expect(configured.seal).toBe(canonicalOutputJSON(expected))
        expect(configured.capacity).toEqual(capacity)
        expect(Object.isFrozen(configured.capacity)).toBe(true)
        if (contractBytes !== undefined) expect(Object.isFrozen(configured.coordination)).toBe(true)
        original.capacity.requests = 0
        original.chain.network = 'mutated-local-input'
        expect(configured.capacity.requests).toBe(capacity.requests)
        expect(configured.chain).toEqual(chain)
        expect(configured.seal).toBe(canonicalOutputJSON(expected))
        expect(rootPosition(revision.toString())).toBe(revision.toString(16).padStart(16, '0'))
        expect(rootDecimal(rootPosition(revision.toString()))).toBe(revision.toString())
        expect(rootBytes(characters.join(''))).toBe(Buffer.byteLength(characters.join(''), 'utf8'))
        expect(() => rootConfiguration(original)).toThrow(
          expect.objectContaining({ code: 'invalid', message: expect.stringMatching(/\S/) })
        )
        expect(() =>
          rootConfiguration({ root, chain, capacity, coordination: { contractBytes: 67108865 } })
        ).toThrow(
          expect.objectContaining({ code: 'invalid', message: expect.stringMatching(/\S/) })
        )
      }
    )
  )
})
