import {
  decodeBinaryJsonValue,
  parseJsonRpc,
  stringifyJsonRpc
} from '../../packages/wallet/wallet-toolbox/out/src/storage/remoting/BinaryJson.js'
import { attempt, equalBytes, invariant, utf8 } from '../lib.mjs'

export function fuzz(data) {
  const bytes = Uint8Array.from(data.subarray(0, 65_536))
  const value = {
    bytes,
    nested: {
      copy: bytes.slice().reverse(),
      length: bytes.length
    }
  }
  const decoded = parseJsonRpc(stringifyJsonRpc(value, true), true)
  equalBytes(decoded.bytes, bytes, 'Wallet binary JSON top-level byte round trip')
  equalBytes(
    decoded.nested.copy,
    bytes.slice().reverse(),
    'Wallet binary JSON nested byte round trip'
  )
  invariant(decoded.nested.length === bytes.length, 'Wallet binary JSON scalar changed')

  const before = Object.prototype.polluted
  const parsed = attempt(() => parseJsonRpc(utf8(data, 65_536), true))
  if (parsed.ok) {
    decodeBinaryJsonValue(parsed.value)
  }
  invariant(Object.prototype.polluted === before, 'Wallet binary JSON polluted Object.prototype')
}
