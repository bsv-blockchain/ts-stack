/**
 * Does this runtime's WebCrypto actually do what the MLS stack needs?
 *
 * Source to copy into your host and own. It is not part of the package's API
 * and carries no compatibility promise. It imports nothing — it probes whatever
 * `SubtleCrypto` you hand it — so it is safe to run anywhere, including on a
 * device at startup.
 *
 * ## Why this exists
 *
 * `react-native-quick-crypto@0.7.17` installs a `subtle` with holes in it:
 * the whole `cfrg` family is commented out of `generateKey`, HMAC imports but
 * cannot sign, HKDF cannot be imported at all, and EC `exportKey('jwk')` emits
 * malformed base64url. None of that is visible until the exact call is made.
 * The first integration found all four **one failed exchange at a time** —
 * build, install, drive the UI, read the log, fix, hit the next one — over two
 * days. One run of this list shows all four at once.
 *
 * So: **it never stops at the first failure.** A list that aborts on the first
 * red tells you one thing per run, which is the loop this replaces.
 *
 * ## Why the vectors matter
 *
 * The version this is written from checked HMAC and HKDF against RFC vectors
 * and checked the two curves against themselves — sign then verify, export then
 * import, both sides agree, where both sides are the same code. A reviewer
 * built a `subtle` whose Ed25519 silently prefixes every message with `0x99`
 * and whose X25519 returns `SHA-256(shared)`, and it **passed all twelve
 * checks**. The log would have read "all checks passed" while no message in the
 * app was readable by anyone else.
 *
 * Self-consistency is not correctness. Every check that can be pinned to a
 * published vector is pinned to one here: RFC 8032 for Ed25519, RFC 7748 for
 * X25519, RFC 4231 for HMAC, RFC 5869 for HKDF. The Ed25519 vector is the
 * valuable one — importing a known seed as PKCS#8 and signing pins the seed to
 * public-key derivation, the signature, *and* the DER layout in one call.
 *
 * ## What it still leaves to you
 *
 * - **Running it where it matters.** Gating this on `__DEV__` means a release
 *   build on an unfamiliar device is the one case it never covers.
 * - **Deciding what a failure means.** It reports; it does not refuse to start.
 * - **The other ciphersuite.** The P-256 suite is checked only far enough to
 *   say whether it exists.
 */

export interface ConformanceResult {
  name: string
  ok: boolean
  /** Why it failed, or what it proved. */
  detail?: string
}

const hex = (value: string): Uint8Array<ArrayBuffer> =>
  bytesOf(value.match(/.{2}/g)!.map(byte => parseInt(byte, 16)))

/** Always backed by an `ArrayBuffer`, never a `SharedArrayBuffer`. */
const bytesOf = (values: readonly number[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(values.length))
  out.set(values)
  return out
}

/** Length-checked and non-short-circuiting, so it leaks nothing by timing. */
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!
  return diff === 0
}

const bytes = (buffer: ArrayBuffer): Uint8Array<ArrayBuffer> => new Uint8Array(buffer)

/** PKCS#8 for a 32-byte Ed25519 or X25519 seed. `oid` is 0x70 or 0x6e. */
const pkcs8 = (seed: Uint8Array, oid: number): Uint8Array<ArrayBuffer> =>
  bytesOf([
    0x30,
    0x2e,
    0x02,
    0x01,
    0x00,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    oid,
    0x04,
    0x22,
    0x04,
    0x20,
    ...seed
  ])

// RFC 8032 §7.1, TEST 1. Empty message.
const ED25519_SEED = hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
const ED25519_PUBLIC = hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
const ED25519_SIGNATURE = hex(
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'
)

// RFC 7748 §6.1.
const X25519_PRIVATE = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a')
const X25519_PEER_PUBLIC = hex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f')
const X25519_SHARED = hex('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742')

// RFC 4231, Test Case 1.
const HMAC_KEY = new Uint8Array(new ArrayBuffer(20)).fill(0x0b)
const HMAC_DATA = bytesOf(Array.from(new TextEncoder().encode('Hi There')))
const HMAC_EXPECTED = hex('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7')

