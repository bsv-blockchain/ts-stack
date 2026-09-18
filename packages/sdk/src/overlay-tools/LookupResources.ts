/** Operational client limits, not BEEF validity or service authority rules. */
export interface LookupLimits {
  maxHosts: number
  maxHostsPerTracker: number
  maxTrackers: number
  hostConcurrency: number
  trackerConcurrency: number
  maxResponseBytes: number
  maxTotalBytes: number
  maxOutputs: number
  maxEvidenceOutputs: number
  maxEvidenceBytes: number
}

/** Finite defaults; applications with larger proofs can raise these explicitly. */
export const DEFAULT_LOOKUP_LIMITS: Readonly<LookupLimits> = Object.freeze({
  maxHosts: 256,
  maxHostsPerTracker: 64,
  maxTrackers: 16,
  hostConcurrency: 8,
  trackerConcurrency: 4,
  maxResponseBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxOutputs: 4096,
  maxEvidenceOutputs: 512,
  maxEvidenceBytes: 16 * 1024 * 1024
})

export class LookupResourceLimitError extends Error {
  constructor(readonly limit: string) {
    super(`Lookup resource limit reached: ${limit}`)
    this.name = 'LookupResourceLimitError'
  }
}

export function lookupLimits(...overrides: Array<Partial<LookupLimits> | undefined>): LookupLimits {
  const limits = Object.assign({}, DEFAULT_LOOKUP_LIMITS, ...overrides)
  for (const [name, value] of Object.entries(limits)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`Lookup limit ${name} must be a positive safe integer`)
    }
  }
  return limits
}

/** Preserve distinct paths and ports; remove only a final slash and URL fragments. */
export function normalizeLookupHost(host: string, allowParameters: boolean = false): string | null {
  if (typeof host !== 'string' || host.length > 2048) return null
  try {
    const url = new URL(host)
    if (!['https:', 'http:'].includes(url.protocol) || url.username !== '' || url.password !== '') return null
    // A query/fragment has no defined meaning before the /lookup route suffix.
    if (!allowParameters && (url.search !== '' || url.hash !== '')) return null
    return url.href.replace(/\/$/, '')
  } catch {
    return null
  }
}

export function lookupAbortError(): Error {
  const error = new Error('Lookup cancelled')
  error.name = 'AbortError'
  return error
}

/** A non-cooperative transport cannot retain a cancelled waiter. */
export async function withLookupAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return await work
  if (signal.aborted) {
    void work.catch(() => {})
    throw lookupAbortError()
  }
  let abort = (): void => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(lookupAbortError())
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([work, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
