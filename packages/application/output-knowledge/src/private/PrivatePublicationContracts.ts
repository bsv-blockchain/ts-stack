import {
  ownOutputJSON,
  canonicalOutputBase,
  closedOutputObject,
  OUTPUT_PROFILES,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputString,
  outputU64,
  parseOutputChain,
  retainOutputCapability,
  restoreOutputCapability,
  type OutputCapabilityRequest,
  type OutputCapabilitySelection,
  type OutputChain
} from '@bsv/sdk'

export interface PrivatePublicationInstallation {
  chain: OutputChain
  seller: string
  baseURL: string
  service: string
  topic: string
  rulesDigest: string
  maximumPrivateBytes: number
  schemas: readonly string[]
}
export type PrivatePublicationTrust = Pick<
  OutputCapabilityRequest,
  'maximumAgeSeconds' | 'clockSkewSeconds' | 'rules' | 'supportedExtensions'
>

/** Fixed local publication contract; neither authentication nor a storage record. */
export class PrivatePublicationContracts {
  private readonly request: Omit<OutputCapabilityRequest, 'now'>
  private readonly installed: PrivatePublicationInstallation

  constructor(input: PrivatePublicationInstallation, trust: PrivatePublicationTrust) {
    const value = ownOutputJSON(input, { bytes: 16384 }).value
    closedOutputObject(value, [
      'chain',
      'seller',
      'baseURL',
      'service',
      'topic',
      'rulesDigest',
      'maximumPrivateBytes',
      'schemas'
    ])
    outputAssert(
      typeof value.maximumPrivateBytes === 'number' &&
        Number.isSafeInteger(value.maximumPrivateBytes) &&
        value.maximumPrivateBytes > 0 &&
        value.maximumPrivateBytes <= 1048576,
      'Invalid installed private capacity'
    )
    outputAssert(
      Array.isArray(value.schemas) && value.schemas.length > 0 && value.schemas.length <= 32,
      'Invalid installed private schemas'
    )
    const schemas = value.schemas.map(schema => outputString(schema))
    outputAssert(new Set(schemas).size === schemas.length, 'Duplicate installed private schema')
    this.installed = {
      chain: parseOutputChain(value.chain),
      seller: outputIdentity(value.seller),
      baseURL: canonicalOutputBase(outputString(value.baseURL)),
      service: outputString(value.service),
      topic: outputString(value.topic),
      rulesDigest: outputHex32(value.rulesDigest),
      maximumPrivateBytes: value.maximumPrivateBytes,
      schemas
    }
    outputAssert(
      outputU64(trust.maximumAgeSeconds) > 0n,
      'Publication capability freshness must be positive'
    )
    outputU64(trust.clockSkewSeconds)
    this.request = {
      baseURL: this.installed.baseURL,
      identity: this.installed.seller,
      chain: structuredClone(this.installed.chain),
      service: this.installed.service,
      kind: 'topic',
      profile: OUTPUT_PROFILES.publication,
      maximumAgeSeconds: trust.maximumAgeSeconds,
      clockSkewSeconds: trust.clockSkewSeconds,
      rules: new Map(trust.rules),
      supportedExtensions: [...(trust.supportedExtensions ?? [])]
    }
  }

  configuration(): PrivatePublicationInstallation {
    return structuredClone(this.installed)
  }

  /** Called at initiation; storage must retain record before any admission effect. */
  retain(manifest: unknown, now: string): ReturnType<typeof retainOutputCapability> {
    const result = retainOutputCapability(manifest, { ...this.request, now })
    this.check(result.selection)
    return result
  }

  /** Recorded selection time is replayed; current authority remains a separate gate. */
  restore(record: unknown): OutputCapabilitySelection {
    const selection = restoreOutputCapability(record, this.request)
    this.check(selection)
    return selection
  }

  private check(selection: OutputCapabilitySelection): void {
    outputAssert(
      selection.service.rulesDigest === this.installed.rulesDigest,
      'Publication service rules differ from installation',
      'context-changed'
    )
    const parameters = selection.profile.parameters as {
      maxPrivateBytes: number
      schemas: string[]
    }
    outputAssert(
      parameters.maxPrivateBytes <= this.installed.maximumPrivateBytes,
      'Publication profile exceeds installed private capacity',
      'limited'
    )
    outputAssert(
      parameters.schemas.every(schema => this.installed.schemas.includes(schema)),
      'Publication profile selects an uninstalled schema',
      'unsupported'
    )
  }
}
