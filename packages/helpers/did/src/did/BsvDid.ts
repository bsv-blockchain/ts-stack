/* eslint-disable @typescript-eslint/no-extraneous-class */
import type {
  DidDereferencingResult,
  DidDocument,
  DidRepresentationResult,
  DidResolutionOptions,
  DidResolutionResult,
  DidUnsupportedOperationResult,
  PublicKeyInput,
  QrCodeOptions,
  QrMode
} from '../types.js'
import { generateQrCode } from '../qr.js'
import { decodeDidKey, publicKeyToDidKey, verificationMethodForDid } from '../utils/multibase.js'
import { assertBoundedString, getOwnDataProperties } from '../validation.js'

const JSON_LD_CONTENT_TYPE = 'application/did+ld+json'
const DID_PATTERN =
  /^did:([a-z0-9]+):(?:[A-Za-z0-9._:-]|%[0-9A-Fa-f]{2})*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})$/

export class BsvDid {
  /** Encode a validated compressed identity key under the proposed BRC-202 profile. */
  static fromPublicKey(publicKey: PublicKeyInput): string {
    return publicKeyToDidKey(publicKey)
  }

  // Implements DID Core verificationMethod and verification relationships:
  // https://www.w3.org/TR/did-core/#verification-methods
  // https://www.w3.org/TR/did-core/#verification-relationships
  static toDidDocument(did: string): DidDocument {
    const { multibaseValue } = decodeDidKey(did)
    const verificationMethod = verificationMethodForDid(did)

    return {
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
      id: did,
      verificationMethod: [
        {
          id: verificationMethod,
          type: 'Multikey',
          controller: did,
          publicKeyMultibase: multibaseValue
        }
      ],
      authentication: [verificationMethod],
      assertionMethod: [verificationMethod],
      capabilityInvocation: [verificationMethod],
      capabilityDelegation: [verificationMethod]
    }
  }

  /** Deterministic resolution proves the key encoding, not current control or issuer trust. */
  static resolve(did: string, options: DidResolutionOptions = {}): DidResolutionResult {
    let document: DidDocument
    try {
      assertBoundedString(did, 'DID', 2_048)
      const match = DID_PATTERN.exec(did)
      if (match == null) throw new Error('Invalid DID')
      if (match[1] !== 'key') {
        return {
          didResolutionMetadata: { error: 'methodNotSupported' },
          didDocument: null,
          didDocumentMetadata: {}
        }
      }
      document = BsvDid.toDidDocument(did)
    } catch {
      return {
        didResolutionMetadata: { error: 'invalidDid' },
        didDocument: null,
        didDocumentMetadata: {}
      }
    }
    let supportedOptions: boolean
    try {
      const suppliedOptions = getOwnDataProperties(
        options,
        'DID resolution options',
        new Set(['accept'])
      )
      supportedOptions =
        suppliedOptions.accept === undefined || suppliedOptions.accept === JSON_LD_CONTENT_TYPE
    } catch {
      supportedOptions = false
    }
    if (!supportedOptions) {
      return {
        didResolutionMetadata: { error: 'representationNotSupported' },
        didDocument: null,
        didDocumentMetadata: {}
      }
    }
    return { didResolutionMetadata: {}, didDocument: document, didDocumentMetadata: {} }
  }

  /** Return UTF-8 JSON-LD bytes separately from the resolution metadata. */
  static resolveRepresentation(
    did: string,
    options: DidResolutionOptions = {}
  ): DidRepresentationResult {
    const result = BsvDid.resolve(did, options)
    if (result.didDocument === null) {
      return {
        didResolutionMetadata: result.didResolutionMetadata,
        didDocumentStream: null,
        didDocumentMetadata: {}
      }
    }
    return {
      didResolutionMetadata: { contentType: JSON_LD_CONTENT_TYPE },
      didDocumentStream: new TextEncoder().encode(JSON.stringify(result.didDocument)),
      didDocumentMetadata: {}
    }
  }

  /** Dereference only this profile's exact verification-method DID URL. */
  static dereference(didUrl: string): DidDereferencingResult {
    try {
      assertBoundedString(didUrl, 'DID URL', 4_096)
    } catch {
      return {
        dereferencingMetadata: { error: 'invalidDidUrl' },
        contentStream: null,
        contentMetadata: {}
      }
    }
    const did = didUrl.split(/[/?#]/, 1)[0]
    const result = BsvDid.resolve(did)
    if (result.didDocument === null) {
      return {
        dereferencingMetadata: {
          error:
            result.didResolutionMetadata.error === 'methodNotSupported'
              ? 'methodNotSupported'
              : 'invalidDidUrl'
        },
        contentStream: null,
        contentMetadata: {}
      }
    }
    const method = result.didDocument.verificationMethod[0]
    if (didUrl !== method.id) {
      return {
        dereferencingMetadata: { error: 'notFound' },
        contentStream: null,
        contentMetadata: {}
      }
    }
    return { dereferencingMetadata: {}, contentStream: method, contentMetadata: {} }
  }

  /** An identity-key DID cannot be updated in place. A new identity key creates a new DID. */
  static update(): DidUnsupportedOperationResult {
    return { supported: false, error: 'operationNotSupported' }
  }

  static rotate(): DidUnsupportedOperationResult {
    return BsvDid.update()
  }

  static recover(): DidUnsupportedOperationResult {
    return BsvDid.update()
  }

  static deactivate(): DidUnsupportedOperationResult {
    return BsvDid.update()
  }

  static generateQrCode(value: string, mode: QrMode = 'did', options: QrCodeOptions = {}): string {
    return generateQrCode(value, mode, options)
  }
}
