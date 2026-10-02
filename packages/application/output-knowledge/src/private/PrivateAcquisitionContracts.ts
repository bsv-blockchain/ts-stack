import {
  OUTPUT_PROFILES,
  bindOutputPaidLookupChallenge,
  canonicalOutputBase,
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputString,
  outputU64,
  parseOutputChain,
  parseOutputJSON,
  parseOutputPaidLookupAcquire,
  parseOutputReleasePolicy,
  retainOutputCapability,
  restoreOutputCapability,
  type OutputCapabilityRequest,
  type OutputCapabilitySelection,
  type OutputChain,
  type OutputReleasePolicy
} from '@bsv/sdk'

export interface PrivateAcquisitionInstallation {
  chain: OutputChain
  seller: string
  baseURL: string
  service: string
  rulesDigest: string
  acceptancePolicy: OutputReleasePolicy
  maximumRequestBytes: number
  maximumResponseBytes: number
  maximumQuoteSeconds: string
  maximumRecoverySeconds: string
}
export interface PrivateAcquisitionQuoteTerms {
  satoshis: string
  derivationPrefix: string
  payableUntil: string
  /** Checked domain/Offer cutoff; generic services supply their own installed cutoff. */
  creationCutoff: string
  /** Additional domain/Offer obligation, zero when there is no such extension. */
  minimumRecoverySeconds: string
}
export type PrivateAcquisitionTrust = Pick<
  OutputCapabilityRequest,
  'maximumAgeSeconds' | 'clockSkewSeconds' | 'rules' | 'supportedExtensions'
>

function bytes(input: unknown): number {
  outputAssert(
    typeof input === 'number' && Number.isSafeInteger(input) && input > 0 && input <= 4194304,
    'Invalid installed acquisition envelope allowance'
  )
  return input
}

/** Immutable selected-host paid lookup semantics, separate from eligibility and custody. */
export class PrivateAcquisitionContracts {
  private readonly installed: PrivateAcquisitionInstallation
  private readonly request: Omit<OutputCapabilityRequest, 'now'>
  constructor(input: PrivateAcquisitionInstallation, trust: PrivateAcquisitionTrust) {
    const value = parseOutputJSON(canonicalOutputJSON(input, { bytes: 16384 }))
    closedOutputObject(value, [
      'chain',
      'seller',
      'baseURL',
      'service',
      'rulesDigest',
      'acceptancePolicy',
      'maximumRequestBytes',
      'maximumResponseBytes',
      'maximumQuoteSeconds',
      'maximumRecoverySeconds'
    ])
    this.installed = {
      chain: parseOutputChain(value.chain),
      seller: outputIdentity(value.seller),
      baseURL: canonicalOutputBase(outputString(value.baseURL)),
      service: outputString(value.service),
      rulesDigest: outputHex32(value.rulesDigest),
      acceptancePolicy: parseOutputReleasePolicy(value.acceptancePolicy),
      maximumRequestBytes: bytes(value.maximumRequestBytes),
      maximumResponseBytes: bytes(value.maximumResponseBytes),
      maximumQuoteSeconds: outputU64(value.maximumQuoteSeconds).toString(),
      maximumRecoverySeconds: outputU64(value.maximumRecoverySeconds).toString()
    }
    outputAssert(
      outputU64(this.installed.maximumQuoteSeconds) > 0n &&
        outputU64(this.installed.maximumRecoverySeconds) >= 86400n,
      'Invalid installed acquisition retention interval'
    )
    outputAssert(
      outputU64(trust.maximumAgeSeconds) > 0n,
      'Acquisition capability freshness must be positive'
    )
    outputU64(trust.clockSkewSeconds)
    this.request = {
      baseURL: this.installed.baseURL,
      identity: this.installed.seller,
      chain: structuredClone(this.installed.chain),
      service: this.installed.service,
      kind: 'lookup',
      profile: OUTPUT_PROFILES.acquisition,
      maximumAgeSeconds: trust.maximumAgeSeconds,
      clockSkewSeconds: trust.clockSkewSeconds,
      rules: new Map(trust.rules),
      supportedExtensions: [...(trust.supportedExtensions ?? [])]
    }
  }
  configuration(): PrivateAcquisitionInstallation {
    return structuredClone(this.installed)
  }
  retain(manifest: unknown, now: string): ReturnType<typeof retainOutputCapability> {
    const result = retainOutputCapability(manifest, { ...this.request, now })
    this.check(result.selection)
    return result
  }
  restore(record: unknown): OutputCapabilitySelection {
    const selection = restoreOutputCapability(record, this.request)
    this.check(selection)
    return selection
  }
  private check(selection: OutputCapabilitySelection): void {
    outputAssert(
      selection.service.rulesDigest === this.installed.rulesDigest,
      'Acquisition service rules differ from installation',
      'context-changed'
    )
    const parameters = selection.profile.parameters as {
      acceptancePolicy: OutputReleasePolicy
      recoverySeconds: string
    }
    outputAssert(
      canonicalOutputJSON(parameters.acceptancePolicy) ===
        canonicalOutputJSON(this.installed.acceptancePolicy),
      'Acquisition acceptance policy differs from installation',
      'context-changed'
    )
    outputAssert(
      outputU64(parameters.recoverySeconds) <= outputU64(this.installed.maximumRecoverySeconds) &&
        selection.profile.maxRequestBytes <= this.installed.maximumRequestBytes &&
        selection.profile.maxResponseBytes <= this.installed.maximumResponseBytes,
      'Acquisition profile exceeds installed capacity',
      'limited'
    )
  }

