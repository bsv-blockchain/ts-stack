import * as s from './OutputProtocolSchema.js'
import {
  outputPacketDigest,
  outputPacketDigestWithInlineStrings,
  outputU64,
  validateOutputExtensions,
  verifyOutputPacket,
  verifyOutputPacketWithInlineStrings,
  type OutputChain,
  type OutputSignedPacket
} from './OutputProtocol.js'
import {
  canonicalOutputJSON,
  canonicalOutputJSONWithInlineRecords as canonicalOutputJSONWithInlineStrings,
  type OutputJSONObject
} from './OutputProtocolJSON.js'
import { outputAssert } from './OutputProtocolError.js'
import { canonicalOutputBase } from './OutputEndpoint.js'

export const OUTPUT_PROFILES = Object.freeze({
  lookup: 'https://bsv.brc.dev/overlays/0193#lookup-live-v1',
  proposal: 'https://bsv.brc.dev/overlays/0194#proposal-v1',
  publication: 'https://bsv.brc.dev/overlays/0195#private-publish-v1',
  acquisition: 'https://bsv.brc.dev/overlays/0195#paid-lookup-v1',
  purchase: 'https://bsv.brc.dev/overlays/0196#steak-potatoes-v1',
  eviction: 'https://bsv.brc.dev/overlays/0199#root-eviction-v1'
} as const)

const positive: s.Schema<number> = value => {
  s.u32(value)
  outputAssert((value as number) > 0, 'Expected positive limit')
  return value as number
}
const positiveU64: s.Schema<string> = value => {
  outputAssert(outputU64(value) > 0n, 'Expected positive duration')
  return value as string
}
const release = s.tagged('kind', {
  'local-admission': s.fixedObject({ kind: s.literal('local-admission') }),
  'processor-accepted': s.fixedObject({
    kind: s.literal('processor-accepted'),
    identity: s.identity,
    policy: s.iri
  }),
  mined: s.fixedObject({ kind: s.literal('mined'), confirmations: positive })
})
export type OutputReleasePolicy = ReturnType<typeof release>

/** Representation only. Selection and trust in a processor remain explicit caller decisions. */
export function parseOutputReleasePolicy(input: unknown): OutputReleasePolicy {
  return s.normalized(input, release)
}

const profile = s.fixedObject({
  id: s.iri,
  authentication: s.literal('none', 'brc103'),
  payment: s.literal('none', 'brc105', 'covenant'),
  maxRequestBytes: positive,
  maxResponseBytes: positive,
  parameters: s.jsonMap
})
const rules = s.fixedObject({ id: s.iri, parameters: s.jsonMap })
const service = s.fixedObject({
  name: s.text,
  kind: s.literal('lookup', 'topic', 'coordination'),
  rules,
  rulesDigest: s.hex,
  profiles: s.array(profile, 32, 1)
})
const capabilities = s.fixedObject(
  {
    version: s.literal(1),
    identity: s.identity,
    baseURL: (value: unknown) => {
      outputAssert(typeof value === 'string' && value.length <= 2048, 'Invalid base URL')
      return value
    },
    chain: s.chain,
    issuedAt: s.u64,
    expiresAt: s.u64,
    services: s.array(service, 256)
  },
  s.extensions
)
const signed = s.fixedObject({ body: capabilities, signature: s.bytes })
export type OutputCapabilities = ReturnType<typeof capabilities>
export type OutputCapabilityService = ReturnType<typeof service>
export type OutputCapabilityProfile = ReturnType<typeof profile>

