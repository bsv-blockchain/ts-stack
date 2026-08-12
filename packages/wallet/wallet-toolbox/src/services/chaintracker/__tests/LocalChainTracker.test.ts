import type { ChaintracksClientApi } from '../chaintracks/Api/ChaintracksClientApi'
import { LocalChainTracker } from '../LocalChainTracker'

const localHash = '01'.repeat(32)
const agreedHash = '02'.repeat(32)

function client(
  options: {
    height?: number
    hash?: string
    valid?: boolean
    heightError?: unknown
    tipError?: unknown
    headerError?: unknown
    validationError?: unknown
    noHeader?: boolean
  } = {}
): ChaintracksClientApi {
  const height = options.height ?? 100
  const hash = options.hash ?? agreedHash
  return {
    getPresentHeight: jest.fn(async () => {
      if (options.heightError != null) throw options.heightError
      return height
    }),
    findChainTipHash: jest.fn(async () => {
      if (options.tipError != null) throw options.tipError
      return hash
    }),
    findHeaderForHeight: jest.fn(async requestedHeight => {
      if (options.headerError != null) throw options.headerError
      return options.noHeader ? undefined : { height: requestedHeight, hash }
    }),
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

  test('uses local height by default and remote height only for explicit or exceptional fallback', async () => {
    const local = client({ height: 101 })
    const firstFallback = client({ heightError: new Error('first unavailable') })
    const secondFallback = client({ height: 103 })
    const tracker = new LocalChainTracker({
      local,
      fallbacks: [firstFallback, secondFallback],
      now: () => new Date('2026-08-11T00:00:00.000Z')
    })

    await expect(tracker.currentHeight()).resolves.toBe(101)
    expect(tracker.getStatus()).toMatchObject({ activeSource: 'local', localHeight: 101 })

    tracker.setMode('remote-only')
    await expect(tracker.currentHeight()).resolves.toBe(103)
    expect(tracker.getStatus()).toMatchObject({
      activeSource: 'fallback-2',
      lastFallbackAt: '2026-08-11T00:00:00.000Z'
    })

    tracker.setMode('local-primary')
    expect(tracker.getStatus().activeSource).toBe('local')
  })

  test('fails closed when local height fallback is disabled or unavailable', async () => {
    const localError = new Error('local height failed')
    const disabled = new LocalChainTracker({
      local: client({ heightError: localError }),
      fallbackOnLocalError: false
    })
    await expect(disabled.currentHeight()).rejects.toBe(localError)
    expect(disabled.getStatus()).toMatchObject({ activeSource: 'unavailable', lastError: localError.message })

    const noSources = new LocalChainTracker({ local: client(), mode: 'remote-only' })
    await expect(noSources.currentHeight()).rejects.toThrow('No fallback ChainTracks source is configured.')

    const stringFailure = new LocalChainTracker({
      local: client(),
      mode: 'remote-only',
      fallbacks: [client({ heightError: 'offline' })]
    })
    await expect(stringFailure.currentHeight()).rejects.toBe('offline')
    expect(stringFailure.getStatus()).toMatchObject({ activeSource: 'unavailable', lastError: 'offline' })
  })

  test('falls back for a local height exception when exceptional fallback is enabled', async () => {
    const tracker = new LocalChainTracker({
      local: client({ heightError: new Error('local unavailable') }),
      fallbacks: [client({ height: 104 })]
    })

    await expect(tracker.currentHeight()).resolves.toBe(104)
    expect(tracker.getStatus()).toMatchObject({ activeSource: 'fallback-1', lastError: undefined })
  })

  test('uses quorum for remote-only rejection and rejects split or failed fallback evidence', async () => {
    const local = client({ valid: true })
    const rejected = new LocalChainTracker({
      local,
      mode: 'remote-only',
      fallbacks: [client({ valid: false }), client({ valid: false })],
      requiredFallbackAgreement: 2
    })
    await expect(rejected.isValidRootForHeight('root', 100)).resolves.toBe(false)
    expect(local.isValidRootForHeight).not.toHaveBeenCalled()
    expect(rejected.getStatus().activeSource).toBe('fallback-2')

    const split = new LocalChainTracker({
      local,
      mode: 'remote-only',
      fallbacks: [client({ valid: true }), client({ valid: false })],
      requiredFallbackAgreement: 2
    })
    await expect(split.isValidRootForHeight('root', 100)).rejects.toThrow(
      'Fallback agreement unavailable: 1 valid and 1 invalid responses, 2 required.'
    )

    const failed = new LocalChainTracker({
      local,
      mode: 'remote-only',
      fallbacks: [client({ validationError: new Error('reference unavailable') })]
    })
    await expect(failed.isValidRootForHeight('root', 100)).rejects.toThrow('reference unavailable')
  })

  test('does not consult fallback when a local validation error must fail closed', async () => {
    const localError = new Error('local validation failed')
    const fallback = client({ valid: true })
    const tracker = new LocalChainTracker({
      local: client({ validationError: localError }),
      fallbacks: [fallback],
      fallbackOnLocalError: false
    })

    await expect(tracker.isValidRootForHeight('root', 100)).rejects.toBe(localError)
    expect(fallback.isValidRootForHeight).not.toHaveBeenCalled()
  })

  test('synchronizes the local client before checking consistency', async () => {
    const local = client()
    const tracker = new LocalChainTracker({ local })

    await expect(tracker.synchronize()).resolves.toMatchObject({
      consistency: 'insufficient-references',
      localHeight: 100
    })
    expect(local.startListening).toHaveBeenCalledTimes(1)
    expect(local.listening).toHaveBeenCalledTimes(1)
  })

  test('requires a configured clearing hook and resets local-primary status when cleared', async () => {
    const unconfigured = new LocalChainTracker({ local: client() })
    await expect(unconfigured.clearLocalData()).rejects.toThrow('Local ChainTracks clearing is not configured.')

    const replacement = client({ height: 105 })
    const configured = new LocalChainTracker({ local: client(), clearLocal: async () => replacement })
    await expect(configured.clearLocalData()).resolves.toEqual({
      mode: 'local-primary',
      activeSource: 'local',
      consistency: 'unchecked'
    })
  })

  test('reports missing, unavailable, and sub-quorum consistency references', async () => {
    const noReferences = new LocalChainTracker({ local: client() })
    await expect(noReferences.checkConsistency()).resolves.toMatchObject({
      consistency: 'insufficient-references',
      localHeight: 100,
      localTipHash: agreedHash
    })

    const unavailable = new LocalChainTracker({
      local: client(),
      fallbacks: [client({ heightError: new Error('offline') })]
    })
    await expect(unavailable.checkConsistency()).resolves.toMatchObject({
      consistency: 'insufficient-references'
    })

    const belowQuorum = new LocalChainTracker({
      local: client(),
      fallbacks: [client()],
      requiredConsistencyAgreement: 2
    })
    await expect(belowQuorum.checkConsistency()).resolves.toMatchObject({
      consistency: 'insufficient-references'
    })
  })

  test('requires header quorum and deterministically selects equally supported hashes', async () => {
    const missingHeaders = new LocalChainTracker({
      local: client(),
      fallbacks: [client({ headerError: new Error('missing') }), client({ noHeader: true })],
      requiredConsistencyAgreement: 2
    })
    await expect(missingHeaders.checkConsistency()).resolves.toMatchObject({
      consistency: 'insufficient-references',
      referenceAgreement: 0
    })

    const higherButExcluded = client({ height: 99, hash: 'ff'.repeat(32) })
    const tied = new LocalChainTracker({
      local: client({ height: 100, hash: 'aa'.repeat(32) }),
      fallbacks: [
        client({ height: 100, hash: 'bb'.repeat(32) }),
        client({ height: 100, hash: 'aa'.repeat(32) }),
        higherButExcluded
      ],
      requiredConsistencyAgreement: 1
    })
    await expect(tied.checkConsistency()).resolves.toMatchObject({
      consistency: 'agreed',
      expectedHash: 'aa'.repeat(32),
      referenceAgreement: 1
    })
    expect(higherButExcluded.findHeaderForHeight).not.toHaveBeenCalled()
  })

  test('reports corroborated lag or divergence without recovery when recovery is disabled', async () => {
    const lagging = new LocalChainTracker({
      local: client({ height: 100, hash: agreedHash }),
      fallbacks: [client({ height: 120, hash: agreedHash }), client({ height: 120, hash: agreedHash })],
      requiredConsistencyAgreement: 2,
      maxHeightLag: 1
    })
    await expect(lagging.checkConsistency()).resolves.toMatchObject({ consistency: 'lagging', heightLag: 20 })

    const diverged = new LocalChainTracker({
      local: client({ noHeader: true }),
      fallbacks: [client({ hash: agreedHash }), client({ hash: agreedHash })],
      requiredConsistencyAgreement: 2
    })
    await expect(diverged.checkConsistency()).resolves.toMatchObject({ consistency: 'diverged' })
  })

  test('records local consistency exceptions without consulting recovery', async () => {
    const tracker = new LocalChainTracker({ local: client({ tipError: new Error('tip unavailable') }) })
    await expect(tracker.checkConsistency()).resolves.toMatchObject({
      consistency: 'error',
      lastError: 'tip unavailable'
    })
  })

  test.each([
    [{ requiredFallbackAgreement: 0 }, 'requiredFallbackAgreement'],
    [{ requiredConsistencyAgreement: Number.NaN }, 'requiredConsistencyAgreement'],
    [{ maxHeightLag: -1 }, 'maxHeightLag']
  ])('rejects invalid safety bounds %p', (invalid, expected) => {
    expect(() => new LocalChainTracker({ local: client(), ...invalid })).toThrow(expected)
  })
})
