import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { isAbsolute } from 'node:path'

const MINIMUM_TOKEN_BYTES = 32
const MAXIMUM_ASSET_BYTES = 16 * 1024 * 1024
const MAXIMUM_BASE64_BYTES = Math.ceil(MAXIMUM_ASSET_BYTES / 3) * 4
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/iu
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

export interface PublicationInput {
  name: string
  mediaType: string
  bytes: Uint8Array
}

export function publicationTokenFromEnvironment(
  environment: NodeJS.ProcessEnv
): string | undefined {
  const inline = environment.LCH_PUBLICATION_TOKEN
  const file = environment.LCH_PUBLICATION_TOKEN_FILE
  if (inline !== undefined && file !== undefined) {
    throw new TypeError('Configure only one LCH publication token source')
  }
  if (file === undefined) return inline
  if (!isAbsolute(file)) throw new TypeError('LCH_PUBLICATION_TOKEN_FILE must be absolute')
  const raw = readFileSync(file, { encoding: 'utf8' })
  if (Buffer.byteLength(raw, 'utf8') > 4098)
    throw new TypeError('LCH publication token file is oversized')
  return raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.endsWith('\n') ? raw.slice(0, -1) : raw
}

export function publicationTokenForMode(
  walletMode: 'fixture' | 'connected',
  value: string | undefined
): string | undefined {
  if (value === undefined && walletMode === 'fixture') return undefined
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') < MINIMUM_TOKEN_BYTES ||
    Buffer.byteLength(value, 'utf8') > 4096 ||
    hasUnsafeCharacter(value, false)
  ) {
    throw new TypeError(
      'LCH_PUBLICATION_TOKEN must contain 32-4096 non-control UTF-8 bytes in connected-wallet mode'
    )
  }
  return value
}

export function publicationAuthorized(
  request: Pick<IncomingMessage, 'headers'>,
  expectedToken: string | undefined
): boolean {
  if (expectedToken === undefined) return true
  const authorization = request.headers.authorization
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice('Bearer '.length), 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export function parsePublicationInput(value: unknown): PublicationInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('publication input must be a JSON object')
  }
  const input = value as Record<string, unknown>
  if (
    typeof input.name !== 'string' ||
    input.name.length < 1 ||
    Buffer.byteLength(input.name, 'utf8') > 512 ||
    hasUnsafeCharacter(input.name, true)
  ) {
    throw new TypeError('publication name is invalid')
  }
  if (typeof input.mediaType !== 'string' || !MEDIA_TYPE.test(input.mediaType)) {
    throw new TypeError('publication media type is invalid')
  }
  if (
    typeof input.bytesBase64 !== 'string' ||
    input.bytesBase64.length > MAXIMUM_BASE64_BYTES ||
    !CANONICAL_BASE64.test(input.bytesBase64)
  ) {
    throw new TypeError('publication bytes must use bounded canonical base64')
  }
  const decoded = Buffer.from(input.bytesBase64, 'base64')
  if (decoded.length > MAXIMUM_ASSET_BYTES || decoded.toString('base64') !== input.bytesBase64) {
    throw new TypeError('publication bytes must use bounded canonical base64')
  }
  return {
    name: input.name,
    mediaType: input.mediaType,
    bytes: Uint8Array.from(decoded)
  }
}

function hasUnsafeCharacter(value: string, rejectBidi: boolean): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (rejectBidi &&
        ((codePoint >= 0x202a && codePoint <= 0x202e) ||
          (codePoint >= 0x2066 && codePoint <= 0x2069)))
    ) {
      return true
    }
  }
  return false
}
