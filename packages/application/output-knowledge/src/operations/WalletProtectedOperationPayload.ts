import {
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  Hash,
  outputAssert,
  outputHex32,
  outputIdentity,
  OutputProtocolError,
  parseOutputJSON,
  Random,
  Utils,
  type OutputJSONObject,
  type WalletInterface
} from '@bsv/sdk'
import type { ProtectedOperationPayload } from './ProtectedOperationPayload.js'
const FORMAT = 'output-wallet-protected-payload/1'
const PROTOCOL = 'output protected workflow'
const digest = (binding: OutputJSONObject): string =>
  Utils.toHex(
    Hash.sha256(
      Utils.toArray(FORMAT + '\0' + canonicalOutputJSON(binding, { bytes: 65536 }), 'utf8')
    )
  )
/**
 * Portable local custody using the selected BRC-100 wallet's authenticated
 * encryption. No raw custody key is stored. Context and a fresh random salt
 * choose the self-counterparty key; decryption requires that same wallet.
 * Identity/binding/length checks do not replace trust in the installed wallet.
 */
export class WalletProtectedOperationPayload implements ProtectedOperationPayload {
  readonly id = FORMAT
  readonly maximumPlaintextBytes: number
  readonly maximumSealedBytes: number
  private readonly identity: string
  private readonly getPublicKey: WalletInterface['getPublicKey']
  private readonly encrypt: WalletInterface['encrypt']
  private readonly decrypt: WalletInterface['decrypt']
  constructor(
    private readonly wallet: Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt'>,
    identity: string,
    maximumPlaintextBytes = 2097152
  ) {
    this.identity = outputIdentity(identity)
    outputAssert(
      Number.isSafeInteger(maximumPlaintextBytes) &&
        maximumPlaintextBytes >= 256 &&
        maximumPlaintextBytes <= 2097152,
      'Invalid protected operation plaintext capacity'
    )
    this.maximumPlaintextBytes = maximumPlaintextBytes
    // BRC-100 encryption is selected explicitly. This local format allows at
    // most 64 bytes of authenticated-encryption framing, never unbounded output.
    this.maximumSealedBytes = Math.ceil((maximumPlaintextBytes + 64) / 3) * 4 + 1024
    this.getPublicKey = wallet.getPublicKey
    this.encrypt = wallet.encrypt
    this.decrypt = wallet.decrypt
    this.current()
  }
  private current(): void {
    outputAssert(
      typeof this.getPublicKey === 'function' &&
        typeof this.encrypt === 'function' &&
        typeof this.decrypt === 'function' &&
        this.wallet.getPublicKey === this.getPublicKey &&
        this.wallet.encrypt === this.encrypt &&
        this.wallet.decrypt === this.decrypt,
      'Protected operation wallet capability changed',
      'context-changed'
    )
  }
  private async requireIdentity(): Promise<void> {
    this.current()
    let actual: string
    try {
      actual = (await this.getPublicKey.call(this.wallet, { identityKey: true })).publicKey
    } catch {
      throw new OutputProtocolError(
        'unavailable',
        'Protected operation wallet is unavailable',
        true
      )
    }
    this.current()
    outputAssert(
      actual === this.identity,
      'Protected operation wallet identity changed',
      'context-changed'
    )
  }
  async seal(binding: OutputJSONObject, plaintext: Uint8Array): Promise<OutputJSONObject> {
    outputAssert(
      plaintext instanceof Uint8Array && plaintext.byteLength <= this.maximumPlaintextBytes,
      'Protected operation plaintext capacity exceeded',
      'limited'
    )
    const bytes = Array.from(plaintext),
      bindingDigest = digest(binding),
      salt = Utils.toHex(Random(32))
    try {
      await this.requireIdentity()
      const result = await this.encrypt.call(this.wallet, {
        protocolID: [2, PROTOCOL],
        keyID: bindingDigest + ' ' + salt,
        counterparty: 'self',
        plaintext: bytes
      })
      await this.requireIdentity()
      const ciphertext = ownedBytes(result.ciphertext, this.maximumPlaintextBytes + 64)
      outputAssert(
        ciphertext.length > bytes.length,
        'Protected operation wallet returned invalid encryption framing',
        'unavailable'
      )
      const envelope = {
        format: FORMAT,
        identity: this.identity,
        bindingDigest,
        salt,
        ciphertext: Utils.toBase64(ciphertext)
      }
      return parseObject(envelope, this.maximumSealedBytes)
    } catch (error) {
      if (error instanceof OutputProtocolError) throw error
      throw new OutputProtocolError(
        'unavailable',
        'Protected operation encryption is unavailable',
        true
      )
    } finally {
      bytes.fill(0)
    }
  }
  async open(binding: OutputJSONObject, input: unknown): Promise<Uint8Array> {
    const value = parseObject(input, this.maximumSealedBytes),
      bindingDigest = digest(binding)
    closedOutputObject(value, ['format', 'identity', 'bindingDigest', 'salt', 'ciphertext'])
    outputAssert(value.format === FORMAT, 'Unsupported protected operation payload', 'unsupported')
    outputAssert(
      value.identity === this.identity && value.bindingDigest === bindingDigest,
      'Protected operation payload binding changed',
      'context-changed'
    )
    const salt = outputHex32(value.salt)
    outputAssert(typeof value.ciphertext === 'string', 'Invalid protected operation ciphertext')
    const ciphertext = Array.from(
      decodeOutputBytes(value.ciphertext, this.maximumPlaintextBytes + 64)
    )
    try {
      await this.requireIdentity()
      const result = await this.decrypt.call(this.wallet, {
        protocolID: [2, PROTOCOL],
        keyID: bindingDigest + ' ' + salt,
        counterparty: 'self',
        ciphertext
      })
      await this.requireIdentity()
      return Uint8Array.from(ownedBytes(result.plaintext, this.maximumPlaintextBytes))
    } catch (error) {
      if (error instanceof OutputProtocolError) throw error
      throw new OutputProtocolError(
        'unavailable',
        'Protected operation decryption is unavailable',
        true
      )
    } finally {
      ciphertext.fill(0)
    }
  }
}
function ownedBytes(input: unknown, maximum: number): number[] {
  outputAssert(
    Array.isArray(input) && input.length <= maximum,
    'Protected operation wallet byte capacity exceeded',
    'limited'
  )
  const copy: number[] = []
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
    outputAssert(
      descriptor &&
        'value' in descriptor &&
        Number.isInteger(descriptor.value) &&
        descriptor.value >= 0 &&
        descriptor.value <= 255,
      'Invalid protected operation wallet bytes',
      'unavailable'
    )
    copy.push(descriptor.value)
  }
  return copy
}
function parseObject(input: unknown, bytes: number): OutputJSONObject {
  const value = parseOutputJSON(canonicalOutputJSON(input, { bytes }), { bytes })
  outputAssert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected protected operation payload object'
  )
  return value
}
