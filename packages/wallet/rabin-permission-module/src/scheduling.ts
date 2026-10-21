/**
 * Cooperative scheduling for the expensive Rabin computations. The arithmetic in `rabin.ts` is
 * written as generators that pause at fine-grained points (a few dozen exponent bits, a few sieve
 * candidates). `runSync` drives one to completion; `runCooperatively` returns control to the event
 * loop whenever the current slice has used its time budget, so a host UI stays responsive while
 * producing exactly the same result.
 */

/** A computation that pauses (yields) at points where it may be suspended. */
export type Steps<T> = Generator<void, T, void>

/** Drives a computation to completion on the current thread. */
export function runSync<T>(steps: Steps<T>): T {
  for (;;) {
    const result = steps.next()
    if (result.done === true) return result.value
  }
}

interface MessageChannelLike {
  port1: { onmessage: ((event: unknown) => void) | null; unref?: () => void }
  port2: { postMessage: (message: unknown) => void; unref?: () => void }
}

let channel: MessageChannelLike | undefined
const channelWaiters: Array<() => void> = []

function viaMessageChannel(Channel: new () => MessageChannelLike): Promise<void> {
  if (channel === undefined) {
    channel = new Channel()
    channel.port1.onmessage = () => channelWaiters.shift()?.()
    // In Node an open port would keep the process alive.
    channel.port1.unref?.()
    channel.port2.unref?.()
  }
  const port = channel.port2
  return new Promise(resolve => {
    channelWaiters.push(resolve)
    port.postMessage(null)
  })
}

/**
 * Returns control to the event loop: `scheduler.yield()` where available (browsers, Electron);
 * in Node `setImmediate`; otherwise a MessageChannel message, else `setImmediate`. Never
 * `setTimeout`, which browsers clamp to at least 4 ms and throttle in background tabs. Node is
 * special-cased because a Node MessagePort keeps delivering messages posted from its own handler,
 * which starves `setImmediate` callbacks and I/O for the whole computation.
 */
export async function yieldToEventLoop(): Promise<void> {
  const host = globalThis as unknown as {
    scheduler?: { yield?: () => Promise<void> }
    MessageChannel?: new () => MessageChannelLike
    setImmediate?: (callback: () => void) => unknown
    process?: { versions?: { node?: string } }
  }
  const viaImmediate = (setImmediateFn: (callback: () => void) => unknown) =>
    new Promise<void>(resolve => setImmediateFn(resolve))
  if (typeof host.scheduler?.yield === 'function') {
    await host.scheduler.yield()
  } else if (
    typeof host.setImmediate === 'function' &&
    typeof host.process?.versions?.node === 'string'
  ) {
    await viaImmediate(host.setImmediate)
  } else if (typeof host.MessageChannel === 'function') {
    await viaMessageChannel(host.MessageChannel)
  } else if (typeof host.setImmediate === 'function') {
    await viaImmediate(host.setImmediate)
  } else {
    await Promise.resolve()
  }
}

export interface CooperativeOptions {
  /** Work per slice before control returns to the event loop. Defaults to 4 ms. */
  budgetMs?: number
  /** Receives the duration of every slice, for measurement. */
  onSlice?: (milliseconds: number) => void
  /** Checked after every yield; when it returns true the computation is abandoned. */
  isCancelled?: () => boolean
  /** The error a cancelled computation rejects with. */
  cancelledError?: () => Error
}

const DEFAULT_BUDGET_MS = 4

/** Milliseconds on a monotonic clock where the host has one (immune to wall-clock changes). */
export const monotonicNow = (): number => globalThis.performance?.now() ?? Date.now()

const now = monotonicNow

/** Drives a computation in slices of about `budgetMs`, yielding to the event loop in between. */
export async function runCooperatively<T>(
  steps: Steps<T>,
  options: CooperativeOptions = {}
): Promise<T> {
  const budget = options.budgetMs ?? DEFAULT_BUDGET_MS
  let sliceStart = now()
  for (;;) {
    const result = steps.next()
    const elapsed = now() - sliceStart
    if (result.done === true) {
      options.onSlice?.(elapsed)
      return result.value
    }
    if (elapsed < budget) continue
    options.onSlice?.(elapsed)
    await yieldToEventLoop()
    if (options.isCancelled?.() === true) {
      steps.return(undefined as never)
      throw options.cancelledError?.() ?? new Error('RABIN: computation cancelled')
    }
    sliceStart = now()
  }
}

/**
 * The drivers the module calls, held in an object so a host's tests can observe them (an ES module
 * namespace cannot be patched).
 */
export const drivers = { runCooperatively }
