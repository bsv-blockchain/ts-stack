import {
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  Hash,
  outputHex32,
  outputString,
  outputU64,
  OutputProtocolError,
  parseOutputJSON,
  SymmetricKey,
  Utils
} from '@bsv/sdk'
import { lookupIndexKey } from './LookupIndexKey.js'

export type LookupCursorPosition =
  | { phase: 'snapshot'; watermark: string; after: string | null }
  | { phase: 'live'; through: string }

function position(input: unknown): LookupCursorPosition {
  closedOutputObject(input, ['phase'], ['watermark', 'after', 'through'])
  if (input.phase === 'snapshot') {
    closedOutputObject(input, ['phase', 'watermark', 'after'])
    outputU64(input.watermark)
    return {
      phase: 'snapshot',
      watermark: input.watermark as string,
      after: input.after === null ? null : lookupIndexKey(input.after)
    }
  }
  if (input.phase === 'live') {
    closedOutputObject(input, ['phase', 'through'])
    outputU64(input.through)
    return { phase: 'live', through: input.through as string }
  }
  throw new OutputProtocolError('invalid', 'Invalid lookup cursor phase')
}

const format = 'output-live-lookup-cursor/1'
// SDK AES-GCM framing is a 32-byte random IV and a 16-byte authentication tag.
// 720 plaintext + 48 framing bytes occupy at most 1024 base64 characters.
const maximumPlaintext = 720
const maximumCiphertext = 768

/**
 * Provider-local opaque cursor framing, not a protocol-defined wire encoding.
 * Persist the random 256-bit key with its session. AES-GCM also conceals internal
 * scan positions for rows excluded by the query. Decryption proves only cursor
 * integrity/binding; the service must separately check principal, current access,
 * epoch, retained history and deadlines before any response serialization.
 */
export class LookupCursorCodec {
  private readonly key: SymmetricKey
  private readonly binding: string

  constructor(secret: string, session: string, epoch: string) {
    this.key = new SymmetricKey(outputHex32(secret), 'hex')
    const context = canonicalOutputJSON({
      format,
      session: outputString(session),
      epoch: outputString(epoch)
    })
    this.binding = Utils.toHex(Hash.sha256(Utils.toArray(context, 'utf8')))
  }

  seal(input: LookupCursorPosition): string {
    const text = canonicalOutputJSON(
      { format, binding: this.binding, position: position(input) },
      { bytes: maximumPlaintext }
    )
    const ciphertext = this.key.encrypt(Utils.toArray(text, 'utf8')) as number[]
    return outputString(Utils.toBase64(ciphertext))
  }

  open(cursor: unknown): LookupCursorPosition {
    try {
      const ciphertext = decodeOutputBytes(cursor, maximumCiphertext)
      const plaintext = this.key.decrypt(ciphertext) as number[]
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(plaintext))
      const value = parseOutputJSON(text, { bytes: maximumPlaintext })
      closedOutputObject(value, ['format', 'binding', 'position'])
      if (value.format !== format || value.binding !== this.binding)
        throw new OutputProtocolError('invalid', 'Lookup cursor binding changed')
      return position(value.position)
    } catch {
      // No cursor/key/body material and no decryption-oracle distinctions escape.
      throw new OutputProtocolError('reset-required', 'Invalid or unavailable lookup cursor')
    }
  }
}
