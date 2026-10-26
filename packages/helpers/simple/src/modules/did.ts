import { BsvDid } from '@bsv/did'
import type { DidDocument, DidResolutionResult } from '@bsv/did'
import type { WalletCore } from '../core/WalletCore'

/** Proposed BRC-202 identity-key profile; encoding does not prove live key control. */
export class DID {
  static fromIdentityKey(identityKey: string): string {
    return BsvDid.fromPublicKey(identityKey)
  }

  static resolve(did: string): DidResolutionResult {
    return BsvDid.resolve(did)
  }
}

export function createDIDMethods(core: WalletCore): {
  getDID: () => DidDocument
  resolveDID: (did: string) => DidResolutionResult
} {
  return {
    getDID(): DidDocument {
      return BsvDid.toDidDocument(DID.fromIdentityKey(core.getIdentityKey()))
    },
    resolveDID: DID.resolve
  }
}
