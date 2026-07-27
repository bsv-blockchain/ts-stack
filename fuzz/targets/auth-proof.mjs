import {
  checkAuthSigData,
  normalizeBody,
  serializeAuthSigData,
  serializeSignablePayload
} from '../../packages/middleware/auth/dist/index.mjs'
import { attempt, deepEqual, equalBytes, invariant, utf8 } from '../lib.mjs'

export function fuzz(data) {
  const prefixLength = Math.min(data.length, data[0] ?? 0)
  const suffixLength = Math.min(data.length - prefixLength, data[1] ?? 0)
  const backing = Uint8Array.from([
    ...data.subarray(0, prefixLength),
    ...data,
    ...data.subarray(data.length - suffixLength)
  ])
  const view = new Uint8Array(backing.buffer, prefixLength, data.length)
  equalBytes(normalizeBody(view), Array.from(data), 'Auth body included adjacent backing bytes')

  const action = utf8(data.subarray(0, 128), 128)
  const identityKey = data.subarray(128, 192).toString('hex') || 'identity'
  const nonce = data.subarray(192, 256).toString('base64') || 'nonce'
  const now = 1_800_000_000_000
  const offset = ((((data[256] ?? 0) << 8) | (data[257] ?? 0)) % 60_000) + 1
  const sigData = { action, identityKey, nonce, expiresAt: now + offset }
  deepEqual(
    checkAuthSigData(sigData, action, now, { windowMs: 60_000, clockSkewMs: 0 }),
    { valid: true },
    'Auth proof rejected an in-window generated payload'
  )
  deepEqual(
    serializeSignablePayload(sigData),
    serializeAuthSigData(sigData),
    'Bodyless auth proof framing changed'
  )
  invariant(
    !Buffer.from(serializeSignablePayload(sigData)).equals(
      Buffer.from(serializeSignablePayload(sigData, ''))
    ),
    'Bodyless and empty-body auth proofs collided'
  )

  const raw = attempt(() => JSON.parse(utf8(data, 8192)))
  if (raw.ok) {
    const result = checkAuthSigData(raw.value, action, now, {
      windowMs: 60_000,
      clockSkewMs: 0
    })
    invariant(typeof result.valid === 'boolean', 'Auth proof validator result is not boolean')
  }
}