function unique(values: readonly unknown[]): void {
  outputAssert(
    new Set(values.map(value => canonicalOutputJSON(value))).size === values.length,
    'Duplicate capability entry'
  )
}
function privateProfile(
  p: OutputCapabilityProfile,
  owner: OutputCapabilityService,
  kind: OutputCapabilityService['kind'],
  payment: OutputCapabilityProfile['payment']
): void {
  outputAssert(
    owner.kind === kind && p.authentication === 'brc103' && p.payment === payment,
    'Invalid profile kind/authentication/payment'
  )
}
function validateProfile(p: OutputCapabilityProfile, owner: OutputCapabilityService): void {
  switch (p.id) {
    case OUTPUT_PROFILES.lookup: {
      outputAssert(owner.kind === 'lookup' && p.payment === 'none', 'Invalid live lookup profile')
      const parameters = s.fixedObject({
        replaySeconds: positiveU64,
        sessionSeconds: positiveU64,
        maxObservations: positive,
        maxWaitMs: s.u32
      })(p.parameters)
      outputAssert(p.maxResponseBytes >= 65536, 'Live profile must allow 64 KiB')
      outputAssert(
        parameters.maxObservations <= 1024 && parameters.maxWaitMs <= 25000,
        'Live profile bounds'
      )
      break
    }
    case OUTPUT_PROFILES.proposal: {
      privateProfile(p, owner, 'topic', 'none')
      const parameters = s.fixedObject({
        policies: s.array(
          s.fixedObject({ id: s.iri, digest: s.hex, parameters: s.jsonMap }),
          32,
          1
        ),
        maxLifetimeSeconds: positiveU64,
        retentionSeconds: positiveU64
      })(p.parameters)
      unique(parameters.policies.map(policy => policy.id))
      for (const policy of parameters.policies) {
        outputAssert(
          policy.digest ===
            outputPacketDigest('proposal-policy', { id: policy.id, parameters: policy.parameters }),
          'Proposal policy digest mismatch'
        )
        if (policy.id === 'https://bsv.brc.dev/overlays/0194#author-document-v1') {
          const limits = s.fixedObject({ maxTextBytes: positive })(policy.parameters)
          outputAssert(limits.maxTextBytes <= 4096, 'Document policy text bound')
        }
      }
      break
    }
    case OUTPUT_PROFILES.publication: {
      privateProfile(p, owner, 'topic', 'none')
      const parameters = s.fixedObject({
        maxPrivateBytes: positive,
        schemas: s.array(s.iri, 32, 1)
      })(p.parameters)
      unique(parameters.schemas)
      break
    }
    case OUTPUT_PROFILES.acquisition: {
      privateProfile(p, owner, 'lookup', 'brc105')
      const parameters = s.fixedObject({ recoverySeconds: positiveU64, acceptancePolicy: release })(
        p.parameters
      )
      outputAssert(
        outputU64(parameters.recoverySeconds) >= 86400n,
        'Acquisition recovery is less than one day'
      )
      break
    }
    case OUTPUT_PROFILES.purchase: {
      privateProfile(p, owner, 'topic', 'covenant')
      const parameters = s.fixedObject({
        recoverySeconds: positiveU64,
        releasePolicies: s.array(release, 32, 1),
        domainProfiles: s.array(s.iri, 32, 1)
      })(p.parameters)
      outputAssert(
        outputU64(parameters.recoverySeconds) >= 86400n,
        'Purchase recovery is less than one day'
      )
      unique(parameters.releasePolicies)
      unique(parameters.domainProfiles)
      break
    }
    case OUTPUT_PROFILES.eviction: {
      privateProfile(p, owner, 'coordination', 'none')
      outputAssert(owner.name === 'root-advertisements', 'Invalid root coordination service')
      s.fixedObject({ maxTargets: positive, maxLifetimeSeconds: positiveU64 })(p.parameters)
      break
    }
  }
}

export function parseOutputCapabilities(
  input: unknown,
  allowLocalHTTP = false,
  supportedExtensions: readonly string[] = []
): OutputSignedPacket<OutputCapabilities> {
  const result = s.normalized(input, signed, 262144)
  const body = result.body
  validateOutputExtensions(body, supportedExtensions)
  outputAssert(
    canonicalOutputBase(body.baseURL, allowLocalHTTP) === body.baseURL,
    'Manifest base URL is not canonical'
  )
  outputAssert(outputU64(body.issuedAt) <= outputU64(body.expiresAt), 'Invalid manifest lifetime')
  unique(body.services.map(item => [item.kind, item.name]))
  for (const item of body.services) {
    outputAssert(
      outputPacketDigest('service-rules', item.rules) === item.rulesDigest,
      'Service rules digest mismatch'
    )
    unique(item.profiles.map(p => p.id))
    for (const p of item.profiles) validateProfile(p, item)
  }
  return result
}

