import { SHA1HMAC, SHA256HMAC, SHA512HMAC } from '../primitives/Hash.js'
import BigNumber from '../primitives/BigNumber.js'
import { constantTimeEquals, toArray } from '../primitives/utils.js'

export type TOTPAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512'

const MAX_SECRET_BYTES = 1024
const MAX_DIGITS = 10
const MAX_PERIOD_SECONDS = 24 * 60 * 60
const MAX_SKEW = 100

/**
 * Options for TOTP generation.
 *
 * `TOTP.generate` and `TOTP.validate` retain their historical two-digit,
 * unpadded default for compatibility. New authentication flows should use
 * `TOTP.generateSecure` and `TOTP.validateSecure`, which default to six
 * zero-padded digits. Applications must still enforce an independent attempt
 * limit.
 *
 * @param {number} [digits=6] - The number of digits in the OTP (1–10).
 * @param {TOTPAlgorithm} [algorithm="SHA-1"] - Algorithm used for hashing.
 * @param {number} [period=30] - The time period for OTP validity in seconds (1–86400).
 * @param {number} [timestamp=Date.now()] - The non-negative timestamp in milliseconds.
 */
export interface TOTPOptions {
  digits?: number
  algorithm?: TOTPAlgorithm
  period?: number
  timestamp?: number
}

/**
 * Options for TOTP validation.
 * @param {number} [skew=1] - The number of time periods to check before and after the current time period (0–100). Wider windows proportionally weaken online-guess resistance.
 */
export type TOTPValidateOptions = TOTPOptions & {
  skew?: number
}

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class TOTP {
  /**
   * Generates a Time-based One-Time Password (TOTP).
   * @param {number[]} secret - The secret key for TOTP.
   * @param {TOTPOptions} options - Optional parameters for TOTP.
   * @returns {string} The generated TOTP.
   */
  static generate(secret: number[], options?: TOTPOptions): string {
    const ownedSecret = validateSecret(secret)
    const _options = this.withDefaultOptions(options)

    const counter = this.getCounter(_options.timestamp, _options.period)
    const otp = generateHOTP(ownedSecret, counter, _options, false)
    return otp
  }

  /**
   * Generates an RFC-style, zero-padded TOTP with a secure six-digit default.
   * Prefer this method for new authentication flows. Existing users of
   * `generate` keep the historical two-digit wire format.
   */
  static generateSecure(secret: number[], options?: TOTPOptions): string {
    const ownedSecret = validateSecret(secret)
    const _options = this.withDefaultOptions(options, 6)
    const counter = this.getCounter(_options.timestamp, _options.period)
    return generateHOTP(ownedSecret, counter, _options, true)
  }

  /**
   * Validates a Time-based One-Time Password (TOTP).
   * @param {number[]} secret - The secret key for TOTP.
   * @param {string} passcode - The passcode to validate.
   * @param {TOTPValidateOptions} options - Optional parameters for TOTP validation.
   * @returns {boolean} A boolean indicating whether the passcode is valid.
   */
  static validate(secret: number[], passcode: string, options?: TOTPValidateOptions): boolean {
    if (typeof passcode !== 'string') return false
    const ownedSecret = validateSecret(secret)
    const _options = this.withDefaultValidateOptions(options)
    passcode = passcode.trim()
    if (passcode.length !== _options.digits) {
      return false
    }

    const counter = this.getCounter(_options.timestamp, _options.period)

    const counters = [counter]
    for (let i = 1; i <= _options.skew; i++) {
      if (counter + i <= Number.MAX_SAFE_INTEGER) counters.push(counter + i)
      if (counter - i >= 0) counters.push(counter - i)
    }

    for (const c of counters) {
      const expected = generateHOTP(ownedSecret, c, _options, false)

      if (constantTimeEquals(toArray(passcode, 'utf8'), toArray(expected, 'utf8'))) {
        return true
      }
    }

    return false
  }

  /**
   * Validates an RFC-style, zero-padded TOTP with a secure six-digit default.
   * Prefer this method for new authentication flows and pair it with an
   * independent attempt limit.
   */
  static validateSecure(
    secret: number[],
    passcode: string,
    options?: TOTPValidateOptions
  ): boolean {
    if (typeof passcode !== 'string') return false
    const ownedSecret = validateSecret(secret)
    const _options = this.withDefaultValidateOptions(options, 6)
    passcode = passcode.trim()
    if (passcode.length !== _options.digits) return false

    const counter = this.getCounter(_options.timestamp, _options.period)
    const counters = [counter]
    for (let i = 1; i <= _options.skew; i++) {
      if (counter + i <= Number.MAX_SAFE_INTEGER) counters.push(counter + i)
      if (counter - i >= 0) counters.push(counter - i)
    }
    for (const c of counters) {
      const expected = generateHOTP(ownedSecret, c, _options, true)
      if (constantTimeEquals(toArray(passcode, 'utf8'), toArray(expected, 'utf8'))) return true
    }
    return false
  }

  private static getCounter(timestamp: number, period: number): number {
    const epochSeconds = Math.floor(timestamp / 1000)
    const counter = Math.floor(epochSeconds / period)
    return counter
  }

  private static withDefaultOptions(
    options?: TOTPOptions,
    defaultDigits = 2
  ): Required<TOTPOptions> {
    const normalized = optionRecord(options)
    const digits = ownOption(normalized, 'digits') ?? defaultDigits
    const algorithm = ownOption(normalized, 'algorithm') ?? 'SHA-1'
    const period = ownOption(normalized, 'period') ?? 30
    const timestamp = ownOption(normalized, 'timestamp') ?? Date.now()
    if (
      typeof digits !== 'number' ||
      !Number.isSafeInteger(digits) ||
      digits < 1 ||
      digits > MAX_DIGITS
    ) {
      throw new RangeError(`TOTP digits must be an integer between 1 and ${MAX_DIGITS}.`)
    }
    if (algorithm !== 'SHA-1' && algorithm !== 'SHA-256' && algorithm !== 'SHA-512') {
      throw new TypeError('TOTP algorithm must be SHA-1, SHA-256, or SHA-512.')
    }
    if (
      typeof period !== 'number' ||
      !Number.isSafeInteger(period) ||
      period < 1 ||
      period > MAX_PERIOD_SECONDS
    ) {
      throw new RangeError(
        `TOTP period must be an integer between 1 and ${MAX_PERIOD_SECONDS} seconds.`
      )
    }
    if (
      typeof timestamp !== 'number' ||
      !Number.isFinite(timestamp) ||
      timestamp < 0 ||
      timestamp > Number.MAX_SAFE_INTEGER
    ) {
      throw new RangeError('TOTP timestamp must be a non-negative finite millisecond value.')
    }
    return { digits, algorithm, period, timestamp }
  }

  private static withDefaultValidateOptions(
    options?: TOTPValidateOptions,
    defaultDigits = 2
  ): Required<TOTPValidateOptions> {
    const normalized = optionRecord(options)
    const skew = ownOption(normalized, 'skew') ?? 1
    if (typeof skew !== 'number' || !Number.isSafeInteger(skew) || skew < 0 || skew > MAX_SKEW) {
      throw new RangeError(`TOTP skew must be an integer between 0 and ${MAX_SKEW}.`)
    }
    return { ...this.withDefaultOptions(options, defaultDigits), skew }
  }
}

