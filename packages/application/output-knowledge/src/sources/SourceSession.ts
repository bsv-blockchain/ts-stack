import {
  canonicalOutputJSON,
  outputString,
  outputU64,
  OutputProtocolError,
  parseOutputScope
} from '@bsv/sdk'
import { parseSourceBatch, parseSourceRequest } from '../validation.js'
import type { OutputScope, SourceBatch, SourceRequest } from '../ports.js'

export interface SourceBinding {
  id: string
  /** Trusted local binding. Remote data cannot change the account, chain or scope. */
  scope: OutputScope
  now?: () => number
}

/** A fixed source binding with one bounded refresh in progress, including late I/O. */
export class SourceSession {
  readonly id: string
  readonly scope: OutputScope
  readonly now: () => number
  private active = false
  private calls = 0

  constructor(binding: SourceBinding) {
    this.id = outputString(binding.id)
    this.scope = Object.freeze(parseOutputScope(binding.scope))
    Object.freeze(this.scope.chain)
    this.now = binding.now ?? Date.now
  }
  begin(input: SourceRequest, signal: AbortSignal): SourceRequest {
    const request = parseSourceRequest(input)
    if (canonicalOutputJSON(request.scope) !== canonicalOutputJSON(this.scope))
      throw new OutputProtocolError('unauthorized', 'Adapter scope differs from configured source')
    if (request.checkpoint !== undefined)
      throw new OutputProtocolError('unsupported', 'Finite source has no durable replay cursor')
    this.check(signal)
    if (this.active || this.calls !== 0)
      throw new OutputProtocolError(
        'limited',
        'Source refresh or earlier I/O is still active',
        true
      )
    this.active = true
    return request
  }
  end(): void {
    this.active = false
  }
  check(signal: AbortSignal): void {
    if (signal.aborted) throw new OutputProtocolError('cancelled', 'Source operation cancelled')
  }
  timestamp(): string {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0)
      throw new OutputProtocolError('invalid', 'Invalid source clock')
    const timestamp = String(Math.floor(value / 1000))
    outputU64(timestamp)
    return timestamp
  }
  batch(
    request: SourceRequest,
    groups: SourceBatch['groups'],
    status: SourceBatch['coverage']['status'] = 'partial'
  ): SourceBatch {
    return parseSourceBatch(
      {
        provenance: {
          partition: request.partition,
          generation: request.generation,
          adapter: this.id,
          scope: this.scope,
          authentication: 'configured-transport',
          peer: this.scope.provider,
          receivedAt: this.timestamp()
        },
        groups,
        coverage: { scope: this.scope, phase: 'finite', status }
      },
      { ...request, adapter: this.id },
      request.limits
    )
  }
  /** A timed-out non-cancellable wallet call retains its capacity until it settles. */
  async call<T>(operation: () => Promise<T>, signal: AbortSignal, deadlineMs: number): Promise<T> {
    this.check(signal)
    this.calls++
    const pending = Promise.resolve().then(() => {
      this.check(signal)
      return operation()
    })
    void pending.then(
      () => this.calls--,
      () => this.calls--
    )
    let timer: ReturnType<typeof setTimeout> | undefined, stop: (() => void) | undefined
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          stop = () => reject(new OutputProtocolError('cancelled', 'Source operation cancelled'))
          signal.addEventListener('abort', stop, { once: true })
          timer = setTimeout(
            () => reject(new OutputProtocolError('limited', 'Source operation deadline', true)),
            deadlineMs
          )
          if (signal.aborted) stop()
        })
      ])
    } finally {
      clearTimeout(timer)
      if (stop) signal.removeEventListener('abort', stop)
    }
  }
}
