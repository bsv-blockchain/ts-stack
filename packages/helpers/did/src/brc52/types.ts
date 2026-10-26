/** Proposed BRC-203 v1 custom mechanism. This is not a registered W3C suite. */
export interface BRC52CredentialGraph {
  '@context': [string, BRC52Context]
  type: ['VerifiableCredential', 'brc:BRC52EncryptedCertificate']
  issuer: string
  credentialSubject: { id: string; encryptedFields: Record<string, string> }
  certificateType: string
  serialNumber: string
  revocationOutpoint: string
  credentialStatus?: { type: 'brc:BRC52OutpointStatus'; revocationOutpoint: string }
}

export interface BRC52Context {
  '@protected': true
  brc: { '@id': string; '@prefix': true }
  certificateType: 'brc:certificateType'
  serialNumber: 'brc:serialNumber'
  revocationOutpoint: 'brc:revocationOutpoint'
  encryptedFields: { '@id': 'brc:encryptedFields'; '@type': '@json' }
}

export interface BRC52Disclosure {
  subject: string
  verifier: string
  keyring: Record<string, string>
}

export interface BRC52Envelope {
  profile: string
  certificateBinary: string
  credential: BRC52CredentialGraph
  disclosure?: BRC52Disclosure
}

export interface BRC52CertificateCore {
  type: string
  serialNumber: string
  subject: string
  certifier: string
  revocationOutpoint: string
  fields: Record<string, string>
  signature: string
}

/** Owned copies of the exact authenticated source, never rebuilt for verification. */
export interface ParsedBRC52Certificate extends BRC52CertificateCore {
  unsignedPrefix: number[]
  certificateBinary: number[]
}

export interface BRC52VerificationResult {
  verified: boolean
  verifiedDocument: BRC52CredentialGraph | null
  mediaType: 'application/vc' | null
  errors: string[]
}
