import {
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputU64,
  parseOutputJSON,
  parseOutputRootEvictionRequest,
  parseOutputRootEvictionStatus,
  verifyOutputRootEvictionResult,
  type OutputRootEvictionResult,
  type OutputRootEvictionStatus
} from '@bsv/sdk'
import { BoundedOutputWork, checkOutputWork } from '../internal/BoundedOutputWork.js'
import type { RootEvictionContracts } from './RootEvictionContracts.js'
import type { RootEvictionCoordinatedStorage } from './RootEvictionCoordinatedStorage.js'
import type {
  RootEvictionCommitGuard,
  RootEvictionObservation
} from './RootEvictionCommitContext.js'
import type { RootEvictionRecoveredRequest } from './RootEvictionRecoveryStorage.js'
import type { RootEvictionHead } from './RootEvictionStorage.js'

/** Verified transport identity and selected header; neither comes from body authority. */
export interface RootEvictionCaller {
  principal: string
  capabilityDigest: string
}
export interface RootEvictionAccess {
  operation: 'submit' | 'status'
  principal: string
  requester: string
  requestId: string
}
export interface RootEvictionServiceOptions {
  journal: RootEvictionCoordinatedStorage
  contracts: RootEvictionContracts
  /** Trusted installation policy, never a request-supplied clock allowance. */
  futureClockSeconds: string
  /**
   * Installed authority supplies current policy/access/context callbacks. Status
   * permits the requester or an explicitly configured auditor; it never grants
   * decision authority. The callbacks run inside the actual journal gate.
   */
  guard(access: Readonly<RootEvictionAccess>, signal: AbortSignal): Promise<RootEvictionCommitGuard>
  sign(body: OutputRootEvictionResult, signal: AbortSignal): Promise<unknown>
  work?: { maximum?: number; perPrincipal?: number; timeoutMs?: number }
}
export interface RootEvictionServiceResponse {
  body: string
  headers: Record<string, string>
  /** Capture for the native final-enqueue companion; this is not permission to send. */
  head: RootEvictionHead
  observedAt: string
  access: RootEvictionAccess
}

const cancelled = 'Root request cancelled'
const check = (signal: AbortSignal): void => checkOutputWork(signal, cancelled)
const bytes = (text: string): number => new TextEncoder().encode(text).byteLength

function caller(input: RootEvictionCaller): RootEvictionCaller {
  closedOutputObject(input, ['principal', 'capabilityDigest'])
  return {
    principal: outputIdentity(input.principal),
    capabilityDigest: outputHex32(input.capabilityDigest)
  }
}

/**
 * Retain and sign root coordination observations. No peer decision is applied:
 * manual/advisory review remains the default. A separate evaluator, recoverable
 * scheduler, projection adapter and final transport fence complete the service.
 */
export class RootEvictionService {
  private readonly options: RootEvictionServiceOptions
  private readonly work: BoundedOutputWork
  constructor(options: RootEvictionServiceOptions) {
    outputAssert(
      options.journal.durability === 'durable',
      'Root journal must be durable',
      'unsupported'
    )
    outputU64(options.futureClockSeconds)
    this.options = { ...options }
    this.work = new BoundedOutputWork(
      {
        invalid: 'Invalid root work capacity or deadline',
        capacity: 'Root physical work capacity is full',
        cancelled,
        deadline: 'Root request deadline reached'
      },
      options.work?.maximum,
      options.work?.perPrincipal,
      options.work?.timeoutMs
    )
  }

