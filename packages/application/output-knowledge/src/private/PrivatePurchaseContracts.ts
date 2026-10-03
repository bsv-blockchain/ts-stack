import {
  OUTPUT_PROFILES,
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
  parseOutputPurchaseTerms,
  parseOutputPurchasePrepare,
  parseOutputReleasePolicy,
  restoreOutputCapability,
  retainOutputCapability,
  verifyOutputPurchaseTerms,
  type OutputCapabilityRequest,
  type OutputCapabilitySelection,
  type OutputChain,
  type OutputPurchasePrepare,
  type OutputPurchaseTerms,
  type OutputReleasePolicy,
  type OutputRetainedCapability,
  type OutputSignedPurchaseTerms
} from '@bsv/sdk'

export interface PrivatePurchaseInstallation {
  chain: OutputChain
  seller: string
  baseURL: string
  topic: string
  rulesDigest: string
  releasePolicy: OutputReleasePolicy
  domainProfile: string
  domainSchema: string
  maximumRequestBytes: number
  maximumResponseBytes: number
  maximumPurchaseSeconds: string
  maximumRecoverySeconds: string
}
export type PrivatePurchaseTrust = Pick<
  OutputCapabilityRequest,
  'maximumAgeSeconds' | 'clockSkewSeconds' | 'rules' | 'supportedExtensions'
>
/** Supplied by an installed domain after verifying listing authority and private readiness. */
export interface PrivatePurchasePreparationTerms {
  domainEvidence: { schema: string; bytes: string }
  purchaseUntil: string
  creationCutoff: string
  minimumRecoverySeconds: string
}
export interface PrivatePurchasePreparedContract {
  request: OutputPurchasePrepare
  body: OutputPurchaseTerms
  capability: OutputRetainedCapability
  createdAt: string
}
export interface PrivatePurchaseOriginal {
  format: 'private-purchase-original/1'
  request: OutputPurchasePrepare
  terms: OutputSignedPurchaseTerms
  capability: OutputRetainedCapability
  createdAt: string
}

function allowance(value: unknown): number {
  outputAssert(
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 4194304,
    'Invalid installed purchase envelope allowance'
  )
  return value
}

function installedIRI(value: unknown): string {
  const text = outputString(value)
  outputAssert(
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(text),
    'Purchase installation requires an absolute IRI'
  )
  return text
}

/**
 * Immutable selected-host purchase semantics. This neither reserves a UTXO nor
 * signs, funds, admits or releases anything. The native owner must reserve the
 * original signed terms, private material and future result capacity before
 * disclosing preparation. Its current guard rechecks the creation cutoff.
 */
