import fc from 'fast-check'
import { describe, expect, it } from '@jest/globals'
import { ColorPlan, type ColorPlan as Plan } from '../ColorPlan.js'
import { parseStrictJson } from '../strictJson.js'

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

const SENDER = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/)
const assetId = fc
  .tuple(hex64, fc.integer({ min: 0, max: 0xffffffff }))
  .map(([txid, vout]) => `${txid}_${vout}`)
const remittance = fc.stringMatching(/^[A-Za-z0-9+/=]{1,24}$/)

const plan: fc.Arbitrary<Plan> = fc
  .uniqueArray(assetId, { minLength: 1, maxLength: 3 })
  .chain(assets =>
    fc.record({
      version: fc.constant(1 as const),
      assets: fc.constant(assets),
      ownedOutputs: fc.uniqueArray(
        fc.record({
          outputIndex: fc.integer({ min: 0, max: 0xffffffff }),
          assetId: fc.constantFrom(...assets),
          derivationPrefix: remittance,
          derivationSuffix: remittance,
          senderIdentityKey: fc.constant(SENDER)
        }),
        { maxLength: 4, selector: owned => owned.outputIndex }
      ),
      operations: fc.constant(assets.map(id => ({ assetId: id, operation: 'transfer' as const }))),
      inputPositions: fc.constant([]),
      changePositions: fc.constant([]),
      sighashTypes: fc.constant([])
    })
  )

describe('ColorPlan properties', () => {
  it('round-trips every valid plan through labels in any order among other labels', () => {
    fc.assert(
      fc.property(
        plan,
        fc.array(fc.stringMatching(/^[a-z]{1,10}$/), { maxLength: 3 }),
        (value, others) => {
          const labels = [...ColorPlan.toLabels(value).reverse(), ...others]
          expect(ColorPlan.fromLabels(labels)).toEqual(value)
        }
      )
    )
  })

  it('parses every serialized JSON value exactly as JSON.parse does', () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        const text = JSON.stringify(value)
        expect(JSON.stringify(parseStrictJson(text, 'property'))).toBe(
          JSON.stringify(JSON.parse(text))
        )
      })
    )
  })
})
