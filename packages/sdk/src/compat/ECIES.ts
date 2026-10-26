// Modified bsv 1.5.6 and SJCL lineages; see ../../THIRD_PARTY_NOTICES.md.
// import { AESWrappercbc } from './aescbc'
import Random from '../primitives/Random.js'
import PrivateKey from '../primitives/PrivateKey.js'
import PublicKey from '../primitives/PublicKey.js'
import Point from '../primitives/Point.js'
import Curve from '../primitives/Curve.js'
import { sha256hmac, sha512 } from '../primitives/Hash.js'
import { constantTimeEquals, toArray, toHex, encode } from '../primitives/utils.js'
import { compatBytes, MAX_COMPAT_BYTE_PAYLOAD } from './CompatValidation.js'

const MAX_ECIES_ENVELOPE_BYTES = MAX_COMPAT_BYTE_PAYLOAD + 160

function ownedPrivateKey(value: unknown, label: string): PrivateKey {
  if (!(value instanceof PrivateKey)) throw new TypeError(`${label} must be a PrivateKey`)
  const key = new PrivateKey(compatBytes(value.toArray('be', 32), label, 32, 32))
  if (key.isZero() || key.gte(new Curve().n)) throw new TypeError(`${label} is invalid`)
  return key
}

function ownedPublicKey(value: unknown, label: string): PublicKey {
  if (!(value instanceof PublicKey)) throw new TypeError(`${label} must be a PublicKey`)
  return PublicKey.fromDER(compatBytes(value.encode(true) as number[], label, 33, 33))
}

interface AESState {
  _key: number[][]
  _tables: Uint32Array[][]
  _precompute: () => void
  _crypt: (input: number[], dir: number) => Uint32Array
  encrypt: (data: number[]) => Uint32Array
  decrypt: (data: number[]) => Uint32Array
}

function expandEncryptionKey(key: number[], sbox: Uint32Array): number[] {
  const keyLen = key.length
  const encKey = key.slice()
  let rcon = 1
  for (let i = keyLen; i < 4 * keyLen + 28; i++) {
    let word = encKey[i - 1]
    if (i % keyLen === 0 || (keyLen === 8 && i % keyLen === 4)) {
      word =
        (sbox[word >>> 24] << 24) ^
        (sbox[(word >> 16) & 255] << 16) ^
        (sbox[(word >> 8) & 255] << 8) ^
        sbox[word & 255]
      if (i % keyLen === 0) {
        word = (word << 8) ^ (word >>> 24) ^ (rcon << 24)
        rcon = (rcon << 1) ^ ((rcon >> 7) * 283)
      }
    }
    encKey[i] = encKey[i - keyLen] ^ word
  }
  return encKey
}

function expandDecryptionKey(
  encKey: number[],
  sbox: Uint32Array,
  decTable: Uint32Array[]
): number[] {
  const decKey: number[] = []
  for (let j = 0, i = encKey.length; i > 0; j++, i--) {
    const word = encKey[(j & 3) === 0 ? i - 4 : i]
    decKey[j] =
      i <= 4 || j < 4
        ? word
        : decTable[0][sbox[word >>> 24]] ^
          decTable[1][sbox[(word >> 16) & 255]] ^
          decTable[2][sbox[(word >> 8) & 255]] ^
          decTable[3][sbox[word & 255]]
  }
  return decKey
}

function AES(this: AESState, key: number[]): void {
  if (this._tables[0][0][0] === 0) this._precompute()

  const sbox = this._tables[0][4]
  const decTable = this._tables[1]
  const keyLen = key.length

  if (keyLen !== 4 && keyLen !== 6 && keyLen !== 8) {
    throw new Error('invalid aes key size')
  }

  const encKey = expandEncryptionKey(key, sbox)
  const decKey = expandDecryptionKey(encKey, sbox, decTable)
  this._key = [encKey, decKey]
}