  /**
   * Pass actual received UTF-8 text and the host's already available manifest
   * snapshot. A retry may pass undefined when discovery is unavailable: storage
   * resolves its saved selector first. New intake requires a valid manifest.
   * Durable retention precedes any caller-issued worker wake hint.
   */
  async submit(
    text: string,
    authenticated: RootEvictionCaller,
    manifest: unknown,
    signal?: AbortSignal
  ): Promise<RootEvictionServiceResponse> {
    const who = caller(authenticated)
    return await this.work.run(who.principal, signal, async active => {
      const packet = parseOutputRootEvictionRequest(parseOutputJSON(text, { bytes: 1048576 }))
      const access: RootEvictionAccess = {
        operation: 'submit',
        principal: who.principal,
        requester: packet.body.requester,
        requestId: packet.body.requestId
      }
      const guard = await this.guard(access, active)
      await this.options.journal.retainCoordinated(
        text,
        who.principal,
        {
          manifest,
          selector: who.capabilityDigest,
          futureClockSeconds: this.options.futureClockSeconds
        },
        this.options.contracts,
        guard
      )
      check(active)
      return await this.result(
        { version: 1, requester: access.requester, requestId: access.requestId },
        who,
        access,
        guard,
        text,
        active
      )
    })
  }

  async status(
    text: string,
    authenticated: RootEvictionCaller,
    signal?: AbortSignal
  ): Promise<RootEvictionServiceResponse> {
    const who = caller(authenticated)
    return await this.work.run(who.principal, signal, async active => {
      const request = parseOutputRootEvictionStatus(parseOutputJSON(text, { bytes: 1048576 }))
      const access: RootEvictionAccess = {
        operation: 'status',
        principal: who.principal,
        requester: request.requester,
        requestId: request.requestId
      }
      return await this.result(request, who, access, await this.guard(access, active), text, active)
    })
  }

  private async guard(
    access: RootEvictionAccess,
    signal: AbortSignal
  ): Promise<RootEvictionCommitGuard> {
    const guard = await this.options.guard(Object.freeze({ ...access }), signal)
    check(signal)
    // Preserve the checked journal's synchronous callback requirement when
    // adding cancellation checks around the installed callbacks.
    for (const callback of [guard.clock, guard.authorize, guard.contextCurrent])
      outputAssert(
        typeof callback === 'function' && callback.constructor.name !== 'AsyncFunction',
        'Root commit callbacks must be synchronous local functions'
      )
    return {
      expectedPolicyDigest: guard.expectedPolicyDigest,
      clock: () => {
        check(signal)
        const now = guard.clock()
        check(signal)
        return now
      },
      authorize: (head, now) => {
        check(signal)
        const authorized = guard.authorize(head, now)
        check(signal)
        return authorized
      },
      contextCurrent: (head, now) => {
        check(signal)
        const current = guard.contextCurrent(head, now)
        check(signal)
        return current
      }
    }
  }

  private async result(
    request: OutputRootEvictionStatus,
    who: RootEvictionCaller,
    access: RootEvictionAccess,
    guard: RootEvictionCommitGuard,
    text: string,
    signal: AbortSignal
  ): Promise<RootEvictionServiceResponse> {
    const observation = await this.options.journal.resultCoordinated(
      request.requester,
      request.requestId,
      who.capabilityDigest,
      this.options.contracts,
      guard
    )
    check(signal)
    outputAssert(
      bytes(text) <= observation.value.retained.contract.limits.maximumRequestBytes,
      'Root request exceeds the selected received-byte limit',
      'limited'
    )
    return await this.sign(observation, access, signal)
  }

  private async sign(
    observation: RootEvictionObservation<RootEvictionRecoveredRequest>,
    access: RootEvictionAccess,
    signal: AbortSignal
  ): Promise<RootEvictionServiceResponse> {
    const { retained, result } = observation.value
    const expected = canonicalOutputJSON(result)
    // The signer receives owned data. Compare against the pre-await observation,
    // not the mutable object it received or an otherwise valid alternate result.
    const signed = await this.options.sign(structuredClone(result), signal)
    check(signal)
    const packet = verifyOutputRootEvictionResult(signed, retained.request, retained.policyDigest)
    outputAssert(
      canonicalOutputJSON(packet.body) === expected,
      'Root signer changed the observed result'
    )
    return {
      body: canonicalOutputJSON(packet, { bytes: retained.contract.limits.maximumResponseBytes }),
      headers: {
        ...retained.contract.selection.headers,
        'content-type': 'application/json',
        'cache-control': 'private, no-store'
      },
      head: { ...observation.head },
      observedAt: observation.observedAt,
      access: { ...access }
    }
  }
}
