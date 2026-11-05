import type { Response } from 'express'
import { guardAuthenticatedResponse } from '@bsv/auth-express-middleware'
import { OUTPUT_PROFILES, OutputProtocolError } from '@bsv/sdk'
import type {
  ProposalHTTPBinding,
  ProposalHTTPCaller,
  ProposalHTTPJournal
} from './ProposalHTTPPorts.js'
import { proposalHTTPError } from './ProposalHTTPPolicy.js'

export interface ProposalResponseGuardOptions<Entry = unknown> {
  journal: ProposalHTTPJournal<Entry>
  caller: ProposalHTTPCaller
  /** Exactly one initial data binding or sanitized control packet. */
  initial: { binding: ProposalHTTPBinding<Entry> } | { error: unknown }
  authorizeControl(identity: string): boolean
  /** Locally constructed CORS/profile fields only. Candidate headers are never copied. */
  controlHeaders: Readonly<Record<string, string>>
}

/** Current record/access and native enqueue share one gate after BRC-104 signing. */
export function guardProposalResponse<Entry>(
  res: Response,
  options: ProposalResponseGuardOptions<Entry>
): void {
  const { journal, authorizeControl } = options
  const caller = { ...options.caller }
  const binding = 'binding' in options.initial ? options.initial.binding : undefined
  let control = 'error' in options.initial ? proposalHTTPError(options.initial.error) : undefined
  const controlHeaders = {
    ...options.controlHeaders,
    'content-type': 'application/json',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'x-bsv-overlay-capability': caller.capabilityDigest,
    'x-bsv-overlay-profile': OUTPUT_PROFILES.proposal
  }
  guardAuthenticatedResponse(res, async (candidate, enqueue, signal) => {
    const data = candidate.attempt === 0 && binding !== undefined
    let attempted = false
    try {
      await journal.enqueueResponse(
        { reference: data ? binding.reference : { kind: 'control' }, bytes: candidate.body },
        (entry, bytes) => {
          if (signal.aborted) return false
          if (
            candidate.identityKey !== caller.caller ||
            candidate.headers['x-bsv-overlay-capability'] !== caller.capabilityDigest ||
            candidate.headers['x-bsv-overlay-profile'] !== OUTPUT_PROFILES.proposal
          )
            throw new OutputProtocolError(
              'unauthorized',
              'Proposal response identity or selection changed'
            )
          if (data) {
            if (candidate.statusCode !== 200)
              throw new OutputProtocolError('invalid', 'Invalid proposal success status')
            return binding.validate(entry, bytes, candidate.identityKey)
          }
          return (
            control !== undefined &&
            candidate.statusCode === control.statusCode &&
            bytes.length === control.body.length &&
            bytes.every((byte, index) => byte === control!.body[index]) &&
            authorizeControl(candidate.identityKey) === true
          )
        },
        () => {
          // An exception after native enqueue starts cannot establish non-delivery.
          attempted = true
          enqueue()
          return undefined
        }
      )
      if (!attempted) throw new Error('Proposal journal did not enqueue the response.')
    } catch (error) {
      if (attempted || signal.aborted || !data) throw error
      control = proposalHTTPError(error)
      // The signer receives a copy; its candidate must not mutate the bytes
      // retained as the control authorization oracle for the second attempt.
      return { ...control, body: control.body.slice(), headers: controlHeaders }
    }
  })
}
