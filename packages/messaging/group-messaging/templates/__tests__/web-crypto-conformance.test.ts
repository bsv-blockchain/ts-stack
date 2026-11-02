/**
 * The conformance list, and the two things it has to do.
 *
 * It has to pass against a correct `SubtleCrypto`, and it has to **fail against
 * a self-consistent wrong one** — which is what the version this was written
 * from could not do. The subverted subtles below are the reviewer's: an
 * Ed25519 that prefixes every message with `0x99`, and an X25519 that returns
 * `SHA-256(shared)`. Both sign-then-verify perfectly. Both are fatal against
 * any real peer.
 *
 * Node's WebCrypto is the correct implementation under test; on a device the
 * list runs against whatever `subtle` is installed, where there is no oracle,
 * which is exactly why the vectors have to be baked in.
 */
import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkWebCrypto, formatConformance } from '../web-crypto-conformance.js'

const real = webcrypto.subtle as SubtleCrypto

/** Lets one adversary reach the private key behind a public one. */
const leaked = new Map<CryptoKey, CryptoKey>()

const named = (results: Awaited<ReturnType<typeof checkWebCrypto>>, name: string) =>
  results.find(result => result.name === name)!

/** Wraps `subtle`, replacing only the named methods. */
const subvert = (overrides: Partial<SubtleCrypto>): SubtleCrypto =>
  new Proxy(real, {
    get(target, prop, receiver) {
      if (prop in overrides) return (overrides as Record<string, unknown>)[prop as string]
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    }
  }) as SubtleCrypto

describe('checkWebCrypto against a correct runtime', () => {
  it('passes every check', async () => {
    const results = await checkWebCrypto(real)
    const failed = results.filter(result => !result.ok)

    expect(failed.map(f => `${f.name}: ${f.detail ?? ''}`)).toEqual([])
    expect(results.length).toBeGreaterThanOrEqual(14)
  })

  it('says which vector each check is pinned to', async () => {
    const results = await checkWebCrypto(real)

    expect(named(results, 'Ed25519 matches RFC 8032').detail).toMatch(/RFC 8032/)
    expect(named(results, 'X25519 matches RFC 7748').detail).toMatch(/RFC 7748/)
    expect(named(results, 'HMAC-SHA-256 sign').detail).toMatch(/RFC 4231/)
    expect(named(results, 'HKDF-SHA-256 derive').detail).toMatch(/RFC 5869/)
  })
})

describe('checkWebCrypto against a self-consistent wrong runtime', () => {
  it('catches an Ed25519 that quietly prefixes every message', async () => {
    // Signs and verifies consistently with itself; agrees with nobody.
    const tag = (data: BufferSource) => {
      const view = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data)
      return Uint8Array.from([0x99, ...view])
    }
    const subtle = subvert({
      sign: async (algorithm, key, data) =>
        real.sign(algorithm as AlgorithmIdentifier, key, tag(data)),
      verify: async (algorithm, key, signature, data) =>
        real.verify(algorithm as AlgorithmIdentifier, key, signature, tag(data))
    })

    const results = await checkWebCrypto(subtle)

    expect(named(results, 'Ed25519 matches RFC 8032').ok).toBe(false)
    expect(named(results, 'Ed25519 matches RFC 8032').detail).toMatch(/vector/)
  })

  it('catches an X25519 that hashes the shared secret', async () => {
    const subtle = subvert({
      deriveBits: async (algorithm, key, length) => {
        const raw = await real.deriveBits(algorithm as AlgorithmIdentifier, key, length as number)
        const name = typeof algorithm === 'string' ? algorithm : algorithm.name
        return name === 'X25519' ? real.digest('SHA-256', raw) : raw
      }
    })

    const results = await checkWebCrypto(subtle)

    expect(named(results, 'X25519 matches RFC 7748').ok).toBe(false)
  })

  it('catches an HMAC that is merely self-consistent', async () => {
    const subtle = subvert({
      sign: async (algorithm, key, data) => {
        const name = typeof algorithm === 'string' ? algorithm : algorithm.name
        const signed = await real.sign(algorithm as AlgorithmIdentifier, key, data)
        return name === 'HMAC' ? real.digest('SHA-256', signed) : signed
      }
    })

    expect(named(await checkWebCrypto(subtle), 'HMAC-SHA-256 sign').ok).toBe(false)
  })

  it('catches an AES-GCM that accepts a forged tag', async () => {
    // The canary that caught a build with none of its patches applied.
    const subtle = subvert({
      decrypt: async (algorithm, key, data) => {
        try {
          return await real.decrypt(algorithm as AlgorithmIdentifier, key, data)
        } catch {
          return new ArrayBuffer(1)
        }
      }
    })

    expect(named(await checkWebCrypto(subtle), 'AES-GCM rejects a wrong tag').ok).toBe(false)
  })
})

