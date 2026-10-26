// Implements BIP 39 with modified bsv 1.5.6 lineage; see ../../THIRD_PARTY_NOTICES.md.
import { wordList } from './bip-39-wordlist-en.js'
import { encode, toArray, Reader, Writer } from '../primitives/utils.js'
import { pbkdf2, sha256 } from '../primitives/Hash.js'
import Random from '../primitives/Random.js'
import { compatBytes, compatString } from './CompatValidation.js'

const BIP39_WORD_COUNTS = new Set([12, 15, 18, 21, 24])
const MAX_MNEMONIC_LENGTH = 8192
const MAX_PASSPHRASE_LENGTH = 1024 * 1024
const MAX_WORD_LENGTH = 256

function validateWordlist(
  wordlist: unknown
): asserts wordlist is { value: string[]; space: string } {
  if (wordlist == null || typeof wordlist !== 'object') {
    throw new TypeError('Mnemonic wordlist must be an object')
  }
  const valueDescriptor = Object.getOwnPropertyDescriptor(wordlist, 'value')
  const spaceDescriptor = Object.getOwnPropertyDescriptor(wordlist, 'space')
  if (
    valueDescriptor == null ||
    !('value' in valueDescriptor) ||
    !Array.isArray(valueDescriptor.value) ||
    valueDescriptor.value.length !== 2048
  ) {
    throw new TypeError('Mnemonic wordlist must contain exactly 2048 words')
  }
  const values = valueDescriptor.value
  const words = new Set<string>()
  for (let index = 0; index < values.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index))
    if (
      descriptor == null ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.length === 0 ||
      descriptor.value.length > MAX_WORD_LENGTH ||
      words.has(descriptor.value)
    ) {
      throw new TypeError('Mnemonic wordlist must contain unique bounded dense string entries')
    }
    words.add(descriptor.value)
  }
  if (
    spaceDescriptor == null ||
    !('value' in spaceDescriptor) ||
    typeof spaceDescriptor.value !== 'string' ||
    spaceDescriptor.value.length === 0 ||
    spaceDescriptor.value.length > 8
  ) {
    throw new TypeError('Mnemonic wordlist separator must be a bounded non-empty string')
  }
}

/**
 * @class Mnemonic
 *
 * @description
 * Class representing Mnemonic functionality.
 * This class provides methods for generating, converting, and validating mnemonic phrases
 * according to the BIP39 standard. It supports creating mnemonics from random entropy,
 * converting mnemonics to seeds, and validating mnemonic phrases.
 *
 * BIP-39's fixed 2048-round PBKDF2 derivation is a compatibility transform, not modern
 * password hardening. Generate 128–256 bits of random entropy, use a high-entropy passphrase
 * where operationally possible, and keep the public `mnemonic` and `seed` fields confined to
 * trusted code. Changing the iteration count changes every derived wallet.
 */
export default class Mnemonic {
  public mnemonic: string
  public seed: number[]
  public Wordlist: { value: string[]; space: string }

  /**
   * Constructs a Mnemonic object.
   * @param {string} [mnemonic] - An optional mnemonic phrase.
   * @param {number[]} [seed] - An optional seed derived from the mnemonic.
   * @param {object} [wordlist=wordList] - An object containing a list of words and space character used in the mnemonic.
   */
  constructor(mnemonic?: string, seed?: number[], wordlist = wordList) {
    validateWordlist(wordlist)
    this.mnemonic = compatString(mnemonic ?? '', 'Mnemonic', MAX_MNEMONIC_LENGTH)
    this.seed = compatBytes(seed ?? [], 'Mnemonic seed', 0, 64)
    this.Wordlist = wordlist
  }

  /**
   * Converts the mnemonic and seed into a binary representation.
   * @returns {number[]} The binary representation of the mnemonic and seed.
   */
  public toBinary(): number[] {
    validateWordlist(this.Wordlist)
    const mnemonic = compatString(this.mnemonic, 'Mnemonic', MAX_MNEMONIC_LENGTH)
    const seed = compatBytes(this.seed, 'Mnemonic seed', 0, 64)
    const bw = new Writer()
    if (mnemonic === '') {
      bw.writeVarIntNum(0)
    } else {
      const buf = toArray(mnemonic, 'utf8')
      bw.writeVarIntNum(buf.length)
      bw.write(buf)
    }
    if (seed.length > 0) {
      bw.writeVarIntNum(seed.length)
      bw.write(seed)
    } else {
      bw.writeVarIntNum(0)
    }
    return bw.toArray()
  }

