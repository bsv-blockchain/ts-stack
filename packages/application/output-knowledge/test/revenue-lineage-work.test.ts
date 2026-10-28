import { afterEach, beforeEach, expect, it, jest } from '@jest/globals'
import { getEventListeners } from 'node:events'
import { OutputProtocolError, ScriptResourceLimitError } from '@bsv/sdk'
import { SDKEvidenceVerifier } from '../src/SDKEvidenceVerifier.js'
import { RevenueListingLineageVerifier } from '../src/revenue-listing/RevenueListingLineageVerifier.js'
import type { VerificationResult } from '../src/ports.js'
import { chains, completeGenesis, context, family } from './revenue-lineage-fixture.js'

// These tests isolate admission/lifecycle behavior from the independently tested
// Bitcoin verifier. Full DAG and actual Script evidence remain integration tests.
let packet: ReturnType<typeof completeGenesis>
beforeEach(() => {
  packet = completeGenesis()
})
function outcome(): VerificationResult {
  return {
    status: 'invalid',
    contextId: 'fixture',
    variantId: 'fixture',
    reason: 'fixture',
    dependencies: []
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

it.each([
  [new Error('unclassified dependency failure'), 'invalid'],
  [
    Object.assign(new Error('foreign error with a coincidentally matching code'), {
      code: 'cancelled'
    }),
    'invalid'
  ],
  [new OutputProtocolError('invalid', 'invalid fixture'), 'invalid'],
  [new OutputProtocolError('cancelled', 'cancelled fixture'), 'cancelled'],
  [new OutputProtocolError('context-changed', 'view fixture'), 'context-changed'],
  [new OutputProtocolError('limited', 'limit fixture'), 'limited'],
  [new OutputProtocolError('unavailable', 'unavailable fixture'), 'limited'],
  [new OutputProtocolError('reset-required', 'reset fixture'), 'limited'],
  [new ScriptResourceLimitError('stack', 1, 2), 'limited']
])('classifies a dependency failure without accepting the lineage: %s', async (error, status) => {
  const evidence = jest.spyOn(SDKEvidenceVerifier.prototype, 'verify').mockRejectedValue(error)
  expect(await new RevenueListingLineageVerifier(family, chains).verify(packet, context())).toEqual(
    { status, dependencies: [] }
  )
  expect(evidence).toHaveBeenCalledTimes(1)
})

it('rejects incompatible context and unrepresentable or expired deadlines before evidence work', async () => {
  const evidence = jest.spyOn(SDKEvidenceVerifier.prototype, 'verify').mockResolvedValue(outcome())
  const verifier = new RevenueListingLineageVerifier(family, chains)
  const foreign = context()
  foreign.view.chain.network = 'foreign'
  const unrepresentable = context()
  unrepresentable.limits.deadline = '9007199254741'
  for (const c of [foreign, unrepresentable]) {
    expect(await verifier.verify(packet, c)).toEqual({ status: 'invalid', dependencies: [] })
    expect(evidence).not.toHaveBeenCalled()
  }
  const now = Math.floor(Date.now() / 1000) * 1000
  jest.spyOn(Date, 'now').mockReturnValue(now)
  const expired = context()
  expired.now = String(now / 1000 - 1)
  expired.limits.deadline = String(now / 1000)
  expect(await verifier.verify(packet, expired)).toEqual({ status: 'limited', dependencies: [] })
  expect(evidence).not.toHaveBeenCalled()
})

it.each(['transactions', 'dependencies', 'bytes'] as const)(
  'applies a smaller caller %s budget before evidence work',
  async key => {
    const evidence = jest
      .spyOn(SDKEvidenceVerifier.prototype, 'verify')
      .mockResolvedValue(outcome())
    const c = context()
    c.limits[key] = 1
    expect(await new RevenueListingLineageVerifier(family, chains).verify(packet, c)).toEqual({
      status: 'limited',
      dependencies: []
    })
    expect(evidence).not.toHaveBeenCalled()
  }
)

it('holds its own concurrency slot until pending evidence physically settles', async () => {
  const entered = deferred<void>(),
    release = deferred<VerificationResult>()
  let innerSignal: AbortSignal | undefined
  const evidence = jest
    .spyOn(SDKEvidenceVerifier.prototype, 'verify')
    .mockImplementation(async (_candidate, _context, signal) => {
      innerSignal = signal
      entered.resolve()
      return await release.promise
    })
  const verifier = new RevenueListingLineageVerifier(family, chains, { concurrentRequests: 1 })
  const controller = new AbortController()
  const pending = verifier.verify(packet, context(), controller.signal)
  try {
    expect(
      await Promise.race([
        entered.promise.then(() => 'entered'),
        pending.then(result => result.status)
      ])
    ).toBe('entered')
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
    expect(await verifier.verify(packet, context())).toEqual({
      status: 'limited',
      dependencies: []
    })
    expect(evidence).toHaveBeenCalledTimes(1)
    controller.abort()
    expect(await pending).toEqual({ status: 'cancelled', dependencies: [] })
    expect(innerSignal?.aborted).toBe(true)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(innerSignal!, 'abort')).toHaveLength(0)
    expect(await verifier.verify(packet, context())).toEqual({
      status: 'limited',
      dependencies: []
    })
    expect(evidence).toHaveBeenCalledTimes(1)
  } finally {
    release.resolve(outcome())
  }
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(await verifier.verify(packet, context())).toEqual({ status: 'invalid', dependencies: [] })
  expect(evidence).toHaveBeenCalledTimes(2)
}, 5000)

it.each([
  { timeoutMs: 3000, deadlineSeconds: 1, expires: 1000 },
  { timeoutMs: 1000, deadlineSeconds: 3, expires: 1000 }
])('uses the earlier local or caller deadline and cleans up timers: %s', async limits => {
  jest.useFakeTimers({ now: 1700000000000 })
  const release = deferred<VerificationResult>()
  let innerSignal: AbortSignal | undefined
  jest
    .spyOn(SDKEvidenceVerifier.prototype, 'verify')
    .mockImplementation(async (_candidate, _context, signal) => {
      innerSignal = signal
      return await release.promise
    })
  const verifier = new RevenueListingLineageVerifier(family, chains, {
    timeoutMs: limits.timeoutMs
  })
  const c = context()
  c.limits.deadline = String(Number(c.now) + limits.deadlineSeconds)
  let result: unknown
  const pending = verifier.verify(packet, c).then(value => {
    result = value
  })
  try {
    await jest.advanceTimersByTimeAsync(1)
    expect(innerSignal).toBeDefined()
    expect(result).toBeUndefined()
    await jest.advanceTimersByTimeAsync(limits.expires - 1)
    expect(result).toEqual({ status: 'limited', dependencies: [] })
    expect(innerSignal?.aborted).toBe(true)
    expect(getEventListeners(innerSignal!, 'abort')).toHaveLength(0)
  } finally {
    release.resolve(outcome())
    await jest.runAllTimersAsync()
    await pending
  }
  expect(jest.getTimerCount()).toBe(0)
})

it('rechecks the absolute deadline after evidence completes even before timer delivery', async () => {
  const now = Math.floor(Date.now() / 1000) * 1000
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now)
  const c = context()
  c.limits.deadline = String(Number(c.now) + 1)
  jest.spyOn(SDKEvidenceVerifier.prototype, 'verify').mockImplementation(async () => {
    clock.mockReturnValue(now + 1000)
    return outcome()
  })
  expect(await new RevenueListingLineageVerifier(family, chains).verify(packet, c)).toEqual({
    status: 'limited',
    dependencies: []
  })
})

