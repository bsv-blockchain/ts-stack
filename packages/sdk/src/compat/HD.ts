// @ts-nocheck
// Modified bsv 1.5.6 lineage; see ../../THIRD_PARTY_NOTICES.md.
import {
  fromBase58Check,
  toBase58Check,
  Writer,
  Reader,
  toArray,
  toHex
} from '../primitives/utils.js'
import { hash160, sha512hmac } from '../primitives/Hash.js'
import Curve from '../primitives/Curve.js'
import PrivateKey from '../primitives/PrivateKey.js'
import PublicKey from '../primitives/PublicKey.js'
import Random from '../primitives/Random.js'
import BigNumber from '../primitives/BigNumber.js'
import { compatBytes, compatString, uint32 } from './CompatValidation.js'

const MAX_DERIVATION_PATH_LENGTH = 4096

/**
 * @deprecated
 * The HD class implements the Bitcoin Improvement Proposal 32 (BIP32) hierarchical deterministic wallets.
 * It allows the generation of child keys from a master key, ensuring a tree-like structure of keys and addresses.
 * This class is deprecated due to the introduction of BRC-42, which offers an enhanced key derivation scheme.
 * BRC-42 uses invoice numbers for key derivation, improving privacy and scalability compared to BIP32.
 * BIP32 also permits recovery of a parent private key from its extended public key plus any
 * non-hardened child private key. Never expose that combination across trust boundaries, and do
 * not share these mutable key objects with untrusted code.
 *
 * @class HD
 * @deprecated Replaced by BRC-42 which uses invoice numbers and supports private derivation.
 */
export default class HD {
  versionBytesNum: number
  depth: number
  parentFingerPrint: number[]
  childIndex: number
  chainCode: number[]
  privKey: PrivateKey
  pubKey: PublicKey
  constants = {
    pubKey: 0x0488b21e,
    privKey: 0x0488ade4
  }

  /**
   * Constructor for the BIP32 HD wallet.
   * Initializes an HD wallet with optional parameters for version bytes, depth, parent fingerprint, child index, chain code, private key, and public key.
   * @param versionBytesNum - Version bytes number for the wallet.
   * @param depth - Depth of the key in the hierarchy.
   * @param parentFingerPrint - Fingerprint of the parent key.
   * @param childIndex - Index of the child key.
   * @param chainCode - Chain code for key derivation.
   * @param privKey - Private key of the wallet.
   * @param pubKey - Public key of the wallet.
   */
  constructor(
    versionBytesNum?: number,
    depth?: number,
    parentFingerPrint?: number[],
    childIndex?: number,
    chainCode?: number[],
    privKey?: PrivateKey,
    pubKey?: PublicKey
  ) {
    this.versionBytesNum = versionBytesNum
    this.depth = depth
    this.parentFingerPrint = parentFingerPrint
    this.childIndex = childIndex
    this.chainCode = chainCode
    this.privKey = privKey
    this.pubKey = pubKey
  }

  /**
   * Generates a new HD wallet with random keys.
   * This method creates a root HD wallet with randomly generated private and public keys.
   * @returns {HD} The current HD instance with generated keys.
   */
  public fromRandom(): this {
    this.versionBytesNum = this.constants.privKey
    this.depth = 0x00
    this.parentFingerPrint = [0, 0, 0, 0]
    this.childIndex = 0
    this.chainCode = Random(32)
    this.privKey = PrivateKey.fromRandom()
    this.pubKey = this.privKey.toPublicKey()
    return this
  }

  /**
   * Generates a new HD wallet with random keys.
   * This method creates a root HD wallet with randomly generated private and public keys.
   * @returns {HD} A new HD instance with generated keys.
   * @static
   */
  public static fromRandom(): HD {
    return new this().fromRandom()
  }

  /**
   * Initializes the HD wallet from a given base58 encoded string.
   * This method decodes a provided string to set up the HD wallet's properties.
   * @param str - A base58 encoded string representing the wallet.
   * @returns {HD} The new instance with properties set from the string.
   */
  public static fromString(str: string): HD {
    return new this().fromString(str)
  }

