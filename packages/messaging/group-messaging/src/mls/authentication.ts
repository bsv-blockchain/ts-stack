import {
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  type AuthenticationService,
  type ClientConfig
} from 'ts-mls'
import { IdentityService } from '../identity/index.js'
import type { MlsCiphersuiteName } from '../types.js'

/**
 * The seam where a member's MLS signature key is checked against the BRC-100
 * identity their credential claims.
 *
 * `validateCredential` receives only the credential and the signature key, which
 * is why the attestation lives inside `BasicCredential.identity` rather than
 * beside it: a member added by somebody else is met here and nowhere else.
 *
 * Returns `false` rather than throwing. `ts-mls` calls this while validating a
 * ratchet tree, and a rejected credential is a validation result, not a crash.
 */
export const walletAuthenticationService = (
  ciphersuite: MlsCiphersuiteName
): AuthenticationService => ({
  async validateCredential(credential, signaturePublicKey) {
    if (credential.credentialType !== 'basic') return false
    try {
      IdentityService.verifyCredential(credential.identity, signaturePublicKey, ciphersuite)
      return true
    } catch {
      return false
    }
  }
})

/**
 * `ts-mls` defaults with the permissive authentication service replaced.
 *
 * `ts-mls` does not export a combined `defaultClientConfig` from its package
 * root (only the individual `default*Config` values), so it is assembled here.
 */
export const clientConfigFor = (ciphersuite: MlsCiphersuiteName): ClientConfig => ({
  keyRetentionConfig: defaultKeyRetentionConfig,
  lifetimeConfig: defaultLifetimeConfig,
  keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
  paddingConfig: defaultPaddingConfig,
  authService: walletAuthenticationService(ciphersuite)
})
