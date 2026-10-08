import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  hkdfSync,
  KeyObject,
  randomBytes
} from 'node:crypto'
import {
  canonicalOutputJSON,
  createClosedOutputObjectValidator,
  outputString,
  parseOutputJSON,
  OutputProtocolError,
  type OutputJSONObject
} from '@bsv/sdk'
import { nativeOutputBytes } from './NativeOutputBytes.js'

// Capture only fixed field definitions; validate every supplied value afresh.
const assertPayloadEnvelopeFields: ReturnType<typeof createClosedOutputObjectValidator> =
  createClosedOutputObjectValidator(['format', 'keyId', 'salt', 'nonce', 'ciphertext', 'tag'])

/** Local custody port. IDs must be public labels; key material never enters a persisted envelope. */
export interface ProtectedPayloadCustody {
  /** Resolve the exact retained key; a missing key must throw, never create a replacement. */
  resolve(keyId: string): KeyObject
}

export interface ProtectedPayloadEnvelope {
  format: 'output-protected-payload/1'
  keyId: string
  salt: string
  nonce: string
  ciphertext: string
  tag: string
}

const FORMAT = 'output-protected-payload/1'
const MAXIMUM_PLAINTEXT_BYTES = 2 * 1024 * 1024
const MAXIMUM_CONTEXT_BYTES = 64 * 1024

/**
 * Node-only local AES-256-GCM framing, not a wire profile or disclosure authority.
 * Use independently generated 256-bit custody keys, retain every referenced key
 * through its obligations, and back up keys separately from the whole database.
 * Each encryption derives a fresh AES key using HKDF-SHA256 and a random
 * 256-bit salt, then uses a random 96-bit GCM nonce and a 128-bit tag.
 * This local format cannot recover missing custody keys or detect rollback of
 * an entire valid database; those remain operator/ledger recovery obligations.
 */
export class NodeProtectedPayloadCodec {
  private readonly writeKeyId: string
  readonly maximumPlaintextBytes: number

  constructor(
    private readonly custody: ProtectedPayloadCustody,
    writeKeyId: string,
    maximumPlaintextBytes = MAXIMUM_PLAINTEXT_BYTES
  ) {
    this.writeKeyId = keyLabel(writeKeyId)
    if (
      !Number.isSafeInteger(maximumPlaintextBytes) ||
      maximumPlaintextBytes < 1 ||
      maximumPlaintextBytes > MAXIMUM_PLAINTEXT_BYTES
    )
      throw new OutputProtocolError('invalid', 'Invalid protected payload capacity')
    this.maximumPlaintextBytes = maximumPlaintextBytes
    this.key(this.writeKeyId)
  }

