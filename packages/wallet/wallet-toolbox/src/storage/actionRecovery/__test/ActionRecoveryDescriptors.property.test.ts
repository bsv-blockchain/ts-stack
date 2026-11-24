import fc from 'fast-check'
import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import type { StorageCreateActionResult } from '../../../sdk/WalletStorage.interfaces'
import { actionRecoveryJSON, decodeActionRecoveryPlan, encodeActionRecoveryPlan } from '../ActionRecoveryCodec'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('generated retained plans preserve descriptor order and owned bytes while rejecting duplicate and unrelated funding roots', () => {
  const source = new Transaction(1, [], [{ satoshis: 100, lockingScript: LockingScript.fromHex('51') }], 0)
  const beef = new Beef()
  beef.mergeTransaction(source)
  const inputBeef = beef.toBinary()
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 16 }), fc.integer({ min: 0, max: 16 }),
    fc.integer({ min: 0, max: 100000 }), fc.boolean(),
    (inputCount, outputCount, satoshis, reverse) => {
      const result: StorageCreateActionResult = {
        reference: 'public-generated-record', version: 1, lockTime: 0, derivationPrefix: 'fixture', inputBeef: [...inputBeef],
        inputs: Array.from({ length: inputCount }, (_, vin) => ({ vin, sourceTxid: vin.toString(16).padStart(64, '0'), sourceVout: 0,
          sourceSatoshis: satoshis, sourceLockingScript: '51', unlockingScriptLength: 0, providedBy: 'you', type: 'custom' })),
        outputs: Array.from({ length: outputCount }, (_, vout) => ({ vout, providedBy: 'storage', lockingScript: '51', satoshis,
          outputDescription: 'Public generated descriptor', tags: ['fixture'] })),
        noSendChangeOutputVouts: Array.from({ length: outputCount }, (_, index) => index)
      }
      const fundingTxids = result.inputs.map(input => input.sourceTxid)
      if (reverse) fundingTxids.reverse()
      const expected = structuredClone({ result, fundingTxids })
      const encoded = encodeActionRecoveryPlan({ result, fundingTxids })
      expect(decodeActionRecoveryPlan(encoded)).toEqual(expected)
      result.inputs[0].sourceSatoshis += 1
      result.inputBeef![0] = 0
      fundingTxids.pop()
      expect(decodeActionRecoveryPlan(encoded)).toEqual(expected)
      const duplicate = JSON.parse(encoded)
      duplicate.result.inputs.push({ ...duplicate.result.inputs[0], vin: inputCount })
      expect(() => decodeActionRecoveryPlan(actionRecoveryJSON(duplicate))).toThrow('Invalid or oversized action recovery record')
      const unrelated = JSON.parse(encoded)
      unrelated.fundingTxids.push('f'.repeat(64))
      expect(() => decodeActionRecoveryPlan(actionRecoveryJSON(unrelated))).toThrow('Invalid or oversized action recovery record')
    }
  ))
})
