import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { canonicalOutputJSON, outputPacketDigest } from '@bsv/sdk'
import { assembleLineage, lineageLimits } from '../src/revenue-listing/LineagePackage.js'
import { parseRevenueListingProfileLineagePackage } from '../src/revenue-listing/ProfileLineagePackage.js'
import {
  inspectProfileLineage,
  executeProfileInputs
} from '../src/revenue-listing/ProfileLineageGraph.js'
import {
  fixture,
  purchased,
  purchaseTransaction,
  construct,
  extend,
  profile
} from './revenue-profile.fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number(process.env.FAST_CHECK_NUM_RUNS),
  requestedSeed = Number(process.env.FAST_CHECK_SEED),
  replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(replayPath ? { path: replayPath } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})

it('preserves owned immutable ancestry and exact signed purchase commitments under bounded envelope checks', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 1 }),
      fc.integer({ min: 1, max: 10000 }),
      (buyer, weight) => {
        const input = purchased(buyer),
          canonical = canonicalOutputJSON(input)
        const packet = parseRevenueListingProfileLineagePackage(new TextEncoder().encode(canonical))
        expect(canonicalOutputJSON(packet)).toBe(canonical)
        expect(packet.genesis.body.listingId).toBe(
          outputPacketDigest('sale-listing', fixture.descriptor)
        )
        packet.descriptor.initialRevenue.recipients[0].weight = weight
        expect(canonicalOutputJSON(input)).toBe(canonical)
        expect(() =>
          parseRevenueListingProfileLineagePackage({
            ...input,
            transactions: [...input.transactions, input.transactions[0]]
          })
        ).toThrow('sorted and unique')
      }
    )
  )
}, 180000)

it('executes complete normal permissionless payouts while retaining reserve, remainder and immutable ancestry', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 100 }),
      fc.integer({ min: 1, max: 100 }),
      async (units, fee) => {
        const payout = await construct(
          purchaseTransaction(),
          0,
          { operation: 'payout', units: String(units) },
          fee
        )
        const packet = parseRevenueListingProfileLineagePackage(extend(purchased(), payout))
        const assembly = assembleLineage(packet, lineageLimits({})),
          graph = inspectProfileLineage(assembly, profile)
        expect(graph.complete).toBe(true)
        if (!graph.complete) throw new Error('Incomplete normal history')
        expect(graph.satoshis).toBe(String(1002 - units * 10))
        expect(graph.transitions[0].plan?.payout).toBe(String(units * 10))
        expect(graph.transitions[0].plan?.schedule).toEqual(fixture.descriptor.initialRevenue)
        expect(() =>
          executeProfileInputs(assembly, graph.transitions[0].transaction, 134217728)
        ).not.toThrow()
        expect(payout.outputs[2].satoshis).toBe(units * 7)
        expect(payout.outputs[3].satoshis).toBe(units * 3)
      }
    )
  )
}, 180000)