it('stops an expired request before parsing any package data', async () => {
  const now = Math.floor(Date.now() / 1000) * 1000
  jest.spyOn(Date, 'now').mockReturnValue(now)
  const c = context()
  c.now = String(now / 1000 - 1)
  c.limits.deadline = String(now / 1000)
  expect(await new RevenueListingLineageVerifier(family, chains).verify(null, c)).toEqual({
    status: 'limited',
    dependencies: []
  })
})

it('removes both listeners and its timer after ordinary completion without aborting the caller', async () => {
  jest.useFakeTimers({ now: 1700000000000 })
  const controller = new AbortController()
  let innerSignal: AbortSignal | undefined
  jest
    .spyOn(SDKEvidenceVerifier.prototype, 'verify')
    .mockImplementation(async (_candidate, _context, signal) => {
      innerSignal = signal
      return outcome()
    })
  const pending = new RevenueListingLineageVerifier(family, chains).verify(
    packet,
    context(),
    controller.signal
  )
  await jest.advanceTimersByTimeAsync(1)
  expect(await pending).toEqual({ status: 'invalid', dependencies: [] })
  expect(controller.signal.aborted).toBe(false)
  expect(innerSignal?.aborted).toBe(false)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  expect(getEventListeners(innerSignal!, 'abort')).toHaveLength(0)
  expect(jest.getTimerCount()).toBe(0)
})
