import type {
  LookupAnswer,
  LookupFacilitatorAnswer,
  LookupQuestion,
  OverlayLookupFacilitator
} from './LookupResolver.js'
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
    super(reason === 'malformed' ? 'Malformed lookup response' : 'Invalid lookup response')
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
export function withinDeadline<T>(
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
      reject(new Error('Request timed out'))
    }
    timer = setTimeout(abort, Math.max(0, ms))
    if (parent?.aborted === true) abort()
    else parent?.addEventListener('abort', abort, { once: true })
  })
  const pending = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw new Error('Lookup cancelled')
    return work(controller.signal)
  })
  return Promise.race([pending, deadline]).finally(() => {
    clearTimeout(timer)
    parent?.removeEventListener('abort', abort)
    controller.abort()
  })
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

/** Non-retryable HTTP rejection, shared by transport and host accounting. */
export function isLookupRejection(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status)
}

function failureReason(error: unknown): HostFailureReason {
  if (error instanceof LookupValidationError) return error.reason
  if (error instanceof Error && /deadline|timed out|abort/i.test(error.message)) return 'timeout'
  if (error instanceof SyntaxError) return 'malformed'
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = Number(error.status)
    return isLookupRejection(status) ? 'rejected' : 'transport'
  }
  return 'transport'
}

export function requestReliableHost<T>(
  facilitator: OverlayLookupFacilitator,
  context: { reputation: ReliableHostReputation; network: string },
  host: string,
  question: LookupQuestion,
  options: Omit<ReliableLookupOptions<T>, 'validate'> & {
    validate: (answer: LookupFacilitatorAnswer, signal: AbortSignal) => T[] | Promise<T[]>
    credit?: (values: T[]) => boolean
    onError?: (error: unknown) => void
    penalizeRejections?: boolean
  },
  remainingMs: number,
  parent: AbortSignal
): Promise<ReliableHostOutcome<T>> {
  const { reputation, network } = context
  const budget = Math.min(boundedMs(options.hostTimeoutMs, 2000), remainingMs)
  return withinDeadline(
    signal =>
      Promise.resolve(facilitator.lookup(host, question, budget, signal)).then(answer =>
        options.validate(answer, signal)
      ),
    budget,
    parent
  )
    .then((values): ReliableHostOutcome<T> => {
      if (!parent.aborted && options.credit?.(values) !== false)
        void reputation.record(network, question.service, host)
      return { host, kind: 'answer', values }
    })
    .catch((error): ReliableHostOutcome<T> => {
      options.onError?.(error)
      const reason = failureReason(error)
      // Cancellation belongs to the operation, not to the host.
      if (
        !parent.aborted &&
        !(error instanceof LookupValidationUnavailableError) &&
        !(reason === 'rejected' && options.penalizeRejections === false)
      )
        void reputation.record(network, question.service, host, reason)
      return { host, kind: reason }
    })
}