  seal(binding: OutputJSONObject, value: Uint8Array): ProtectedPayloadEnvelope {
    // Own caller bytes before consulting trusted custody code.
    if (!(value instanceof Uint8Array))
      throw new OutputProtocolError('invalid', 'Protected payload must contain bytes')
    if (value.byteLength > this.maximumPlaintextBytes)
      throw new OutputProtocolError('limited', 'Protected payload exceeds its reserved capacity')
    const bytes = Buffer.from(value)
    let derived: Buffer | undefined
    try {
      const aad = associatedData(binding, this.writeKeyId)
      const key = this.key(this.writeKeyId)
      const salt = randomBytes(32)
      derived = Buffer.from(hkdfSync('sha256', key, salt, FORMAT, 32))
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', createSecretKey(derived), nonce, {
        authTagLength: 16
      })
      cipher.setAAD(aad)
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
      return {
        format: FORMAT,
        keyId: this.writeKeyId,
        salt: salt.toString('base64'),
        nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64')
      }
    } finally {
      bytes.fill(0)
      derived?.fill(0)
    }
  }

  open(binding: OutputJSONObject, input: unknown): Uint8Array {
    return this.decrypt(binding, parseEnvelope(input, this.maximumPlaintextBytes))
  }

  /** Own and validate serialized data locally; every call resolves custody afresh. */
  openSerialized(
    binding: OutputJSONObject,
    input: string,
    maximumEnvelopeBytes: number
  ): Uint8Array {
    if (typeof input !== 'string')
      throw new OutputProtocolError('invalid', 'Protected payload must contain serialized JSON')
    if (
      !Number.isSafeInteger(maximumEnvelopeBytes) ||
      maximumEnvelopeBytes < 1 ||
      maximumEnvelopeBytes > Math.ceil(this.maximumPlaintextBytes / 3) * 4 + 1024
    )
      throw new OutputProtocolError('invalid', 'Invalid protected payload envelope capacity')
    // Preserve the ledger's existing virtual reader, including one getter capture
    // before text parsing. A custom reader receives the same owned envelope.
    const reader = this.open
    const owned = parseOutputJSON(input, { bytes: maximumEnvelopeBytes })
    if (reader !== defaultObjectReader) return Reflect.apply(reader, this, [binding, owned])
    const fields = ['format', 'keyId', 'salt', 'nonce', 'ciphertext', 'tag']
    const stringsOnly =
      owned !== null &&
      typeof owned === 'object' &&
      !Array.isArray(owned) &&
      Object.keys(owned).length === fields.length &&
      fields.every(name => typeof owned[name] === 'string')
    // Six owned string fields have canonical JSON no larger than their bounded
    // serialized input. Preserve the original canonicalization/error order for
    // every malformed shape or nonstring field rather than broadening that path.
    const envelope = stringsOnly
      ? envelopeFields(owned)
      : parseEnvelope(owned, this.maximumPlaintextBytes)
    return this.decrypt(binding, envelope)
  }

  private decrypt(binding: OutputJSONObject, envelope: ProtectedPayloadEnvelope): Uint8Array {
    const aad = associatedData(binding, envelope.keyId)
    const key = this.key(envelope.keyId)
    const salt = bytes(envelope.salt, 32, 32)
    const nonce = bytes(envelope.nonce, 12, 12)
    const tag = bytes(envelope.tag, 16, 16)
    const ciphertext = bytes(envelope.ciphertext, this.maximumPlaintextBytes)
    let tentative: Buffer | undefined
    let derived: Buffer | undefined
    try {
      derived = Buffer.from(hkdfSync('sha256', key, salt, FORMAT, 32))
      const decipher = createDecipheriv('aes-256-gcm', createSecretKey(derived), nonce, {
        authTagLength: 16
      })
      decipher.setAAD(aad)
      decipher.setAuthTag(tag)
      tentative = decipher.update(ciphertext)
      const tail = decipher.final()
      return Uint8Array.from(Buffer.concat([tentative, tail]))
    } catch {
      // Do not attach provider errors, private bytes or OpenSSL diagnostics.
      throw new OutputProtocolError('unavailable', 'Protected payload authentication failed')
    } finally {
      tentative?.fill(0)
      derived?.fill(0)
    }
  }

  private key(keyId: string): KeyObject {
    try {
      const key = this.custody.resolve(keyId)
      if (!(key instanceof KeyObject) || key.type !== 'secret' || key.symmetricKeySize !== 32)
        throw new Error('Invalid custody capability')
      return key
    } catch {
      throw new OutputProtocolError('unavailable', 'Protected payload custody is unavailable')
    }
  }
}

// Capture only a function identity; every operation still resolves the current
// instance/prototype reader, binding, custody and authentication independently.
const defaultObjectReader = NodeProtectedPayloadCodec.prototype.open

function keyLabel(input: unknown): string {
  const value = outputString(input)
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(value))
    throw new OutputProtocolError('invalid', 'Invalid protected payload key label')
  return value
}

function associatedData(binding: OutputJSONObject, keyId: string): Buffer {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding))
    throw new OutputProtocolError('invalid', 'Protected payload binding must be an object')
  return Buffer.from(
    canonicalOutputJSON({ format: FORMAT, keyId, binding }, { bytes: MAXIMUM_CONTEXT_BYTES }),
    'utf8'
  )
}

function bytes(input: string, maximum: number, exact?: number): Buffer {
  const result = nativeOutputBytes(input, maximum)
  if (exact !== undefined && result.byteLength !== exact)
    throw new OutputProtocolError('invalid', 'Invalid protected payload framing')
  return result
}

function parseEnvelope(input: unknown, maximum: number): ProtectedPayloadEnvelope {
  // Canonicalization rejects accessors before copying any field or calling custody.
  const value: unknown = JSON.parse(
    canonicalOutputJSON(input, { bytes: Math.ceil(maximum / 3) * 4 + 1024 })
  )
  return envelopeFields(value)
}

function envelopeFields(value: unknown): ProtectedPayloadEnvelope {
  assertPayloadEnvelopeFields(value)
  if (value.format !== FORMAT)
    throw new OutputProtocolError('unsupported', 'Unsupported protected payload format')
  return {
    format: FORMAT,
    keyId: keyLabel(value.keyId),
    salt: outputString(value.salt),
    nonce: outputString(value.nonce),
    ciphertext:
      typeof value.ciphertext === 'string' ? value.ciphertext : outputString(value.ciphertext),
    tag: outputString(value.tag)
  }
}
