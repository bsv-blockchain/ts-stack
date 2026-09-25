import {
  LookupAnswer,
  PushDrop,
  VerifiableCertificate,
  ProtoWallet,
  LookupResolver,
  DiscoverCertificatesResult,
  IdentityCertificate,
  IdentityCertifier,
  Base64String,
  ChainTracker,
  TransactionEvidenceCoordinator,
  TransactionEvidenceError,
  TransactionEvidenceLimits,
  VerifiedTransactionOutput,
  defaultTransactionEvidenceLimits
} from '@bsv/sdk'
import { toUTF8Strict } from '@bsv/sdk/primitives/utils'
import { TrustSettings, validateTrustSettings } from '../WalletSettingsManager'
import { OverlayOutputEvidence } from './verifyOverlayOutput'

const MAX_IDENTITY_RESULTS = 256
const MAX_IDENTITY_CERTIFICATE_BYTES = 256 * 1024
const MAX_IDENTITY_FIELDS = 100
const IDENTITY_PROTOCOL: [1, 'identity'] = [1, 'identity']
const IDENTITY_KEY_ID = '1'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownData(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor == null || !('value' in descriptor)) {
    throw new Error(`Identity certificate ${key} must be an own data property`)
  }
  return descriptor.value
}

function boundedBytes(value: unknown, field: string, minimum: number, maximum: number): number[] {
  const normalized = value instanceof Uint8Array ? Array.from(value) : value
  if (!Array.isArray(normalized) || normalized.length < minimum || normalized.length > maximum) {
    throw new Error(`${field} must contain ${minimum}-${maximum} bytes`)
  }
  for (let index = 0; index < normalized.length; index++) {
    if (
      !Object.prototype.hasOwnProperty.call(normalized, index) ||
      !Number.isInteger(normalized[index]) ||
      normalized[index] < 0 ||
      normalized[index] > 255
    ) {
      throw new Error(`${field} must be a dense byte array`)
    }
  }
  return Array.from(normalized)
}

function pushOpcode(value: number[]): number {
  if (value.length <= 75) return value.length
  if (value.length <= 0xff) return 0x4c
  if (value.length <= 0xffff) return 0x4d
  return 0x4e
}

function certificateRecord(encoded: number[]): Record<string, unknown> {
  const parsed: unknown = JSON.parse(toUTF8Strict(encoded))
  if (!isPlainRecord(parsed)) throw new Error('Identity certificate must be a plain object')
  const allowed = new Set([
    'type',
    'serialNumber',
    'subject',
    'certifier',
    'revocationOutpoint',
    'fields',
    'keyring',
    'signature'
  ])
  for (const key of Reflect.ownKeys(parsed)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error('Identity certificate contains an unexpected field')
    }
    ownData(parsed, key)
  }
  for (const key of allowed) ownData(parsed, key)
  const fields = ownData(parsed, 'fields')
  const keyring = ownData(parsed, 'keyring')
  if (!isPlainRecord(fields) || !isPlainRecord(keyring)) {
    throw new Error('Identity certificate fields and keyring must be plain objects')
  }
  const fieldNames = Object.keys(fields)
  const keyringNames = Object.keys(keyring)
  if (
    fieldNames.length < 1 ||
    fieldNames.length > MAX_IDENTITY_FIELDS ||
    keyringNames.length < 1 ||
    keyringNames.length > MAX_IDENTITY_FIELDS
  ) {
    throw new Error('Identity certificate fields or keyring have invalid cardinality')
  }
  for (const fieldName of keyringNames) {
    if (!Object.prototype.hasOwnProperty.call(fields, fieldName)) {
      throw new Error('Identity keyring refers to an absent certificate field')
    }
    const key = ownData(keyring, fieldName)
    if (typeof key !== 'string' || key.length > 2048) {
      throw new Error('Identity keyring value is missing or oversized')
    }
  }
  return parsed
}

// Our extended certificate includes certifierInfo.
export interface ExtendedVerifiableCertificate extends IdentityCertificate {
  certifierInfo: IdentityCertifier
  publiclyRevealedKeyring: Record<string, Base64String>
}

function normalizeIdentitySearch(input: string): string {
  return input.trim().replaceAll(/\s+/g, ' ')
}

