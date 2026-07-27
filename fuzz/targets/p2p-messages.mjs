import { decodeMessage, tryDecodeMessage } from '../../packages/network/ts-p2p/dist/messages.js'
import { deepEqual, invariant, utf8 } from '../lib.mjs'

const encoder = new TextEncoder()

export function fuzz(data) {
  const raw = Uint8Array.from(data.subarray(0, 65_536))
  const tolerant = tryDecodeMessage(raw)
  if (tolerant !== null) {
    deepEqual(decodeMessage(raw), tolerant, 'P2P strict and tolerant decoders diverged')
    invariant(typeof tolerant.sender === 'string', 'P2P decoder returned a non-string sender')
    invariant(
      tolerant.payload !== null &&
        typeof tolerant.payload === 'object' &&
        !Array.isArray(tolerant.payload),
      'P2P decoder returned a non-object payload'
    )
  }

  const sender = utf8(data.subarray(0, 128), 128)
  const payload = {
    fuzz: data.subarray(128, 4096).toString('base64'),
    length: data.length
  }
  const inner = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  const frame = encoder.encode(JSON.stringify({ name: sender, data: inner }))
  deepEqual(decodeMessage(frame), { sender, payload }, 'P2P generated envelope round trip')
}