export interface OutputCapabilityRequest {
  baseURL: string
  identity: string
  chain: OutputChain
  kind: OutputCapabilityService['kind']
  service: string
  profile: string
  now: string
  maximumAgeSeconds: string
  clockSkewSeconds: string
  allowLocalHTTP?: boolean
  authenticatedPeer?: string
  /** Installed immutable rules; callbacks validate their exact parameter schema. */
  rules: ReadonlyMap<string, (parameters: OutputJSONObject) => void>
  supportedExtensions?: readonly string[]
}

export interface OutputCapabilitySelection {
  manifest: OutputSignedPacket<OutputCapabilities>
  digest: string
  service: OutputCapabilityService
  profile: OutputCapabilityProfile
  headers: { 'x-bsv-overlay-capability': string; 'x-bsv-overlay-profile': string }
}

/** Caller endpoint trust and authentication run before this explicit selection. */
export function selectOutputCapability(
  input: unknown,
  request: OutputCapabilityRequest
): OutputCapabilitySelection {
  const manifest = parseOutputCapabilities(
    input,
    request.allowLocalHTTP,
    request.supportedExtensions
  )
  const body = manifest.body
  outputAssert(
    body.baseURL === canonicalOutputBase(request.baseURL, request.allowLocalHTTP),
    'Capability base mismatch',
    'unauthorized'
  )
  outputAssert(
    body.identity === request.identity &&
      (request.authenticatedPeer === undefined || request.authenticatedPeer === body.identity),
    'Capability identity mismatch',
    'unauthorized'
  )
  outputAssert(
    canonicalOutputJSON(body.chain) === canonicalOutputJSON(request.chain),
    'Capability chain mismatch',
    'context-changed'
  )
  const now = outputU64(request.now),
    issued = outputU64(body.issuedAt)
  const skew = outputU64(request.clockSkewSeconds),
    age = outputU64(request.maximumAgeSeconds)
  outputAssert(age > 0n, 'Capability freshness must be finite and positive')
  outputAssert(now < outputU64(body.expiresAt), 'Capability expired', 'expired')
  outputAssert(
    issued <= now + skew && now <= issued + age,
    'Capability outside local freshness policy',
    'expired'
  )
  outputAssert(
    verifyOutputPacket('capabilities', manifest, request.identity),
    'Invalid capability signature',
    'unauthorized'
  )
  const selectedService = body.services.find(
    item => item.kind === request.kind && item.name === request.service
  )
  outputAssert(selectedService !== undefined, 'Required service unavailable', 'unsupported')
  const selectedProfile = selectedService.profiles.find(p => p.id === request.profile)
  outputAssert(
    selectedProfile !== undefined &&
      (Object.values(OUTPUT_PROFILES) as readonly string[]).includes(request.profile),
    'Required profile unavailable',
    'unsupported'
  )
  const validateRules = request.rules.get(selectedService.rules.id)
  outputAssert(validateRules !== undefined, 'Service rules are not installed', 'unsupported')
  validateRules(
    JSON.parse(canonicalOutputJSON(selectedService.rules.parameters)) as OutputJSONObject
  )
  if (request.profile !== OUTPUT_PROFILES.lookup)
    outputAssert(
      body.baseURL.startsWith('https://'),
      'Private profiles require HTTPS',
      'unsupported'
    )
  const digest = outputPacketDigest('capabilities', body)
  return {
    manifest,
    digest,
    service: selectedService,
    profile: selectedProfile,
    headers: { 'x-bsv-overlay-capability': digest, 'x-bsv-overlay-profile': selectedProfile.id }
  }
}

/** Explicit fresh-copy capability parsing for native integrations. This selects
 * one-pass ownership for object inputs; wire text and bytes retain the original
 * parser. All schema, extension, installed-rule and profile checks still run. */