AES.prototype = {
  /**
   * Encrypt an array of 4 big-endian words.
   * @param {Array} data The plaintext.
   * @return {Array} The ciphertext.
   */
  encrypt: function (this: AESState, data: number[]) {
    return this._crypt(data, 0)
  },

  /**
   * Decrypt an array of 4 big-endian words.
   * @param {Array} data The ciphertext.
   * @return {Array} The plaintext.
   */
  decrypt: function (this: AESState, data: number[]) {
    return this._crypt(data, 1)
  },

  /**
   * The expanded S-box and inverse S-box tables.  These will be computed
   * on the client so that we don't have to send them down the wire.
   *
   * There are two tables, _tables[0] is for encryption and
   * _tables[1] is for decryption.
   *
   * The first 4 sub-tables are the expanded S-box with MixColumns.  The
   * last (_tables[01][4]) is the S-box itself.
   *
   * @private
   */
  _tables: [
    [
      new Uint32Array(256),
      new Uint32Array(256),
      new Uint32Array(256),
      new Uint32Array(256),
      new Uint32Array(256)
    ],
    [
      new Uint32Array(256),
      new Uint32Array(256),
      new Uint32Array(256),
      new Uint32Array(256),
      new Uint32Array(256)
    ]
  ],
  _key: [] as number[][],

  // Expand the S-box tables.
  _precompute: function (this: AESState) {
    const encTable = this._tables[0]
    const decTable = this._tables[1]
    const sbox = encTable[4]
    const sboxInv = decTable[4]
    let i
    let x
    let xInv
    const d = new Uint8Array(256)
    const th = new Uint8Array(256)
    let x2
    let x4
    let x8
    let s
    let tEnc
    let tDec

    // Compute double and third tables
    for (i = 0; i < 256; i++) {
      d[i] = (i << 1) ^ ((i >> 7) * 283)
      th[d[i] ^ i] = i
    }

    for (
      x = xInv = 0;
      sbox[x] === 0;
      x ^= x2 === 0 ? 1 : x2, xInv = th[xInv] === 0 ? 1 : th[xInv]
    ) {
      // Compute sbox
      s = xInv ^ (xInv << 1) ^ (xInv << 2) ^ (xInv << 3) ^ (xInv << 4)
      s = (s >> 8) ^ (s & 255) ^ 99
      sbox[x] = s
      sboxInv[s] = x

      // Compute MixColumns
      x2 = d[x]
      x4 = d[x2]
      x8 = d[x4]
      tDec = (x8 * 0x1010101) ^ (x4 * 0x10001) ^ (x2 * 0x101) ^ (x * 0x1010100)
      tEnc = (d[s] * 0x101) ^ (s * 0x1010100)

      for (i = 0; i < 4; i++) {
        encTable[i][x] = tEnc = (tEnc << 24) ^ (tEnc >>> 8)
        decTable[i][s] = tDec = (tDec << 24) ^ (tDec >>> 8)
      }
    }
  },

  /**
   * Encryption and decryption core.
   * @param {Array} input Four words to be encrypted or decrypted.
   * @param dir The direction, 0 for encrypt and 1 for decrypt.
   * @return {Array} The four encrypted or decrypted words.
   * @private
   */
  _crypt: function (this: AESState, input: number[], dir: number) {
    if (input.length !== 4) {
      throw new Error('invalid aes block size')
    }

    const key = this._key[dir]
    // state variables a,b,c,d are loaded with pre-whitened data
    let a = input[0] ^ key[0]
    let b = input[dir === 1 ? 3 : 1] ^ key[1]
    let c = input[2] ^ key[2]
    let d = input[dir === 1 ? 1 : 3] ^ key[3]
    let a2
    let b2
    let c2

    const nInnerRounds = key.length / 4 - 2
    let i
    let kIndex = 4
    const out = new Uint32Array(4)
    const // <--- this is slower in Node, about the same in Chrome */
      table = this._tables[dir]

    // load up the tables
    const t0 = table[0]
    const t1 = table[1]
    const t2 = table[2]
    const t3 = table[3]
    const sbox = table[4]

    // Inner rounds.  Cribbed from OpenSSL.
    for (i = 0; i < nInnerRounds; i++) {
      a2 = t0[a >>> 24] ^ t1[(b >> 16) & 255] ^ t2[(c >> 8) & 255] ^ t3[d & 255] ^ key[kIndex]
      b2 = t0[b >>> 24] ^ t1[(c >> 16) & 255] ^ t2[(d >> 8) & 255] ^ t3[a & 255] ^ key[kIndex + 1]
      c2 = t0[c >>> 24] ^ t1[(d >> 16) & 255] ^ t2[(a >> 8) & 255] ^ t3[b & 255] ^ key[kIndex + 2]
      d = t0[d >>> 24] ^ t1[(a >> 16) & 255] ^ t2[(b >> 8) & 255] ^ t3[c & 255] ^ key[kIndex + 3]
      kIndex += 4
      a = a2
      b = b2
      c = c2
    }

    // Last round.
    for (i = 0; i < 4; i++) {
      out[dir === 1 ? 3 & -i : i] =
        (sbox[a >>> 24] << 24) ^
        (sbox[(b >> 16) & 255] << 16) ^
        (sbox[(c >> 8) & 255] << 8) ^
        sbox[d & 255] ^
        key[kIndex++]
      a2 = a
      a = b
      b = c
      c = d
      d = a2
    }

    return out
  }
}

