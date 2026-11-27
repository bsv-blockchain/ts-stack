import {
  bigintToBe,
  bitLength,
  bytesToHex,
  concatBytes,
  hexToBytes,
  leToBigint,
  utf8,
  wipe
} from '../bytes.js'
import { hkdfExpand, hkdfExtract, sha256 } from '../hkdf.js'
import { forcePrimeShape, isProbablePrime, mod, modPow } from '../primes.js'
import {
  deriveRabinFactors,
  isQuadraticResidue,
  isRabinModulusBits,
  principalCrtRoot,
  rabinSign,
  verifyRabinSignature
} from '../rabin.js'
import {
  decodePushes,
  decodeScriptNumber,
  encodePush,
  encodeScriptNumber
} from '../scriptNumber.js'
import { decodeRabinKey, decodeRabinSignature } from '../RabinPermissionModule.js'

describe('Rabin math', () => {
  it('matches the RFC 5869 SHA-256 HKDF test vector', async () => {
    const ikm = hexToBytes('0b'.repeat(22))
    const salt = hexToBytes('000102030405060708090a0b0c')
    const info = hexToBytes('f0f1f2f3f4f5f6f7f8f9')
    const prk = await hkdfExtract(salt, ikm)
    const okm = await hkdfExpand(prk, info, 42)
    expect(bytesToHex(prk)).toBe('077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5')
    expect(bytesToHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'
    )
    await expect(hkdfExpand(prk, info, 0)).rejects.toThrow('HKDF length')
    await expect(hkdfExpand(prk, info, Number.NaN)).rejects.toThrow('HKDF length')
    await expect(hkdfExpand(prk, info, 255 * 32 + 1)).rejects.toThrow('HKDF length')
  })

  it('round-trips minimal script numbers, including the sign-bit padding byte', () => {
    for (const value of [0n, 1n, 127n, 128n, 255n, 256n, 65535n, 1n << 2048n]) {
      const encoded = encodeScriptNumber(value)
      expect(decodeScriptNumber(encoded)).toBe(value)
      if (value !== 0n && (encoded[encoded.length - 1] ?? 0) === 0) {
        const padded = encoded.slice(0, -1)
        expect(() => decodeScriptNumber(padded)).toThrow('negative')
      }
    }
    expect([...encodeScriptNumber(0n)]).toEqual([])
    expect([...encodeScriptNumber(128n)]).toEqual([128, 0])
    const nonMinimal = new Uint8Array([0x01, 0x00])
    expect(() => decodeScriptNumber(nonMinimal)).toThrow('non-minimal')
    expect(() => encodeScriptNumber(-1n)).toThrow('non-negative')
    expect(() => decodeScriptNumber(new Uint8Array([0x80]))).toThrow('negative')

    const direct = encodePush(new Uint8Array(80).fill(2))
    expect(direct[0]).toBe(0x4c)
    expect(decodePushes(direct)[0]).toEqual(new Uint8Array(80).fill(2))
    const wide = encodePush(new Uint8Array(300).fill(2))
    expect(wide[0]).toBe(0x4d)
    expect(decodePushes(wide)[0]?.length).toBe(300)
    expect(decodePushes(encodePush(Uint8Array.of(0x81)))).toEqual([Uint8Array.of(0x81)])
    expect(() => encodePush(new Uint8Array(65_536))).toThrow('PUSHDATA2')
    expect(() => decodePushes(Uint8Array.of(0x4c))).toThrow('PUSHDATA1')
    expect(() => decodePushes(Uint8Array.of(0x4d))).toThrow('PUSHDATA2')
    expect(() => decodePushes(Uint8Array.of(0x4d, 0x01))).toThrow('PUSHDATA2')
    expect(() => decodePushes(Uint8Array.of(0x4e))).toThrow('non-push')
    expect(() => decodePushes(Uint8Array.of(0x02, 0x01))).toThrow('truncated script push')
    expect(() => decodeRabinKey([])).toThrow('one script push')
    expect(() => decodeRabinKey([0x51, 0x51])).toThrow('one script push')
    expect(() => decodeRabinKey([0x01, 0x80])).toThrow('negative')
    expect(() => decodeRabinSignature([0x51])).toThrow('two script pushes')
  })

  it('accepts the fixed witness set for small primes and rejects composites', () => {
    expect(isProbablePrime(2n)).toBe(true)
    expect(isProbablePrime(3n)).toBe(true)
    expect(isProbablePrime(5n)).toBe(true)
    expect(isProbablePrime(1n)).toBe(false)
    expect(isProbablePrime(4n)).toBe(false)
    expect(isProbablePrime(9n)).toBe(false)
    expect(isProbablePrime(15n)).toBe(false)
    expect(isProbablePrime(7919n)).toBe(true)
    // 4129 ≡ 1 (mod 8), so witness 2 reaches −1 only after squaring.
    expect(isProbablePrime(4129n)).toBe(true)
    // Both factors are above the trial limit. 4111 × 4127 never produces −1.
    expect(isProbablePrime(4111n * 4127n)).toBe(false)
    // 10177 × 12721 fails witness 2 by squaring a nontrivial root of 1.
    expect(isProbablePrime(10177n * 12721n)).toBe(false)
    expect(modPow(2n, 10n, 1000n)).toBe(24n)
    expect(modPow(2n, 0n, 5n)).toBe(1n)
    expect(mod(-3n, 5n)).toBe(2n)
    expect(() => modPow(2n, -1n, 5n)).toThrow('exponent')
    expect(() => modPow(2n, 1n, 0n)).toThrow('modulus')
    expect(isQuadraticResidue(0n, 7n)).toBe(true)
    expect(isQuadraticResidue(3n, 7n)).toBe(false)
    const shaped = forcePrimeShape(new Uint8Array(16))
    expect(shaped % 4n).toBe(3n)
    expect(bitLength(shaped)).toBe(128)
    expect(bitLength(0n)).toBe(0)
    expect(bitLength(-1n)).toBe(0)
  })

  it('signs with the smallest padding and the principal CRT root', async () => {
    const p = 7n
    const q = 11n
    const message = new Uint8Array([1, 2, 3, 4])
    const signed = await rabinSign(message, p, q)
    const hashMod = mod(leToBigint(await sha256(message)), signed.modulus)
    expect(
      await verifyRabinSignature(message, signed.signature, signed.padding, signed.modulus)
    ).toBe(true)
    for (let smaller = 0n; smaller < signed.padding; smaller++) {
      const target = mod(hashMod - smaller, signed.modulus)
      expect(isQuadraticResidue(target, p) && isQuadraticResidue(target, q)).toBe(false)
    }
    const target = mod(hashMod - signed.padding, signed.modulus)
    expect(
      principalCrtRoot(modPow(target, (p + 1n) / 4n, p), p, modPow(target, (q + 1n) / 4n, q), q)
    ).toBe(signed.signature)
    expect(mod(signed.modulus - signed.signature, signed.modulus)).not.toBe(signed.signature)
    const digest = leToBigint(await sha256(message))
    expect(await verifyRabinSignature(message, 0n, digest, signed.modulus)).toBe(false)
    expect(
      await verifyRabinSignature(message, signed.signature, signed.padding + 1n, signed.modulus)
    ).toBe(false)
    await expect(rabinSign(message, q, p)).rejects.toThrow('p < q')
    await expect(rabinSign(message, 5n, 7n)).rejects.toThrow('3 mod 4')
    expect(await verifyRabinSignature(message, -1n, 0n, signed.modulus)).toBe(false)
    expect(await verifyRabinSignature(message, 0n, -1n, signed.modulus)).toBe(false)
    expect(await verifyRabinSignature(message, 0n, 65536n, signed.modulus)).toBe(false)
    expect(await verifyRabinSignature(message, 0n, 0n, 0n)).toBe(false)
    expect(isRabinModulusBits(2048)).toBe(true)
    expect(isRabinModulusBits(3072)).toBe(true)
    expect(isRabinModulusBits(4096)).toBe(true)
    expect(isRabinModulusBits(1024)).toBe(false)
    await expect(deriveRabinFactors(new Uint8Array(31), 2048)).rejects.toThrow('32 bytes')
    await expect(deriveRabinFactors(new Uint8Array(32), 1024 as never)).rejects.toThrow(
      '2048, 3072, or 4096'
    )
    expect(() => hexToBytes('abc')).toThrow('hex')
    expect(() => hexToBytes('zz')).toThrow('hex')
    expect(() => bigintToBe(-1n, 1)).toThrow('non-negative')
    expect(() => bigintToBe(256n, 1)).toThrow('does not fit')
    expect(utf8('ab')).toEqual(new Uint8Array([97, 98]))
    expect(concatBytes([])).toEqual(new Uint8Array())
    wipe(undefined)
  })
})
