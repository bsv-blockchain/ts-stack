import { createCipheriv, createDecipheriv } from 'node:crypto'
import { AESGCM, AESGCMDecrypt } from '../AESGCM'
import type SymmetricKey from '../SymmetricKey'

// Independent native oracle; the primitives below always use portable AES/GHASH.
describe.each([16, 24, 32])('portable AES-GCM with a %i-byte key', keyLength => {
  const key = new Uint8Array(keyLength).fill(7)

  describe.each([12, 32])('%i-byte IV', ivLength => {
    const iv = new Uint8Array(ivLength).fill(9)

    it.each([0, 1, 15, 16, 17, 64])('authenticates %i plaintext bytes across runtimes', size => {
      const plaintext = new Uint8Array(size).fill(42)
      const cipher = createCipheriv(`aes-${keyLength * 8}-gcm`, key, iv)
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const tag = cipher.getAuthTag()
      const portable = AESGCM(plaintext, iv, key)

      expect(portable.result).toEqual(new Uint8Array(ciphertext))
      expect(portable.authenticationTag).toEqual(new Uint8Array(tag))
      expect(AESGCMDecrypt(ciphertext, iv, tag, key)).toEqual(plaintext)

      const decipher = createDecipheriv(`aes-${keyLength * 8}-gcm`, key, iv)
      decipher.setAuthTag(portable.authenticationTag)
      expect(Buffer.concat([decipher.update(portable.result), decipher.final()])).toEqual(
        Buffer.from(plaintext)
      )

      for (let index = 0; index < tag.length; index++) {
        const changed = Uint8Array.from(tag)
        changed[index] ^= 1
        expect(AESGCMDecrypt(ciphertext, iv, changed, key)).toBeNull()
      }
      for (const tagLength of [0, 1, 12, 15, 17]) {
        const changed = new Uint8Array(tagLength)
        changed.set(tag.subarray(0, tagLength))
        expect(AESGCMDecrypt(ciphertext, iv, changed, key)).toBeNull()
      }
      expect(AESGCMDecrypt(ciphertext, iv, tag, new Uint8Array(keyLength).fill(8))).toBeNull()
      expect(AESGCMDecrypt(ciphertext, new Uint8Array(ivLength).fill(8), tag, key)).toBeNull()
      if (size > 0) {
        const changed = Uint8Array.from(ciphertext)
        changed[0] ^= 1
        expect(AESGCMDecrypt(changed, iv, tag, key)).toBeNull()
      }
    })
  })
})

describe('portable SymmetricKey empty envelopes', () => {
  it('authenticates native and portable empty envelopes with the Node fast path unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule')
    Object.defineProperty(process, 'getBuiltinModule', { configurable: true, value: undefined })
    try {
      jest.isolateModules(() => {
        const PortableKey = require('../SymmetricKey').default as typeof SymmetricKey
        const key = new Uint8Array(32).fill(7)
        const iv = new Uint8Array(32).fill(9)
        const cipher = createCipheriv('aes-256-gcm', key, iv)
        cipher.final()
        const nativeEnvelope = [...iv, ...cipher.getAuthTag()]
        const symmetricKey = new PortableKey([...key])
        expect(symmetricKey.decrypt(nativeEnvelope)).toEqual([])
        expect(symmetricKey.decrypt(nativeEnvelope, 'utf8')).toBe('')
        const portableEnvelope = symmetricKey.encrypt([]) as number[]
        expect(portableEnvelope).toHaveLength(48)
        expect(symmetricKey.decrypt(portableEnvelope)).toEqual([])
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key,
          new Uint8Array(portableEnvelope.slice(0, 32))
        )
        decipher.setAuthTag(new Uint8Array(portableEnvelope.slice(32)))
        expect(decipher.final()).toHaveLength(0)
        for (let index = 32; index < 48; index++) {
          const changed = [...nativeEnvelope]
          changed[index] ^= 1
          expect(() => symmetricKey.decrypt(changed)).toThrow('Decryption failed')
        }
        expect(() => symmetricKey.decrypt(nativeEnvelope.slice(0, 47))).toThrow('too short')
        expect(() =>
          new PortableKey([...new Uint8Array(32).fill(8)]).decrypt(nativeEnvelope)
        ).toThrow('Decryption failed')
      })
    } finally {
      if (descriptor !== undefined) Object.defineProperty(process, 'getBuiltinModule', descriptor)
      else Reflect.deleteProperty(process, 'getBuiltinModule')
    }
  })
})
