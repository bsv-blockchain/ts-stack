import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { canonicalOutputJSON } from '@bsv/sdk'
import { RevenueListingLineageVerifier } from '../src/revenue-listing/RevenueListingLineageVerifier.js'
import { chains, completeGenesis, context, family } from './revenue-lineage-fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

it('binds genuine genesis to owned context across representations, byte limits and cancellation', async () => {
  const original = completeGenesis()
  const json = canonicalOutputJSON(original)
  const bytes = new TextEncoder().encode(json)
  const verifier = new RevenueListingLineageVerifier(family, chains)
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('object', 'string', 'utf8'),
      fc.constantFrom('accept', 'short-bytes', 'foreign-chain', 'cancelled'),
      fc.integer({ min: 0, max: 2147483647 }),
      async (representation, caseName, generation) => {
        const packet = structuredClone(original)
        const selected = context()
        selected.generation = String(generation)
        selected.limits.bytes = bytes.length - (caseName === 'short-bytes' ? 1 : 0)
        if (caseName === 'foreign-chain') selected.view.chain.network = 'unrelated'
        const expectedContext = structuredClone(selected)
        const controller = new AbortController()
        if (caseName === 'cancelled') controller.abort()
        const inputs = { object: packet, string: json, utf8: bytes.slice() }
        const pending = verifier.verify(inputs[representation], selected, controller.signal)
        packet.target.txid = 'ff'.repeat(32)
        selected.generation = '18446744073709551615'
        const result = await pending
        const expected = {
          accept: 'verified',
          'short-bytes': 'limited',
          'foreign-chain': 'invalid',
          cancelled: 'cancelled'
        }[caseName]
        expect(result.status).toBe(expected)
        if (result.status === 'verified') {
          expect(result.verificationContext).toEqual(expectedContext)
          expect(result.target).toEqual(original.target)
          expect(result.transactions).toEqual([original.target.txid])
          expect(result.state).toEqual(original.descriptor.initialRevenue)
          expect(result.satoshis).toBe(original.descriptor.reserve)
          result.descriptor.initialRevenue.recipients[0].weight = 999
          expect(original.descriptor.initialRevenue.recipients[0].weight).toBe(7)
        }
      }
    )
  )
}, 120000)
