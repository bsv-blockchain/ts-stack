import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import {
  assembleLineage,
  lineageLimits,
  parseRevenueListingLineagePackage
} from '../src/revenue-listing/LineagePackage.js'
import { inspectLineage } from '../src/revenue-listing/LineageGraph.js'
import { atListing, family } from './revenue-lineage-fixture.js'

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

it(
  'traverses both merge histories independently of entry order and reports the exact missing-parent frontier',
  () => {
    const graphs = [atListing('split', 0), atListing('split', 1), atListing('merge')].map(packet =>
      assembleLineage(parseRevenueListingLineagePackage(packet), lineageLimits({}))
    )
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 }),
        fc.nat(10000),
        fc.boolean(),
        fc.boolean(),
        (which, selected, missing, reversed) => {
          const original = graphs[which],
            entries = [...original.entries]
          if (reversed) entries.reverse()
          const omitted = missing ? entries[selected % entries.length] : undefined
          const assembly = {
            ...original,
            entries: new Set(entries.filter(id => id !== omitted))
          }
          const observed = inspectLineage(assembly, family)
          if (omitted === undefined) {
            expect(observed.complete).toBe(true)
            if (!observed.complete) throw new Error('Complete retained graph was unresolved')
            expect(observed.transitions).toHaveLength(original.entries.size)
            expect(new Set(observed.transitions.map(item => item.transaction.id('hex'))).size).toBe(
              original.entries.size
            )
            expect(
              observed.transitions.some(
                item => item.transaction.id('hex') === original.package.genesis.body.genesis.txid
              )
            ).toBe(true)
            const merge = observed.transitions.find(
              item => item.transaction.id('hex') === original.package.target.txid
            )!
            expect(merge.inputs).toEqual(which === 2 ? [0, 1] : [0])
          } else {
            expect(observed.complete).toBe(false)
            if (observed.complete) throw new Error('Missing lineage became complete')
            const expected =
              omitted === original.package.target.txid
                ? [`${omitted}.${original.package.target.outputIndex}`]
                : [
                    ...new Set(
                      [...assembly.entries.keys()].flatMap(id =>
                        original.transactions
                          .get(id)!
                          .inputs.filter(input => input.sourceTXID === omitted)
                          .map(input => `${input.sourceTXID}.${input.sourceOutputIndex}`)
                      )
                    )
                  ].sort()
            expect(expected.length).toBeGreaterThan(0)
            expect(
              observed.missing.map(point => `${point.txid}.${point.outputIndex}`).sort()
            ).toEqual(expected)
            expect(
              observed.missing.every(
                point =>
                  JSON.stringify(point.chain) === JSON.stringify(original.package.descriptor.chain)
              )
            ).toBe(true)
          }
          expect(original.entries.size).toBe(entries.length)
        }
      )
    )
  },
  Math.min(2147483647, Math.max(120000, propertyRuns * 400))
)
