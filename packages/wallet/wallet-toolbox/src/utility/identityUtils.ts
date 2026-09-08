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
  ChainTracker
} from '@bsv/sdk'
import { Certifier, TrustSettings } from '../WalletSettingsManager'
import { OverlayOutputEvidence, verifyOverlayOutput } from './verifyOverlayOutput'

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

/** Fetch an owned snapshot of UNTRUSTED evidence, suitable only for revalidation. */
export const queryOverlayEvidence = async (query: unknown, resolver: LookupResolver): Promise<LookupAnswer> => {
  const results = await resolver.query(
    {
      service: 'ls_identity',
      query
    },
    undefined,
    { graceMs: 300 }
  )

  if (results.type !== 'output-list') return results
  return {
    type: 'output-list',
    outputs: results.outputs.map(output => ({
      ...output,
      beef: output.beef.slice(),
      ...(output.context === undefined ? {} : { context: output.context.slice() })
    }))
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
const parseOne = async (
  output: OverlayOutputEvidence,
  chainTracker: ChainTracker
): Promise<VerifiableCertificate | null> => {
  try {
    const verifiedOutput = await verifyOverlayOutput(output, chainTracker)
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
 * Parse the returned UTXOs, decrypting and verifying each certificate.
 * An omitted ChainTracker fails closed. Each call revalidates transaction evidence;
 * returned certificates carry no reusable chain-verdict or unspentness guarantee.
 *
 * On UI runtimes (browser / React Native), yields between iterations so the JS thread does not
 * own the frame for the full duration. On Node, runs straight through.
 */
export const parseResults = async (
  lookupResult: LookupAnswer,
  chainTracker?: ChainTracker
): Promise<VerifiableCertificate[]> => {
  if (lookupResult.type !== 'output-list' || chainTracker == null) return []
  const parsedResults: VerifiableCertificate[] = []
  const shouldYield = isUiRuntime()
  for (const output of lookupResult.outputs) {
    if (shouldYield) await yieldToUi()
    const cert = await parseOne(output, chainTracker)
    if (cert != null) parsedResults.push(cert)
  }
  return parsedResults
}

/**
 * Iterable variant of {@link parseResults}: emits each successfully parsed certificate as soon as
 * it's ready, so callers can render progressively instead of waiting for the full set.
 */
export async function* parseResults$(
  lookupResult: LookupAnswer,
  chainTracker?: ChainTracker
): AsyncIterable<VerifiableCertificate> {
  if (lookupResult.type !== 'output-list' || chainTracker == null) return
  const shouldYield = isUiRuntime()
  for (const output of lookupResult.outputs) {
    if (shouldYield) await yieldToUi()
    const cert = await parseOne(output, chainTracker)
    if (cert != null) yield cert
  }
}
