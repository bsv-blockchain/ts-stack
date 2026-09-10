import type { ChaintracksClientApi } from '../chaintracks/Api/ChaintracksClientApi'
import { ChaintracksServiceClient } from '../chaintracks/ChaintracksServiceClient'
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

class PromisingEventsClient extends ChaintracksServiceClient {
  override readonly supportsReorgEvents = true
}

describe('LocalChainTracker', () => {
  test('uses an event-unsupported HTTP fallback in remote-only mode without subscribing', async () => {
    const local = client()
    const fallback = new ChaintracksServiceClient('main', 'https://chaintracks.example')
    expect(fallback.supportsReorgEvents).toBe(false)
    jest.spyOn(fallback, 'findChainTipHash').mockResolvedValue('aa'.repeat(32))
    jest.spyOn(fallback, 'subscribeReorgs')
    const tracker = new LocalChainTracker({ local, fallbacks: [fallback], mode: 'remote-only' })

    await expect(tracker.getVerificationContextToken()).resolves.toContain('aa'.repeat(32))
    expect(fallback.subscribeReorgs).not.toHaveBeenCalled()
    expect(local.findChainTipHash).not.toHaveBeenCalled()
  })

  test('does not hide a registration failure from a fallback that promises reorg events', async () => {
    const fallback = new PromisingEventsClient('main', 'https://chaintracks.example')
    expect(fallback.supportsReorgEvents).toBe(true)
    jest.spyOn(fallback, 'findChainTipHash').mockResolvedValue('aa'.repeat(32))
    const subscribe = jest.spyOn(fallback, 'subscribeReorgs')
    const tracker = new LocalChainTracker({ local: client(), fallbacks: [fallback], mode: 'remote-only' })

    await expect(tracker.getVerificationContextToken()).rejects.toThrow('Method not implemented.')
    expect(subscribe).toHaveBeenCalled()
  })

  test('requires participating canonical identity and ignores unused providers', async () => {
    const unusedLocal = client({ hash: 'aa'.repeat(32) })
    const deadFallback = client({ tipError: new Error('fallback offline') })
    const remoteOnly = new LocalChainTracker({
      local: unusedLocal,
      fallbacks: [deadFallback],
      mode: 'remote-only'
    })
    await expect(remoteOnly.getVerificationContextToken()).rejects.toThrow('fallback offline')
    expect(unusedLocal.findChainTipHash).not.toHaveBeenCalled()

    const hangingLocal = client({ hash: 'aa'.repeat(32) })
    const remoteWithoutFallback = new LocalChainTracker({ local: hangingLocal, mode: 'remote-only' })
    await expect(remoteWithoutFallback.getVerificationContextToken()).rejects.toThrow(
      'No canonical ChainTracks source is available'
    )
    expect(hangingLocal.findChainTipHash).not.toHaveBeenCalled()

    const liveLocal = client({ hash: 'cc'.repeat(32) })
    const unusedFallback = client({ tipError: new Error('fallback offline') })
    const localPrimary = new LocalChainTracker({ local: liveLocal, fallbacks: [unusedFallback] })
    await expect(localPrimary.getVerificationContextToken()).resolves.toContain('cc'.repeat(32))
    expect(unusedFallback.findChainTipHash).not.toHaveBeenCalled()

    const deadLocal = client({ tipError: new Error('local offline') })
    const unusedLiveFallback = client({ hash: 'dd'.repeat(32) })
    const localMissing = new LocalChainTracker({ local: deadLocal, fallbacks: [unusedLiveFallback] })
    await expect(localMissing.getVerificationContextToken()).rejects.toThrow('local offline')
    expect(unusedLiveFallback.findChainTipHash).not.toHaveBeenCalled()
  })
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

  test('fences an in-flight root validation while local clearing is deferred or fails', async () => {
    let releaseRoot: (() => void) | undefined
    let releaseClear: (() => void) | undefined
    const rootPending = new Promise<void>(resolve => {
      releaseRoot = resolve
    })
    const clearPending = new Promise<ChaintracksClientApi>(resolve => {
      releaseClear = () => resolve(client())
    })
    const local = client()
    ;(local.isValidRootForHeight as jest.Mock).mockImplementation(async () => {
      await rootPending
      return true
    })
    const tracker = new LocalChainTracker({ local, clearLocal: async () => await clearPending })
    const validation = tracker.isValidRootForHeight('root', 100)
    const clearing = tracker.clearLocalData()
    releaseRoot!()
    await expect(validation).rejects.toThrow('provider changed')
    releaseClear!()
    await expect(clearing).resolves.toMatchObject({ consistency: 'unchecked' })

    const failed = new LocalChainTracker({
      local: client(),
      clearLocal: async () => {
        throw new Error('reset failed')
      }
    })
    await expect(failed.clearLocalData()).rejects.toThrow('reset failed')
    await expect(failed.isValidRootForHeight('root', 100)).rejects.toThrow('provider changed')
  })

  test('drops a pending observer registration during reset and registers a fresh replacement observer', async () => {
    let releaseSubscription: ((value: string) => void) | undefined
    const pendingSubscription = new Promise<string>(resolve => {
      releaseSubscription = resolve
    })
    const oldLocal = client()
    ;(oldLocal as any).subscribeReorgs = jest.fn(async () => await pendingSubscription)
    ;(oldLocal as any).unsubscribe = jest.fn(async () => true)
    const replacement = client()
    ;(replacement as any).subscribeReorgs = jest.fn(async () => 'fresh')
    ;(replacement as any).unsubscribe = jest.fn(async () => true)
    const tracker = new LocalChainTracker({ local: oldLocal, clearLocal: async () => replacement })

    const staleToken = tracker.getVerificationContextToken()
    const reset = tracker.clearLocalData()
    releaseSubscription!('stale')
    await expect(staleToken).rejects.toThrow('provider changed')
    await reset
    await expect(tracker.getVerificationContextToken()).resolves.toContain('eventEpoch')
    expect((oldLocal as any).unsubscribe).toHaveBeenCalledWith('stale')
    expect((replacement as any).subscribeReorgs).toHaveBeenCalledTimes(1)
  })

  test('does not invoke a superseded recovery hook when reset is overtaken during disposal', async () => {
    let releaseUnsubscribe: (() => void) | undefined
    const pendingUnsubscribe = new Promise<void>(resolve => {
      releaseUnsubscribe = resolve
    })
    let sawUnsubscribe: (() => void) | undefined
    const unsubscribed = new Promise<void>(resolve => {
      sawUnsubscribe = resolve
    })
    const oldLocal = client({ hash: localHash })
    ;(oldLocal as any).subscribeReorgs = jest.fn(async () => 'sub-1')
    ;(oldLocal as any).unsubscribe = jest.fn(async () => {
      sawUnsubscribe!()
      await pendingUnsubscribe
      return true
    })
    const recovered = client({ hash: agreedHash })
    const recoverLocal = jest.fn(async () => recovered)
    const replacement = client()
    const clearLocal = jest.fn(async () => replacement)
    const tracker = new LocalChainTracker({
      local: oldLocal,
      fallbacks: [client({ hash: agreedHash }), client({ hash: agreedHash })],
      requiredConsistencyAgreement: 2,
      autoRecover: true,
      recoverLocal,
      clearLocal
    })
    await tracker.getVerificationContextToken()

    const recovering = tracker.checkConsistency()
    await unsubscribed
    const clearing = tracker.clearLocalData()
    releaseUnsubscribe!()
    await expect(recovering).resolves.toMatchObject({
      consistency: 'error',
      lastError: 'Local ChainTracks reset was superseded'
    })
    await expect(clearing).resolves.toMatchObject({ consistency: 'unchecked' })
    expect(recoverLocal).not.toHaveBeenCalled()
    expect(clearLocal).toHaveBeenCalledTimes(1)
    expect(tracker.getLocalClient()).toBe(replacement)
  })

  test('does not invoke a superseded clear hook when reset is overtaken during disposal', async () => {
    let releaseUnsubscribe: (() => void) | undefined
    const pendingUnsubscribe = new Promise<void>(resolve => {
      releaseUnsubscribe = resolve
    })
    let sawUnsubscribe: (() => void) | undefined
    const unsubscribed = new Promise<void>(resolve => {
      sawUnsubscribe = resolve
    })
    const oldLocal = client()
    ;(oldLocal as any).subscribeReorgs = jest.fn(async () => 'sub-1')
    ;(oldLocal as any).unsubscribe = jest.fn(async () => {
      sawUnsubscribe!()
      await pendingUnsubscribe
      return true
    })
    const replacement = client()
    const clearLocal = jest.fn(async () => replacement)
    const tracker = new LocalChainTracker({ local: oldLocal, clearLocal })
    await tracker.getVerificationContextToken()

    const first = tracker.clearLocalData()
    await unsubscribed
    const second = tracker.clearLocalData()
    releaseUnsubscribe!()
    await expect(first).rejects.toThrow('superseded')
    await expect(second).resolves.toMatchObject({ consistency: 'unchecked' })
    expect(clearLocal).toHaveBeenCalledTimes(1)
    expect(tracker.getLocalClient()).toBe(replacement)
  })

  test('keeps the newest clear replacement when concurrent resets complete out of order', async () => {
    let resolveFirst: ((value: ChaintracksClientApi) => void) | undefined
    let resolveSecond: ((value: ChaintracksClientApi) => void) | undefined
    const first = new Promise<ChaintracksClientApi>(resolve => {
      resolveFirst = resolve
    })
    const second = new Promise<ChaintracksClientApi>(resolve => {
      resolveSecond = resolve
    })
    let firstHookEntered: (() => void) | undefined
    const firstHook = new Promise<void>(resolve => {
      firstHookEntered = resolve
    })
    const older = client({ valid: false })
    const newer = client({ valid: true })
    const clearLocal = jest
      .fn()
      .mockImplementationOnce(async () => {
        firstHookEntered!()
        return await first
      })
      .mockImplementationOnce(async () => await second)
    const tracker = new LocalChainTracker({ local: client(), clearLocal })

    const oldReset = tracker.clearLocalData()
    await firstHook
    const newReset = tracker.clearLocalData()
    resolveSecond!(newer)
    await newReset
    resolveFirst!(older)
    await expect(oldReset).rejects.toThrow('superseded')

    expect(tracker.getLocalClient()).toBe(newer)
    await expect(tracker.isValidRootForHeight('root', 100)).resolves.toBe(true)
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

  test('rejects a local validation result when the tracker mode changes in flight', async () => {
    let release: (() => void) | undefined
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    const local = client()
    ;(local.isValidRootForHeight as jest.Mock).mockImplementation(async () => {
      await pending
      return true
    })
    const tracker = new LocalChainTracker({ local, fallbacks: [client({ valid: true })] })

    const validation = tracker.isValidRootForHeight('root', 100)
    tracker.setMode('remote-only')
    release!()

    await expect(validation).rejects.toThrow('provider changed')
    expect(tracker.getVerificationContext()).toContain('local-chaintracks:[1,false,"remote-only"')
  })

  test('rejects a local height result when its nested provider context changes in flight', async () => {
    let release: (() => void) | undefined
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    let providerContext = 0
    const local = client()
    ;(local.getPresentHeight as jest.Mock).mockImplementation(async () => {
      await pending
      return 101
    })
    ;(local as ChaintracksClientApi & { getVerificationContext: () => number }).getVerificationContext = () =>
      providerContext
    const tracker = new LocalChainTracker({ local })

    const height = tracker.currentHeight()
    providerContext++
    release!()

    await expect(height).rejects.toThrow('provider changed')
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
