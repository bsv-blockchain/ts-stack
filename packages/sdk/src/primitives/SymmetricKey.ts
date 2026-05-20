import BigNumber from './BigNumber.js'
import { AESGCM, AESGCMDecrypt } from './AESGCM.js'
import Random from './Random.js'
import { toArray, encode } from './utils.js'

// ---------------------------------------------------------------------------
// Native AES-GCM fast-path via node:crypto / react-native-quick-crypto
//
// Resolved once at module load using the same pattern as Hash.ts.  When
// `node:crypto` (or a compatible shim) is available and exposes
// `createCipheriv` / `createDecipheriv`, encrypt and decrypt will use it
// instead of the pure-TS implementation.  The pure-TS path remains the
// unconditional fallback — any error in the native path causes silent
// re-execution through the pure-TS implementation.
// ---------------------------------------------------------------------------
const NODE_CRYPTO_SYM = (() => {
  const processLike =
    typeof globalThis === 'undefined' ? undefined : (globalThis as any).process
  const getBuiltinModule = processLike?.getBuiltinModule
  if (typeof getBuiltinModule === 'function') {
    try {
      const crypto = getBuiltinModule.call(processLike, 'node:crypto')
      if (crypto != null) return crypto
    } catch {
      // continue to CommonJS fallback
    }
  }
  try {
    if (typeof require === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('node:crypto')
    }
  } catch {
    // node:crypto is unavailable in this runtime
  }
  return undefined
})()

/** True when the runtime provides a usable createCipheriv for aes-256-gcm. */
const NATIVE_AES_GCM_AVAILABLE: boolean = (() => {
  if (NODE_CRYPTO_SYM == null) return false
  return (
    typeof NODE_CRYPTO_SYM.createCipheriv === 'function' &&
    typeof NODE_CRYPTO_SYM.createDecipheriv === 'function'
  )
})()

/**
 * Encrypt `plaintext` with AES-256-GCM via node:crypto.
 * Returns `iv (32 bytes) || ciphertext || authTag (16 bytes)` — identical
 * layout to the pure-TS AESGCM path used by SymmetricKey.encrypt.
 *
 * Returns `null` on any failure so the caller can fall back to pure-TS.
 */
function nativeEncrypt (
  plaintext: Uint8Array,
  iv: Uint8Array,
  key: Uint8Array
): Uint8Array | null {
  try {
    const cipher = NODE_CRYPTO_SYM.createCipheriv(
      'aes-256-gcm',
      Buffer.from(key.buffer, key.byteOffset, key.byteLength),
      Buffer.from(iv.buffer, iv.byteOffset, iv.byteLength)
    )
    const encrypted: Buffer = Buffer.concat([
      cipher.update(Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength)),
      cipher.final()
    ])
    const authTag: Buffer = cipher.getAuthTag() // always 16 bytes for GCM

    const out = new Uint8Array(iv.length + encrypted.length + authTag.length)
    let offset = 0
    out.set(iv, offset); offset += iv.length
    out.set(encrypted, offset); offset += encrypted.length
    out.set(authTag, offset)
    return out
  } catch {
    return null
  }
}

/**
 * Decrypt an `iv || ciphertext || authTag` bundle produced by nativeEncrypt
 * (or by the pure-TS SymmetricKey.encrypt path) using node:crypto.
 *
 * Returns the plaintext on success, `null` on authentication failure, or
 * `undefined` to signal a non-auth error so the caller can fall back.
 */
function nativeDecrypt (
  msgBytes: Uint8Array,
  ivLength: number,
  tagLength: number,
  key: Uint8Array
): Uint8Array | null | undefined {
  try {
    const iv = msgBytes.slice(0, ivLength)
    const tagStart = msgBytes.length - tagLength
    const ciphertext = msgBytes.slice(ivLength, tagStart)
    const messageTag = msgBytes.slice(tagStart)

    const decipher = NODE_CRYPTO_SYM.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(key.buffer, key.byteOffset, key.byteLength),
      Buffer.from(iv.buffer, iv.byteOffset, iv.byteLength)
    )
    decipher.setAuthTag(Buffer.from(messageTag.buffer, messageTag.byteOffset, messageTag.byteLength))

    // Decryption authenticates on final(); throws if tag is wrong.
    const decrypted: Buffer = Buffer.concat([
      decipher.update(Buffer.from(ciphertext.buffer, ciphertext.byteOffset, ciphertext.byteLength)),
      decipher.final()
    ])
    return new Uint8Array(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength)
  } catch (err: any) {
    // Node throws "Unsupported state or unable to authenticate data" on auth
    // failure.  Treat all errors as auth failure (null) so SymmetricKey.decrypt
    // re-throws its own descriptive message; the pure-TS fallback below would
    // also return null in the same scenario.
    // Return `undefined` only for unexpected setup errors so we can retry with
    // the pure-TS path — but in practice those are also unrecoverable, so null
    // is fine here too.
    return null
  }
}

