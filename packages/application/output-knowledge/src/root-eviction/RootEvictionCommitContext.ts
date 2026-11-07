import { outputAssert, outputHex32, outputU64 } from '@bsv/sdk'
import type { OutputRootEvictionResult } from '@bsv/sdk'
import type {
  RootEvictionAssessment,
  RootEvictionEvaluation,
  RootEvictionHead,
  RootEvictionRetainedRequest,
  RootEvictionStorage
} from './RootEvictionStorage.js'

/**
 * Trusted local callbacks, evaluated synchronously after acquiring the journal's
 * shared commit gate. Never construct these callbacks from request data. Access
 * and chain/context writers must use that gate or an independently coherent port.
 * Callbacks may inspect local state; they must not sign, await, perform network
 * I/O, mutate state or call another journal method while holding the gate.
 */
export interface RootEvictionCommitGuard {
  expectedPolicyDigest: string
  clock(): string
  authorize(head: Readonly<RootEvictionHead>, now: string): boolean
  contextCurrent(head: Readonly<RootEvictionHead>, now: string): boolean
}

/** The exact observation used for later signing and final transport fencing. */
export interface RootEvictionObservation<T> {
  value: T
  head: RootEvictionHead
  observedAt: string
}

/** Optional companion; existing RootEvictionStorage implementations are unchanged. */
export interface RootEvictionCheckedStorage extends RootEvictionStorage {
  retainChecked(
    request: unknown,
    authenticatedRequester: string,
    window: { maximumLifetimeSeconds: string; futureClockSeconds: string },
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<RootEvictionRetainedRequest>>
  evaluateChecked(
    input: Omit<RootEvictionEvaluation, 'now'>,
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<undefined>>
  assessChecked(
    input: RootEvictionAssessment,
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<string>>
  resultChecked(
    requester: string,
    requestId: string,
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<OutputRootEvictionResult>>
}

/** Internal helper: the caller must already hold its actual database gate. */
export function rootCommitContext(head: RootEvictionHead, guard: RootEvictionCommitGuard): string {
  const selected = Object.freeze({
    revision: outputU64(head.revision).toString(),
    policyDigest: outputHex32(head.policyDigest)
  })
  const policy = outputHex32(guard.expectedPolicyDigest)
  for (const callback of [guard.clock, guard.authorize, guard.contextCurrent])
    outputAssert(
      typeof callback === 'function' && callback.constructor.name !== 'AsyncFunction',
      'Root commit callbacks must be synchronous local functions'
    )
  const now = guard.clock()
  outputU64(now)
  // Check current access before looking up a retained key or exposing the
  // difference between a stale selected policy and a missing record.
  outputAssert(guard.authorize(selected, now) === true, 'Root operation unavailable', 'not-found')
  outputAssert(
    selected.policyDigest === policy,
    'Root evaluation policy changed',
    'context-changed'
  )
  outputAssert(
    guard.contextCurrent(selected, now) === true,
    'Root evaluation context changed',
    'context-changed'
  )
  return now
}
