import { Utils } from '../../packages/sdk/dist/esm/mod.js'
import { attempt, deepEqual, equalBytes, invariant, utf8 } from '../lib.mjs'

export function fuzz(data) {
  const bytes = Array.from(data.subarray(0, 4096))
  if (bytes.length > 0) {
    equalBytes(Utils.fromBase58(Utils.toBase58(bytes)), bytes, 'SDK Base58 byte round trip')
  }

  const raw = utf8(data, 4096)
  const decoded = attempt(() => Utils.fromBase58(raw))
  if (decoded.ok) {
    invariant(Utils.toBase58(decoded.value) === raw, 'SDK Base58 accepted non-canonical text')
  }

  const prefixLength = Math.min(4, Math.max(1, bytes.length === 0 ? 1 : (bytes[0] % 4) + 1))
  const prefix = bytes.slice(0, prefixLength)
  while (prefix.length < prefixLength) prefix.push(0)
  const payload = bytes.slice(prefixLength)
  const checked = Utils.toBase58Check(payload, prefix)
  deepEqual(
    Utils.fromBase58Check(checked, undefined, prefix.length),
    { prefix, data: payload },
    'SDK Base58Check prefix and payload round trip'
  )
}
