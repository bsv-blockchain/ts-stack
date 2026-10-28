export { IdentityService, type IdentityInput, type WalletLike } from './identity-service.js'
export {
  GROUP_MESSAGING_PROTOCOL,
  CREDENTIAL_KEY_ID_PREFIX,
  newCredentialKeyId
} from './protocol.js'
export {
  attestationPreimage,
  attestationPublicKey,
  createCredentialIdentity,
  encodeCredentialIdentity,
  decodeCredentialIdentity,
  verifyCredentialIdentity,
  type CredentialIdentity
} from './credential.js'
