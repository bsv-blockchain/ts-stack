import { Utils } from '../../packages/sdk/dist/esm/mod.js'
import {
  convertValueToArray,
  writeHeaderPair
} from '../../packages/middleware/auth-express-middleware/dist/src/authMiddlewareHelpers.mjs'
import { attempt, equalBytes, invariant, utf8 } from '../lib.mjs'

function readString(reader) {
  return Utils.toUTF8(reader.read(reader.readVarIntNum()))
}

export function fuzz(data) {
  const split = Math.floor(data.length / 2)
  const key = utf8(data.subarray(0, split), 2048)
  const value = utf8(data.subarray(split), 8192)
  const writer = new Utils.Writer()
  writeHeaderPair(writer, key, value)
  const reader = new Utils.Reader(writer.toArray())
  invariant(readString(reader) === key, 'Auth middleware changed a header key')
  invariant(readString(reader) === value, 'Auth middleware changed a header value')
  invariant(reader.pos === reader.bin.length, 'Auth middleware left ambiguous header bytes')

  const prefix = data.subarray(0, Math.min(data.length, 16))
  const suffix = data.subarray(Math.max(0, data.length - 16))
  const backing = Uint8Array.from([...prefix, ...data, ...suffix])
  const view = new Uint8Array(backing.buffer, prefix.length, data.length)
  equalBytes(
    convertValueToArray(view, {}),
    Array.from(data),
    'Auth middleware included adjacent typed-array bytes'
  )

  const before = Object.prototype.polluted
  const parsed = attempt(() => JSON.parse(utf8(data, 65_536)))
  if (parsed.ok) {
    const headers = {}
    const first = convertValueToArray(parsed.value, headers)
    const second = convertValueToArray(parsed.value, {})
    equalBytes(first, second, 'Auth response serialization was nondeterministic')
  }
  invariant(Object.prototype.polluted === before, 'Auth middleware polluted Object.prototype')
}