describe('the adversaries that used to score full marks', () => {
  // Each of these is a `subtle` that is wrong in a way every self-referential
  // check tolerates. Before the export round trips were added, all four
  // passed. They are the reason this list is the only safety net a host has
  // once the gap-filling is theirs.

  it('catches an export that publishes the private seed as the public key', async () => {
    // The dangerous one. `makeNobleSignatureImpl.keygen` is exactly
    // exportKey('raw', publicKey) + exportKey('pkcs8', privateKey), so this
    // writes the signing seed into the KeyPackage as its signature key.
    const subtle = subvert({
      exportKey: (async (format: string, key: CryptoKey) => {
        if (format === 'raw' && key.type === 'public' && key.algorithm.name === 'Ed25519') {
          const sneak = await real.exportKey('pkcs8', leaked.get(key)!)
          return new Uint8Array(sneak).slice(-32).buffer
        }
        return real.exportKey(format as never, key)
      }) as never,
      generateKey: (async (...args: unknown[]) => {
        const pair = (await (real.generateKey as never as (...a: unknown[]) => Promise<unknown>)(
          ...args
        )) as CryptoKeyPair
        if (pair.publicKey !== undefined) leaked.set(pair.publicKey, pair.privateKey)
        return pair
      }) as never
    })

    const result = named(await checkWebCrypto(subtle), 'Ed25519 survives its own export')
    expect(result.ok).toBe(false)
    // Asserted on the message because the round-trip verify below catches this
    // adversary too; without pinning the diagnostic, the guard that names the
    // danger could be deleted unnoticed.
    expect(result.detail).toMatch(/private seed/)
  })

  it('catches a generator that returns the same key pair forever', async () => {
    const stuck = new Map<string, CryptoKeyPair>()
    const subtle = subvert({
      generateKey: (async (algorithm: unknown, ...rest: unknown[]) => {
        const name =
          typeof algorithm === 'string' ? algorithm : (algorithm as { name: string }).name
        const held = stuck.get(name)
        if (held !== undefined) return held
        const made = (await (real.generateKey as never as (...a: unknown[]) => Promise<unknown>)(
          algorithm,
          ...rest
        )) as CryptoKeyPair
        if (made.publicKey !== undefined) stuck.set(name, made)
        return made
      }) as never
    })

    const results = await checkWebCrypto(subtle)
    // A cross-derive check would NOT catch this: with one constant pair both
    // sides agree perfectly.
    expect(named(results, 'Ed25519 generateKey').ok).toBe(false)
    expect(named(results, 'X25519 generateKey').ok).toBe(false)
  })

  it('catches a pkcs8 export that corrupts the seed', async () => {
    const subtle = subvert({
      exportKey: (async (format: string, key: CryptoKey) => {
        const out = await real.exportKey(format as never, key)
        if (format === 'pkcs8') {
          const corrupted = new Uint8Array(out as ArrayBuffer)
          corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0xff
          return corrupted.buffer
        }
        return out
      }) as never
    })

    const results = await checkWebCrypto(subtle)
    expect(named(results, 'Ed25519 survives its own export').ok).toBe(false)
    expect(named(results, 'X25519 survives its own export').ok).toBe(false)
  })

  it('catches an X25519 export that publishes the private scalar', async () => {
    const subtle = subvert({
      exportKey: (async (format: string, key: CryptoKey) => {
        if (format === 'raw' && key.type === 'public' && key.algorithm.name === 'X25519') {
          const sneak = await real.exportKey('pkcs8', leaked.get(key)!)
          return new Uint8Array(sneak).slice(-32).buffer
        }
        return real.exportKey(format as never, key)
      }) as never,
      generateKey: (async (...args: unknown[]) => {
        const pair = (await (real.generateKey as never as (...a: unknown[]) => Promise<unknown>)(
          ...args
        )) as CryptoKeyPair
        if (pair.publicKey !== undefined) leaked.set(pair.publicKey, pair.privateKey)
        return pair
      }) as never
    })

    const result = named(await checkWebCrypto(subtle), 'X25519 survives its own export')
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/private scalar/)
  })

  it('catches a pkcs8 import that silently returns a different key', async () => {
    // Export is honest here, so the private-seed guard passes. Only signing
    // with the re-imported key and verifying with the exported public key
    // notices.
    let swapped: CryptoKey | undefined
    const subtle = subvert({
      importKey: (async (format: string, data: unknown, ...rest: unknown[]) => {
        if (format === 'pkcs8') {
          swapped ??= (
            (await real.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
          ).privateKey
          return swapped
        }
        return (real.importKey as never as (...a: unknown[]) => Promise<unknown>)(
          format,
          data,
          ...rest
        )
      }) as never
    })

    const result = named(await checkWebCrypto(subtle), 'Ed25519 survives its own export')
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/no longer agrees/)
  })

  it('catches an X25519 whose two sides disagree', async () => {
    // Again export is honest; only comparing the two derived secrets notices.
    let flip = false
    const subtle = subvert({
      deriveBits: (async (algorithm: unknown, key: CryptoKey, length: number) => {
        const name =
          typeof algorithm === 'string' ? algorithm : (algorithm as { name: string }).name
        const out = await real.deriveBits(algorithm as AlgorithmIdentifier, key, length)
        if (name !== 'X25519') return out
        flip = !flip
        if (!flip) return out
        const tweaked = new Uint8Array(out)
        tweaked[0] = (tweaked[0] ?? 0) ^ 0xff
        return tweaked.buffer
      }) as never
    })

    const result = named(await checkWebCrypto(subtle), 'X25519 survives its own export')
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/different secrets/)
  })

  it('catches a verify that rejects a valid signature', async () => {
    // The mirror of the tampered-signature adversary: that one needs the
    // negative arm, this one needs the positive arm.
    const subtle = subvert({ verify: (async () => false) as never })

    const results = await checkWebCrypto(subtle)
    const result = named(results, 'Ed25519 verifies the published public key')
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/rejected a valid signature/)
  })

  it('catches a digest that truncates', async () => {
    // Without the length guard in `sameBytes`, a truncated output compares
    // equal on its prefix and passes every vector.
    const subtle = subvert({
      digest: (async (algorithm: unknown, data: BufferSource) => {
        const full = await real.digest(algorithm as AlgorithmIdentifier, data)
        return full.slice(0, 16)
      }) as never
    })

    expect(named(await checkWebCrypto(subtle), 'SHA-256 digest').ok).toBe(false)
  })

  it('catches an HKDF that is offset by one byte', async () => {
    const subtle = subvert({
      deriveBits: (async (algorithm: unknown, key: CryptoKey, length: number) => {
        const name =
          typeof algorithm === 'string' ? algorithm : (algorithm as { name: string }).name
        if (name !== 'HKDF') {
          return real.deriveBits(algorithm as AlgorithmIdentifier, key, length)
        }
        const out = new Uint8Array(
          await real.deriveBits(algorithm as AlgorithmIdentifier, key, length + 8)
        )
        return out.slice(1, 1 + length / 8).buffer
      }) as never
    })

    expect(named(await checkWebCrypto(subtle), 'HKDF-SHA-256 derive').ok).toBe(false)
  })

  it('catches a jwk export with the malformed base64url quick-crypto emits', async () => {
    // The fourth documented hole in react-native-quick-crypto@0.7.17, and the
    // only check in this list that covers it.
    const subtle = subvert({
      exportKey: (async (format: string, key: CryptoKey) => {
        const out = await real.exportKey(format as never, key)
        if (format === 'jwk')
          return { ...(out as JsonWebKey), x: `${String((out as JsonWebKey).x)}.` }
        return out
      }) as never
    })

    expect(named(await checkWebCrypto(subtle), 'P-256 is available').ok).toBe(false)
  })

  it('catches an AES-GCM that does not round trip', async () => {
    const subtle = subvert({
      decrypt: (async () => new TextEncoder().encode('something else').buffer) as never
    })

    expect(named(await checkWebCrypto(subtle), 'AES-GCM round trip').ok).toBe(false)
  })

  it('catches a generateKey that refuses a curve outright', async () => {
    // quick-crypto 0.7.17's actual shape for the cfrg family.
    const subtle = subvert({
      generateKey: (async (algorithm: unknown, ...rest: unknown[]) => {
        const name =
          typeof algorithm === 'string' ? algorithm : (algorithm as { name: string }).name
        if (name === 'Ed25519' || name === 'X25519') {
          throw new Error(`subtle.generateKey() is not available for ${name}`)
        }
        return (real.generateKey as never as (...a: unknown[]) => Promise<unknown>)(
          algorithm,
          ...rest
        )
      }) as never
    })

    const results = await checkWebCrypto(subtle)
    expect(named(results, 'Ed25519 generateKey').ok).toBe(false)
    expect(named(results, 'X25519 generateKey').ok).toBe(false)
    // and the vector checks, which import rather than generate, still run
    expect(named(results, 'Ed25519 matches RFC 8032').ok).toBe(true)
  })

  it('catches a verify that accepts a tampered signature', async () => {
    const subtle = subvert({ verify: (async () => true) as never })

    expect(
      named(await checkWebCrypto(subtle), 'Ed25519 verifies the published public key').ok
    ).toBe(false)
  })

  it('catches randomness that repeats', async () => {
    const constant = new Uint8Array(32).fill(7)
    const original = globalThis.crypto.getRandomValues
    try {
      Object.defineProperty(globalThis.crypto, 'getRandomValues', {
        value: (target: Uint8Array) => {
          target.set(constant.slice(0, target.length))
          return target
        },
        configurable: true
      })
      expect(named(await checkWebCrypto(real), 'randomness').ok).toBe(false)
    } finally {
      Object.defineProperty(globalThis.crypto, 'getRandomValues', {
        value: original,
        configurable: true
      })
    }
  })
})

