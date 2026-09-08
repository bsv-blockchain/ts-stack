import {
  LookupAnswer,
  PushDrop,
  VerifiableCertificate,
  Utils,
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
import { Certifier, TrustSettings } from '../WalletSettingsManager'
import { OverlayOutputEvidence } from './verifyOverlayOutput'

// Our extended certificate includes certifierInfo.
export interface ExtendedVerifiableCertificate extends IdentityCertificate {
  certifierInfo: IdentityCertifier
  publiclyRevealedKeyring: Record<string, Base64String>
}

// --- Helper Types for Grouping ---

interface IdentityGroup {
  totalTrust: number
  members: ExtendedVerifiableCertificate[]
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
  // Group certificates by subject while accumulating trust.
  const identityGroups: Record<string, IdentityGroup> = {}
  // Cache certifier lookups.
  const certifierCache: Record<string, Certifier> = {}

  certificates.forEach(cert => {
    const { subject, certifier } = cert
    if (subject === '' || certifier === '') return

    // Lookup and cache certifier details from trustSettings.
    if (certifierCache[certifier] == null) {
      const found = trustSettings.trustedCertifiers.find(x => x.identityKey === certifier)
      if (found == null) return // Skip this certificate if its certifier is not trusted.
      certifierCache[certifier] = found
    }

    // Create the IdentityCertifier object that we want to attach.
    const certifierInfo: IdentityCertifier = {
      name: certifierCache[certifier].name,
      iconUrl: certifierCache[certifier].iconUrl ?? '',
      description: certifierCache[certifier].description,
      trust: certifierCache[certifier].trust
    }

    // Create an extended certificate that includes certifierInfo.
    // Note: We use object spread to copy over all properties from the original certificate.
    const extendedCert: IdentityCertificate = {
      ...cert,
      signature: cert.signature as string, // We know it exists at this point
      decryptedFields: cert.decryptedFields as Record<string, string>,
      publiclyRevealedKeyring: cert.keyring,
      certifierInfo
    }

    // Group certificates by subject.
    identityGroups[subject] ??= { totalTrust: 0, members: [] }
    identityGroups[subject].totalTrust += certifierInfo.trust
    identityGroups[subject].members.push(extendedCert)
  })

  // Filter out groups that do not meet the trust threshold and flatten the results.
  const finalResults: ExtendedVerifiableCertificate[] = []
  Object.values(identityGroups).forEach(group => {
    if (group.totalTrust >= trustSettings.trustLevel) {
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
    const certificate: VerifiableCertificate = JSON.parse(Utils.toUTF8(decodedOutput.fields[0]))
    const verifiableCert = new VerifiableCertificate(
      certificate.type,
      certificate.serialNumber,
      certificate.subject,
      certificate.certifier,
      certificate.revocationOutpoint,
      certificate.fields,
      certificate.keyring,
      certificate.signature
    )
    // IdentityClient.publiclyRevealAttributes and tm_identity use the subject's
    // BRC-42 identity key to sign the certificate/keyring fields in this output.
    const anyoneWallet = new ProtoWallet('anyone')
    const signature = decodedOutput.fields.pop()
    if (decodedOutput.fields.length === 0 || signature == null) return null
    const { valid } = await anyoneWallet.verifySignature({
      data: decodedOutput.fields.flat(),
      signature,
      counterparty: verifiableCert.subject,
      protocolID: [1, 'identity'],
      keyID: '1'
    })
    if (valid !== true) return null
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
