/**
 * Transport dispatcher — air-gap optical transport (BRC-141).
 *
 * Categories:
 *   air-gap-optical — wire protocol v1 of @bsv/air-gap: deterministic
 *     fountain-coded part encoding, camera-safe decoding, session locking,
 *     and hostile-input rejection.
 *
 * Vector operations (input.operation):
 *   crc32            — IEEE CRC-32 check value of a hex payload
 *   part-char-length — exact rendered part length for a block size
 *   encode-part      — one deterministic part string for
 *                      (message, blockBytes, sessionId, seq)
 *   decode           — feed parts in order; the message must complete and
 *                      match the expected hex exactly
 *   progress         — feed parts in order; assert final progress counters
 *                      (used for the linear-dependence stall regression)
 *   accept-one       — a single scanned string must be rejected without a
 *                      throw and without producing a message
 *
 * Binary data is lowercase hex in the vectors (corpus convention); part
 * strings travel verbatim since they are the wire format under test.
 */

import { expect } from '@jest/globals'
import { AirGapDecoder, AirGapEncoder, crc32, estimatePartCharLength } from '@bsv/air-gap'

export const categories: ReadonlyArray<string> = ['air-gap-optical']

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function getString(m: Record<string, unknown>, key: string): string {
  const v = m[key]
  return typeof v === 'string' ? v : ''
}

function getNumber(m: Record<string, unknown>, key: string): number {
  const v = m[key]
  return typeof v === 'number' ? v : Number.NaN
}

function getStrings(m: Record<string, unknown>, key: string): string[] {
  const v = m[key]
  return Array.isArray(v) ? v.filter((item): item is string => typeof item === 'string') : []
}

export function dispatch(
  category: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  if (category !== 'air-gap-optical') {
    throw new Error(`not implemented: transport category '${category}'`)
  }
  const operation = getString(input, 'operation')
  switch (operation) {
    case 'crc32': {
      const value = crc32(hexToBytes(getString(input, 'message_hex')))
      expect(value.toString(16).padStart(8, '0')).toBe(expected.crc32_hex)
      return
    }
    case 'part-char-length': {
      expect(estimatePartCharLength(getNumber(input, 'block_bytes'))).toBe(expected.chars)
      return
    }
    case 'encode-part': {
      const encoder = new AirGapEncoder(hexToBytes(getString(input, 'message_hex')), {
        blockBytes: getNumber(input, 'block_bytes'),
        sessionId: hexToBytes(getString(input, 'session_id_hex'))
      })
      expect(encoder.partAt(getNumber(input, 'seq'))).toBe(expected.part)
      return
    }
    case 'decode': {
      const decoder = new AirGapDecoder()
      let done = false
      for (const part of getStrings(input, 'parts')) done = decoder.accept(part).done || done
      expect(done).toBe(true)
      const out = decoder.message()
      expect(out).not.toBeNull()
      expect(bytesToHex(out as Uint8Array)).toBe(expected.message_hex)
      return
    }
    case 'progress': {
      const decoder = new AirGapDecoder()
      let last = decoder.accept('')
      for (const part of getStrings(input, 'parts')) last = decoder.accept(part)
      expect(last.have).toBe(expected.have)
      expect(last.total).toBe(expected.total)
      expect(last.done).toBe(expected.done)
      return
    }
    case 'accept-one': {
      const decoder = new AirGapDecoder()
      expect(decoder.accept(getString(input, 'text')).ok).toBe(expected.ok)
      expect(decoder.message()).toBeNull()
      return
    }
    default:
      throw new Error(`not implemented: transport operation '${operation}'`)
  }
}