function optionRecord(
  options: TOTPOptions | TOTPValidateOptions | undefined
): Record<string, unknown> {
  if (options === undefined) return Object.create(null)
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('TOTP options must be a plain data object.')
  }
  const prototype = Object.getPrototypeOf(options)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('TOTP options must be a plain data object.')
  }
  return options as Record<string, unknown>
}

function ownOption(options: Record<string, unknown>, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(options, name)
  if (descriptor === undefined) return undefined
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new TypeError(`TOTP option ${name} must be an own data property.`)
  }
  return descriptor.value
}

function validateSecret(secret: number[]): number[] {
  if (!Array.isArray(secret) || secret.length < 1 || secret.length > MAX_SECRET_BYTES) {
    throw new RangeError(`TOTP secret must contain between 1 and ${MAX_SECRET_BYTES} bytes.`)
  }
  const owned = Array.from({ length: secret.length }, () => 0)
  for (let i = 0; i < secret.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(secret, i)) {
      throw new TypeError('TOTP secret must be a dense byte array.')
    }
    const value = secret[i]
    if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
      throw new TypeError('TOTP secret must contain only byte values.')
    }
    owned[i] = value
  }
  return owned
}

function generateHOTP(
  secret: number[],
  counter: number,
  options: Required<TOTPOptions>,
  pad: boolean
): string {
  const timePad = new BigNumber(counter).toArray('be', 8)
  const hmac = calcHMAC(secret, timePad, options.algorithm)
  const signature = hmac.digest()

  // RFC 4226 https://datatracker.ietf.org/doc/html/rfc4226#section-5.4
  const offset = (signature.at(-1) ?? 0) & 0x0f // offset is the last byte in the hmac
  const fourBytesRange = signature.slice(offset, offset + 4) // starting from offset, get 4 bytes
  const mask = 0x7fffffff // 32-bit number with a leading 0 followed by 31 ones [0111 (...) 1111]
  const masked = new BigNumber(fourBytesRange).toNumber() & mask

  const decimal = masked.toString()
  const otp = (pad ? decimal.padStart(options.digits, '0') : decimal).slice(-options.digits)
  return otp
}

function calcHMAC(
  secret: number[],
  timePad: number[],
  algorithm: TOTPAlgorithm
): SHA1HMAC | SHA256HMAC | SHA512HMAC {
  switch (algorithm) {
    case 'SHA-1':
      return new SHA1HMAC(secret).update(timePad)
    case 'SHA-256':
      return new SHA256HMAC(secret).update(timePad)
    case 'SHA-512':
      return new SHA512HMAC(secret).update(timePad)
    default:
      throw new Error('unsupported HMAC algorithm')
  }
}
