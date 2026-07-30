import { crc32 } from '../src/crc32'
import { message } from './helpers'

describe('crc32', () => {
  it('matches the standard check vector', () => {
    // The IEEE CRC-32 "check" value: crc32(ascii "123456789") is 0xCBF43926.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('is 0 for no bytes', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('matches known single-byte vectors', () => {
    expect(crc32(new Uint8Array([0x00]))).toBe(0xd202ef8d)
    expect(crc32(new Uint8Array([0xff]))).toBe(0xff000000)
  })

  it('returns an unsigned 32-bit value even when the high bit is set', () => {
    const value = crc32(new Uint8Array([0x00]))
    expect(value).toBeGreaterThan(0x7fffffff)
    expect(value >>> 0).toBe(value)
  })

  it('is order sensitive', () => {
    expect(crc32(new Uint8Array([1, 2]))).not.toBe(crc32(new Uint8Array([2, 1])))
  })

  it('detects a single flipped bit in a large payload', () => {
    const clean = message(4096)
    const dirty = message(4096)
    dirty[2048] ^= 0x01
    expect(crc32(dirty)).not.toBe(crc32(clean))
  })

  it('reads only the bytes of a subarray view', () => {
    const backing = new Uint8Array([0xaa, 0x31, 0x32, 0x33, 0xbb])
    expect(crc32(backing.subarray(1, 4))).toBe(crc32(new TextEncoder().encode('123')))
  })
})
