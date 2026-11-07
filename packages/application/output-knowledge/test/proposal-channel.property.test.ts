import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { fixture, successor } from './proposal-current-fixture.js'
import { signed } from './proposal-client-fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  ...(replayPath ? { path: replayPath } : {})
})

it('rejects an entire generated multi-channel change when its last predecessor is wrong', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 255 }), value => {
      const f = fixture(),
        first = signed({ channel: '00'.repeat(32) }),
        last = signed({ channel: value.toString(16).padStart(2, '0').repeat(32) })
      f.append('snapshot', f.pair(first))
      f.append('snapshot', f.pair(last))
      const wrong = successor(last, { previous: 'ff'.repeat(32) })
      f.append('live', [
        f.removal(first),
        ...f.pair(successor(first)),
        f.removal(last),
        ...f.pair(wrong)
      ])
      const result = f.result()
      expect(result.consistent).toBe(false)
      expect(result.channels.map(row => row.proposal)).toEqual([first, last])
      expect(result.channels.every(row => !row.activeIntent)).toBe(true)
    })
  )
})