const AESConstructor = AES as unknown as new (key: number[]) => AESState

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class AESWrapper {
  public static encrypt(messageBuf: number[], keyBuf: number[]): number[] {
    const key = AESWrapper.buf2Words(keyBuf)
    const message = AESWrapper.buf2Words(messageBuf)
    const a = new AESConstructor(key)
    const enc = a.encrypt(message)
    const encBuf = AESWrapper.words2Buf(enc)
    return encBuf
  }

  public static decrypt(encBuf: number[], keyBuf: number[]): number[] {
    const enc = AESWrapper.buf2Words(encBuf)
    const key = AESWrapper.buf2Words(keyBuf)
    const a = new AESConstructor(key)
    const message = a.decrypt(enc)
    const messageBuf = AESWrapper.words2Buf(message)
    return messageBuf
  }

  public static buf2Words(buf: number[]): number[] {
    if (buf.length % 4 !== 0) {
      throw new Error('buf length must be a multiple of 4')
    }
    const words: number[] = []
    for (let i = 0; i < buf.length / 4; i++) {
      const val =
        buf[i * 4] * 0x1000000 + // Shift the first byte by 24 bits
        ((buf[i * 4 + 1] << 16) | // Shift the second byte by 16 bits
          (buf[i * 4 + 2] << 8) | // Shift the third byte by 8 bits
          buf[i * 4 + 3]) // The fourth byte
      words.push(val)
    }
    return words
  }

  public static words2Buf(words: ArrayLike<number>): number[] {
    const buf = Array.from({ length: words.length * 4 }, () => 0)

    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      buf[i * 4] = (word >>> 24) & 0xff
      buf[i * 4 + 1] = (word >>> 16) & 0xff
      buf[i * 4 + 2] = (word >>> 8) & 0xff
      buf[i * 4 + 3] = word & 0xff
    }

    return buf
  }
}

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class CBC {
  public static buf2BlocksBuf(buf: number[], blockSize: number): number[][] {
    const bytesize = blockSize / 8
    const blockBufs: number[][] = []

    for (let i = 0; i <= buf.length / bytesize; i++) {
      let blockBuf = buf.slice(i * bytesize, i * bytesize + bytesize)

      if (blockBuf.length < blockSize) {
        blockBuf = CBC.pkcs7Pad(blockBuf, blockSize)
      }

      blockBufs.push(blockBuf)
    }

    return blockBufs
  }

  public static blockBufs2Buf(blockBufs: number[][]): number[] {
    let last = blockBufs.at(-1)
    last = CBC.pkcs7Unpad(last!)
    blockBufs[blockBufs.length - 1] = last

    const buf = blockBufs.flat()

    return buf
  }

  public static encrypt(
    messageBuf: number[],
    ivBuf: number[],
    blockCipher: any,
    cipherKeyBuf: number[]
  ): number[] {
    const blockSize = ivBuf.length * 8
    const blockBufs = CBC.buf2BlocksBuf(messageBuf, blockSize)
    const encBufs = CBC.encryptBlocks(blockBufs, ivBuf, blockCipher, cipherKeyBuf)
    const encBuf = encBufs.flat()
    return encBuf
  }

  public static decrypt(
    encBuf: number[],
    ivBuf: number[],
    blockCipher: any,
    cipherKeyBuf: number[]
  ): number[] {
    const bytesize = ivBuf.length
    const encBufs: number[][] = []
    for (let i = 0; i < encBuf.length / bytesize; i++) {
      encBufs.push(encBuf.slice(i * bytesize, i * bytesize + bytesize))
    }
    const blockBufs = CBC.decryptBlocks(encBufs, ivBuf, blockCipher, cipherKeyBuf)
    const buf = CBC.blockBufs2Buf(blockBufs)
    return buf
  }

  public static encryptBlock(
    blockBuf: number[],
    ivBuf: number[],
    blockCipher: any,
    cipherKeyBuf: number[]
  ): number[] {
    const xorbuf = CBC.xorBufs(blockBuf, ivBuf)
    const encBuf = blockCipher.encrypt(xorbuf, cipherKeyBuf)
    return encBuf
  }

  public static decryptBlock(
    encBuf: number[],
    ivBuf: number[],
    blockCipher: any,
    cipherKeyBuf: number[]
  ): number[] {
    const xorbuf = blockCipher.decrypt(encBuf, cipherKeyBuf)
    const blockBuf = CBC.xorBufs(xorbuf, ivBuf)
    return blockBuf
  }

  public static encryptBlocks(
    blockBufs: number[][],
    ivBuf: number[],
    blockCipher: any,
    cipherKeyBuf: number[]
  ): number[][] {
    const encBufs: number[][] = []

    for (const blockBuf of blockBufs) {
      const encBuf = CBC.encryptBlock(blockBuf, ivBuf, blockCipher, cipherKeyBuf)

      encBufs.push(encBuf)

      ivBuf = encBuf
    }

    return encBufs
  }

  public static decryptBlocks(
    encBufs: number[][],
    ivBuf: number[],
    blockCipher: any,
    cipherKeyBuf: number[]
  ): number[][] {
    const blockBufs: number[][] = []

    for (const encBuf of encBufs) {
      const blockBuf = CBC.decryptBlock(encBuf, ivBuf, blockCipher, cipherKeyBuf)

      blockBufs.push(blockBuf)

      ivBuf = encBuf
    }

    return blockBufs
  }

  public static pkcs7Pad(buf: number[], blockSize: number): number[] {
    const bytesize = blockSize / 8
    const padbytesize = bytesize - buf.length
    const pad = Array.from({ length: padbytesize }, () => 0)
    pad.fill(padbytesize)
    const paddedbuf = [...buf, ...pad]
    return paddedbuf
  }

  public static pkcs7Unpad(paddedbuf: number[]): number[] {
    const padlength = paddedbuf.at(-1)!
    if (padlength < 1 || padlength > 16 || padlength > paddedbuf.length) {
      throw new Error('invalid padding')
    }
    const padbuf = paddedbuf.slice(paddedbuf.length - padlength, paddedbuf.length)
    const padbuf2 = Array.from({ length: padlength }, () => 0)
    padbuf2.fill(padlength)
    if (toHex(padbuf) !== toHex(padbuf2)) {
      throw new Error('invalid padding')
    }
    return paddedbuf.slice(0, paddedbuf.length - padlength)
  }

  public static xorBufs(buf1: number[], buf2: number[]): number[] {
    if (buf1.length !== buf2.length) {
      throw new Error('bufs must have the same length')
    }

    const buf = Array.from({ length: buf1.length }, () => 0)

    for (let i = 0; i < buf1.length; i++) {
      buf[i] = buf1[i] ^ buf2[i]
    }

    return buf
  }
}

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class AESCBC {
  public static encrypt(
    messageBuf: number[],
    cipherKeyBuf: number[],
    ivBuf: number[],
    concatIvBuf = true
  ): number[] {
    ivBuf = ivBuf ?? Random(128 / 8)
    const ctBuf = CBC.encrypt(messageBuf, ivBuf, AESWrapper, cipherKeyBuf)
    if (concatIvBuf) {
      return [...ivBuf, ...ctBuf]
    } else {
      return [...ctBuf]
    }
  }

  public static decrypt(encBuf: number[], cipherKeyBuf: number[], ivBuf?: number[]): number[] {
    if (ivBuf == null) {
      ivBuf = encBuf.slice(0, 128 / 8)
      const ctBuf = encBuf.slice(128 / 8)
      return CBC.decrypt(ctBuf, ivBuf, AESWrapper, cipherKeyBuf)
    } else {
      const ctBuf = encBuf
      return CBC.decrypt(ctBuf, ivBuf, AESWrapper, cipherKeyBuf)
    }
  }
}

