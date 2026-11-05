import fc from 'fast-check'
import { Validation } from '@bsv/sdk'
import { validateRecoveryConstruction } from '../ActionRecoveryPlan'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('only fixed-layout full-evidence two-phase noSend requests enter the recovery profile', () => {
  fc.assert(fc.property(fc.subarray(['new', 'sign', 'nosend', 'sendwith', 'process', 'random', 'txid', 'send-list', 'known', 'trust', 'expiry']), changes => {
    const args = Validation.validateCreateActionArgs({ description: 'Generated profile fixture', outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'Generated output' }],
      options: { noSend: true, signAndProcess: false, randomizeOutputs: false, returnTXIDOnly: false } })
    for (const change of changes) {
      if (change === 'new') args.isNewTx = false
      if (change === 'sign') args.isSignAction = false
      if (change === 'nosend') args.isNoSend = false
      if (change === 'sendwith') args.isSendWith = true
      if (change === 'process') args.options.signAndProcess = true
      if (change === 'random') args.options.randomizeOutputs = true
      if (change === 'txid') args.options.returnTXIDOnly = true
      if (change === 'send-list') args.options.sendWith = ['11'.repeat(32)]
      if (change === 'known') args.options.knownTxids = ['22'.repeat(32)]
      if (change === 'trust') args.options.trustSelf = 'known'
      if (change === 'expiry') args.labels = ['p nosend expiry seconds 60']
    }
    if (changes.length === 0) expect(() => validateRecoveryConstruction(args)).not.toThrow()
    else expect(() => validateRecoveryConstruction(args)).toThrow('Action recovery requires')
  }))
})
