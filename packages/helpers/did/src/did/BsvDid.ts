/* eslint-disable @typescript-eslint/no-extraneous-class */
import type { DidDocument, PublicKeyInput, QrCodeOptions, QrMode } from '../types.js'
import { generateQrCode } from '../qr.js'
import { decodeDidKey, publicKeyToDidKey, verificationMethodForDid } from '../utils/multibase.js'

export class BsvDid {
  // Implements did:key Create and Document Creation Algorithm:
  // https://w3c-ccg.github.io/did-key-spec/#create
  static fromPublicKey (publicKey: PublicKeyInput): string {
    return publicKeyToDidKey(publicKey)
  }

  // Implements DID Core verificationMethod and verification relationships:
  // https://www.w3.org/TR/did-core/#verification-methods
  // https://www.w3.org/TR/did-core/#verification-relationships
  static toDidDocument (did: string): DidDocument {
    const { multibaseValue } = decodeDidKey(did)
    const verificationMethod = verificationMethodForDid(did)

    return {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/multikey/v1'
      ],
      id: did,
      verificationMethod: [{
        id: verificationMethod,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: multibaseValue
      }],
      authentication: [verificationMethod],
      assertionMethod: [verificationMethod],
      capabilityDelegation: [verificationMethod],
      capabilityInvocation: [verificationMethod]
    }
  }

  static generateQrCode (value: string, mode: QrMode = 'did', options: QrCodeOptions = {}): string {
    return generateQrCode(value, mode, options)
  }
}