  /**
   * Produces an owned original quote after an installed validator supplies eligible
   * immutable terms. The owner must still reserve the exact material, envelope and
   * durable recovery capacity atomically, and recheck the cutoff before sending402.
   * An existing acquisition always recovers its saved quote instead of calling here.
   */
  prepare(
    requestInput: unknown,
    manifest: unknown,
    termsInput: PrivateAcquisitionQuoteTerms,
    nowInput: string
  ) {
    const request = parseOutputPaidLookupAcquire(requestInput, this.request.supportedExtensions)
    const terms = parseOutputJSON(canonicalOutputJSON(termsInput, { bytes: 4096 }))
    closedOutputObject(terms, [
      'satoshis',
      'derivationPrefix',
      'payableUntil',
      'creationCutoff',
      'minimumRecoverySeconds'
    ])
    const now = outputU64(nowInput),
      payable = outputU64(terms.payableUntil),
      cutoff = outputU64(terms.creationCutoff)
    outputAssert(
      now < payable &&
        payable <= cutoff &&
        payable - now <= outputU64(this.installed.maximumQuoteSeconds),
      'Acquisition construction cutoff is not eligible',
      'expired'
    )
    const retained = this.retain(manifest, now.toString())
    outputAssert(
      request.service === this.installed.service &&
        canonicalOutputJSON(request.listing.chain) === canonicalOutputJSON(this.installed.chain),
      'Acquisition request differs from installed service or chain',
      'context-changed'
    )
    canonicalOutputJSON(request, { bytes: retained.selection.profile.maxRequestBytes })
    const parameters = retained.selection.profile.parameters as { recoverySeconds: string }
    const recoverySeconds = [
      86400n,
      outputU64(parameters.recoverySeconds),
      outputU64(terms.minimumRecoverySeconds)
    ].reduce((a, b) => (a > b ? a : b))
    outputAssert(
      recoverySeconds <= outputU64(this.installed.maximumRecoverySeconds),
      'Acquisition domain recovery exceeds installed capacity',
      'limited'
    )
    const recoveryUntil = payable + recoverySeconds
    outputAssert(
      recoveryUntil <= 18446744073709551615n,
      'Acquisition recovery deadline exhausted',
      'limited'
    )
    const challenge = bindOutputPaidLookupChallenge(
      {
        version: 1,
        acquisitionId: outputPacketDigest('acquisition', {
          chain: this.installed.chain,
          seller: this.installed.seller,
          buyer: request.recipient,
          service: request.service,
          requestId: request.requestId
        }),
        requestDigest: outputPacketDigest('acquire-request', request),
        seller: this.installed.seller,
        buyer: request.recipient,
        assetId: request.assetId,
        termsDigest: request.termsDigest,
        satoshis: terms.satoshis,
        derivationPrefix: terms.derivationPrefix,
        acceptancePolicy: this.installed.acceptancePolicy,
        rulesDigest: this.installed.rulesDigest,
        payableUntil: payable.toString(),
        recoveryUntil: recoveryUntil.toString()
      },
      request,
      { seller: this.installed.seller, rulesDigest: this.installed.rulesDigest },
      this.request.supportedExtensions
    )
    canonicalOutputJSON(challenge, { bytes: retained.selection.profile.maxResponseBytes })
    return { request, challenge, capability: retained.record, selection: retained.selection }
  }
}
