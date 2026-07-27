import { allowlistIssuerPolicy } from '../../packages/overlays/topics/dist/admission/issuerPolicy.js'
import {
  decodeLinkagePayload,
  encodeLinkagePayload
} from '../../packages/overlays/topics/dist/mandala/types.js'
import { attempt, deepEqual, equalBytes, invariant, utf8 } from '../lib.mjs'

const encoder = new TextEncoder()

function linkage(data, offset) {
  const key = start =>
    Buffer.from(data.subarray(start, start + 33))
      .toString('hex')
      .padEnd(66, '0')
  return {
    prover: key(offset),
    verifier: key(offset + 33),
    counterparty: key(offset + 66),
    protocolID: [(data[offset + 99] ?? 0) % 3, utf8(data.subarray(offset + 100, offset + 164), 64)],
    keyID: data.subarray(offset + 164, offset + 196).toString('base64url'),
    encryptedLinkage: Array.from(data.subarray(offset + 196, offset + 260)),
    encryptedLinkageProof: Array.from(data.subarray(offset + 260, offset + 324)),
    proofType: data[offset + 324] ?? 0
  }
}

export function fuzz(data) {
  const raw = attempt(() => decodeLinkagePayload(Array.from(data.subarray(0, 65_536))))
  if (raw.ok) {
    equalBytes(
      encodeLinkagePayload(raw.value),
      Array.from(encoder.encode(JSON.stringify(raw.value))),
      'Overlay linkage decoder returned a value that cannot be encoded deterministically'
    )
  }

  const indexes = Buffer.alloc(3)
  data.copy(indexes, 0, 0, Math.min(data.length, indexes.length))
  const payload = {
    inputs: [{ index: indexes.readUInt16LE(0), linkage: linkage(data, 2) }],
    outputs: [{ index: indexes.readUInt16LE(1), linkage: linkage(data, 3) }]
  }
  const encoded = encodeLinkagePayload(payload)
  equalBytes(
    encoded,
    Array.from(encoder.encode(JSON.stringify(payload))),
    'Overlay linkage encoding diverged from canonical UTF-8 JSON'
  )
  deepEqual(decodeLinkagePayload(encoded), payload, 'Overlay linkage payload round trip')

  const values = utf8(data, 8192).split('\0').slice(0, 64)
  const allowed = values.filter((_, index) => index % 2 === 0)
  const policy = allowlistIssuerPolicy(allowed)
  for (const value of values) {
    invariant(
      policy.allowIssuance(value) === allowed.includes(value),
      'Overlay issuer policy changed exact allowlist membership'
    )
  }
}