describe('checkWebCrypto reporting', () => {
  it('reports every gap in one run, not the first', async () => {
    // The whole point: the integration this came from found four gaps one
    // failed exchange at a time, over two days.
    const broken = async () => {
      throw new Error('not implemented')
    }
    const subtle = subvert({
      importKey: broken as never,
      generateKey: broken as never,
      sign: broken as never,
      deriveBits: broken as never
    })

    const results = await checkWebCrypto(subtle)
    const failed = results.filter(result => !result.ok)

    expect(failed.length).toBeGreaterThanOrEqual(6)
    // And the ones that do not depend on the broken methods still ran.
    expect(named(results, 'SHA-256 digest').ok).toBe(true)
    expect(named(results, 'randomness').ok).toBe(true)
  })

  it('names the failure rather than swallowing it', async () => {
    const subtle = subvert({
      importKey: (async () => {
        throw new Error('"subtle.importKey()" is not implemented for HKDF')
      }) as never
    })

    const hkdf = named(await checkWebCrypto(subtle), 'HKDF-SHA-256 derive')
    expect(hkdf.ok).toBe(false)
    expect(hkdf.detail).toMatch(/not implemented for HKDF/)
  })

  it('formats a pass as one headline plus a line each', async () => {
    const text = formatConformance(await checkWebCrypto(real))

    expect(text).toMatch(/^WebCrypto: all \d+ checks passed/)
    expect(text).toMatch(/ok {3}Ed25519 matches RFC 8032/)
    expect(text).not.toMatch(/FAIL/)
  })

  it('counts the failures in the headline', () => {
    const text = formatConformance([
      { name: 'a', ok: true },
      { name: 'b', ok: false, detail: 'boom' }
    ])

    expect(text).toMatch(/1 of 2 checks FAILED/)
    expect(text).toMatch(/FAIL b — boom/)
  })
})