// RFC 5869, Test Case 1.
const HKDF_IKM = new Uint8Array(new ArrayBuffer(22)).fill(0x0b)
const HKDF_SALT = hex('000102030405060708090a0b0c')
const HKDF_INFO = hex('f0f1f2f3f4f5f6f7f8f9')
const HKDF_EXPECTED = hex(
  '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'
)

const EMPTY = new Uint8Array(new ArrayBuffer(0))

const SHA256_OF_ABC = hex('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')

interface Check {
  name: string
  run: (subtle: SubtleCrypto) => Promise<string | undefined>
}

/**
 * An AES-GCM key the way HPKE obtains one: 16 raw bytes through `importKey`.
 *
 * `extractable` false and the two AEAD usages match what `@hpke/core` asks
 * for, so a runtime that refuses this refuses the real thing too.
 */
const aesKey = async (subtle: SubtleCrypto): Promise<CryptoKey> =>
  subtle.importKey(
    'raw',
    bytesOf(Array.from({ length: 16 }, () => 7)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  )

const CHECKS: Check[] = [
  {
    name: 'randomness',
    run: async () => {
      const first = globalThis.crypto.getRandomValues(new Uint8Array(32))
      const second = globalThis.crypto.getRandomValues(new Uint8Array(32))
      if (first.every(byte => byte === 0)) throw new Error('getRandomValues returned all zeroes')
      if (sameBytes(first, second)) throw new Error('getRandomValues repeated itself')
      return undefined
    }
  },
  {
    name: 'SHA-256 digest',
    run: async subtle => {
      const digest = bytes(
        await subtle.digest('SHA-256', bytesOf(Array.from(new TextEncoder().encode('abc'))))
      )
      if (!sameBytes(digest, SHA256_OF_ABC)) throw new Error('digest disagrees with the vector')
      return 'FIPS 180-4 "abc"'
    }
  },
  {
    name: 'HMAC-SHA-256 sign',
    run: async subtle => {
      const key = await subtle.importKey(
        'raw',
        HMAC_KEY,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      )
      const mac = bytes(await subtle.sign('HMAC', key, HMAC_DATA))
      if (!sameBytes(mac, HMAC_EXPECTED)) throw new Error('HMAC disagrees with the vector')
      return 'RFC 4231 case 1'
    }
  },
  {
    name: 'HKDF-SHA-256 derive',
    run: async subtle => {
      const key = await subtle.importKey('raw', HKDF_IKM, 'HKDF', false, ['deriveBits'])
      const okm = bytes(
        await subtle.deriveBits(
          { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
          key,
          42 * 8
        )
      )
      if (!sameBytes(okm, HKDF_EXPECTED)) throw new Error('HKDF disagrees with the vector')
      return 'RFC 5869 case 1'
    }
  },
  {
    name: 'AES-GCM round trip',
    run: async subtle => {
      // Imported, not generated. HPKE's AEAD derives its key and brings it in
      // through `importKey('raw', …)` — `AesGcmContext._importKey` in
      // `@hpke/core` — and never calls `generateKey` at all. A runtime that
      // implements one and not the other is the same shape as the HKDF hole
      // this file documents above, and probing the wrong one passes here and
      // fails on the first real message.
      const key = await aesKey(subtle)
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
      const plaintext = bytesOf(Array.from(new TextEncoder().encode('group messaging')))
      const sealed = bytes(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))
      const opened = bytes(await subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed))
      if (!sameBytes(opened, plaintext)) throw new Error('AES-GCM did not round trip')
      return undefined
    }
  },
  {
    name: 'AES-GCM rejects a wrong tag',
    run: async subtle => {
      // The canary. A build with unapplied patches once accepted this.
      const key = await aesKey(subtle)
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
      const sealed = bytes(
        await subtle.encrypt(
          { name: 'AES-GCM', iv },
          key,
          bytesOf(Array.from(new TextEncoder().encode('x')))
        )
      )
      sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0xff
      try {
        await subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed)
      } catch {
        return undefined
      }
      throw new Error('AES-GCM accepted a forged tag')
    }
  },
  {
    name: 'Ed25519 generateKey',
    run: async subtle => {
      const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
      if (pair.privateKey === undefined) throw new Error('no private key')
      // A stuck generator passes every other check: both parties derive the
      // same keys and every signature verifies. Two pairs that match is the
      // only symptom, and it is fatal.
      const second = (await subtle.generateKey('Ed25519', true, [
        'sign',
        'verify'
      ])) as CryptoKeyPair
      const first = bytes(await subtle.exportKey('raw', pair.publicKey))
      if (sameBytes(first, bytes(await subtle.exportKey('raw', second.publicKey)))) {
        throw new Error('generateKey returned the same key twice')
      }
      return undefined
    }
  },
  {
    name: 'Ed25519 survives its own export',
    run: async subtle => {
      // The vectors above go in through `importKey` and never touch
      // `exportKey`, yet `makeNobleSignatureImpl.keygen` is exactly
      // `exportKey('raw', publicKey)` + `exportKey('pkcs8', privateKey)` — so
      // export is both unchecked and on the path that writes a KeyPackage.
      // An export that returns the private seed where the public key belongs
      // publishes the signing key, and every other check still passes.
      const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
      const publicRaw = bytes(await subtle.exportKey('raw', pair.publicKey))
      const privateDer = bytes(await subtle.exportKey('pkcs8', pair.privateKey))
      if (publicRaw.length !== 32) throw new Error(`public raw key is ${publicRaw.length} bytes`)
      if (sameBytes(publicRaw, privateDer.slice(privateDer.length - 32))) {
        throw new Error('exportKey published the private seed as the public key')
      }

      const signer = await subtle.importKey('pkcs8', privateDer, 'Ed25519', false, ['sign'])
      const verifier = await subtle.importKey('raw', publicRaw, 'Ed25519', false, ['verify'])
      const message = bytesOf([1, 2, 3, 4])
      const signature = await subtle.sign('Ed25519', signer, message)
      if (!(await subtle.verify('Ed25519', verifier, signature, message))) {
        throw new Error('a re-imported key pair no longer agrees with itself')
      }
      return 'export, re-import, sign, verify'
    }
  },
  {
    name: 'Ed25519 matches RFC 8032',
    run: async subtle => {
      // Pins seed-to-public derivation, the signature and the PKCS#8 layout in
      // one call. A self-consistent but wrong Ed25519 fails here and nowhere
      // else.
      const key = await subtle.importKey('pkcs8', pkcs8(ED25519_SEED, 0x70), 'Ed25519', false, [
        'sign'
      ])
      const signature = bytes(await subtle.sign('Ed25519', key, EMPTY))
      if (!sameBytes(signature, ED25519_SIGNATURE)) {
        throw new Error('signature disagrees with the vector')
      }
      return 'RFC 8032 §7.1 test 1'
    }
  },
  {
    name: 'Ed25519 verifies the published public key',
    run: async subtle => {
      const key = await subtle.importKey('raw', ED25519_PUBLIC, 'Ed25519', false, ['verify'])
      const good = await subtle.verify('Ed25519', key, ED25519_SIGNATURE, EMPTY)
      if (!good) throw new Error('rejected a valid signature')
      const tampered = bytesOf(Array.from(ED25519_SIGNATURE))
      tampered[0] = (tampered[0] ?? 0) ^ 0xff
      if (await subtle.verify('Ed25519', key, tampered, EMPTY)) {
        throw new Error('accepted a tampered signature')
      }
      return undefined
    }
  },
  {
    name: 'X25519 generateKey',
    run: async subtle => {
      const pair = (await subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair
      if (pair.privateKey === undefined) throw new Error('no private key')
      const second = (await subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair
      const first = bytes(await subtle.exportKey('raw', pair.publicKey))
      if (sameBytes(first, bytes(await subtle.exportKey('raw', second.publicKey)))) {
        // Note a cross-derive check does NOT catch this: with one constant
        // pair both sides agree and the shared secret is consistent.
        throw new Error('generateKey returned the same key twice')
      }
      return undefined
    }
  },
  {
    name: 'X25519 survives its own export',
    run: async subtle => {
      const ours = (await subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair
      const theirs = (await subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair
      const ourPublic = bytes(await subtle.exportKey('raw', ours.publicKey))
      const ourPrivate = bytes(await subtle.exportKey('pkcs8', ours.privateKey))
      if (sameBytes(ourPublic, ourPrivate.slice(ourPrivate.length - 32))) {
        throw new Error('exportKey published the private scalar as the public key')
      }

      // Both directions through export and re-import, which is what hpke does
      // to put an init key on the wire.
      const reimported = await subtle.importKey('pkcs8', ourPrivate, 'X25519', false, [
        'deriveBits'
      ])
      const peer = await subtle.importKey(
        'raw',
        bytes(await subtle.exportKey('raw', theirs.publicKey)),
        'X25519',
        false,
        []
      )
      const mine = bytes(await subtle.deriveBits({ name: 'X25519', public: peer }, reimported, 256))
      const yours = bytes(
        await subtle.deriveBits(
          { name: 'X25519', public: await subtle.importKey('raw', ourPublic, 'X25519', false, []) },
          theirs.privateKey,
          256
        )
      )
      if (!sameBytes(mine, yours)) throw new Error('the two sides derived different secrets')
      return 'export, re-import, agree'
    }
  },
  {
    name: 'X25519 matches RFC 7748',
    run: async subtle => {
      const mine = await subtle.importKey('pkcs8', pkcs8(X25519_PRIVATE, 0x6e), 'X25519', false, [
        'deriveBits'
      ])
      const theirs = await subtle.importKey('raw', X25519_PEER_PUBLIC, 'X25519', false, [])
      const shared = bytes(await subtle.deriveBits({ name: 'X25519', public: theirs }, mine, 256))
      if (!sameBytes(shared, X25519_SHARED)) {
        throw new Error('shared secret disagrees with the vector')
      }
      return 'RFC 7748 §6.1'
    }
  },
  {
    name: 'P-256 is available',
    run: async subtle => {
      // The other ciphersuite, checked only far enough to say whether it
      // exists — EXCEPT for the jwk shape, which is the one place anything
      // here covers quick-crypto 0.7.17's malformed-base64url defect.
      const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
        'deriveBits'
      ])) as CryptoKeyPair
      const jwk = await subtle.exportKey('jwk', pair.publicKey)
      if (typeof jwk.x !== 'string' || !/^[A-Za-z0-9_-]+$/.test(jwk.x)) {
        // quick-crypto 0.7.17 emits standard base64 with a stray '.' here.
        throw new Error(`exportKey('jwk') produced malformed base64url: ${String(jwk.x)}`)
      }
      return undefined
    }
  }
]

const runCheck = async (check: Check, subtle: SubtleCrypto): Promise<ConformanceResult> => {
  try {
    const detail = await check.run(subtle)
    return detail === undefined
      ? { name: check.name, ok: true }
      : { name: check.name, ok: true, detail }
  } catch (cause) {
    return { name: check.name, ok: false, detail: String(cause) }
  }
}

/**
 * Run every check. Never stops early — finding one gap per run is the loop
 * this replaces.
 */
export const checkWebCrypto = async (subtle: SubtleCrypto): Promise<ConformanceResult[]> => {
  const results: ConformanceResult[] = []
  for (const check of CHECKS) {
    results.push(await runCheck(check, subtle))
  }
  return results
}

export const formatConformance = (results: ConformanceResult[]): string => {
  const failed = results.filter(result => !result.ok)
  const lines = results.map(
    result =>
      `  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.detail === undefined ? '' : ` — ${result.detail}`}`
  )
  const headline =
    failed.length === 0
      ? `WebCrypto: all ${results.length} checks passed`
      : `WebCrypto: ${failed.length} of ${results.length} checks FAILED`
  return [headline, ...lines].join('\n')
}
