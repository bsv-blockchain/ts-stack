import { AESGCM } from '@bsv/sdk/primitives/AESGCM'
import { Brc39WebCryptoGcm } from './Brc39WebCryptoGcm'

// Authored UNRUN. Real browser native WebCrypto AES-GCM is an independent
// oracle, together with the existing SDK. No browser/native-mobile timing,
// physical resource, hostile shared-CPU or production qualification is implied.
export async function verifyBrowserIncrementalGcmIndependentOracles(): Promise<void> {
  const raw = new Uint8Array(32).fill(37),
    key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt'])
  for (const nonceBytes of [12, 32])
    for (const size of [0, 1, 15, 16, 17, 31, 32, 33, 257, 65537]) {
      const nonce = new Uint8Array(nonceBytes).fill(41),
        plain = Uint8Array.from({ length: size }, (_, index) => (index * 17 + 5) & 255),
        encrypted = new Uint8Array(
          await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, plain)
        ),
        sdk = AESGCM(plain, nonce, raw)
      if (
        sdk.result.some((value, index) => value !== encrypted[index]) ||
        sdk.authenticationTag.some((value, index) => value !== encrypted[size + index])
      )
        throw new Error('Independent native and SDK GCM oracles differ')
      for (const width of [1, 15, 16, 17, 97, 4096]) {
        const owner = await Brc39WebCryptoGcm.create(raw, nonce, {
            maximumChunkBytes: 4096,
            maximumPlaintextBytes: 1048576,
            maximumAllocationBytes: 1048576,
            expiresAt: Date.now() + 120000,
            cleanupMilliseconds: 30000
          }),
          pieces: Uint8Array[] = []
        try {
          for (let offset = 0; offset < size; offset += width)
            pieces.push(await owner.update(encrypted.subarray(offset, Math.min(size, offset + width))))
          pieces.push(await owner.finish(encrypted.subarray(size)))
          let offset = 0
          for (const bytes of pieces) {
            for (const value of bytes) {
              if (value !== plain[offset++]) throw new Error('Incremental plaintext oracle differs')
            }
          }
          if (offset !== size) throw new Error('Incremental plaintext extent differs')
        } finally {
          for (const bytes of pieces) bytes.fill(0)
          await owner.close()
        }
      }
      plain.fill(0)
      encrypted.fill(0)
      sdk.result.fill(0)
      sdk.authenticationTag.fill(0)
    }
  raw.fill(0)
}
export async function verifyBrowserIncrementalGcmRefusals(): Promise<void> {
  const raw = new Uint8Array(32).fill(43),
    nonce = new Uint8Array(32).fill(47),
    plaintext = new Uint8Array(113).fill(53),
    encrypted = AESGCM(plaintext, nonce, raw),
    selected = {
      maximumChunkBytes: 128,
      maximumPlaintextBytes: 128,
      maximumAllocationBytes: 65536,
      expiresAt: Date.now() + 120000,
      cleanupMilliseconds: 30000
    }
  for (const mode of ['tag', 'ciphertext', 'short-tag', 'byte-limit', 'cancellation']) {
    const controller = new AbortController(),
      owner = await Brc39WebCryptoGcm.create(raw, nonce, {
        ...selected,
        maximumPlaintextBytes: mode === 'byte-limit' ? 112 : 128,
        signal: controller.signal
      }),
      cipher = encrypted.result.slice(),
      tag = encrypted.authenticationTag.slice()
    let output: Uint8Array | undefined,
      failed = false
    try {
      if (mode === 'ciphertext') cipher[0] ^= 1
      if (mode === 'tag') tag[0] ^= 1
      if (mode === 'cancellation') controller.abort(new Error('case cancellation'))
      output = await owner.update(cipher)
      const final = await owner.finish(mode === 'short-tag' ? tag.subarray(0, 15) : tag)
      final.fill(0)
    } catch {
      failed = true
    } finally {
      output?.fill(0)
      cipher.fill(0)
      tag.fill(0)
      await owner.close()
    }
    if (!failed) throw new Error('Incremental browser GCM admitted refused ciphertext')
  }
  raw.fill(0)
  plaintext.fill(0)
  encrypted.result.fill(0)
  encrypted.authenticationTag.fill(0)
}

export async function verifyBrowserIncrementalEncryptionIndependentOracles(): Promise<void> {
  const raw = new Uint8Array(32).fill(59),
    native = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt'])
  try {
    for (const nonceBytes of [12, 32])
      for (const size of [0, 1, 15, 16, 17, 31, 32, 33, 257, 65537]) {
        const nonce = new Uint8Array(nonceBytes).fill(61),
          plaintext = Uint8Array.from({ length: size }, (_, index) => (index * 19 + 3) & 255),
          expected = new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, native, plaintext)
          )
        for (const width of [1, 15, 16, 17, 97, 4096]) {
          const owner = await Brc39WebCryptoGcm.createEncryptor(raw, nonce, {
              maximumChunkBytes: 4096,
              maximumPlaintextBytes: 1048576,
              maximumAllocationBytes: 1048576,
              expiresAt: Date.now() + 120000,
              cleanupMilliseconds: 30000
            }),
            parts: Uint8Array[] = []
          try {
            for (let offset = 0; offset < size; offset += width)
              parts.push(await owner.update(plaintext.subarray(offset, Math.min(size, offset + width))))
            const end = await owner.finishEncryption()
            parts.push(end.ciphertext, end.tag)
            let offset = 0
            for (const bytes of parts)
              for (const byte of bytes) {
                if (byte !== expected[offset++])
                  throw new Error('Incremental browser encryption differs from native GCM oracle')
              }
            if (offset !== expected.byteLength) throw new Error('Incremental browser encryption output length differs')
          } finally {
            for (const bytes of parts) bytes.fill(0)
            await owner.close()
          }
        }
        plaintext.fill(0)
        expected.fill(0)
      }
  } finally {
    raw.fill(0)
  }
}
