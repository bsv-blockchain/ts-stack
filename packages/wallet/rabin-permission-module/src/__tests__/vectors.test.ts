import { CachedKeyDeriver, PrivateKey } from '@bsv/sdk'
import { jest } from '@jest/globals'
import { decodeKeyResult, decodeSignResult, scriptNum, scriptNumToBigInt } from '../encoding.js'
import { createRabinModule, verify } from '../index.js'
import {
  assembleKey,
  digestValue,
  expandSeed,
  generateKey,
  isAcceptedPrime,
  MR_BASES,
  nextAcceptedPrime,
  sign,
  SMALL_PRIMES
} from '../rabin.js'
import { beHex, execute, fromHex, keyVector, toHex, vectors } from './helpers.js'

const walletA = new CachedKeyDeriver(PrivateKey.fromHex(vectors.parameters.walletA))
// The module gets its own deriver, so its calls are counted apart from the seed checks below.
const moduleDeriver = new CachedKeyDeriver(PrivateKey.fromHex(vectors.parameters.walletA))
const derivePrivateKey = jest.spyOn(moduleDeriver, 'derivePrivateKey')
const moduleA = createRabinModule({ keyDeriver: moduleDeriver, authorize: async () => true })

const seedOf = (name: string): number[] => fromHex(keyVector(name).derivation.seed)
const keyOf = (name: string) => {
  const vector = keyVector(name)
  return assembleKey(beHex(vector.key.p), beHex(vector.key.q), vector.key.bits)
}

describe('BRC-206 conformance vectors', () => {
  it('pins the normative sieve and Miller–Rabin bases', () => {
    expect(SMALL_PRIMES).toHaveLength(6542)
    expect(SMALL_PRIMES[0]).toBe(2)
    expect(SMALL_PRIMES.at(-1)).toBe(65521)
    expect(MR_BASES.map(Number)).toEqual(
      [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53].concat([
        59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131
      ])
    )
  })

  it.each(vectors.keys.map(vector => [vector.name, vector] as const))(
    '%s: seed, expansion, primes and modulus',
    (_name, vector) => {
      const derived = walletA.derivePrivateKey(
        vector.derivation.derivationProtocolID,
        vector.request.keyID,
        vector.request.counterparty
      )
      expect(toHex(derived.toArray('be', 32))).toBe(vector.derivation.seed)
      const okm = expandSeed(fromHex(vector.derivation.seed), vector.key.bits)
      expect(okm).toHaveLength(vector.expansion.okmLength)
      expect(toHex(okm)).toBe(vector.expansion.okm)

      const key = generateKey(fromHex(vector.derivation.seed), vector.key.bits)
      expect(key.p).toBe(beHex(vector.key.p))
      expect(key.q).toBe(beHex(vector.key.q))
      expect(key.n).toBe(beHex(vector.key.n))
      expect(isAcceptedPrime(key.p)).toBe(true)
      expect(isAcceptedPrime(key.q)).toBe(true)
    },
    30_000
  )

  it.each(vectors.keys.map(vector => [vector.name, vector] as const))(
    '%s: the module returns the key result byte for byte',
    async (_name, vector) => {
      const result = await execute(moduleA, { ...vector.request, plaintext: [] })
      expect(toHex(result.ciphertext)).toBe(vector.response.ciphertext)
      expect(result.ciphertext).toHaveLength(vector.key.bits / 8 + 3)
      expect(Array.isArray(result.ciphertext)).toBe(true)
      expect(decodeKeyResult(result.ciphertext)).toBe(beHex(vector.key.n))
      expect(toHex(scriptNum(beHex(vector.key.n)))).toBe(vector.response.nScriptNum)
    },
    30_000
  )

  it.each(vectors.signatures.map(vector => [vector.name, vector] as const))(
    '%s: the module returns the signature byte for byte, deterministically',
    async (_name, vector) => {
      const args = { ...vector.request, plaintext: fromHex(vector.request.plaintext) }
      const first = await execute(moduleA, args)
      const second = await execute(moduleA, args)
      expect(toHex(first.ciphertext)).toBe(vector.response.ciphertext)
      expect(second.ciphertext).toEqual(first.ciphertext)

      const { sig, padding } = decodeSignResult(first.ciphertext)
      expect(sig).toBe(beHex(vector.signature.sig))
      expect(padding).toBe(BigInt(vector.signature.padding))
      expect(toHex(scriptNum(sig))).toBe(vector.signature.sigScriptNum)
      expect(toHex(scriptNum(padding))).toBe(vector.signature.paddingScriptNum)
      expect(digestValue(fromHex(vector.message.hex))).toBe(BigInt(vector.message.h))
    }
  )

  it('derives once per vector key and only through the canonical Rabin namespace', () => {
    // K1 and K2 share a seed but are distinct keys (sizes), K3 has another counterparty; every
    // signature vector reuses one of those three cached keys.
    const calls = derivePrivateKey.mock.calls.map(call => JSON.stringify(call)).sort()
    const self = JSON.stringify([[2, 'p rabin example oracle'], 'feed 1', 'self'])
    const walletB = JSON.stringify([
      [2, 'p rabin example oracle'],
      'feed 1',
      vectors.parameters.walletBIdentity
    ])
    expect(calls).toEqual([self, self, walletB].sort())
  })

  it('verifies every vector and rejects tampered or forged signatures', () => {
    for (const vector of vectors.signatures) {
      const n = beHex(keyVector(vector.keyVector).key.n)
      const message = fromHex(vector.message.hex)
      const sig = beHex(vector.signature.sig)
      const padding = BigInt(vector.signature.padding)
      const h = BigInt(vector.message.h)
      expect(verify(message, sig, padding, n)).toBe(true)
      expect(verify(message, sig + 1n, padding, n)).toBe(false)
      expect(verify(message, sig, padding + 1n, n)).toBe(false)
      expect(verify([...message, 0], sig, padding, n)).toBe(false)
      expect(verify(message, 0n, h, n)).toBe(false)
      expect(verify(message, sig + n, padding, n)).toBe(false)
      expect(verify(message, -sig, padding, n)).toBe(false)
      expect(verify(message, sig, -1n, n)).toBe(false)
      expect(verify(message, sig, padding, 0n)).toBe(false)
      expect(verify(message, sig as never, Number(padding) as never, n)).toBe(false)
    }
  })

  it('separates key sizes from one seed and counterparties by seed', async () => {
    const deriver = new CachedKeyDeriver(PrivateKey.fromHex(vectors.parameters.walletA))
    const derive = jest.spyOn(deriver, 'derivePrivateKey')
    const separate = createRabinModule({ keyDeriver: deriver, authorize: async () => true })
    const k1 = keyVector('K1 2048 self')
    const k2 = keyVector('K2 3072 self')
    const k3 = keyVector('K3 2048 counterparty B')
    const n = async (vector: typeof k1) =>
      decodeKeyResult((await execute(separate, { ...vector.request, plaintext: [] })).ciphertext)

    const [n1, n2, n3] = [await n(k1), await n(k2), await n(k3)]
    expect(derive).toHaveBeenCalledTimes(3)
    // K1 and K2: the same derivation (one seed), different sizes, different moduli.
    expect(derive.mock.calls[0]).toEqual(derive.mock.calls[1])
    expect(n1).not.toBe(n2)
    // K3: another counterparty, another seed and modulus.
    expect(derive.mock.calls[2][2]).toBe(vectors.parameters.walletBIdentity)
    expect(k1.derivation.seed).toBe(k2.derivation.seed)
    expect(k1.derivation.seed).not.toBe(k3.derivation.seed)
    expect(n3).not.toBe(n1)
    expect(seedOf('K3 2048 counterparty B')).toHaveLength(32)
  }, 30_000)

  it('produces the normative padding encodings', () => {
    for (const { padding, scriptNum: expected } of vectors.paddingEncodings) {
      expect(toHex(scriptNum(BigInt(padding)))).toBe(expected)
      expect(scriptNumToBigInt(fromHex(expected))).toBe(BigInt(padding))
    }
  }, 30_000)

  it('signs directly with the vector primes', () => {
    const key = keyOf('K1 2048 self')
    const s1 = vectors.signatures[0]
    expect(sign(fromHex(s1.message.hex), key)).toEqual({
      sig: beHex(s1.signature.sig),
      padding: BigInt(s1.signature.padding)
    })
  })
})