  /**
   * Loads a mnemonic and seed from a binary representation.
   * @param {number[]} bin - The binary representation of a mnemonic and seed.
   * @returns {this} The Mnemonic instance with loaded mnemonic and seed.
   */
  public fromBinary(bin: number[]): this {
    bin = compatBytes(bin, 'Mnemonic binary data', 2, MAX_MNEMONIC_LENGTH + 80)
    const br = new Reader(bin)
    const mnemoniclen = br.readVarIntNumStrict(false)
    if (mnemoniclen > MAX_MNEMONIC_LENGTH) {
      throw new RangeError('Mnemonic binary text exceeds the supported limit')
    }
    let mnemonic = ''
    if (mnemoniclen > 0) {
      const mnemonicBytes = br.read(mnemoniclen)
      mnemonic = encode(mnemonicBytes, 'utf8') as string
      if (toArray(mnemonic, 'utf8').join(',') !== mnemonicBytes.join(',')) {
        throw new TypeError('Mnemonic binary text is not canonical UTF-8')
      }
    }
    const seedlen = br.readVarIntNumStrict(false)
    if (seedlen > 64) throw new RangeError('Mnemonic binary seed exceeds 64 bytes')
    let seed: number[] = []
    if (seedlen > 0) {
      seed = br.read(seedlen)
    }
    if (!br.eof()) throw new Error('Mnemonic binary data contains trailing bytes')
    if (mnemonic !== '') {
      const previousMnemonic = this.mnemonic
      let valid = false
      try {
        this.mnemonic = mnemonic
        valid = this.check()
      } finally {
        this.mnemonic = previousMnemonic
      }
      if (!valid) throw new Error('Mnemonic binary data contains an invalid BIP-39 phrase')
    }
    this.mnemonic = mnemonic
    this.seed = seed
    return this
  }

  /**
   * Generates a random mnemonic from a given bit length.
   * @param {number} [bits=128] - The bit length for the random mnemonic (must be a multiple of 32 and at least 128).
   * @returns {this} The Mnemonic instance with the new random mnemonic.
   * @throws {Error} If the bit length is not a multiple of 32 or is less than 128.
   */
  public fromRandom(bits?: number): this {
    if (bits === undefined || bits === null || Number.isNaN(bits) || bits === 0) {
      bits = 128
    }
    if (!Number.isSafeInteger(bits) || bits % 32 !== 0) {
      throw new Error('bits must be multiple of 32')
    }
    if (bits < 128) {
      throw new Error('bits must be at least 128')
    }
    if (bits > 256) throw new Error('bits must not exceed the BIP-39 maximum of 256')
    const buf = Random(bits / 8)
    this.entropy2Mnemonic(buf)
    this.mnemonic2Seed()
    return this
  }

  /**
   * Static method to generate a Mnemonic instance with a random mnemonic.
   * @param {number} [bits=128] - The bit length for the random mnemonic.
   * @returns {Mnemonic} A new Mnemonic instance.
   */
  public static fromRandom(bits?: number): Mnemonic {
    return new this().fromRandom(bits)
  }

  /**
   * Converts given entropy into a mnemonic phrase.
   * This method is used to generate a mnemonic from a specific entropy source.
   * @param {number[]} buf - The entropy buffer, must be at least 128 bits.
   * @returns {this} The Mnemonic instance with the mnemonic set from the given entropy.
   * @throws {Error} If the entropy is less than 128 bits.
   */
  public fromEntropy(buf: number[]): this {
    this.entropy2Mnemonic(buf)
    return this
  }

  /**
   * Static method to create a Mnemonic instance from a given entropy.
   * @param {number[]} buf - The entropy buffer.
   * @returns {Mnemonic} A new Mnemonic instance.
   */
  public static fromEntropy(buf: number[]): Mnemonic {
    return new this().fromEntropy(buf)
  }

  /**
   * Sets the mnemonic for the instance from a string.
   * @param {string} mnemonic - The mnemonic phrase as a string.
   * @returns {this} The Mnemonic instance with the set mnemonic.
   * @throws {Error} If the mnemonic does not pass BIP-39 validation
   * (unknown words, invalid length, or bad checksum).
   */
  public fromString(mnemonic: string): this {
    mnemonic = compatString(mnemonic, 'Mnemonic', MAX_MNEMONIC_LENGTH)
    const previousMnemonic = this.mnemonic
    this.mnemonic = mnemonic
    let valid = false
    try {
      valid = this.check()
    } catch {
      valid = false
    }
    if (!valid) {
      this.mnemonic = previousMnemonic
      throw new Error(
        'Mnemonic does not pass the check - was the mnemonic typed incorrectly? Are there extra spaces?'
      )
    }
    // A previously derived seed belongs to the old phrase (and possibly an unavailable
    // passphrase). Do not leave that stale key authority attached to newly parsed words.
    this.seed = []
    return this
  }

