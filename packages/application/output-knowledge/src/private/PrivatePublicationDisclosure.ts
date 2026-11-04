import { readCurrentPrivatePublicationStatus } from './PrivatePublicationPorts.js'
import {
  canonicalOutputJSON,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputString,
  parseOutputPrivatePublicationStatus,
  parseOutputServiceError
} from '@bsv/sdk'
import { PrivatePublicationAccess } from './PrivatePublicationAccess.js'
import { PrivatePublicationContracts } from './PrivatePublicationContracts.js'
import { privatePublicationResult } from './PrivatePublicationProgress.js'
import { PrivateServiceDomain } from './PrivateServiceDomain.js'
import type {
  PrivatePublicationCaller,
  PrivatePublicationStore
} from './PrivatePublicationPorts.js'

/**
 * Preparation is not disclosure. The trusted authenticated transport signs the
 * exact body/headers, then invokes enqueue once at its actual send boundary.
 * Its callback must synchronously enqueue those signed bytes under the same
 * native policy domain; buffering before this gate is not an implementation.
 */
export class PrivatePublicationDisclosure {
  private readonly unchanged: readonly (() => boolean)[]
  constructor(
    private readonly domain: PrivateServiceDomain,
    private readonly store: Pick<
      PrivatePublicationStore,
      'loadStatus' | 'loadVerified' | 'markUnavailable'
    >,
    private readonly contracts: PrivatePublicationContracts,
    private readonly access: Pick<PrivatePublicationAccess, 'guard'>,
    private readonly clock: () => string,
    private readonly authorizeControl?: (publisher: string) => boolean
  ) {
    outputAssert(typeof clock === 'function', 'Publication disclosure clock is required')
    this.unchanged = [
      pin(domain, 'ledger'),
      pin(store, 'loadVerified'),
      pin(store, 'loadStatus'),
      pin(store, 'markUnavailable'),
      pin(contracts, 'restore'),
      pin(access, 'guard'),
      pin(domain.ledger, 'disclose'),
      pin(domain.ledger, 'read'),
      pin(domain, 'identity'),
      pin(domain.identity, 'address')
    ]
  }

  /** Fixed public errors share native serialization with current control authorization. */
  enqueueControl(input: unknown, supplied: PrivatePublicationCaller, send: () => void): void {
    const packet = parseOutputServiceError(input)
    outputAssert(
      canonicalOutputJSON(packet) ===
        canonicalOutputJSON({
          version: 1,
          error: {
            code: packet.error.code,
            message: 'Private publication request ' + packet.error.code,
            retryable: packet.error.retryable
          }
        }),
      'Private publication control must use fixed public diagnostics'
    )
    const publisher = outputIdentity(supplied.publisher),
      current = supplied.current,
      signal = supplied.signal
    outputAssert(
      typeof current === 'function' &&
        current.constructor.name !== 'AsyncFunction' &&
        typeof this.authorizeControl === 'function' &&
        this.authorizeControl.constructor.name !== 'AsyncFunction',
      'Private publication control authority must be installed and synchronous'
    )
    outputAssert(
      typeof send === 'function' && send.constructor.name !== 'AsyncFunction',
      'Publication control enqueue must be synchronous'
    )
    const guard = () => {
      outputAssert(
        !signal?.aborted &&
          this.unchanged.every(check => check()) &&
          permitted(current()) &&
          permitted(this.authorizeControl!(publisher)) &&
          !signal?.aborted,
        'Private publication control authority changed',
        'unauthorized'
      )
    }
    const address = this.domain.identity.address('rules', {
      purpose: 'private-publication-control/1'
    })
    const read = this.domain.ledger.read([address], this.clock, guard)
    this.domain.ledger.disclose(read.revision, [address], this.clock, guard, () => {
      const result: unknown = send()
      if (result instanceof Promise) void result.catch(() => undefined)
      outputAssert(result === undefined, 'Publication control enqueue must finish synchronously')
    })
  }