export class PrivatePurchaseContracts {
  private readonly installed: PrivatePurchaseInstallation
  private readonly request: Omit<OutputCapabilityRequest, 'now'>
  constructor(input: PrivatePurchaseInstallation, trust: PrivatePurchaseTrust) {
    const value = parseOutputJSON(canonicalOutputJSON(input, { bytes: 16384 }))
    closedOutputObject(value, [
      'chain',
      'seller',
      'baseURL',
      'topic',
      'rulesDigest',
      'releasePolicy',
      'domainProfile',
      'domainSchema',
      'maximumRequestBytes',
      'maximumResponseBytes',
      'maximumPurchaseSeconds',
      'maximumRecoverySeconds'
    ])
    this.installed = {
      chain: parseOutputChain(value.chain),
      seller: outputIdentity(value.seller),
      baseURL: canonicalOutputBase(outputString(value.baseURL)),
      topic: outputString(value.topic),
      rulesDigest: outputHex32(value.rulesDigest),
      releasePolicy: parseOutputReleasePolicy(value.releasePolicy),
      domainProfile: installedIRI(value.domainProfile),
      domainSchema: installedIRI(value.domainSchema),
      maximumRequestBytes: allowance(value.maximumRequestBytes),
      maximumResponseBytes: allowance(value.maximumResponseBytes),
      maximumPurchaseSeconds: outputU64(value.maximumPurchaseSeconds).toString(),
      maximumRecoverySeconds: outputU64(value.maximumRecoverySeconds).toString()
    }
    outputAssert(
      outputU64(this.installed.maximumPurchaseSeconds) > 0n &&
        outputU64(this.installed.maximumRecoverySeconds) >= 86400n &&
        outputU64(trust.maximumAgeSeconds) > 0n,
      'Invalid installed purchase retention or freshness interval'
    )
    outputU64(trust.clockSkewSeconds)
    this.request = {
      baseURL: this.installed.baseURL,
      identity: this.installed.seller,
      chain: structuredClone(this.installed.chain),
      service: this.installed.topic,
      kind: 'topic',
      profile: OUTPUT_PROFILES.purchase,
      maximumAgeSeconds: trust.maximumAgeSeconds,
      clockSkewSeconds: trust.clockSkewSeconds,
      rules: new Map(trust.rules),
      supportedExtensions: [...(trust.supportedExtensions ?? [])]
    }
  }
  configuration(): PrivatePurchaseInstallation {
    return structuredClone(this.installed)
  }
  retain(manifest: unknown, now: string): ReturnType<typeof retainOutputCapability> {
    const retained = retainOutputCapability(manifest, { ...this.request, now })
    this.check(retained.selection)
    return retained
  }
  restore(capability: unknown): OutputCapabilitySelection {
    const selection = restoreOutputCapability(capability, this.request)
    this.check(selection)
    return selection
  }
  private check(selection: OutputCapabilitySelection): void {
    const parameters = selection.profile.parameters as {
      recoverySeconds: string
      releasePolicies: OutputReleasePolicy[]
      domainProfiles: string[]
    }
    outputAssert(
      selection.service.rulesDigest === this.installed.rulesDigest &&
        parameters.domainProfiles.includes(this.installed.domainProfile) &&
        parameters.releasePolicies.some(
          policy =>
            canonicalOutputJSON(policy) === canonicalOutputJSON(this.installed.releasePolicy)
        ),
      'Purchase rules, domain or release policy differs from installation',
      'context-changed'
    )
    outputAssert(
      outputU64(parameters.recoverySeconds) <= outputU64(this.installed.maximumRecoverySeconds) &&
        selection.profile.maxRequestBytes <= this.installed.maximumRequestBytes &&
        selection.profile.maxResponseBytes <= this.installed.maximumResponseBytes,
      'Purchase profile exceeds installed capacity',
      'limited'
    )
  }
  prepare(
    requestInput: unknown,
    manifest: unknown,
    termsInput: PrivatePurchasePreparationTerms,
    nowInput: string
  ): PrivatePurchasePreparedContract {
    const request = parseOutputPurchasePrepare(requestInput),
      terms = parseOutputJSON(canonicalOutputJSON(termsInput)),
      now = outputU64(nowInput)
    closedOutputObject(terms, [
      'domainEvidence',
      'purchaseUntil',
      'creationCutoff',
      'minimumRecoverySeconds'
    ])
    closedOutputObject(terms.domainEvidence, ['schema', 'bytes'])
    const purchaseUntil = outputU64(terms.purchaseUntil),
      cutoff = outputU64(terms.creationCutoff),
      retained = this.retain(manifest, now.toString())
    outputAssert(
      request.topic === this.installed.topic &&
        canonicalOutputJSON(request.listing.chain) === canonicalOutputJSON(this.installed.chain),
      'Purchase request differs from selected topic or chain',
      'context-changed'
    )
    outputAssert(
      now < purchaseUntil &&
        purchaseUntil <= cutoff &&
        purchaseUntil - now <= outputU64(this.installed.maximumPurchaseSeconds),
      'Purchase construction cutoff is not eligible',
      'expired'
    )
    outputAssert(
      terms.domainEvidence.schema === this.installed.domainSchema,
      'Purchase domain evidence schema differs',
      'context-changed'
    )
    const advertised = outputU64(
        (retained.selection.profile.parameters as { recoverySeconds: string }).recoverySeconds
      ),
      minimum = outputU64(terms.minimumRecoverySeconds)
    // Both are U64 integers: converting to Number for Math.max loses precision.
    let recovery = advertised
    if (minimum > recovery) recovery = minimum
    outputAssert(
      recovery <= outputU64(this.installed.maximumRecoverySeconds),
      'Purchase domain recovery exceeds installed capacity',
      'limited'
    )
    outputAssert(
      purchaseUntil + recovery <= 18446744073709551615n,
      'Purchase recovery deadline exhausted',
      'limited'
    )
    const bodyInput: OutputPurchaseTerms = {
      version: 1,
      acquisitionId: outputPacketDigest('purchase', {
        chain: this.installed.chain,
        seller: this.installed.seller,
        recipient: request.recipient,
        topic: request.topic,
        requestId: request.requestId
      }),
      requestDigest: outputPacketDigest('purchase-request', request),
      seller: this.installed.seller,
      recipient: request.recipient,
      topic: request.topic,
      listing: request.listing,
      assetId: request.assetId,
      termsDigest: request.termsDigest,
      domainProfile: this.installed.domainProfile,
      domainEvidence: {
        schema: this.installed.domainSchema,
        bytes: terms.domainEvidence.bytes as string
      },
      releasePolicy: structuredClone(this.installed.releasePolicy),
      purchaseUntil: purchaseUntil.toString(),
      recoveryUntil: (purchaseUntil + recovery).toString()
    }
    const body = parseOutputPurchaseTerms({ body: bodyInput, signature: '' }).body
    canonicalOutputJSON(request, { bytes: retained.selection.profile.maxRequestBytes })
    // Reserve signature framing too; every permitted BRC-77 signature fits 174 bytes.
    canonicalOutputJSON(
      { body, signature: 'A'.repeat(232) },
      { bytes: retained.selection.profile.maxResponseBytes }
    )
    return { request, body, capability: retained.record, createdAt: now.toString() }
  }
  /** Verify the signer's exact returned body before the native owner retains it. */
  authenticate(preparedInput: unknown, signedInput: unknown): PrivatePurchaseOriginal {
    const prepared = parseOutputJSON(canonicalOutputJSON(preparedInput))
    closedOutputObject(prepared, ['request', 'body', 'capability', 'createdAt'])
    const original = this.original({
      format: 'private-purchase-original/1',
      request: prepared.request,
      terms: signedInput,
      capability: prepared.capability,
      createdAt: prepared.createdAt
    })
    outputAssert(
      canonicalOutputJSON(original.terms.body) === canonicalOutputJSON(prepared.body),
      'Purchase signer changed the prepared body',
      'conflict'
    )
    return original
  }
  /** Restore original obligations without applying today's catalogue/capability expiry. */
  original(input: unknown): PrivatePurchaseOriginal {
    const value = parseOutputJSON(canonicalOutputJSON(input))
    closedOutputObject(value, ['format', 'request', 'terms', 'capability', 'createdAt'])
    outputAssert(
      value.format === 'private-purchase-original/1',
      'Unsupported purchase original',
      'unsupported'
    )
    const request = parseOutputPurchasePrepare(value.request),
      terms = verifyOutputPurchaseTerms(value.terms, request, this.installed.seller),
      selection = this.restore(value.capability),
      createdAt = outputU64(value.createdAt),
      body = terms.body,
      purchaseUntil = outputU64(body.purchaseUntil),
      interval = outputU64(body.recoveryUntil) - purchaseUntil,
      advertised = outputU64(
        (selection.profile.parameters as { recoverySeconds: string }).recoverySeconds
      )
    outputAssert(
      request.topic === this.installed.topic &&
        canonicalOutputJSON(request.listing.chain) === canonicalOutputJSON(this.installed.chain) &&
        body.domainProfile === this.installed.domainProfile &&
        body.domainEvidence.schema === this.installed.domainSchema &&
        canonicalOutputJSON(body.releasePolicy) ===
          canonicalOutputJSON(this.installed.releasePolicy),
      'Original purchase installation differs',
      'context-changed'
    )
    outputAssert(
      createdAt < purchaseUntil &&
        purchaseUntil - createdAt <= outputU64(this.installed.maximumPurchaseSeconds) &&
        interval >= advertised &&
        interval <= outputU64(this.installed.maximumRecoverySeconds),
      'Original purchase deadlines exceed its reservation',
      'context-changed'
    )
    canonicalOutputJSON(request, { bytes: selection.profile.maxRequestBytes })
    canonicalOutputJSON(terms, { bytes: selection.profile.maxResponseBytes })
    return {
      format: 'private-purchase-original/1',
      request,
      terms,
      capability: structuredClone(value.capability) as unknown as OutputRetainedCapability,
      createdAt: createdAt.toString()
    }
  }
}
