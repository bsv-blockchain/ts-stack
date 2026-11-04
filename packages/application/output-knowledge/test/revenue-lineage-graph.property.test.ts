import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { LockingScript, OutputProtocolError } from '@bsv/sdk'
import {
  assembleLineage,
  lineageLimits,
  parseRevenueListingLineagePackage
} from '../src/revenue-listing/LineagePackage.js'
import { inspectLineage } from '../src/revenue-listing/LineageGraph.js'
import { changedGenesis, family } from './revenue-lineage-fixture.js'

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

it('checks authorized genesis layout across output counts, headers and target indices', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(1, 2),
      fc.integer({ min: 1, max: 11 }),
      fc.constantFrom('valid', 'locktime', 'sequence', 'reserve', 'target'),
      (version, outputCount, mode) => {
        const packet = changedGenesis(tx => {
          tx.version = version
          tx.outputs = [
            tx.outputs[0],
            ...Array.from({ length: outputCount - 1 }, () => ({
              satoshis: 0,
              lockingScript: LockingScript.fromASM('OP_FALSE OP_RETURN')
            }))
          ]
          if (mode === 'locktime') tx.lockTime = 1
          if (mode === 'sequence') tx.inputs[0].sequence = 0xfffffffe
          if (mode === 'reserve') tx.outputs[0].satoshis! += 1
        })
        if (mode === 'target') packet.target.outputIndex = 1
        const assembly = assembleLineage(
          parseRevenueListingLineagePackage(packet),
          lineageLimits({})
        )
        if (mode !== 'valid')
          expect(() => inspectLineage(assembly, family)).toThrow(OutputProtocolError)
        else {
          const result = inspectLineage(assembly, family)
          expect(result.complete).toBe(true)
          if (!result.complete) throw new Error('Unexpected unresolved genesis')
          expect(result.state).toEqual(packet.descriptor.initialRevenue)
          expect(result.satoshis).toBe(packet.descriptor.reserve)
          expect(result.transitions).toHaveLength(1)
          expect(result.transitions[0].transaction.version).toBe(version)
          expect(result.transitions[0].transaction.outputs).toHaveLength(outputCount)
        }
      }
    )
  )
}, 120000)
