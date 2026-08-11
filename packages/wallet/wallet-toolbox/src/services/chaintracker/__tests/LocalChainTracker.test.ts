import type { ChaintracksClientApi } from '../chaintracks/Api/ChaintracksClientApi'
import { LocalChainTracker } from '../LocalChainTracker'

const localHash = '01'.repeat(32)
const agreedHash = '02'.repeat(32)

function client(
  options: {
    height?: number
    hash?: string
    valid?: boolean
    heightError?: Error
    validationError?: Error
  } = {}
): ChaintracksClientApi {
  const height = options.height ?? 100
  const hash = options.hash ?? agreedHash
  return {
    getPresentHeight: jest.fn(async () => {
      if (options.heightError != null) throw options.heightError
      return height
    }),
    findChainTipHash: jest.fn(async () => hash),
    findHeaderForHeight: jest.fn(async requestedHeight => ({ height: requestedHeight, hash })),
    isValidRootForHeight: jest.fn(async () => {
      if (options.validationError != null) throw options.validationError
      return options.valid ?? true
    }),
    startListening: jest.fn(async () => undefined),
    listening: jest.fn(async () => undefined)
  } as unknown as ChaintracksClientApi
}

describe('LocalChainTracker', () => {
  test('never overrides a definitive local rejection with a remote answer', async () => {
    const local = client({ valid: false })
    const fallback = client({ valid: true })
    const tracker = new LocalChainTracker({ local, fallbacks: [fallback] })

    await expect(tracker.isValidRootForHeight('root', 100)).resolves.toBe(false)
    expect(fallback.isValidRootForHeight).not.toHaveBeenCalled()
    expect(tracker.getStatus().activeSource).toBe('local')
  })

  test('requires configured agreement when local validation throws', async () => {
    const tracker = new LocalChainTracker({
      local: client({ validationError: new Error('local storage unavailable') }),
      fallbacks: [client({ valid: true }), client({ valid: true })],
      requiredFallbackAgreement: 2
    })

    await expect(tracker.isValidRootForHeight('root', 100)).resolves.toBe(true)
    expect(tracker.getStatus()).toMatchObject({ activeSource: 'fallback-2' })
  })

  test('compares local history with independent references at a shared height', async () => {
    const tracker = new LocalChainTracker({
      local: client({ height: 102, hash: agreedHash }),
      fallbacks: [client({ height: 101, hash: agreedHash }), client({ height: 100, hash: agreedHash })],
      requiredConsistencyAgreement: 2
    })

    await expect(tracker.checkConsistency()).resolves.toMatchObject({
      consistency: 'agreed',
      localHeight: 102,
      referenceHeight: 100,
      heightLag: 0,
      comparisonHeight: 100,
      expectedHash: agreedHash,
      referenceAgreement: 2
    })
  })

  test('auto-recovers only after enough references agree on divergence', async () => {
    const recovered = client({ hash: agreedHash })
    const recoverLocal = jest.fn(async () => recovered)
    const tracker = new LocalChainTracker({
      local: client({ hash: localHash }),
      fallbacks: [client({ hash: agreedHash }), client({ hash: agreedHash })],
      requiredConsistencyAgreement: 2,
      autoRecover: true,
      recoverLocal
    })

    await expect(tracker.checkConsistency()).resolves.toMatchObject({
      consistency: 'agreed',
      recoveredAt: expect.any(String)
    })
    expect(recoverLocal).toHaveBeenCalledWith({
      reason: 'diverged',
      localHeight: 100,
      referenceHeight: 100,
      heightLag: 0,
      comparisonHeight: 100,
      expectedHash: agreedHash,
      referenceAgreement: 2
    })
    expect(tracker.getLocalClient()).toBe(recovered)
  })

  test('detects and recovers a quorum-confirmed stuck local chain', async () => {
    const recovered = client({ height: 120, hash: agreedHash })
    const recoverLocal = jest.fn(async () => recovered)
    const tracker = new LocalChainTracker({
      local: client({ height: 100, hash: agreedHash }),
      fallbacks: [client({ height: 120, hash: agreedHash }), client({ height: 121, hash: agreedHash })],
      requiredConsistencyAgreement: 2,
      maxHeightLag: 6,
      autoRecover: true,
      recoverLocal
    })

    await expect(tracker.checkConsistency()).resolves.toMatchObject({
      consistency: 'agreed',
      localHeight: 120,
      recoveredAt: expect.any(String)
    })
    expect(recoverLocal).toHaveBeenCalledWith({
      reason: 'lagging',
      localHeight: 100,
      referenceHeight: 120,
      heightLag: 20,
      comparisonHeight: 100,
      expectedHash: agreedHash,
      referenceAgreement: 2
    })
  })

  test('does not let one inflated reference declare local state stuck', async () => {
    const tracker = new LocalChainTracker({
      local: client({ height: 100, hash: agreedHash }),
      fallbacks: [client({ height: 10_000, hash: agreedHash }), client({ height: 100, hash: agreedHash })],
      requiredConsistencyAgreement: 2,
      maxHeightLag: 0
    })

    await expect(tracker.checkConsistency()).resolves.toMatchObject({
      consistency: 'agreed',
      referenceHeight: 100,
      heightLag: 0
    })
  })

  test('exposes explicit local clearing and mode management hooks', async () => {
    const replacement = client()
    const clearLocal = jest.fn(async () => replacement)
    const tracker = new LocalChainTracker({ local: client(), fallbacks: [client()], clearLocal })

    tracker.setMode('remote-only')
    expect(tracker.getMode()).toBe('remote-only')
    await expect(tracker.clearLocalData()).resolves.toMatchObject({
      mode: 'remote-only',
      consistency: 'unchecked'
    })
    expect(tracker.getLocalClient()).toBe(replacement)
  })
})
