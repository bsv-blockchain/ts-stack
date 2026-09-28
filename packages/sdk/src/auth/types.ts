import { VerifiableCertificate } from './certificates/VerifiableCertificate.js'

export interface RequestedCertificateTypeIDAndFieldList {
  [certificateTypeID: string]: string[]
}

/**
 * BRC-103 v0.1 certificate request/allowlist.
 *
 * The current wire/API contract does not express all-of, any-of, threshold, or
 * optional-field semantics. For compatibility, validation establishes only
 * that every supplied certificate and disclosed field belongs to this set; it
 * does not establish that every listed type or field was supplied. Each party
 * remains free to choose what to request, what to provide, and how much to
 * disclose. The library standardizes selective revelation; it never declares
 * the actual disclosures sufficient for an application's decision. An
 * application must inspect the received certificates and decrypted fields and
 * terminate or constrain the session, access, or operation whenever those
 * actual disclosures do not satisfy its own policy.
 */
export interface RequestedCertificateSet {
  certifiers: string[]
  types: RequestedCertificateTypeIDAndFieldList
}

export interface AuthMessage {
  version: string
  messageType:
    'initialRequest' | 'initialResponse' | 'certificateRequest' | 'certificateResponse' | 'general'
  identityKey: string // Sender's public key (used for identity verification)
  nonce?: string // Sender's nonce (256-bit random value)
  initialNonce?: string
  yourNonce?: string // The recipient's nonce from a previous message (if applicable)
  certificates?: VerifiableCertificate[] // Optional: List of certificates (if required/requested)
  /**
   * Requested disclosure allowlist. Initial-exchange copies are not signed and
   * can be altered in transit. Authorization must depend on the certificates
   * and fields actually received and validated, never on this request alone.
   */
  requestedCertificates?: RequestedCertificateSet
  payload?: number[] // The actual message data (optional, could be a string or an object)
  signature?: number[] // Digital signature covering the entire message
}

export interface Transport {
  send: (message: AuthMessage) => Promise<void>
  onData: (callback: (message: AuthMessage) => Promise<void>) => Promise<void>
}

/** Locally selected payload policy; never read from a remote message. */
export interface AuthMessageValidationOptions {
  /**
   * Optional separate general-message payload byte budget. Omission preserves
   * the existing aggregate message budget. A positive safe integer sets an
   * explicit payload budget; null delegates payload capacity to the transport.
   * Metadata, byte validity, signatures and non-general messages retain their
   * existing validation. Configure the HTTP server/edge before delegating.
   */
  maxGeneralPayloadBytes?: number | null
}

export interface PeerSession {
  /**
   * True after the peer has proved control of the session identity key. This is
   * transport authentication, not application authorization or proof that all
   * configured certificate attributes were supplied.
   */
  isAuthenticated: boolean
  sessionNonce?: string
  peerNonce?: string
  peerIdentityKey?: string
  lastUpdate: number
  certificatesRequired?: boolean
  /** True when supplied certificates fit the legacy v0.1 request allowlist. */
  certificatesValidated?: boolean
  /** Local handshake policy snapshot. Session stores must retain this field; never sent on the wire. */
  certificatePolicy?: RequestedCertificateSet
  /** Locally issued standalone requests, keyed by their nonce. Not a wire correlation field. */
  pendingCertificateRequests?: Record<string, RequestedCertificateSet>
}