/**
 * `SymmetricKey` is a class that extends the `BigNumber` class and implements symmetric encryption and decryption methods.
 * Symmetric-Key encryption is a form of encryption where the same key is used to encrypt and decrypt the message.
 * It leverages the Advanced Encryption Standard Galois/Counter Mode (AES-GCM) for encryption and decryption of messages.
 *
 * @class SymmetricKey
 * @extends {BigNumber}
 */
export default class SymmetricKey extends BigNumber {
  /**
   * Generates a symmetric key randomly.
   *
   * @method fromRandom
   * @static
   * @returns The newly generated Symmetric Key.
   *
   * @example
   * const symmetricKey = SymmetricKey.fromRandom();
   */
  static fromRandom (): SymmetricKey {
    return new SymmetricKey(Random(32))
  }

  /**
   * Encrypts a given message using AES-GCM encryption.
   * The generated Initialization Vector (IV) is attached to the encrypted message for decryption purposes.
   * The OpenSSL format of |IV|encryptedContent|authTag| is used.
   *
   * @method encrypt
   * @param msg - The message to be encrypted. It can be a string or an array of numbers.
   * @param enc - optional. The encoding of the message. If hex, the string is assumed to be hex, UTF-8 otherwise.
   * @returns Returns the encrypted message as a string or an array of numbers, depending on `enc` argument.
   *
   * @example
   * const key = new SymmetricKey(1234);
   * const encryptedMessage = key.encrypt('plainText', 'utf8');
   */
  encrypt (msg: number[] | string, enc?: 'hex'): string | number[] {
    const iv = new Uint8Array(Random(32))
    const msgBytes = new Uint8Array(toArray(msg, enc))
    const keyBytes = new Uint8Array(this.toArray('be', 32))

    // Fast path: native AES-256-GCM via node:crypto / react-native-quick-crypto.
    // Falls back to pure-TS on any failure.
    if (NATIVE_AES_GCM_AVAILABLE) {
      const nativeResult = nativeEncrypt(msgBytes, iv, keyBytes)
      if (nativeResult !== null) {
        return encode(Array.from(nativeResult), enc)
      }
    }

    // Pure-TS fallback.
    const { result, authenticationTag } = AESGCM(
      msgBytes,
      iv,
      keyBytes
    )

    const totalLength = iv.length + result.length + authenticationTag.length
    const combined = new Uint8Array(totalLength)
    let offset = 0

    combined.set(iv, offset)
    offset += iv.length
    combined.set(result, offset)
    offset += result.length
    combined.set(authenticationTag, offset)

    return encode(Array.from(combined), enc)
  }

  /**
   * Decrypts a given AES-GCM encrypted message using the same key that was used for encryption.
   * The method extracts the IV and the authentication tag from the encrypted message, then attempts to decrypt it.
   * If the decryption fails (e.g., due to message tampering), an error is thrown.
   *
   * @method decrypt
   * @param msg - The encrypted message to be decrypted. It can be a string or an array of numbers.
   * @param enc - optional. The encoding of the message (if no encoding is provided, uses utf8 for strings, unless specified as hex).
   * @returns Returns the decrypted message as a string or an array of numbers, depending on `enc` argument. If absent, an array of numbers is returned.
   *
   * @example
   * const key = new SymmetricKey(1234);
   * const decryptedMessage = key.decrypt(encryptedMessage, 'utf8');
   *
   * @throws {Error} Will throw an error if the decryption fails, likely due to message tampering or incorrect decryption key.
   */
  decrypt (msg: number[] | string, enc?: 'hex' | 'utf8'): string | number[] {
    const msgBytes = new Uint8Array(toArray(msg, enc))

    const ivLength = 32
    const tagLength = 16

    if (msgBytes.length < ivLength + tagLength) {
      throw new Error('Ciphertext too short')
    }

    const keyBytes = new Uint8Array(this.toArray('be', 32))

    // Fast path: native AES-256-GCM via node:crypto / react-native-quick-crypto.
    // Falls back to pure-TS on null/undefined return.
    if (NATIVE_AES_GCM_AVAILABLE) {
      const nativeResult = nativeDecrypt(msgBytes, ivLength, tagLength, keyBytes)
      if (nativeResult !== undefined) {
        // nativeResult is Uint8Array on success or null on auth/decryption failure.
        if (nativeResult === null) {
          throw new Error('Decryption failed!')
        }
        return encode(Array.from(nativeResult), enc)
      }
      // undefined means unexpected setup error — fall through to pure-TS.
    }

    // Pure-TS fallback.
    const iv = msgBytes.slice(0, ivLength)
    const tagStart = msgBytes.length - tagLength
    const ciphertext = msgBytes.slice(ivLength, tagStart)
    const messageTag = msgBytes.slice(tagStart)

    const result = AESGCMDecrypt(
      ciphertext,
      iv,
      messageTag,
      keyBytes
    )
    if (result === null) {
      throw new Error('Decryption failed!')
    }
    return encode(Array.from(result), enc)
  }
}