/** Mirrors the identity overlay's fuzzy attribute regex (tokens in order, case-insensitive). */
function identityFuzzyMatches(actual: string, expected: string): boolean {
  const normalized = normalizeIdentitySearch(expected)
  if (normalized.length === 0) return false
  const pattern = normalized
    .split(' ')
    .map(token => token.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join('.*')
  return new RegExp(pattern, 'i').test(actual)
}

function identityAttributeMatches(fieldName: string, actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false
  // The overlay matches userName exactly and every other field fuzzily.
  if (fieldName === 'userName') return actual === normalizeIdentitySearch(expected)
  return identityFuzzyMatches(actual, expected)
}

/**
 * `any` is the overlay's all-fields search, not a field name. Accept a certificate
 * when at least one decrypted field contains one of the search terms.
 */
function identityAnyMatches(fields: Record<string, unknown>, expected: string): boolean {
  const normalized = normalizeIdentitySearch(expected)
  if (normalized.length < 2) return false
  const values = Object.values(fields).filter((v): v is string => typeof v === 'string')
  if (normalized.length === 2) return values.some(v => identityFuzzyMatches(v, normalized))
  const terms = normalized.toLowerCase().split(' ')
  return values.some(v => {
    const lower = v.toLowerCase()
    return terms.some(term => lower.includes(term))
  })
}

/** Re-bind authenticated certificates to the identity lookup they answered. */
export function filterCertificatesByIdentityKey(
  certificates: VerifiableCertificate[],
  identityKey: string
): VerifiableCertificate[] {
  const expected = identityKey.toLowerCase()
  return certificates.filter(
    certificate => typeof certificate.subject === 'string' && certificate.subject.toLowerCase() === expected
  )
}

/** Re-bind authenticated certificates to the attribute lookup they answered. */
export function filterCertificatesByAttributes(
  certificates: VerifiableCertificate[],
  attributes: Record<string, string>
): VerifiableCertificate[] {
  const expected = Object.entries(attributes)
  return certificates.filter(certificate => {
    const fields = certificate.decryptedFields
    if (fields == null || typeof fields !== 'object' || Array.isArray(fields)) return false
    const record = fields as Record<string, unknown>
    if ('any' in attributes) return identityAnyMatches(record, attributes.any)
    return expected.every(([fieldName, value]) => identityAttributeMatches(fieldName, record[fieldName], value))
  })
}

// --- Helper Types for Grouping ---

interface IdentityGroup {
  totalTrust: number
  members: ExtendedVerifiableCertificate[]
  certifiers: Set<string>
  certificates: Set<string>
}

/**
 * Transforms an array of VerifiableCertificate instances according to the trust settings.
 * Only certificates whose grouped total trust meets the threshold are returned,
 * and each certificate is augmented with a certifierInfo property.
 *
 * @param trustSettings - the user's trust settings including trustLevel and trusted certifiers.
 * @param certificates - an array of VerifiableCertificate objects.
 * @returns a DiscoverCertificatesResult with totalCertificates and ordered certificates.
 */
export const transformVerifiableCertificatesWithTrust = (
  trustSettings: TrustSettings,
  certificates: VerifiableCertificate[]
): DiscoverCertificatesResult => {
  const validatedTrust = validateTrustSettings(trustSettings)
  // Group certificates by subject while accumulating trust.
  const identityGroups = new Map<string, IdentityGroup>()
  // Cache certifier lookups.
  const certifierCache = new Map(
    validatedTrust.trustedCertifiers.map(certifier => [certifier.identityKey, certifier] as const)
  )

  certificates.slice(0, MAX_IDENTITY_RESULTS).forEach(cert => {
    const { subject, certifier } = cert
    if (subject === '' || certifier === '') return

    const trustedCertifier = certifierCache.get(certifier)
    if (trustedCertifier == null) return

    // Create the IdentityCertifier object that we want to attach.
    const certifierInfo: IdentityCertifier = {
      name: trustedCertifier.name,
      iconUrl: trustedCertifier.iconUrl ?? 'https://bsvblockchain.org/favicon.ico',
      description: trustedCertifier.description,
      trust: trustedCertifier.trust
    }

    // Create an extended certificate that includes certifierInfo.
    const extendedCert: IdentityCertificate = {
      type: cert.type,
      serialNumber: cert.serialNumber,
      subject: cert.subject,
      certifier: cert.certifier,
      revocationOutpoint: cert.revocationOutpoint,
      signature: cert.signature as string, // We know it exists at this point
      fields: { ...cert.fields },
      decryptedFields: { ...cert.decryptedFields } as Record<string, string>,
      publiclyRevealedKeyring: { ...cert.keyring },
      certifierInfo
    }

    // Group certificates by subject.
    let group = identityGroups.get(subject)
    if (group == null) {
      group = { totalTrust: 0, members: [], certifiers: new Set(), certificates: new Set() }
      identityGroups.set(subject, group)
    }
    const certificateID = `${cert.type}\0${cert.serialNumber}\0${certifier}`
    if (group.certificates.has(certificateID)) return
    group.certificates.add(certificateID)
    if (!group.certifiers.has(certifier)) {
      group.certifiers.add(certifier)
      group.totalTrust += certifierInfo.trust
    }
    group.members.push(extendedCert)
  })

  // Filter out groups that do not meet the trust threshold and flatten the results.
  const finalResults: ExtendedVerifiableCertificate[] = []
  identityGroups.forEach(group => {
    if (group.totalTrust >= validatedTrust.trustLevel) {
      finalResults.push(...group.members)
    }
  })

  // Sort the certificates by their certifier trust in descending order.
  finalResults.sort((a, b) => b.certifierInfo.trust - a.certifierInfo.trust)

  return {
    totalCertificates: finalResults.length,
    certificates: finalResults
  }
}

/**
 * Performs an identity overlay service lookup query and returns the parsed results.
 * Requires an independently maintained ChainTracker; missing context returns no identities.
 *
 * Identity paths benefit from a larger grace window (more hosts contribute outputs before the
 * query resolves) — 300 ms is well under the "instant" perception threshold and catches the long
 * tail of healthy-but-slightly-slow hosts.
 */
export const queryOverlay = async (
  query: unknown,
  resolver: LookupResolver,
  chainTracker?: ChainTracker
): Promise<VerifiableCertificate[]> => {
  if (chainTracker == null) return []
  return await parseResults(await queryOverlayEvidence(query, resolver), chainTracker)
}

/** Configurable identity intake bounds; share byte limits with IdentityEvidenceVerifier. */
export interface IdentityEvidenceIntakeLimits {
  candidateBytes?: number
  retainedBytes?: number
  outputs?: number
}

/**
 * Fetch an owned snapshot of UNTRUSTED evidence, suitable only for revalidation.
 * A limit rejects the lookup because this legacy result cannot represent partial completion.
 */
export const queryOverlayEvidence = async (
  query: unknown,
  resolver: LookupResolver,
  limits: IdentityEvidenceIntakeLimits = {}
): Promise<LookupAnswer> => {
  const candidateBytes = limits.candidateBytes ?? defaultTransactionEvidenceLimits.candidateBytes
  const retainedBytes = limits.retainedBytes ?? defaultTransactionEvidenceLimits.retainedBytes
  const maxOutputs = limits.outputs ?? 512
  if (![candidateBytes, retainedBytes, maxOutputs].every(value => Number.isSafeInteger(value) && value > 0))
    throw new TransactionEvidenceError('limit')
  const outputs: LookupAnswer['outputs'] = []
  let bytes = 0
  let received = false
  let closed = false
  let limited = false
  const accept = (output: LookupAnswer['outputs'][number]): void => {
    const size = output.beef.length + (output.context?.length ?? 0)
    if (outputs.length >= maxOutputs || output.beef.length > candidateBytes || bytes + size > retainedBytes) {
      limited = true
      return
    }
    bytes += size
    outputs.push({
      ...output,
      beef: output.beef.slice(),
      ...(output.context === undefined ? {} : { context: output.context.slice() })
    })
  }
  try {
    const results = await resolver.query(
      {
        service: 'ls_identity',
        query
      },
      undefined,
      {
        graceMs: 300,
        evidenceLimits: { maxOutputs, maxBytes: retainedBytes },
        onEvidence: event => {
          if (closed) return
          received = true
          if (event.type === 'output') accept(event.output)
          else limited = true
        }
      }
    )

    if (limited) throw new TransactionEvidenceError('limit')
    if (results.type !== 'output-list') return results
    // Custom/older resolvers may not implement the additive intake callback.
    if (!received) for (const output of results.outputs) accept(output)
    if (limited) throw new TransactionEvidenceError('limit')
    return { type: 'output-list', outputs }
  } finally {
    closed = true
  }
}

/**
 * Cooperative yield helper. On environments where the main thread also drives UI work
 * (React Native, browsers), parsing many certificates synchronously freezes input handling.
 * Interleaving a 0 ms timeout between iterations gives the runtime a chance to flush UI events.
 *
 * On Node we skip the yield to avoid the timer overhead (no UI to unblock).
 */
const isUiRuntime = (): boolean => {
  if (typeof globalThis === 'undefined') return false
  const g = globalThis as any
  // React Native exposes __DEV__/navigator.product; browsers expose window/document.
  if (g.window !== undefined && g.document !== undefined) return true
  if (typeof g.navigator?.product === 'string' && g.navigator.product === 'ReactNative') return true
  return false
}

const yieldToUi = async (): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}