export function parseOutputCapabilitiesWithInlineStrings(
  input: unknown,
  allowLocalHTTP = false,
  supportedExtensions: readonly string[] = []
): OutputSignedPacket<OutputCapabilities> {
  const result = s.normalizedWithInlineStrings(input, signed, 262144)
  const body = result.body
  validateOutputExtensions(body, supportedExtensions)
  outputAssert(
    canonicalOutputBase(body.baseURL, allowLocalHTTP) === body.baseURL,
    'Manifest base URL is not canonical'
  )
  outputAssert(outputU64(body.issuedAt) <= outputU64(body.expiresAt), 'Invalid manifest lifetime')
  unique(body.services.map(item => [item.kind, item.name]))
  for (const item of body.services) {
    outputAssert(
      outputPacketDigestWithInlineStrings('service-rules', item.rules) === item.rulesDigest,
      'Service rules digest mismatch'
    )
    unique(item.profiles.map(p => p.id))
    for (const p of item.profiles) validateProfile(p, item)
  }
  return result
}

/** Equivalent selection with fresh inline canonicalization. Endpoint trust,
 * authenticated identity, chain, freshness, signature and installed rules are
 * independently checked; this supplies no operation or effect authorization. */
export function selectOutputCapabilityWithInlineStrings(
  input: unknown,
  request: OutputCapabilityRequest
): OutputCapabilitySelection {
  const manifest = parseOutputCapabilitiesWithInlineStrings(
    input,
    request.allowLocalHTTP,
    request.supportedExtensions
  )
  const body = manifest.body
  outputAssert(
    body.baseURL === canonicalOutputBase(request.baseURL, request.allowLocalHTTP),
    'Capability base mismatch',
    'unauthorized'
  )
  outputAssert(
    body.identity === request.identity &&
      (request.authenticatedPeer === undefined || request.authenticatedPeer === body.identity),
    'Capability identity mismatch',
    'unauthorized'
  )
  outputAssert(
    canonicalOutputJSONWithInlineStrings(body.chain) ===
      canonicalOutputJSONWithInlineStrings(request.chain),
    'Capability chain mismatch',
    'context-changed'
  )
  const now = outputU64(request.now),
    issued = outputU64(body.issuedAt)
  const skew = outputU64(request.clockSkewSeconds),
    age = outputU64(request.maximumAgeSeconds)
  outputAssert(age > 0n, 'Capability freshness must be finite and positive')
  outputAssert(now < outputU64(body.expiresAt), 'Capability expired', 'expired')
  outputAssert(
    issued <= now + skew && now <= issued + age,
    'Capability outside local freshness policy',
    'expired'
  )
  outputAssert(
    verifyOutputPacketWithInlineStrings('capabilities', manifest, request.identity),
    'Invalid capability signature',
    'unauthorized'
  )
  const selectedService = body.services.find(
    item => item.kind === request.kind && item.name === request.service
  )
  outputAssert(selectedService !== undefined, 'Required service unavailable', 'unsupported')
  const selectedProfile = selectedService.profiles.find(p => p.id === request.profile)
  outputAssert(
    selectedProfile !== undefined &&
      (Object.values(OUTPUT_PROFILES) as readonly string[]).includes(request.profile),
    'Required profile unavailable',
    'unsupported'
  )
  const validateRules = request.rules.get(selectedService.rules.id)
  outputAssert(validateRules !== undefined, 'Service rules are not installed', 'unsupported')
  validateRules(
    JSON.parse(
      canonicalOutputJSONWithInlineStrings(selectedService.rules.parameters)
    ) as OutputJSONObject
  )
  if (request.profile !== OUTPUT_PROFILES.lookup)
    outputAssert(
      body.baseURL.startsWith('https://'),
      'Private profiles require HTTPS',
      'unsupported'
    )
  const digest = outputPacketDigestWithInlineStrings('capabilities', body)
  return {
    manifest,
    digest,
    service: selectedService,
    profile: selectedProfile,
    headers: { 'x-bsv-overlay-capability': digest, 'x-bsv-overlay-profile': selectedProfile.id }
  }
}

/** @internal Fresh bounded policy ownership for explicitly composed schemas.
 * Selection, processor trust and current authority remain caller decisions. */
export function parseOutputReleasePolicyWithInlineStrings(input: unknown): OutputReleasePolicy {
  return s.normalizedWithInlineStrings(input, release)
}

/** @internal Child grammar for a freshly owned, bounded enclosing packet only.
 * Standalone policy input requires a complete parser. Every policy field is
 * checked afresh; this makes no selection or authority decision. */
export function validateOutputReleasePolicyOfOwnedParent(input: unknown): OutputReleasePolicy {
  return release(input)
}