  /**
   * Static method to create a Mnemonic instance from a mnemonic string.
   * @param {string} str - The mnemonic phrase.
   * @returns {Mnemonic} A new Mnemonic instance.
   */
  public static fromString(str: string): Mnemonic {
    return new this().fromString(str)
  }

  /**
   * Converts the instance's mnemonic to a string representation.
   * @returns {string} The mnemonic phrase as a string.
   */
  public toString(): string {
    return this.mnemonic
  }

  /**
   * Converts the mnemonic to a seed.
   * The mnemonic must pass the validity check before conversion.
   * @param {string} [passphrase=''] - An optional passphrase for additional security.
   * @returns {number[]} The generated seed.
   * @throws {Error} If the mnemonic is invalid.
   */
  public toSeed(passphrase?: string): number[] {
    this.mnemonic2Seed(passphrase)
    return this.seed
  }

  /**
   * Converts entropy to a mnemonic phrase.
   * This method takes a buffer of entropy and converts it into a corresponding
   * mnemonic phrase based on the Mnemonic wordlist. The entropy should be at least 128 bits.
   * The method applies a checksum and maps the entropy to words in the wordlist.
   * @param {number[]} buf - The entropy buffer to convert. Must be at least 128 bits.
   * @returns {this} The Mnemonic instance with the mnemonic set from the entropy.
   * @throws {Error} If the entropy is less than 128 bits or if it's not an even multiple of 11 bits.
   */
  public entropy2Mnemonic(buf: number[]): this {
    validateWordlist(this.Wordlist)
    if (Array.isArray(buf) && buf.length < 128 / 8) {
      throw new Error('Entropy is less than 128 bits. It must be 128 bits or more.')
    }
    buf = compatBytes(buf, 'Mnemonic entropy', 16, 32)
    if (buf.length > 32 || buf.length % 4 !== 0) {
      throw new Error('Entropy must be 128 to 256 bits in a multiple of 32 bits')
    }

    const hash = sha256(buf)
    let bin = ''
    const bits = buf.length * 8
    for (const byte of buf) {
      bin = bin + ('00000000' + byte.toString(2)).slice(-8)
    }
    let hashbits = hash[0].toString(2)
    hashbits = ('00000000' + hashbits).slice(-8).slice(0, bits / 32)
    bin = bin + hashbits

    if (bin.length % 11 !== 0) {
      throw new Error(
        'internal error - entropy not an even multiple of 11 bits - ' + bin.length.toString()
      )
    }

    let mnemonic = ''
    for (let i = 0; i < bin.length / 11; i++) {
      if (mnemonic !== '') {
        mnemonic = mnemonic + this.Wordlist.space
      }
      const wi = Number.parseInt(bin.slice(i * 11, (i + 1) * 11), 2)
      mnemonic = mnemonic + this.Wordlist.value[wi]
    }

    this.mnemonic = mnemonic
    this.seed = []
    return this
  }

  /**
   * Recovers the original entropy bytes from the instance's mnemonic phrase.
   * @returns {number[]} The entropy buffer that was originally used to generate the mnemonic.
   * @throws {Error} If the mnemonic is invalid or contains unknown words.
   */
  public toEntropy(): number[] {
    validateWordlist(this.Wordlist)
    compatString(this.mnemonic, 'Mnemonic', MAX_MNEMONIC_LENGTH)
    const words = this.mnemonic.split(this.Wordlist.space)
    if (!BIP39_WORD_COUNTS.has(words.length)) {
      throw new Error('Mnemonic must contain 12, 15, 18, 21, or 24 words')
    }
    let bin = ''
    for (const word of words) {
      const ind = this.Wordlist.value.indexOf(word)
      if (ind < 0) {
        throw new Error(`Unknown word in mnemonic: "${word}"`)
      }
      bin = bin + ('00000000000' + ind.toString(2)).slice(-11)
    }

    if (bin.length % 11 !== 0) {
      throw new Error(
        'internal error - entropy not an even multiple of 11 bits - ' + bin.length.toString()
      )
    }

    const cs = bin.length / 33
    const entropyBits = bin.slice(0, bin.length - cs)
    const buf: number[] = []
    for (let i = 0; i < entropyBits.length / 8; i++) {
      buf.push(Number.parseInt(entropyBits.slice(i * 8, (i + 1) * 8), 2))
    }

    const hash = sha256(buf)
    let expectedHashBits = hash[0].toString(2)
    expectedHashBits = ('00000000' + expectedHashBits).slice(-8).slice(0, cs)
    const actualHashBits = bin.slice(-cs)
    if (expectedHashBits !== actualHashBits) {
      throw new Error('Mnemonic checksum invalid')
    }

    return buf
  }