/**
 * Parse a single overlay output into a verified, decrypted certificate. Returns `null` on any
 * parse / decrypt / verify failure so a malformed entry can never block the others.
 */
const decodeIdentityOutput = async (
  verifiedOutput: VerifiedTransactionOutput
): Promise<VerifiableCertificate | null> => {
  try {
    const decodedOutput = PushDrop.decode(verifiedOutput.lockingScript)
    if (decodedOutput.fields.length !== 2) return null
    const certificateBytes = boundedBytes(
      decodedOutput.fields[0],
      'Identity certificate',
      1,
      MAX_IDENTITY_CERTIFICATE_BYTES
    )
    const fieldSignature = boundedBytes(decodedOutput.fields[1], 'Identity field signature', 8, 80)
    const chunks = verifiedOutput.lockingScript.chunks
    if (
      chunks.length !== 5 ||
      chunks[0].op !== 33 ||
      chunks[0].data?.length !== 33 ||
      chunks[1].op !== 0xac ||
      chunks[2].op !== pushOpcode(certificateBytes) ||
      chunks[3].op !== pushOpcode(fieldSignature) ||
      chunks[4].op !== 0x6d
    ) {
      return null
    }
    const certificate = certificateRecord(certificateBytes)
    const subject = ownData(certificate, 'subject')
    if (typeof subject !== 'string') return null
    const anyoneWallet = new ProtoWallet('anyone')
    const { publicKey: expectedLockingKey } = await anyoneWallet.getPublicKey({
      protocolID: IDENTITY_PROTOCOL,
      keyID: IDENTITY_KEY_ID,
      counterparty: subject
    })
    if (decodedOutput.lockingPublicKey.toString() !== expectedLockingKey) return null
    const { valid } = await anyoneWallet.verifySignature({
      data: certificateBytes,
      signature: fieldSignature,
      counterparty: subject,
      protocolID: IDENTITY_PROTOCOL,
      keyID: IDENTITY_KEY_ID
    })
    if (valid !== true) return null
    const verifiableCert = new VerifiableCertificate(
      ownData(certificate, 'type') as string,
      ownData(certificate, 'serialNumber') as string,
      subject,
      ownData(certificate, 'certifier') as string,
      ownData(certificate, 'revocationOutpoint') as string,
      ownData(certificate, 'fields') as Record<string, string>,
      ownData(certificate, 'keyring') as Record<string, string>,
      ownData(certificate, 'signature') as string
    )
    if ((await verifiableCert.verify()) !== true) return null
    const decryptedFields = await verifiableCert.decryptFields(anyoneWallet)
    if (Object.keys(decryptedFields).length === 0) return null
    verifiableCert.decryptedFields = decryptedFields
    return verifiableCert
  } catch {
    // Untrusted parsing/decryption errors can contain identity data. Do not log it.
    return null
  }
}

