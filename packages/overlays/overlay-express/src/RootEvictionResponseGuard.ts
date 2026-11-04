import type { Response } from 'express'
import { guardAuthenticatedResponse } from '@bsv/auth-express-middleware'
import {
  canonicalOutputJSON,
  OutputProtocolError,
  outputServiceErrorHTTPStatus,
  type OutputRootEvictionTarget,
  type OutputServiceError
} from '@bsv/sdk'

type ServingTarget = Pick<OutputRootEvictionTarget, 'service' | 'outpoint' | 'advertisementDigest'>

/** Structural companion port; the transport does not import a particular database. */
export interface RootAdvertisementSendJournal {
  head(): Promise<{ revision: string }>
  enqueue(
    candidate: { revision: string; targets: ServingTarget[]; bytes: Uint8Array },
    authorize: () => boolean,
    enqueue: (bytes: Uint8Array) => undefined
  ): Promise<void>
}

export interface RootAdvertisementResponseGuard {
  journal: RootAdvertisementSendJournal
  /** Capture before reading or hydrating the complete response. */
  revision: string
  /** Every disclosed advertisement, including references disclosed in headers. */
  targets: readonly ServingTarget[]
  /**
   * Runs synchronously under the journal's shared decision/send gate. Access
   * writers must use that same gate or an explicitly coherent local policy port.
   * Control permission authorizes only the sanitized, empty-target error.
   */
  authorize(identityKey: string, kind: 'data' | 'control'): boolean
  /** Complete safe CORS/profile headers for an error; candidate headers are never copied. */
  controlHeaders: Readonly<Record<string, string>>
}

function controlError(error: unknown): OutputServiceError | undefined {
  if (!(error instanceof OutputProtocolError)) return undefined
  if (error.code === 'reset-required')
    return {
      version: 1,
      error: { code: 'reset-required', message: 'Serving state changed', retryable: false }
    }
  if (error.code === 'unauthorized')
    return {
      version: 1,
      error: { code: 'not-found', message: 'Response unavailable', retryable: false }
    }
  if (error.code === 'unavailable')
    return {
      version: 1,
      error: { code: 'unavailable', message: 'Service unavailable', retryable: error.retryable }
    }
  return undefined
}

/**
 * Install after authentication and before sending. Hydration and signing finish
 * outside the root lock; actual native enqueue and current access/target checks
 * happen together inside it. A stale snapshot/live replay is reset in full.
 * This companion does not infer the response's target inventory or mount routes.
 */
export function guardRootAdvertisementResponse(
  res: Response,
  options: RootAdvertisementResponseGuard
): void {
  const { journal, revision, authorize } = options
  const targets = options.targets.map(target => ({
    service: target.service,
    advertisementDigest: target.advertisementDigest,
    outpoint: { ...target.outpoint, chain: { ...target.outpoint.chain } }
  }))
  const controlHeaders = {
    ...options.controlHeaders,
    'content-type': 'application/json',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff'
  }
  let controlRevision: string | undefined
  guardAuthenticatedResponse(res, async (candidate, enqueue, signal) => {
    const selectedRevision = candidate.attempt === 0 ? revision : controlRevision
    if (selectedRevision === undefined) throw new Error('Missing root control-response fence.')
    let queued = false
    try {
      await journal.enqueue(
        {
          revision: selectedRevision,
          targets: candidate.attempt === 0 ? targets : [],
          bytes: candidate.body
        },
        () =>
          !signal.aborted &&
          authorize(candidate.identityKey, candidate.attempt === 0 ? 'data' : 'control'),
        () => {
          enqueue()
          queued = true
          return undefined
        }
      )
      if (!queued) throw new Error('Root journal did not enqueue the response.')
      return
    } catch (error) {
      if (queued || signal.aborted || candidate.attempt !== 0) throw error
      const packet = controlError(error)
      if (packet === undefined) throw error
      // The replacement is signed asynchronously and then checked again under
      // the same gate. Another change before that enqueue closes the response.
      controlRevision = (await journal.head()).revision
      return {
        statusCode: outputServiceErrorHTTPStatus(packet.error.code),
        headers: controlHeaders,
        body: new TextEncoder().encode(canonicalOutputJSON(packet, { bytes: 4096 }))
      }
    }
  })
}
