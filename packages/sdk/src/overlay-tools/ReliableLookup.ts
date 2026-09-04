import type { LookupAnswer, LookupQuestion, OverlayLookupFacilitator } from './LookupResolver.js'
import { ReliableHostReputation, type HostFailureReason } from './ReliableHostReputation.js'

export type ReliableHostOutcome<T> =
  { host: string; kind: 'answer'; values: T[] } | { host: string; kind: HostFailureReason }
export interface ReliableLookupResult<T> {
  hosts: ReliableHostOutcome<T>[]
  discoveryComplete: boolean
  durationMs: number
}
export interface ReliableLookupOptions<T> {
  /** Includes discovery, host requests and validation; default 5000 ms. */
  deadlineMs?: number
  /** Per host, including validation; default 2000 ms. */
  hostTimeoutMs?: number
  signal?: AbortSignal
  /** Must reject malformed, off-query or invalid data before returning any values. */
  validate: (answer: LookupAnswer, signal: AbortSignal) => Promise<T[]>
}
/** Validation infrastructure failed independently of the responding host. */
export class LookupValidationUnavailableError extends Error {
  constructor() {
    super('Proof validation temporarily unavailable')
    this.name = 'LookupValidationUnavailableError'
  }
}
export class LookupValidationError extends Error {
  constructor(readonly reason: 'malformed' | 'invalid') {
    super(`Lookup response ${reason}`)
    this.name = 'LookupValidationError'
  }
}
export const monotonicNow = (): number => globalThis.performance?.now() ?? Date.now()
export function boundedMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 1 || value > 30000)
    throw new RangeError('Lookup deadline must be between 1 and 30000 ms')
  return value
}

/** Races even a non-cooperative facilitator; cooperative work also receives abort. */
export async function withinDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parent?: AbortSignal
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: () => void = () => {}
  const deadline = new Promise<never>((_resolve, reject) => {
    abort = () => {
      controller.abort()
      reject(new Error('Lookup deadline exceeded'))
    }
    timer = setTimeout(abort, Math.max(0, ms))
    if (parent?.aborted === true) abort()
    else parent?.addEventListener('abort', abort, { once: true })
  })
  try {
    const pending = Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw new Error('Lookup cancelled')
      return await work(controller.signal)
    })
    return await Promise.race([pending, deadline])
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', abort)
    controller.abort()
  }
}

export function normalizeHosts(hosts: string[], allowHTTP: boolean): string[] {
  const normalized = new Set<string>()
  for (const host of hosts) {
    try {
      const url = new URL(host)
      if (url.protocol !== 'https:' && !(allowHTTP && url.protocol === 'http:')) continue
      if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
        continue
      normalized.add(url.href.replace(/\/$/, ''))
    } catch {
      /* Invalid discovery URL. */
    }
  }
  return [...normalized]
}

export async function requestReliableHost<T>(
  facilitator: OverlayLookupFacilitator,
  reputation: ReliableHostReputation,
  network: string,
  host: string,
  question: LookupQuestion,
  options: ReliableLookupOptions<T>,
  remainingMs: number,
  parent: AbortSignal
): Promise<ReliableHostOutcome<T>> {
  const budget = Math.min(boundedMs(options.hostTimeoutMs, 2000), remainingMs)
  try {
    const values = await withinDeadline(
      async signal => {
        const answer = await facilitator.lookup(host, question, budget, signal)
        if (answer?.type !== 'output-list' || !Array.isArray(answer.outputs))
          throw new LookupValidationError('malformed')
        return await options.validate(answer, signal)
      },
      budget,
      parent
    )
    if (!parent.aborted) void reputation.record(network, question.service, host)
    return { host, kind: 'answer', values }
  } catch (error) {
    let reason: HostFailureReason = 'transport'
    if (error instanceof LookupValidationError) reason = error.reason
    else if (error instanceof Error && /deadline|timed out|abort/i.test(error.message))
      reason = 'timeout'
    else if (error instanceof SyntaxError) reason = 'malformed'
    else if (typeof error === 'object' && error !== null && 'status' in error) {
      reason = Number(error.status) < 500 ? 'rejected' : 'transport'
    }
    // Cancellation belongs to the operation, not to the host.
    if (!parent.aborted && !(error instanceof LookupValidationUnavailableError))
      void reputation.record(network, question.service, host, reason)
    return { host, kind: reason }
  }
}