/**
 * Wallet/session-owned identity validation. Chain evidence is checked on every
 * use; bounded certificate crypto results are independent of mutable trust ratings.
 */
export class IdentityEvidenceVerifier {
  private disposed = false
  private readonly coordinator: TransactionEvidenceCoordinator
  private readonly certificates = new Map<string, { json: string; expiresAt: number }>()
  private expiryTimer?: ReturnType<typeof setTimeout>

  constructor(
    readonly chainTracker: ChainTracker,
    readonly chainNamespace = 'caller-chain-tracker',
    limits?: Partial<TransactionEvidenceLimits>
  ) {
    this.coordinator = new TransactionEvidenceCoordinator({
      chainTracker,
      chainNamespace,
      limits,
      policyId: 'sdk-spv-overlay-graph-v1'
    })
  }

  private clone(json: string): VerifiableCertificate {
    const cert: VerifiableCertificate = JSON.parse(json)
    const copy = new VerifiableCertificate(
      cert.type,
      cert.serialNumber,
      cert.subject,
      cert.certifier,
      cert.revocationOutpoint,
      cert.fields,
      cert.keyring,
      cert.signature
    )
    copy.decryptedFields = cert.decryptedFields
    return copy
  }

  async parse(output: OverlayOutputEvidence): Promise<{ outpoint: string; certificate: VerifiableCertificate } | null> {
    try {
      const evidence = { ...output, beef: output.beef.slice() }
      const verified = await this.coordinator.verify(evidence)
      if (this.disposed) return null
      const cached = this.certificates.get(verified.outpoint)
      if (cached !== undefined && cached.expiresAt > Date.now()) {
        return { outpoint: verified.outpoint, certificate: this.clone(cached.json) }
      }
      const certificate = await decodeIdentityOutput(verified)
      if (certificate === null) return null
      // Certificate crypto can await; fence its completion against current chain/session state.
      await this.coordinator.verify(evidence)
      if (this.disposed) return null
      // Store owned bytes and return a separate object; callers cannot mutate future results.
      const json = JSON.stringify(certificate)
      this.prune()
      let bytes = [...this.certificates.values()].reduce((total, value) => total + value.json.length * 2, 0)
      while (
        this.certificates.size > 0 &&
        (this.certificates.size >= 128 || bytes + json.length * 2 > 2 * 1024 * 1024)
      ) {
        const oldest = this.certificates.keys().next().value!
        bytes -= this.certificates.get(oldest)!.json.length * 2
        this.certificates.delete(oldest)
      }
      if (json.length * 2 <= 2 * 1024 * 1024) {
        this.certificates.set(verified.outpoint, { json, expiresAt: Date.now() + 60_000 })
        this.scheduleExpiry()
      }
      return { outpoint: verified.outpoint, certificate: this.clone(json) }
    } catch (error) {
      if (error instanceof TransactionEvidenceError && (error.code === 'limit' || error.code === 'timeout')) throw error
      return null
    }
  }