  /**
   * Validates the mnemonic phrase.
   * Checks for correct length, absence of invalid words, and proper checksum.
   * @returns {boolean} True if the mnemonic is valid, false otherwise.
   * @throws {Error} If the mnemonic is not an even multiple of 11 bits.
   */
  public check(): boolean {
    validateWordlist(this.Wordlist)
    const mnemonic = compatString(this.mnemonic, 'Mnemonic', MAX_MNEMONIC_LENGTH)

    // confirm no invalid words
    const words = mnemonic.split(this.Wordlist.space)
    if (!BIP39_WORD_COUNTS.has(words.length)) return false
    let bin = ''
    for (const word of words) {
      const ind = this.Wordlist.value.indexOf(word)
      if (ind < 0) {
        return false
      }
      bin = bin + ('00000000000' + ind.toString(2)).slice(-11)
    }

    if (bin.length % 11 !== 0) {
      throw new Error(
        'internal error - entropy not an even multiple of 11 bits - ' + bin.length.toString()
      )
    }

    // confirm checksum
    const cs = bin.length / 33
    const hashBits = bin.slice(-cs)
    const nonhashBits = bin.slice(0, bin.length - cs)
    const buf: number[] = []

    for (let i = 0; i < nonhashBits.length / 8; i++) {
      buf.push(Number.parseInt(bin.slice(i * 8, (i + 1) * 8), 2))
    }
    const hash = sha256(buf.slice(0, nonhashBits.length / 8))
    let expectedHashBits = hash[0].toString(2)
    expectedHashBits = ('00000000' + expectedHashBits).slice(-8).slice(0, cs)

    return expectedHashBits === hashBits
  }

  /**
   * Converts a mnemonic to a seed.
   * This method takes the instance's mnemonic phrase, combines it with a passphrase (if provided),
   * and uses PBKDF2 to generate a seed. It also validates the mnemonic before conversion.
   * This seed can then be used for generating deterministic keys.
   * @param {string} [passphrase=''] - An optional passphrase for added security.
   * @returns {this} The Mnemonic instance with the seed generated from the mnemonic.
   * @throws {Error} If the mnemonic does not pass validation or if the passphrase is not a string.
   */
  public mnemonic2Seed(passphrase = ''): this {
    let mnemonic = this.mnemonic
    if (typeof passphrase !== 'string') {
      throw new TypeError('passphrase must be a string or undefined')
    }
    compatString(passphrase, 'Mnemonic passphrase', MAX_PASSPHRASE_LENGTH)
    if (!this.check()) {
      throw new Error(
        'Mnemonic does not pass the check - was the mnemonic typed incorrectly? Are there extra spaces?'
      )
    }
    mnemonic = mnemonic.normalize('NFKD')
    passphrase = passphrase.normalize('NFKD')
    const mbuf = toArray(mnemonic, 'utf8')
    const pbuf = [...toArray('mnemonic', 'utf8'), ...toArray(passphrase, 'utf8')]
    this.seed = pbkdf2(mbuf, pbuf, 2048, 64, 'sha512')
    return this
  }

  /**
   * Determines the validity of a given passphrase with the mnemonic.
   * This method is useful for checking if a passphrase matches with the mnemonic.
   * @param {string} [passphrase=''] - The passphrase to validate.
   * @returns {boolean} True if the mnemonic and passphrase combination is valid, false otherwise.
   */
  public isValid(passphrase = ''): boolean {
    let isValid
    try {
      this.mnemonic2Seed(passphrase)
      isValid = true
    } catch {
      isValid = false
    }
    return isValid
  }

  /**
   * Static method to check the validity of a given mnemonic and passphrase combination.
   * @param {string} mnemonic - The mnemonic phrase.
   * @param {string} [passphrase=''] - The passphrase to validate.
   * @returns {boolean} True if the combination is valid, false otherwise.
   */
  public static isValid(mnemonic: string, passphrase = ''): boolean {
    return new Mnemonic(mnemonic).isValid(passphrase)
  }
}
