import { fromB64url, toB64url } from '../src/base64url'
import { message } from './helpers'

describe('base64url', () => {
  it('round-trips arbitrary byte lengths', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 14, 1214, 40000]) {
      const bytes = message(len)
      expect(Array.from(fromB64url(toB64url(bytes)))).toEqual(Array.from(bytes))
    }
  })

  it('emits unpadded, URL-safe text only', () => {
    const text = toB64url(new Uint8Array([0xfb, 0xff, 0xbf, 0x00]))
    expect(text).toMatch(/^[\w-]+$/)
    expect(text).not.toContain('=')
    expect(text).not.toContain('+')
    expect(text).not.toContain('/')
  })

  it('produces the canonical mapping of the base64 alphabet', () => {
    // 0xfb 0xff 0xbf covers the two characters that differ from plain base64.
    expect(toB64url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('-_-_')
    expect(Array.from(fromB64url('-_-_'))).toEqual([0xfb, 0xff, 0xbf])
  })

  it('encodes the empty input as the empty string', () => {
    expect(toB64url(new Uint8Array(0))).toBe('')
    expect(fromB64url('').length).toBe(0)
  })

  it('rejects characters outside the base64url alphabet', () => {
    // `atob` strips ASCII whitespace and accepts standard base64 punctuation,
    // so these have to be rejected here or the same wire part would decode on
    // one runtime and not another.
    for (const text of ['AA AA', 'AA\nAA', 'AAA+', 'AAA/', 'AAAA=', 'AA.AA', 'AAAé']) {
      expect(() => fromB64url(text)).toThrow(/invalid base64url/)
    }
  })

  it('rejects a length that cannot encode whole bytes', () => {
    expect(() => fromB64url('A')).toThrow(/invalid base64url length/)
    expect(() => fromB64url('AAAAA')).toThrow(/invalid base64url length/)
  })

  it('accepts every unpadded body length that can encode bytes', () => {
    expect(fromB64url('AA').length).toBe(1)
    expect(fromB64url('AAA').length).toBe(2)
    expect(fromB64url('AAAA').length).toBe(3)
  })
})
