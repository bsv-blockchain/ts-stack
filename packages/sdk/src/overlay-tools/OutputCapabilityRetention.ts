import * as s from './OutputProtocolSchema.js'
import {
  parseOutputCapabilities,
  selectOutputCapability,
  type OutputCapabilityRequest,
  type OutputCapabilitySelection
} from './OutputCapabilities.js'
import { outputAssert } from './OutputProtocolError.js'

const maximumRetainedBytes = 524288

function retainedSchema(allowLocalHTTP = false, supportedExtensions: readonly string[] = []) {
  return s.object({
    format: s.literal('output-capability-retention/1'),
    manifest: (value: unknown) =>
      parseOutputCapabilities(value, allowLocalHTTP, supportedExtensions),
    digest: s.hex,
    kind: s.literal('lookup', 'topic', 'coordination'),
    service: s.text,
    profile: s.iri,
    selectedAt: s.u64,
    freshness: s.object({ maximumAgeSeconds: s.u64, clockSkewSeconds: s.u64 })
  })
}

/**
 * Local replay material, not a wire claim or proof of current authorization.
 * Persist atomically with the operation, in an integrity-protected local store.
 * The signature authenticates the manifest; storage protects the selection time
 * and local freshness policy. Never accept this record from a remote caller.
 */
export type OutputRetainedCapability = ReturnType<ReturnType<typeof retainedSchema>>

/** Endpoint/identity trust and installed rules are supplied again during recovery. */
export type OutputCapabilityRecoveryRequest = Omit<
  OutputCapabilityRequest,
  'now' | 'maximumAgeSeconds' | 'clockSkewSeconds'
>

/**
 * Validate a new selection at initiation time and capture an owned local record.
 * This does not persist the record, open a session, charge, submit or authorize an
 * effect. Persist it with the operation before carrying out any such effect.
 */
export function retainOutputCapability(
  input: unknown,
  request: OutputCapabilityRequest
): { record: OutputRetainedCapability; selection: OutputCapabilitySelection } {
  const selection = selectOutputCapability(input, request)
  const record = s.normalized(
    {
      format: 'output-capability-retention/1',
      manifest: selection.manifest,
      digest: selection.digest,
      kind: request.kind,
      service: selection.service.name,
      profile: selection.profile.id,
      selectedAt: request.now,
      freshness: {
        maximumAgeSeconds: request.maximumAgeSeconds,
        clockSkewSeconds: request.clockSkewSeconds
      }
    },
    retainedSchema(request.allowLocalHTTP, request.supportedExtensions),
    maximumRetainedBytes
  )
  return { record, selection }
}

/**
 * Revalidate the original contract at its recorded selection time, even after
 * manifest expiry. Current caller authorization and the operation's actual
 * recovery/session deadline must be checked separately before returning data or
 * performing an effect. This result cannot initiate a new operation using an
 * expired manifest. Endpoint/key rotation requires separately verified migration;
 * a new discovery result or redirect does not replace the saved contract.
 */
export function restoreOutputCapability(
  input: unknown,
  request: OutputCapabilityRecoveryRequest
): OutputCapabilitySelection {
  const record = s.normalized(
    input,
    retainedSchema(request.allowLocalHTTP, request.supportedExtensions),
    maximumRetainedBytes
  )
  outputAssert(
    record.kind === request.kind &&
      record.service === request.service &&
      record.profile === request.profile,
    'Retained capability selection changed',
    'context-changed'
  )
  const selection = selectOutputCapability(record.manifest, {
    ...request,
    now: record.selectedAt,
    ...record.freshness
  })
  outputAssert(
    selection.digest === record.digest,
    'Retained capability digest changed',
    'context-changed'
  )
  return selection
}