/**
 * @class ECIES
 * Implements the Electrum ECIES protocol for encrypted communication.
 *
 * Electrum BIE1 derives its IV from the ECDH secret. Reusing `fromPrivateKey`, especially in
 * `noKey` mode, therefore repeats the encryption key and IV and reveals equality/relationships
 * between messages. Do not use static sender keys for new encryption and do not treat either
 * legacy format as carrying an application audience, purpose, freshness, or replay guarantee.
 *
 * @deprecated This class is deprecated in favor of the BRC-78 standard for portable encrypted messages,
 * which provides a more comprehensive and secure solution by integrating with BRC-42 and BRC-43 standards.
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export default class ECIES {
  /**
   * Generates the initialization vector (iv), encryption key (kE), and MAC key (kM)
   * using the sender's private key and receiver's public key.
   *
   * @param {PrivateKey} privKey - The sender's private key.
   * @param {PublicKey} pubKey - The receiver's public key.
   * @returns {Object} An object containing the iv, kE, and kM as number arrays.
   */
  public static ivkEkM(
    privKey: PrivateKey,
    pubKey: PublicKey
  ): { iv: number[]; kE: number[]; kM: number[] } {
    const r = ownedPrivateKey(privKey, 'ECIES private key')
    const KB = ownedPublicKey(pubKey, 'ECIES public key')
    const P = KB.mul(r)
    const S = new PublicKey(P.x, P.y)
    const Sbuf = S.encode(true) as number[]
    const hash = sha512(Sbuf)
    return {
      iv: hash.slice(0, 16),
      kE: hash.slice(16, 32),
      kM: hash.slice(32, 64)
    }
  }

  /**
   * Encrypts a given message using the Electrum ECIES method.
   *
   * @param {number[]} messageBuf - The message to be encrypted, in number array format.
   * @param {PublicKey} toPublicKey - The public key of the recipient.
   * @param {PrivateKey} [fromPrivateKey] - The private key of the sender. If not provided, a random private key is used.
   * @param {boolean} [noKey=false] - If true, does not include the sender's public key in the encrypted message.
   * Reusing `fromPrivateKey` repeats BIE1's derived key and IV. Omit it to use a fresh ephemeral
   * key, and do not use `noKey` for new protocols.
   * @returns {number[]} The encrypted message as a number array.
   */
  public static electrumEncrypt(
    messageBuf: number[],
    toPublicKey: PublicKey,
    fromPrivateKey?: PrivateKey,
    noKey = false
  ): number[] {
    messageBuf = compatBytes(messageBuf, 'Electrum ECIES plaintext')
    toPublicKey = ownedPublicKey(toPublicKey, 'Electrum ECIES recipient public key')
    if (typeof noKey !== 'boolean') throw new TypeError('Electrum ECIES noKey must be boolean')
    let Rbuf: string | number[] | null = null
    fromPrivateKey =
      fromPrivateKey == null
        ? PrivateKey.fromRandom()
        : ownedPrivateKey(fromPrivateKey, 'Electrum ECIES sender private key')
    if (!noKey) {
      Rbuf = fromPrivateKey.toPublicKey().encode(true)
    }
    const { iv, kE, kM } = ECIES.ivkEkM(fromPrivateKey, toPublicKey)
    const ciphertext = AESCBC.encrypt(messageBuf, kE, iv, false)
    const BIE1 = toArray('BIE1', 'utf8')
    let encBuf: number[]
    if (Rbuf !== undefined && Rbuf !== null && Rbuf.length > 0) {
      encBuf = [...BIE1, ...Rbuf, ...ciphertext]
    } else {
      encBuf = [...BIE1, ...ciphertext]
    }
    const hmac = sha256hmac(kM, encBuf)
    return [...encBuf, ...hmac]
  }

  /**
   * Decrypts a message encrypted using the Electrum ECIES method.
   *
   * @param {number[]} encBuf - The encrypted message buffer.
   * @param {PrivateKey} toPrivateKey - The private key of the recipient.
   * @param {PublicKey} [fromPublicKey=null] - The public key of the sender. If not provided, it is extracted from the message.
   * @returns {number[]} The decrypted message as a number array.
   */
  public static electrumDecrypt(
    encBuf: number[],
    toPrivateKey: PrivateKey,
    fromPublicKey?: PublicKey
  ): number[] {
    const tagLength = 32
    encBuf = compatBytes(
      encBuf,
      'Electrum ECIES envelope',
      4 + 16 + tagLength,
      MAX_ECIES_ENVELOPE_BYTES
    )
    toPrivateKey = ownedPrivateKey(toPrivateKey, 'Electrum ECIES recipient private key')
    const expectedPublicKey =
      fromPublicKey == null
        ? undefined
        : ownedPublicKey(fromPublicKey, 'Electrum ECIES sender public key')

    const magic = encBuf.slice(0, 4)
    if (encode(magic, 'utf8') !== 'BIE1') {
      throw new Error('Invalid Magic')
    }
    let offset = 4

    // Determine if the sender's public key is included in encBuf
    let Rbuf: number[] | null = null
    const available = encBuf.length - offset - tagLength
    if (available >= 33 + 16) {
      const firstByte = encBuf[offset]
      if ((firstByte === 0x02 || firstByte === 0x03) && (available - 33) % 16 === 0) {
        // Compressed public key
        Rbuf = encBuf.slice(offset, offset + 33)
        offset += 33
      } else if (firstByte === 0x04 && available >= 65 + 16 && (available - 65) % 16 === 0) {
        // Uncompressed public key
        Rbuf = encBuf.slice(offset, offset + 65)
        offset += 65
      }
    }

    if (Rbuf === null) {
      if (expectedPublicKey == null) {
        throw new Error('Sender public key is required')
      }
      fromPublicKey = expectedPublicKey
    } else {
      const embeddedPublicKey = PublicKey.fromString(toHex(Rbuf))
      if (
        expectedPublicKey != null &&
        !constantTimeEquals(
          embeddedPublicKey.encode(true) as number[],
          expectedPublicKey.encode(true) as number[]
        )
      ) {
        throw new Error('Embedded sender public key does not match the expected sender')
      }
      fromPublicKey = expectedPublicKey ?? embeddedPublicKey
    }

    const { iv, kE, kM } = ECIES.ivkEkM(toPrivateKey, fromPublicKey)
    const ciphertext = encBuf.slice(offset, encBuf.length - tagLength)
    if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
      throw new Error('Invalid Electrum ECIES ciphertext framing')
    }
    const hmac = encBuf.slice(encBuf.length - tagLength, encBuf.length)

    const hmac2 = sha256hmac(kM, encBuf.slice(0, encBuf.length - tagLength))

    if (!constantTimeEquals(hmac, hmac2)) {
      throw new Error('Invalid checksum')
    }

    return AESCBC.decrypt(ciphertext, kE, iv)
  }

  /**
   * Encrypts a given message using the Bitcore variant of ECIES.
   *
   * @param {number[]} messageBuf - The message to be encrypted, in number array format.
   * @param {PublicKey} toPublicKey - The public key of the recipient.
   * @param {PrivateKey} [fromPrivateKey] - The private key of the sender. If not provided, a random private key is used.
   * @param {number[]} [ivBuf] - The initialization vector for encryption. If not provided, a random IV is used.
   * @returns {number[]} The encrypted message as a number array.
   */
  public static bitcoreEncrypt(
    messageBuf: number[],
    toPublicKey: PublicKey,
    fromPrivateKey?: PrivateKey,
    ivBuf?: number[]
  ): number[] {
    messageBuf = compatBytes(messageBuf, 'Bitcore ECIES plaintext')
    toPublicKey = ownedPublicKey(toPublicKey, 'Bitcore ECIES recipient public key')
    fromPrivateKey =
      fromPrivateKey == null
        ? PrivateKey.fromRandom()
        : ownedPrivateKey(fromPrivateKey, 'Bitcore ECIES sender private key')
    ivBuf = ivBuf == null ? Random(16) : compatBytes(ivBuf, 'Bitcore ECIES IV', 16, 16)
    const r = fromPrivateKey
    const RPublicKey = fromPrivateKey.toPublicKey()
    const RBuf = RPublicKey.encode(true) as number[]
    const KB = toPublicKey
    const P = KB.mul(r)
    const S = P.getX()
    const Sbuf = S.toArray('be', 32)
    const kEkM = sha512(Sbuf)
    const kE = kEkM.slice(0, 32)
    const kM = kEkM.slice(32, 64)
    const c = AESCBC.encrypt(messageBuf, kE, ivBuf)
    const d = sha256hmac(kM, [...c])
    const encBuf = [...RBuf, ...c, ...d]
    return encBuf
  }

  /**
   * Decrypts a message encrypted using the Bitcore variant of ECIES.
   *
   * @param {number[]} encBuf - The encrypted message buffer.
   * @param {PrivateKey} toPrivateKey - The private key of the recipient.
   * @returns {number[]} The decrypted message as a number array.
   */
  public static bitcoreDecrypt(encBuf: number[], toPrivateKey: PrivateKey): number[] {
    encBuf = compatBytes(
      encBuf,
      'Bitcore ECIES envelope',
      33 + 16 + 16 + 32,
      MAX_ECIES_ENVELOPE_BYTES
    )
    if ((encBuf.length - 33 - 32) % 16 !== 0) {
      throw new Error('Invalid Bitcore ECIES ciphertext framing')
    }
    const kB = ownedPrivateKey(toPrivateKey, 'Bitcore ECIES recipient private key')
    const fromPublicKey = PublicKey.fromString(toHex(encBuf.slice(0, 33)))
    const R = fromPublicKey
    const P = R.mul(kB)
    if (P.eq(new Point(0, 0))) {
      throw new Error('P equals 0')
    }
    const S = P.getX()
    const Sbuf = S.toArray('be', 32)
    const kEkM = sha512(Sbuf)
    const kE = kEkM.slice(0, 32)
    const kM = kEkM.slice(32, 64)
    const c = encBuf.slice(33, -32)
    const d = encBuf.slice(-32)
    const d2 = sha256hmac(kM, c)
    if (!constantTimeEquals(d, d2)) {
      throw new Error('Invalid checksum')
    }
    const messageBuf = AESCBC.decrypt(c, kE)
    return [...messageBuf]
  }
}
