import {
  canonicalOutputBase,
  canonicalOutputJSON,
  closedOutputObject,
  OUTPUT_PROFILES,
  outputHex32,
  outputIdentity,
  outputString,
  outputU64,
  OutputProtocolError,
  parseOutputJSON,
  retainOutputCapability,
  restoreOutputCapability,
  type OutputCapabilityRequest,
  type OutputCapabilitySelection
} from '@bsv/sdk'
import type { ProposalPolicyDescription } from './ProposalPolicy.js'
import type { ProposalTransitions } from './ProposalTransitions.js'

export type ProposalCapabilityTrust = Pick<
  OutputCapabilityRequest,
  | 'baseURL'
  | 'identity'
  | 'maximumAgeSeconds'
  | 'clockSkewSeconds'
  | 'rules'
  | 'supportedExtensions'
>

/**
 * Binds retained signed contracts to an installed proposal lifecycle. This is
 * configuration validation, not current caller authorization or topic admission.
 * Rules validators must be installed immutable code, never remote downloads.
 */
export class ProposalCapabilityContracts {
  private readonly request: Omit<OutputCapabilityRequest, 'now'>
  private readonly configuration: ReturnType<ProposalTransitions['configuration']>

  constructor(lifecycle: ProposalTransitions, trust: ProposalCapabilityTrust) {
    this.configuration = lifecycle.configuration()
    if (outputU64(trust.maximumAgeSeconds) === 0n)
      throw new OutputProtocolError('invalid', 'Capability freshness must be positive')
    outputU64(trust.clockSkewSeconds)
    this.request = {
      baseURL: canonicalOutputBase(trust.baseURL),
      identity: outputIdentity(trust.identity),
      maximumAgeSeconds: trust.maximumAgeSeconds,
      clockSkewSeconds: trust.clockSkewSeconds,
      rules: new Map(trust.rules),
      supportedExtensions: [...(trust.supportedExtensions ?? [])],
      ...this.configuration.scope,
      kind: 'topic',
      profile: OUTPUT_PROFILES.proposal
    }
  }

  /** Validate before a new mutation; persist the returned record with its plan. */
  retain(manifest: unknown, now: string): ReturnType<typeof retainOutputCapability> {
    const retained = retainOutputCapability(manifest, { ...this.request, now })
    this.check(retained.selection)
    return retained
  }

  /** Recover the original installed contract; current access/deadlines remain separate. */
  restore(record: unknown): OutputCapabilitySelection {
    const selection = restoreOutputCapability(record, this.request)
    this.check(selection)
    return selection
  }

  /**
   * Require a signed head's exact policy to be advertised by its saved contract.
   * A policy installed on the host but omitted from this selection is not enabled.
   * Lifecycle validation must independently verify the proposal and its signature.
   */
  requirePolicy(record: unknown, reference: unknown): OutputCapabilitySelection {
    const selected = this.restore(record)
    const value = parseOutputJSON(canonicalOutputJSON(reference))
    closedOutputObject(value, ['id', 'digest'])
    outputString(value.id)
    outputHex32(value.digest)
    if (
      !this.policies(selected).some(
        policy => policy.id === value.id && policy.digest === value.digest
      )
    )
      throw new OutputProtocolError(
        'unsupported',
        'Proposal policy is not enabled by this contract'
      )
    return selected
  }

  private check(selection: OutputCapabilitySelection): void {
    if (
      selection.profile.parameters.maxLifetimeSeconds !==
      this.configuration.clock.maxLifetimeSeconds
    )
      throw new OutputProtocolError(
        'context-changed',
        'Proposal capability lifetime differs from installed lifecycle'
      )
    for (const policy of this.policies(selection)) {
      const installed = this.configuration.policies.find(candidate => candidate.id === policy.id)
      if (installed === undefined || canonicalOutputJSON(installed) !== canonicalOutputJSON(policy))
        throw new OutputProtocolError(
          'unsupported',
          'Proposal capability policy is not installed exactly'
        )
    }
  }

  private policies(selection: OutputCapabilitySelection): ProposalPolicyDescription[] {
    // The SDK's fixed proposal profile parser already checks this closed array,
    // exact policy digests and all profile bounds before either public entry.
    return selection.profile.parameters.policies as unknown as ProposalPolicyDescription[]
  }
}
