export { BsvDid } from './did/BsvDid.js'
export { generateQrCode } from './qr.js'
export { SdJwtVcIssuer } from './sd-jwt/issuer.js'
export { SdJwtVcHolder } from './sd-jwt/holder.js'
export { SdJwtVcPresenter } from './sd-jwt/presenter.js'
export { SdJwtVcVerifier } from './sd-jwt/verifier.js'
export * from './types.js'
export {
  parseDisclosure,
  disclosureDigest,
  applyDisclosures,
  selectDisclosures
} from './sd-jwt/disclosures.js'
export {
  parseSdJwt,
  serializeSdJwt
} from './sd-jwt/format.js'
export {
  createKeyBindingJwt,
  verifyKeyBindingJwt
} from './sd-jwt/keyBinding.js'
export {
  publicKeyToJwk,
  privateKeyToJwk,
  jwkToPublicKey,
  signCompact,
  verifyCompact
} from './utils/crypto.js'
export {
  decodeJwt,
  signJwt,
  verifyJwt
} from './utils/jwt.js'
export {
  base64UrlDecode,
  base64UrlDecodeJson,
  base64UrlEncode,
  base64UrlEncodeJson
} from './utils/base64url.js'
export {
  decodeDidKey,
  encodeBase58Multibase,
  publicKeyFromDid,
  publicKeyToDidKey,
  verificationMethodForDid
} from './utils/multibase.js'
