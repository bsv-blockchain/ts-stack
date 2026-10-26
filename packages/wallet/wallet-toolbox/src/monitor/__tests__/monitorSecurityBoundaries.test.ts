import { blockHash, genesisHeader } from '../../services/chaintracker/chaintracks/util/blockHeaderUtilities'
import { Monitor } from '../Monitor'
import { copyValidatedMonitorHeader } from '../monitorValidation'
import { TaskCheckForProofs } from '../tasks/TaskCheckForProofs'
import { TaskCheckNoSends } from '../tasks/TaskCheckNoSends'
import { TaskFailAbandoned } from '../tasks/TaskFailAbandoned'
import { TaskNewHeader } from '../tasks/TaskNewHeader'
import { TaskReconcilePendingTransactions } from '../tasks/TaskReconcilePendingTransactions'
import { TaskReviewDoubleSpends } from '../tasks/TaskReviewDoubleSpends'
import { TaskReviewProvenTxs } from '../tasks/TaskReviewProvenTxs'
import { TaskSendWaiting } from '../tasks/TaskSendWaiting'

function monitorOptions(): any {
  return {
    chain: 'main',
    services: { chain: 'main' },
    storage: {},
    chaintracks: {},
    msecsWaitPerMerkleProofServiceReq: 0,
    taskRunWaitMsecs: 0,
    abandonedMsecs: 0,
    unprovenAttemptsLimitTest: 0,
    unprovenAttemptsLimitMain: 0,
    maxRebroadcastAttempts: 0
  }
}

describe('monitor configuration and header trust boundaries', () => {
  test('rejects accessor-backed options without invoking them', () => {
    let invoked = false
    const options = monitorOptions()
    Object.defineProperty(options, 'taskRunWaitMsecs', {
      enumerable: true,
      get: () => {
        invoked = true
        return 0
      }
    })

    expect(() => new Monitor(options)).toThrow('accessor-free')
    expect(invoked).toBe(false)
  })

  test.each([
    ['msecsWaitPerMerkleProofServiceReq', -1],
    ['taskRunWaitMsecs', Number.NaN],
    ['abandonedMsecs', Number.MAX_SAFE_INTEGER],
    ['unprovenAttemptsLimitTest', 1.5],
    ['unprovenAttemptsLimitMain', -1],
    ['maxRebroadcastAttempts', 1_000_001]
  ])('rejects invalid %s', (property, value) => {
    const options = monitorOptions()
    options[property] = value
    expect(() => new Monitor(options)).toThrow(property)
  })

  test('copies a proof-of-work-valid header and rejects accessor or forged fields', () => {
    const source = genesisHeader('main')
    const copy = copyValidatedMonitorHeader(source)
    expect(copy).toEqual(source)
    expect(copy).not.toBe(source)

    let invoked = false
    const accessor = { ...source }
    Object.defineProperty(accessor, 'nonce', {
      enumerable: true,
      get: () => {
        invoked = true
        return source.nonce
      }
    })
    expect(() => copyValidatedMonitorHeader(accessor)).toThrow('accessor-free')
    expect(invoked).toBe(false)
    expect(() => copyValidatedMonitorHeader({ ...source, hash: '11'.repeat(32) })).toThrow('proof-of-work-valid')
  })

  test('permits only the explicit mock-chain caller to skip consensus proof of work', () => {
    const source = genesisHeader('main')
    const mockTargetHeader = { ...source, bits: 0x207fffff }
    mockTargetHeader.hash = blockHash(mockTargetHeader)

    expect(() => copyValidatedMonitorHeader(mockTargetHeader)).toThrow('proof-of-work-valid')
    expect(copyValidatedMonitorHeader(mockTargetHeader, 'mock header', false)).toEqual(mockTargetHeader)
  })

  test('task constructors reject negative, fractional, and excessive work controls', () => {
    const monitor = { storage: {} } as never
    expect(() => new TaskNewHeader(monitor, -1)).toThrow('triggerMsecs')
    expect(() => new TaskCheckForProofs(monitor, 1.5)).toThrow('triggerMsecs')
    expect(() => new TaskCheckNoSends(monitor, Number.MAX_SAFE_INTEGER)).toThrow('triggerMsecs')
    expect(() => new TaskFailAbandoned(monitor, -1)).toThrow('triggerMsecs')
    expect(() => new TaskReviewDoubleSpends(monitor, 0, 1001)).toThrow('reviewLimit')
    expect(() => new TaskReconcilePendingTransactions(monitor, 0, 0)).toThrow('reviewLimit')
    expect(() => new TaskReviewProvenTxs(monitor, 0, 1.5)).toThrow('maxHeightsPerRun')
    expect(() => new TaskSendWaiting(monitor, 0, 0, 0, 0, 0)).toThrow('chunkLimit')
  })
})
