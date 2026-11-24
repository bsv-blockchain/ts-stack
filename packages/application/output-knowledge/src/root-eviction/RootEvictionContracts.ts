import {
  canonicalOutputBase,
  OUTPUT_PROFILES,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputString,
  outputU64,
  retainOutputCapability,
  restoreOutputCapability,
  type OutputCapabilityRequest,
  type OutputCapabilitySelection,
  type OutputRetainedCapability
} from '@bsv/sdk'

export type RootEvictionCapabilityTrust = Pick<
  OutputCapabilityRequest,
  | 'baseURL'
  | 'identity'
  | 'chain'
  | 'maximumAgeSeconds'
  | 'clockSkewSeconds'
  | 'rules'
  | 'supportedExtensions'
>

/** The selected manifest may narrow, but never expand, BRC-199 bounds. */
export interface RootEvictionContractLimits {
  maximumTargets: number
  maximumLifetimeSeconds: string
  maximumRequestBytes: number
  maximumResponseBytes: number
}
export interface RootEvictionSelectedContract {
  selection: OutputCapabilitySelection
  limits: RootEvictionContractLimits
}

/**
 * Explicit BRC-194 selection for the one root coordination service. This checks
 * the contract, not current requester privilege, evidence or restoration rights.
 * The caller must persist record atomically with first request intake. Recovery
 * resolves that original local record before consulting current discovery.
 */
export class RootEvictionContracts {
  private readonly request: Omit<OutputCapabilityRequest, 'now'>

  constructor(trust: RootEvictionCapabilityTrust) {
    outputAssert(
      outputU64(trust.maximumAgeSeconds) > 0n,
      'Root capability freshness must be positive'
    )
    outputU64(trust.clockSkewSeconds)
    this.request = {
      baseURL: canonicalOutputBase(trust.baseURL),
      identity: outputIdentity(trust.identity),
      chain: {
        network: outputString(trust.chain.network),
        genesisHash: outputHex32(trust.chain.genesisHash)
      },
      maximumAgeSeconds: trust.maximumAgeSeconds,
      clockSkewSeconds: trust.clockSkewSeconds,
      rules: new Map(trust.rules),
      supportedExtensions: [...(trust.supportedExtensions ?? [])],
      kind: 'coordination',
      service: 'root-advertisements',
      profile: OUTPUT_PROFILES.eviction
    }
  }

  /** New operations only: now is sampled at the actual intake decision gate. */
  retain(
    manifest: unknown,
    selector: string,
    now: string
  ): RootEvictionSelectedContract & { record: OutputRetainedCapability } {
    const retained = retainOutputCapability(manifest, { ...this.request, now })
    return { record: retained.record, ...this.selected(retained.selection, selector) }
  }

  /** Exact retained selector only; a new manifest does not silently alias it. */
  restore(record: unknown, selector: string): RootEvictionSelectedContract {
    return this.selected(restoreOutputCapability(record, this.request), selector)
  }

  private selected(
    selection: OutputCapabilitySelection,
    selector: string
  ): RootEvictionSelectedContract {
    outputAssert(
      selection.digest === outputHex32(selector),
      'Use the retained root capability selector',
      'context-changed'
    )
    const profile = selection.profile
    const lifetime = outputU64(profile.parameters.maxLifetimeSeconds as string)
    const limits = {
      maximumTargets: Math.min(64, profile.parameters.maxTargets as number),
      maximumLifetimeSeconds: (lifetime < 86400n ? lifetime : 86400n).toString(),
      maximumRequestBytes: Math.min(1048576, profile.maxRequestBytes),
      maximumResponseBytes: Math.min(1048576, profile.maxResponseBytes)
    }
    return { selection, limits }
  }
}