describe('Rabin arithmetic edge cases', () => {
  it('accepts exactly the integers the normative test accepts', () => {
    expect(isAcceptedPrime(65537n)).toBe(true)
    expect(isAcceptedPrime((1n << 61n) - 1n)).toBe(true)
    expect(isAcceptedPrime(65521n)).toBe(false)
    expect(isAcceptedPrime(1n)).toBe(false)
    expect(isAcceptedPrime(1n << 70n)).toBe(false)
    expect(isAcceptedPrime(65537n * 65539n)).toBe(false)
    expect(isAcceptedPrime(65537n * 3n)).toBe(false)
  })

  it('searches in steps of four and fails past 2^k', () => {
    expect(nextAcceptedPrime(65539n, 20)).toBe(65539n)
    expect(nextAcceptedPrime(65543n, 20) % 4n).toBe(3n)
    expect(() => nextAcceptedPrime((1n << 20n) - 1n, 20)).toThrow('prime search exceeded 2^k')
  })

  it('applies every key-generation rejection rule', () => {
    const k1 = keyOf('K1 2048 self')
    expect(() => assembleKey(k1.p, k1.p, 2048)).toThrow('p equals q')
    expect(() => assembleKey(k1.p, k1.p + 4n, 2048)).toThrow('too close')
    expect(() => assembleKey(k1.p, (1n << 1022n) + 3n, 2048)).toThrow('wrong size')
    expect(() => assembleKey(k1.p, k1.q, 1024 as never)).toThrow('bits must be')
    expect(() =>
      generateKey(
        Array.from({ length: 32 }, () => 1),
        2047 as never
      )
    ).toThrow('bits must be')
    expect(() =>
      expandSeed(
        Array.from({ length: 31 }, () => 1),
        2048
      )
    ).toThrow('32 bytes')
  })

  it('refuses to sign when the digest is not below the modulus or the key is inconsistent', () => {
    const k1 = keyOf('K1 2048 self')
    expect(() => sign([1], { ...k1, n: 7n * 11n, p: 7n, q: 11n, pInvModQ: 8n })).toThrow(
      'digest is not below the modulus'
    )
    expect(() => sign([0x61, 0x62, 0x63], { ...k1, pInvModQ: k1.pInvModQ + 1n })).toThrow(
      'RABIN: signing failed'
    )
  })
})