  prepare(input: unknown, supplied: PrivatePublicationCaller) {
    const request = parseOutputPrivatePublicationStatus(input)
    const caller = {
      publisher: outputIdentity(supplied.publisher),
      capability: outputHex32(supplied.capability),
      profile: outputString(supplied.profile),
      current: supplied.current,
      signal: supplied.signal
    }
    outputAssert(
      typeof caller.current === 'function' && caller.current.constructor.name !== 'AsyncFunction',
      'Publication disclosure requires current authenticated context'
    )
    const current = () => {
      if (caller.signal?.aborted || !this.unchanged.every(check => check())) return false
      const allowed: unknown = caller.current()
      if (allowed instanceof Promise) {
        void allowed.catch(() => undefined)
        return false
      }
      return allowed === true && !caller.signal?.aborted
    }
    const guard = this.access.guard(request.publicationId, caller.publisher, current)
    const currentStatus = readCurrentPrivatePublicationStatus(
      this.store,
      request.publicationId,
      this.clock,
      guard,
      metadata => {
        const selected = this.contracts.restore(metadata.original.capability)
        outputAssert(
          caller.capability === selected.digest && caller.profile === selected.profile.id,
          'Original publication capability selector differs',
          'context-changed'
        )
      }
    )
    outputAssert(currentStatus, 'Private publication not found', 'not-found')
    const retained = currentStatus.metadata,
      verified = currentStatus.verified
    const selection = this.contracts.restore(retained.original.capability)
    outputAssert(
      caller.capability === selection.digest && caller.profile === selection.profile.id,
      'Original publication capability selector differs',
      'context-changed'
    )
    const body = canonicalOutputJSON(privatePublicationResult(retained.fence.state), {
      bytes: selection.profile.maxResponseBytes
    })
    const headers = Object.freeze({ ...selection.headers })
    // Metadata-only non-ready responses never read or disclose unavailable private bytes.
    // Ready responses still require the full exact current relation at physical enqueue.
    const addresses = [
      { kind: retained.record.kind, key: retained.record.key },
      ...(verified
        ? [
            { kind: 'publication' as const, key: verified.fence.state.blobKey },
            { kind: verified.bindingRecord.kind, key: verified.bindingRecord.key }
          ]
        : [])
    ]
    const originalFence = canonicalOutputJSON(retained.record)
    const originalBlob = verified && canonicalOutputJSON(verified.blob)
    const originalBinding = verified && canonicalOutputJSON(verified.bindingRecord)
    let attempted = false
    return Object.freeze({
      body,
      headers,
      enqueue: (send: (body: string, headers: Readonly<Record<string, string>>) => void): void => {
        outputAssert(!attempted, 'Publication disclosure was already attempted', 'conflict')
        outputAssert(
          typeof send === 'function' && send.constructor.name !== 'AsyncFunction',
          'Publication response enqueue must be synchronous'
        )
        attempted = true
        this.domain.ledger.disclose(retained.revision, addresses, this.clock, guard, records => {
          const [fence, blob, binding] = records
          outputAssert(
            fence &&
              canonicalOutputJSON(fence) === originalFence &&
              (!verified ||
                (blob &&
                  binding &&
                  canonicalOutputJSON(blob.value) === originalBlob &&
                  canonicalOutputJSON(binding) === originalBinding)),
            'Original private publication records changed before enqueue',
            'conflict'
          )
          const result: unknown = send(body, headers)
          if (result instanceof Promise) void result.catch(() => undefined)
          outputAssert(
            result === undefined,
            'Publication response enqueue must finish synchronously'
          )
        })
      }
    })
  }
}
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const original = owner[key]
  return () => owner[key] === original
}

function permitted(value: unknown): boolean {
  if (value instanceof Promise) {
    void value.catch(() => undefined)
    return false
  }
  return value === true
}