  /**
   * Initializes the HD wallet from a given base58 encoded string.
   * This method decodes a provided string to set up the HD wallet's properties.
   * @param str - A base58 encoded string representing the wallet.
   * @returns {HD} The current instance with properties set from the string.
   */
  public fromString(str: string): this {
    str = compatString(str, 'BIP32 extended key', 256)
    if (str.length === 0) throw new TypeError('BIP32 extended key must not be empty')
    const decoded = fromBase58Check(str)
    return this.fromBinary([...decoded.prefix, ...decoded.data] as number[])
  }

  /**
   * Initializes the HD wallet from a seed.
   * This method generates keys and other properties from a given seed, conforming to the BIP32 specification.
   * @param bytes - An array of bytes representing the seed.
   * @returns {HD} The current instance with properties set from the seed.
   */
  public static fromSeed(bytes: number[]): HD {
    return new this().fromSeed(bytes)
  }

  /**
   * Initializes the HD wallet from a seed.
   * This method generates keys and other properties from a given seed, conforming to the BIP32 specification.
   * @param bytes - An array of bytes representing the seed.
   * @returns {HD} The current instance with properties set from the seed.
   */
  public fromSeed(bytes: number[]): this {
    bytes = compatBytes(bytes, 'BIP32 seed', 16, 64)
    if (bytes.length < 128 / 8) {
      throw new Error('Need more than 128 bits of entropy')
    }
    if (bytes.length > 512 / 8) {
      throw new Error('More than 512 bits of entropy is nonstandard')
    }
    const hash: number[] = sha512hmac(toArray('Bitcoin seed', 'utf8'), bytes)

    this.depth = 0x00
    this.parentFingerPrint = [0, 0, 0, 0]
    this.childIndex = 0
    this.chainCode = hash.slice(32, 64)
    this.versionBytesNum = this.constants.privKey
    const master = new BigNumber(hash.slice(0, 32))
    if (master.isZero() || master.gte(new Curve().n)) {
      throw new Error('Invalid BIP32 master key')
    }
    this.privKey = new PrivateKey(master)
    this.pubKey = this.privKey.toPublicKey()

    return this
  }

  /**
   * Initializes the HD wallet from a binary buffer.
   * Parses a binary buffer to set up the wallet's properties.
   * @param buf - A buffer containing the wallet data.
   * @returns {HD} The new instance with properties set from the buffer.
   */
  public static fromBinary(buf: number[]): HD {
    return new this().fromBinary(buf)
  }

  /**
   * Initializes the HD wallet from a binary buffer.
   * Parses a binary buffer to set up the wallet's properties.
   * @param buf - A buffer containing the wallet data.
   * @returns {HD} The current instance with properties set from the buffer.
   */
  public fromBinary(buf: number[]): this {
    buf = compatBytes(buf, 'BIP32 data', 78, 78)
    const reader = new Reader(buf)

    const versionBytesNum = reader.readUInt32BE()
    const depth = reader.readUInt8()
    const parentFingerPrint = reader.read(4)
    const childIndex = reader.readUInt32BE()
    const chainCode = reader.read(32)
    const keyBytes = reader.read(33)

    const isPrivate = versionBytesNum === this.constants.privKey
    const isPublic = versionBytesNum === this.constants.pubKey
    let privKey: PrivateKey | undefined
    let pubKey: PublicKey

    if (isPrivate && keyBytes[0] === 0) {
      const privateKey = new BigNumber(keyBytes.slice(1, 33))
      if (privateKey.isZero() || privateKey.gte(new Curve().n)) {
        throw new Error('Invalid key')
      }
      privKey = new PrivateKey(privateKey)
      pubKey = privKey.toPublicKey()
    } else if (isPublic && (keyBytes[0] === 0x02 || keyBytes[0] === 0x03)) {
      pubKey = PublicKey.fromString(toHex(keyBytes))
    } else {
      throw new Error('Invalid key')
    }

    if (depth === 0 && (childIndex !== 0 || parentFingerPrint.some(byte => byte !== 0))) {
      throw new Error('Invalid BIP32 root metadata')
    }

    // Commit only after the whole extended key has been validated. In particular, loading an
    // xpub into a previously private instance must clear the old scalar rather than leaving a
    // hidden private derivation capability attached to public metadata.
    this.versionBytesNum = versionBytesNum
    this.depth = depth
    this.parentFingerPrint = parentFingerPrint
    this.childIndex = childIndex
    this.chainCode = chainCode
    this.privKey = privKey
    this.pubKey = pubKey

    return this
  }

