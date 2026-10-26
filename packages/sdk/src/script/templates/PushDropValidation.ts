import PublicKey from '../../primitives/PublicKey.js'
import { toArray } from '../../primitives/utils.js'
import LockingScript from '../LockingScript.js'
import OP from '../OP.js'
import PushDrop from './PushDrop.js'

export interface CanonicalPushDropLimits {
  fieldCount: number | readonly number[]
  maximumFieldBytes: number
  maximumPayloadBytes: number
}

function minimallyEncodedChunk(data: number[]): { op: number; data?: number[] } {
  if (data.length === 0 || (data.length === 1 && data[0] === 0)) return { op: 0 }
  if (data.length === 1 && data[0] >= 1 && data[0] <= 16) {
    return { op: 0x50 + data[0] }
  }
  if (data.length === 1 && data[0] === 0x81) return { op: 0x4f }
  if (data.length <= 75) return { op: data.length, data }
  if (data.length <= 0xff) return { op: 0x4c, data }
  if (data.length <= 0xffff) return { op: 0x4d, data }
  return { op: 0x4e, data }
}

function assertLimits(limits: CanonicalPushDropLimits): number[] {
  const counts = Array.isArray(limits.fieldCount) ? [...limits.fieldCount] : [limits.fieldCount]
  if (
    counts.length === 0 ||
    counts.some(count => !Number.isSafeInteger(count) || count < 1 || count > 64) ||
    !Number.isSafeInteger(limits.maximumFieldBytes) ||
    limits.maximumFieldBytes < 1 ||
    !Number.isSafeInteger(limits.maximumPayloadBytes) ||
    limits.maximumPayloadBytes < limits.maximumFieldBytes
  ) {
    throw new Error('PushDrop validation limits are invalid')
  }
  return counts
}

function canonicalScript(lockingPublicKey: PublicKey, fields: number[][]): LockingScript {
  const chunks: Array<{ op: number; data?: number[] }> = [
    { op: 33, data: toArray(lockingPublicKey.toString(), 'hex') },
    { op: OP.OP_CHECKSIG },
    ...fields.map(minimallyEncodedChunk)
  ]
  for (let remaining = fields.length; remaining > 1; remaining -= 2) {
    chunks.push({ op: OP.OP_2DROP })
  }
  if (fields.length % 2 === 1) chunks.push({ op: OP.OP_DROP })
  return new LockingScript(chunks)
}

/** Decode a PushDrop token only when its entire script is canonical and bounded. */
export function decodeCanonicalPushDrop(
  lockingScript: LockingScript,
  limits: CanonicalPushDropLimits
): { lockingPublicKey: PublicKey; fields: number[][] } {
  const counts = assertLimits(limits)
  const decoded = PushDrop.decode(lockingScript)
  if (!counts.includes(decoded.fields.length)) {
    throw new Error('Unexpected PushDrop token field count')
  }
  let payloadBytes = 0
  for (const field of decoded.fields) {
    if (!Array.isArray(field) || field.length > limits.maximumFieldBytes) {
      throw new Error('PushDrop token contains an oversized field')
    }
    payloadBytes += field.length
    if (payloadBytes > limits.maximumPayloadBytes) {
      throw new Error('PushDrop token payload is too large')
    }
  }
  if (canonicalScript(decoded.lockingPublicKey, decoded.fields).toHex() !== lockingScript.toHex()) {
    throw new Error('PushDrop token must use the canonical PushDrop envelope')
  }
  return decoded
}
