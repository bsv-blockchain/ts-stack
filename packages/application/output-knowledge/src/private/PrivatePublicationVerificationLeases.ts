import { randomUUID } from 'node:crypto'
import {
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputIdentity,
  outputPrivatePublicationRequestDigest,
  outputString,
  parseOutputChain,
  parseOutputJSON,
  parseOutputPrivatePublish,
  type OutputChain,
  type OutputPrivatePublish
} from '@bsv/sdk'
import type { VerificationContext } from '../ports.js'
import { parseVerificationContext } from '../validation.js'
import { checkOutputWork } from '../internal/BoundedOutputWork.js'

/** Structural companion to the optional Engine bridge, never a wire credential. */
export interface PrivatePublicationVerificationReference {
  id: string
  publisher: string
  requestDigest: string
  view: { chain: OutputChain }
}
interface Lease {
  reference: PrivatePublicationVerificationReference
  request: OutputPrivatePublish
  original: VerificationContext
  signal: AbortSignal
  current: () => boolean
}

/**
 * Binds each in-flight Engine call to the complete originally verified context.
 * Only installed service code issues leases after evidence/domain validation or
 * verified protected recovery. Issuing a lease does not perform those checks.
 * Keep it alive until physical admission settles, including after caller timeout.
 */
export class PrivatePublicationVerificationLeases {
  private readonly active = new Map<string, Lease>()
  private readonly extensions: readonly string[]
  private readonly maximum: number
  private readonly maximumBytes: number
  private retainedBytes = 0
  constructor(
    private readonly authority: (
      request: OutputPrivatePublish,
      publisher: string,
      original: VerificationContext
    ) => boolean,
    options: {
      maximum?: number
      maximumBytes?: number
      supportedExtensions?: readonly string[]
    } = {}
  ) {
    outputAssert(
      typeof authority === 'function' && authority.constructor.name !== 'AsyncFunction',
      'Private publication verification authority must be synchronous'
    )
    const maximum = options.maximum ?? 64
    const maximumBytes = options.maximumBytes ?? 16 * 1048576
    outputAssert(
      Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= 64 * 1048576,
      'Invalid private publication verification byte capacity'
    )
    this.maximum = maximum
    this.maximumBytes = maximumBytes
    outputAssert(
      Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 64,
      'Invalid private publication verification lease capacity'
    )
    this.extensions = [...(options.supportedExtensions ?? [])]
  }

  async run<T>(
    request: OutputPrivatePublish,
    publisher: string,
    verification: VerificationContext,
    signal: AbortSignal,
    current: () => boolean,
    operation: (reference: PrivatePublicationVerificationReference) => Promise<T>
  ): Promise<T> {
    const owned = parseOutputPrivatePublish(request, this.extensions)
    const identity = outputIdentity(publisher),
      original = parseVerificationContext(verification)
    outputAssert(
      typeof current === 'function' && current.constructor.name !== 'AsyncFunction',
      'Private publication lease guard must be synchronous'
    )
    outputAssert(
      typeof operation === 'function',
      'Private publication admission operation is required'
    )
    checkOutputWork(signal, 'Private publication verification was cancelled')
    outputAssert(
      this.active.size < this.maximum,
      'Private publication verification capacity is occupied',
      'limited'
    )
    const bytes = Buffer.byteLength(canonicalOutputJSON({ request: owned, original }))
    outputAssert(
      this.retainedBytes + bytes <= this.maximumBytes,
      'Private publication verification byte capacity is occupied',
      'limited'
    )
    const reference = {
      id: 'private-publication-verification-lease/1:' + randomUUID(),
      publisher: identity,
      requestDigest: outputPrivatePublicationRequestDigest(owned, this.extensions),
      view: { chain: structuredClone(original.view.chain) }
    }
    const lease = { reference, request: owned, original, signal, current }
    this.active.set(reference.id, lease)
    this.retainedBytes += bytes
    try {
      outputAssert(
        this.isCurrent(reference),
        'Private publication verification context changed',
        'context-changed'
      )
      const result = await operation(structuredClone(reference))
      outputAssert(
        this.isCurrent(reference),
        'Private publication verification context changed',
        'context-changed'
      )
      return result
    } finally {
      this.active.delete(reference.id)
      this.retainedBytes -= bytes
    }
  }

  /** Install this callback as the Engine bridge's synchronous isCurrent guard. */
  isCurrent(input: PrivatePublicationVerificationReference): boolean {
    const value = parseOutputJSON(canonicalOutputJSON(input, { bytes: 16384 }))
    closedOutputObject(value, ['id', 'publisher', 'requestDigest', 'view'])
    closedOutputObject(value.view, ['chain'])
    const lease = this.active.get(outputString(value.id))
    if (!lease || lease.signal.aborted) return false
    const chain = parseOutputChain(value.view.chain)
    if (
      value.publisher !== lease.reference.publisher ||
      value.requestDigest !== lease.reference.requestDigest ||
      canonicalOutputJSON(chain) !== canonicalOutputJSON(lease.reference.view.chain)
    )
      return false
    // Current local policy and full immutable chain premises remain separate from
    // the small admission reference. A copied id alone cannot supply those facts.
    if (!permitted(lease.current())) return false
    const allowed = permitted(
      this.authority(
        structuredClone(lease.request),
        lease.reference.publisher,
        structuredClone(lease.original)
      )
    )
    return allowed && !lease.signal.aborted
  }
}

/** An incorrectly installed asynchronous policy fails closed without an orphan rejection. */
function permitted(value: unknown): boolean {
  if (value instanceof Promise) {
    void value.catch(() => undefined)
    return false
  }
  return value === true
}