  private prune(): void {
    for (const [key, cached] of this.certificates) if (cached.expiresAt <= Date.now()) this.certificates.delete(key)
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer)
    const expiresAt = Math.min(...[...this.certificates.values()].map(value => value.expiresAt))
    if (!Number.isFinite(expiresAt)) return
    this.expiryTimer = setTimeout(
      () => {
        this.prune()
        this.scheduleExpiry()
      },
      Math.max(1, expiresAt - Date.now())
    )
    this.expiryTimer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    this.coordinator.dispose()
    this.certificates.clear()
    clearTimeout(this.expiryTimer)
  }
}

/**
 * Parse the returned UTXOs, decrypting and verifying each certificate.
 * An omitted ChainTracker fails closed. Each call revalidates transaction evidence;
 * returned certificates carry no reusable chain-verdict or unspentness guarantee.
 *
 * On UI runtimes (browser / React Native), yields between iterations so the JS thread does not
 * own the frame for the full duration. On Node, runs straight through.
 */
export const parseResults = async (
  lookupResult: LookupAnswer,
  chainTracker?: ChainTracker,
  verifier?: IdentityEvidenceVerifier
): Promise<VerifiableCertificate[]> => {
  const certificates: VerifiableCertificate[] = []
  for await (const certificate of parseResults$(lookupResult, chainTracker, verifier)) certificates.push(certificate)
  return certificates
}

/**
 * Iterable variant of {@link parseResults}: emits each successfully parsed certificate as soon as
 * it's ready, so callers can render progressively instead of waiting for the full set.
 */
export async function* parseResults$(
  lookupResult: LookupAnswer,
  chainTracker?: ChainTracker,
  verifier?: IdentityEvidenceVerifier
): AsyncIterable<VerifiableCertificate> {
  if (lookupResult.type !== 'output-list' || chainTracker == null) return
  if (verifier !== undefined && verifier.chainTracker !== chainTracker) return
  const owned = verifier === undefined
  verifier ??= new IdentityEvidenceVerifier(chainTracker)
  const shouldYield = isUiRuntime()
  const seen = new Set<string>()
  try {
    for (const output of lookupResult.outputs) {
      if (shouldYield) await yieldToUi()
      const result = await verifier.parse(output)
      if (result !== null && !seen.has(result.outpoint)) {
        seen.add(result.outpoint)
        yield result.certificate
      }
    }
  } finally {
    if (owned) verifier.dispose()
  }
}
