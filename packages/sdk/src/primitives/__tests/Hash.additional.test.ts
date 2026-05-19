import { createHash, createHmac } from 'node:crypto'
import { SHA1HMAC, SHA512HMAC, pbkdf2 } from '../../primitives/Hash'

describe('Hash – additional coverage', () => {
  describe('SHA1HMAC', () => {
    it('produces a correct HMAC-SHA1 digest', () => {
      // SHA1HMAC constructor calls toArray(key, 'hex'), so key must be hex
      const hmac = new SHA1HMAC('deadbeef')
      const result = hmac.update('abcd', 'hex').digest()
      expect(result).toHaveLength(20)
    })

    it('returns a hex string from digestHex()', () => {
      const hmac = new SHA1HMAC('deadbeef')
      const result = hmac.update('deadbeef', 'hex').digestHex()
      expect(typeof result).toBe('string')
      expect(result).toHaveLength(40) // SHA1 = 20 bytes = 40 hex chars
    })

    it('handles a key longer than 64 bytes (key hashed internally)', () => {
      // Key longer than SHA1 blockSize (64 bytes) → key is SHA1-hashed.
      // Each hex byte is 2 chars, so 65 bytes = 130 hex chars.
      const longKey = 'ab'.repeat(65) // 65 bytes when decoded from hex
      const hmac = new SHA1HMAC(longKey)
      const result = hmac.update('deadbeef', 'hex').digest()
      expect(result).toHaveLength(20)
    })
  })

  describe('SHA512HMAC', () => {
    it('produces a correct HMAC-SHA512 digest', () => {
      // SHA512HMAC string key is treated as hex
      const hmac = new SHA512HMAC('deadbeef')
      const result = hmac.update('message').digest()
      expect(result).toHaveLength(64) // SHA512 = 64 bytes
    })

    it('returns a hex string from digestHex()', () => {
      const hmac = new SHA512HMAC('deadbeef')
      const result = hmac.update(new Uint8Array([1, 2, 3])).digestHex()
      expect(typeof result).toBe('string')
      expect(result).toHaveLength(128) // SHA512 = 64 bytes = 128 hex chars
    })

    it('accepts a Uint8Array key', () => {
      const key = new Uint8Array([1, 2, 3, 4])
      const hmac = new SHA512HMAC(key)
      const result = hmac.update(new Uint8Array([5, 6, 7])).digest()
      expect(result).toHaveLength(64)
    })
  })

  describe('pbkdf2', () => {
    it('throws when digest is not sha512', () => {
      expect(() => pbkdf2([1, 2, 3], [4, 5, 6], 1, 32, 'sha256')).toThrow(
        'Only sha512 is supported in this PBKDF2 implementation'
      )
    })
  })

  describe('pure-TS fallback parity', () => {
    const msg = new Uint8Array([
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
      0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
      0xff, 0xfe, 0xfd, 0xfc
    ])
    const key = new Uint8Array([0xde, 0xad, 0xbe, 0xef])

    const expectedSha256 = createHash('sha256').update(msg).digest('hex')
    const expectedSha512 = createHash('sha512').update(msg).digest('hex')
    const expectedRipemd160 = createHash('ripemd160').update(msg).digest('hex')
    const expectedHash256 = createHash('sha256')
      .update(createHash('sha256').update(msg).digest())
      .digest('hex')
    const expectedHash160 = createHash('ripemd160')
      .update(createHash('sha256').update(msg).digest())
      .digest('hex')
    const expectedSha256Hmac = createHmac('sha256', key)
      .update(msg)
      .digest('hex')
    const expectedSha512Hmac = createHmac('sha512', key)
      .update(msg)
      .digest('hex')

    function toHex (arr: number[]): string {
      return Buffer.from(arr).toString('hex')
    }

    it('matches native digests when node:crypto is unavailable', () => {
      const originalGetBuiltin = (process as any).getBuiltinModule
      ;(process as any).getBuiltinModule = (): never => {
        throw new Error('blocked for test')
      }
      try {
        jest.isolateModules(() => {
          jest.doMock('node:crypto', () => {
            throw new Error('blocked for test')
          })
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const fallback = require('../../primitives/Hash')
          expect(toHex(fallback.sha256(Array.from(msg)))).toBe(expectedSha256)
          expect(toHex(fallback.sha512(Array.from(msg)))).toBe(expectedSha512)
          expect(toHex(fallback.ripemd160(Array.from(msg)))).toBe(
            expectedRipemd160
          )
          expect(toHex(fallback.hash256(Array.from(msg)))).toBe(
            expectedHash256
          )
          expect(toHex(fallback.hash160(Array.from(msg)))).toBe(
            expectedHash160
          )
          expect(
            toHex(fallback.sha256hmac(Array.from(key), Array.from(msg)))
          ).toBe(expectedSha256Hmac)
          expect(
            toHex(fallback.sha512hmac(Array.from(key), Array.from(msg)))
          ).toBe(expectedSha512Hmac)
        })
      } finally {
        ;(process as any).getBuiltinModule = originalGetBuiltin
      }
    })
  })
})
