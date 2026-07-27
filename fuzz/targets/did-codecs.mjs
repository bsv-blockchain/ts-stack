import {
  base64UrlDecode,
  base64UrlEncode
} from '../../packages/helpers/did/dist/src/utils/base64url.js'
import {
  decodeBase58Multibase,
  encodeBase58Multibase
} from '../../packages/helpers/did/dist/src/utils/multibase.js'
import { attempt, equalBytes, invariant, utf8 } from '../lib.mjs'

export function fuzz(data) {
  const bytes = Array.from(data.subarray(0, 4096))
  equalBytes(base64UrlDecode(base64UrlEncode(bytes)), bytes, 'DID base64url byte round trip')
  if (bytes.length > 0) {
    equalBytes(
      decodeBase58Multibase(encodeBase58Multibase(bytes)),
      bytes,
      'DID base58-btc multibase byte round trip'
    )
  }

  const raw = utf8(data, 4096)
  const decodedBase64 = attempt(() => base64UrlDecode(raw))
  if (decodedBase64.ok) {
    invariant(base64UrlEncode(decodedBase64.value) === raw, 'DID accepted non-canonical base64url')
  }
  const decodedMultibase = attempt(() => decodeBase58Multibase(raw))
  if (decodedMultibase.ok) {
    invariant(
      encodeBase58Multibase(decodedMultibase.value) === raw,
      'DID accepted non-canonical base58-btc multibase'
    )
  }
}
