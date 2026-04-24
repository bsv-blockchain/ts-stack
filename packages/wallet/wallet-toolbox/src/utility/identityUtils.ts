import {
  LookupAnswer,
  Transaction,
  PushDrop,
  VerifiableCertificate,
  Utils,
  ProtoWallet,
  LookupResolver,
  DiscoverCertificatesResult,
  IdentityCertificate,
  IdentityCertifier,
  Base64String
} from '@bsv/sdk'
import { Certifier, TrustSettings } from '../WalletSettingsManager'

const OUTPUT_INDEX = 0

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
    if (!subject || !certifier) return

    // Lookup and cache certifier details from trustSettings.
    if (!certifierCache[certifier]) {
      const found = trustSettings.trustedCertifiers.find(x => x.identityKey === certifier)
      if (!found) return // Skip this certificate if its certifier is not trusted.
      certifierCache[certifier] = found
    }

    // Create the IdentityCertifier object that we want to attach.
    const certifierInfo: IdentityCertifier = {
      name: certifierCache[certifier].name,
      iconUrl: certifierCache[certifier].iconUrl || '',
      description: certifierCache[certifier].description,
      trust: certifierCache[certifier].trust
    }

    // Create an extended certificate that includes certifierInfo.
    // Note: We use object spread to copy over all properties from the original certificate.
    const extendedCert: IdentityCertificate = {
      ...cert,
      signature: cert.signature!, // We know it exists at this point
      decryptedFields: cert.decryptedFields as Record<string, string>,
      publiclyRevealedKeyring: cert.keyring,
      certifierInfo
    }

    // Group certificates by subject.
    if (!identityGroups[subject]) {
      identityGroups[subject] = { totalTrust: 0, members: [] }
    }
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
 * Performs an identity overlay service lookup query and returns the parsed results
 *
 * @param query
 * @returns
 */
export const queryOverlay = async (query: unknown, resolver: LookupResolver): Promise<VerifiableCertificate[]> => {
  const results = await resolver.query({
    service: 'ls_identity',
    query
  })

  return await parseResults(results)
}

/**
 * Internal func: Parse the returned UTXOs Decrypt and verify the certificates and signatures Return the set of identity keys, certificates and decrypted certificate fields
 *
 * @param {Output[]} outputs
 * @returns {Promise<VerifiableCertificate[]>}
 */
export const parseResults = async (lookupResult: LookupAnswer): Promise<VerifiableCertificate[]> => {
  if (lookupResult.type === 'output-list') {
    const parsedResults: VerifiableCertificate[] = []

    for (const output of lookupResult.outputs) {
      try {
        const tx = Transaction.fromBEEF(output.beef)
        // Decode the Identity token fields from the Bitcoin outputScript
        const decodedOutput = PushDrop.decode(tx.outputs[output.outputIndex].lockingScript)

        // Parse out the certificate and relevant data
        const certificate: VerifiableCertificate = JSON.parse(Utils.toUTF8(decodedOutput.fields[0])) // TEST
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
        const decryptedFields = await verifiableCert.decryptFields(new ProtoWallet('anyone'))
        // Verify the certificate signature is correct
        await verifiableCert.verify()
        verifiableCert.decryptedFields = decryptedFields
        parsedResults.push(verifiableCert)
      } catch (error) {
        console.error(error)
        // do nothing
      }
    }
    return parsedResults
  }
  return []
}