  /**
   * Converts the HD wallet to a base58 encoded string.
   * This method provides a string representation of the HD wallet's current state.
   * @returns {string} A base58 encoded string of the HD wallet.
   */
  public toString(): string {
    const bin = this.toBinary()
    return toBase58Check(bin, [])
  }

  /**
   * Derives a child HD wallet based on a given path.
   * The path specifies the hierarchy of the child key to be derived.
   * @param path - A string representing the derivation path (e.g., 'm/0'/1).
   * @returns {HD} A new HD instance representing the derived child wallet.
   */
  public derive(path: string): HD {
    path = compatString(path, 'BIP32 derivation path', MAX_DERIVATION_PATH_LENGTH)
    if (path === 'm') {
      return this
    }

    const e = path.split('/')
    if (e.length - 1 > 0xff - this.depth) {
      throw new Error('BIP32 derivation depth exceeds 255')
    }

    let bip32: HD | undefined
    for (const [i, c] of e.entries()) {
      if (i === 0) {
        // Since `i` is now a number, compare it to 0
        if (c !== 'm') {
          throw new Error('invalid path')
        }
        continue
      }

      const childMatch = /^(\d+)('?)$/.exec(c)
      if (childMatch === null) {
        throw new Error('invalid path')
      }

      const childIndexValue = Number.parseInt(childMatch[1], 10)
      if (childIndexValue > 0x7fffffff) {
        throw new Error('invalid path')
      }

      const usePrivate = childMatch[2] === "'"
      let childIndex = childIndexValue

      if (usePrivate) {
        childIndex += 0x80000000
      }

      bip32 = (bip32 ?? this).deriveChild(childIndex)
    }

    return bip32 ?? this
  }

  /**
   * Derives a child HD wallet from the current wallet based on an index.
   * This method generates either a private or public child key depending on the current wallet's state.
   * @param i - The index of the child key to derive.
   * @returns {HD} A new HD instance representing the derived child wallet.
   */
  public deriveChild(i: number): HD {
    i = uint32(i, 'BIP32 child index')
    if (!Number.isSafeInteger(this.depth) || this.depth < 0 || this.depth >= 0xff) {
      throw new Error('BIP32 derivation depth exceeds 255')
    }
    const chainCode = compatBytes(this.chainCode, 'BIP32 chain code', 32, 32)

    const ibc: number[] = [(i >> 24) & 0xff, (i >> 16) & 0xff, (i >> 8) & 0xff, i & 0xff]
    const ib = [...ibc]

    const usePrivate = (i & 0x80000000) !== 0

    const isPrivate = this.versionBytesNum === this.constants.privKey

    if (usePrivate && (this.privKey === null || this.privKey === undefined || !isPrivate)) {
      throw new Error('Cannot do private key derivation without private key')
    }

    let ret = null
    if (this.privKey !== null && this.privKey !== undefined) {
      let data = null

      if (usePrivate) {
        data = [0, ...this.privKey.toArray('be', 32), ...ib]
      } else {
        data = [...(this.pubKey.encode(true) as number[]), ...ib]
      }

      const hash = sha512hmac(chainCode, data)
      const il = new BigNumber(hash.slice(0, 32))
      const ir = hash.slice(32, 64)
      const curve = new Curve()
      if (il.gte(curve.n)) throw new Error('Invalid BIP32 child derivation')

      // ki = IL + kpar (mod n).
      const k = il.add(this.privKey).mod(curve.n)
      if (k.isZero()) throw new Error('Invalid BIP32 child derivation')

      ret = new HD()
      ret.chainCode = ir

      ret.privKey = new PrivateKey(k.toArray())
      ret.pubKey = ret.privKey.toPublicKey()
    } else {
      const data = [...(this.pubKey.encode(true) as number[]), ...ib]
      const hash = sha512hmac(chainCode, data)
      const il = new BigNumber(hash.slice(0, 32))
      const ir = hash.slice(32, 64)
      const curve = new Curve()
      if (il.gte(curve.n)) throw new Error('Invalid BIP32 child derivation')

      // Ki = (IL + kpar)*G = IL*G + Kpar
      const ilG = curve.g.mul(il)
      const Kpar = this.pubKey
      const Ki = ilG.add(Kpar)
      if (Ki.isInfinity()) throw new Error('Invalid BIP32 child derivation')
      const newpub = new PublicKey(Ki.x, Ki.y)

      ret = new HD()
      ret.chainCode = ir

      ret.pubKey = newpub
    }

    ret.childIndex = i
    const pubKeyhash = hash160(this.pubKey.encode(true))
    ret.parentFingerPrint = pubKeyhash.slice(0, 4)
    ret.versionBytesNum = this.versionBytesNum
    ret.depth = this.depth + 1

    return ret
  }

  /**
   * Converts the current HD wallet to a public-only wallet.
   * This method strips away the private key information, leaving only the public part.
   * @returns {HD} A new HD instance representing the public-only wallet.
   */
  public toPublic(): HD {
    const bip32 = new HD(
      this.versionBytesNum,
      this.depth,
      compatBytes(this.parentFingerPrint, 'BIP32 parent fingerprint', 4, 4),
      this.childIndex,
      compatBytes(this.chainCode, 'BIP32 chain code', 32, 32),
      undefined,
      PublicKey.fromString(this.pubKey.toString())
    )
    bip32.versionBytesNum = this.constants.pubKey
    bip32.privKey = undefined
    return bip32
  }

  /**
   * Converts the HD wallet into a binary representation.
   * This method serializes the wallet's properties into a binary format.
   * @returns {number[]} An array of numbers representing the binary data of the wallet.
   */
  public toBinary(): number[] {
    if (!Number.isSafeInteger(this.depth) || this.depth < 0 || this.depth > 0xff) {
      throw new TypeError('BIP32 depth must be a uint8')
    }
    const parentFingerPrint = compatBytes(this.parentFingerPrint, 'BIP32 parent fingerprint', 4, 4)
    const childIndex = uint32(this.childIndex, 'BIP32 child index')
    const chainCode = compatBytes(this.chainCode, 'BIP32 chain code', 32, 32)
    const isPrivate = this.versionBytesNum === this.constants.privKey
    const isPublic = this.versionBytesNum === this.constants.pubKey
    if (isPrivate) {
      return new Writer()
        .writeUInt32BE(this.versionBytesNum)
        .writeUInt8(this.depth)
        .write(parentFingerPrint)
        .writeUInt32BE(childIndex)
        .write(chainCode)
        .writeUInt8(0)
        .write(this.privKey.toArray('be', 32))
        .toArray()
    } else if (isPublic) {
      return new Writer()
        .writeUInt32BE(this.versionBytesNum)
        .writeUInt8(this.depth)
        .write(parentFingerPrint)
        .writeUInt32BE(childIndex)
        .write(chainCode)
        .write(this.pubKey.encode(true) as number[])
        .toArray()
    } else {
      throw new Error('bip32: invalid versionBytesNum byte')
    }
  }

  /**
   * Checks if the HD wallet contains a private key.
   * This method determines whether the wallet is a private key wallet or a public key only wallet.
   * @returns {boolean} A boolean value indicating whether the wallet has a private key (true) or not (false).
   */
  public isPrivate(): boolean {
    return this.versionBytesNum === this.constants.privKey
  }
}
