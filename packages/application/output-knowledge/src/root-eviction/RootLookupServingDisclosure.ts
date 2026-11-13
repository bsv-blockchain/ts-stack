import { outputAssert } from '@bsv/sdk'
import {
  RootAdvertisementServing,
  rootLookupAdvertisementTargets
} from './RootAdvertisementServing.js'

/** Structural transport port: no dependency on Express or a particular lookup backend. */
export interface RootLookupServingCaller {
  principal: string | null
  capabilityDigest: string
}
export interface RootLookupServingBinding {
  enqueue(
    bytes: Uint8Array,
    identity: string,
    enqueue: (bytes: Uint8Array) => undefined,
    signal: AbortSignal
  ): Promise<void>
}
export interface RootLookupServingDelegate {
  bind(
    operation: 'open' | 'read',
    body: string,
    caller: RootLookupServingCaller
  ): RootLookupServingBinding
  control(body: string, caller: RootLookupServingCaller): RootLookupServingBinding
}
export interface RootLookupServingDisclosureOptions {
  disclosure: RootLookupServingDelegate
  serving: RootAdvertisementServing
  /** Installed synchronous current authorization; request fields never establish it. */
  authorize(identity: string, kind: 'data' | 'control'): boolean
  supportedExtensions?: readonly string[]
}

/**
 * After asynchronous BRC-104 signing, the provider enters its native session gate;
 * its actual synchronous send callback then enters the independent root gate.
 * Both owners hold their fences at physical enqueue. Projection never takes these
 * locks in reverse order. A stale full batch is rejected, allowing the existing
 * HTTP guard to sign an identifier-free reset and fence it again as control.
 */
export class RootLookupServingDisclosure implements RootLookupServingDelegate {
  private readonly options: RootLookupServingDisclosureOptions
  private readonly bindMethod: RootLookupServingDelegate['bind']
  private readonly controlMethod: RootLookupServingDelegate['control']
  constructor(options: RootLookupServingDisclosureOptions) {
    outputAssert(
      typeof options.authorize === 'function' &&
        options.authorize.constructor.name !== 'AsyncFunction',
      'Root lookup authority must be synchronous'
    )
    this.options = { ...options, supportedExtensions: [...(options.supportedExtensions ?? [])] }
    this.bindMethod = options.disclosure.bind
    this.controlMethod = options.disclosure.control
  }
  bind(
    operation: 'open' | 'read',
    body: string,
    caller: RootLookupServingCaller
  ): RootLookupServingBinding {
    this.current()
    const targets = rootLookupAdvertisementTargets(body, this.options.supportedExtensions)
    return this.wrap(
      body,
      this.bindMethod.call(this.options.disclosure, operation, body, { ...caller }),
      targets,
      'data'
    )
  }
  control(body: string, caller: RootLookupServingCaller): RootLookupServingBinding {
    this.current()
    return this.wrap(
      body,
      this.controlMethod.call(this.options.disclosure, body, { ...caller }),
      [],
      'control'
    )
  }
  private current(): void {
    outputAssert(
      this.options.disclosure.bind === this.bindMethod &&
        this.options.disclosure.control === this.controlMethod,
      'Root lookup disclosure owner changed',
      'unavailable'
    )
  }
  private wrap(
    body: string,
    delegate: RootLookupServingBinding,
    targets: Parameters<RootAdvertisementServing['bind']>[1],
    kind: 'data' | 'control'
  ): RootLookupServingBinding {
    const bound = this.options.serving.bind(new TextEncoder().encode(body), targets),
      enqueue = delegate.enqueue
    return Object.freeze({
      enqueue: async (
        bytes: Uint8Array,
        identity: string,
        send: (bytes: Uint8Array) => undefined,
        signal: AbortSignal
      ) => {
        this.current()
        outputAssert(
          delegate.enqueue === enqueue,
          'Root lookup disclosure owner changed',
          'unavailable'
        )
        let attempted = false
        await enqueue.call(
          delegate,
          bytes,
          identity,
          owned => {
            this.current()
            outputAssert(!attempted, 'Root lookup delegate already enqueued', 'conflict')
            attempted = true
            bound.enqueue(
              owned,
              () =>
                !signal.aborted &&
                this.options.authorize(identity, kind) === true &&
                !signal.aborted,
              send
            )
            return undefined
          },
          signal
        )
        outputAssert(attempted, 'Root lookup delegate did not enqueue', 'unavailable')
      }
    })
  }
}
