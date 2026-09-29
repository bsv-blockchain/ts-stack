import { PrivateKey, PublicKey, Signature, StorageUtils, Utils } from '@bsv/sdk'
import {
  decodeAndVerifyUHRPAdvertisement,
  type VerifiedUHRPAdvertisement
} from './uhrpTokenValidation'

const OBJECT_IDENTIFIER = /^[1-9A-HJ-NP-Za-km-z]{1,128}$/
const KEYS = [
  'version', 'uhrpUrl', 'objectIdentifier', 'uploaderIdentityKey',
  'hostedFileLocation', 'hash', 'expiryTime', 'fileSize', 'contentType'
] as const

export interface AdvertisementMetadata {
  version: 1
  uhrpUrl: string
  objectIdentifier: string
  uploaderIdentityKey: string
  hostedFileLocation: string
  hash: string
  expiryTime: number
  fileSize: number
  contentType: string
}

function serverPrivateKey(): PrivateKey {
  const value = process.env.SERVER_PRIVATE_KEY
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('SERVER_PRIVATE_KEY must be a 32-byte hexadecimal private key')
  }
  return new PrivateKey(value, 'hex', 'be', 'error')
}

function object(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is malformed`)
  const keys = Reflect.ownKeys(value)
  if (
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))
  ) throw new Error(`${label} is malformed`)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor == null || !('value' in descriptor)) throw new Error(`${label} is malformed`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || Utils.toArray(value, 'utf8').length < 1 ||
      Utils.toArray(value, 'utf8').length > maximum || /\p{Cc}/u.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`)
  return value
}

function validate(value: unknown): AdvertisementMetadata {
  const input = object(value, KEYS, 'UHRP advertisement metadata')
  if (input.version !== 1) throw new Error('UHRP advertisement metadata version is invalid')
  const hash = text(input.hash, 'UHRP advertisement hash', 64).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('UHRP advertisement hash is invalid')
  const uhrpUrl = text(input.uhrpUrl, 'UHRP URL', 128)
  if (uhrpUrl !== StorageUtils.getURLForHash(Utils.toArray(hash, 'hex'))) {
    throw new Error('UHRP advertisement metadata URL does not match its hash')
  }
  const objectIdentifier = text(input.objectIdentifier, 'UHRP object identifier', 128)
  if (!OBJECT_IDENTIFIER.test(objectIdentifier)) throw new Error('UHRP object identifier is invalid')
  const uploaderIdentityKey = text(input.uploaderIdentityKey, 'UHRP uploader identity key', 66).toLowerCase()
  if (!/^(?:02|03)[0-9a-f]{64}$/.test(uploaderIdentityKey)) throw new Error('UHRP uploader identity key is invalid')
  PublicKey.fromString(uploaderIdentityKey)
  const hostedFileLocation = text(input.hostedFileLocation, 'UHRP hosted file location', 2048)
  const location = new URL(hostedFileLocation)
  const isChirpRoot = objectIdentifier === uhrpUrl &&
    location.pathname === `/chirp/v1/${objectIdentifier}/objects/${objectIdentifier}`
  if (
    location.protocol !== 'https:' || location.username !== '' || location.password !== '' ||
    location.hash !== '' || location.search !== '' ||
    (location.pathname !== `/cdn/${objectIdentifier}` && !isChirpRoot)
  ) throw new Error('UHRP hosted file location is invalid')
  const contentType = text(input.contentType, 'UHRP content type', 200)
  return {
    version: 1, uhrpUrl, objectIdentifier, uploaderIdentityKey, hostedFileLocation, hash,
    expiryTime: positive(input.expiryTime, 'UHRP expiry time'),
    fileSize: positive(input.fileSize, 'UHRP file size'), contentType
  }
}

function canonical(metadata: AdvertisementMetadata): string {
  return JSON.stringify({
    version: metadata.version, uhrpUrl: metadata.uhrpUrl,
    objectIdentifier: metadata.objectIdentifier, uploaderIdentityKey: metadata.uploaderIdentityKey,
    hostedFileLocation: metadata.hostedFileLocation, hash: metadata.hash,
    expiryTime: metadata.expiryTime, fileSize: metadata.fileSize, contentType: metadata.contentType
  })
}

function bind(metadata: AdvertisementMetadata, token: VerifiedUHRPAdvertisement): void {
  if (
    metadata.hash !== Utils.toHex(token.hash) || metadata.uhrpUrl !== StorageUtils.getURLForHash(token.hash) ||
    metadata.hostedFileLocation !== token.hostedFileLocation || metadata.expiryTime !== token.expiryTime ||
    metadata.fileSize !== token.fileSize || token.hostIdentityKey !== serverPrivateKey().toPublicKey().toString().toLowerCase()
  ) throw new Error('UHRP advertisement metadata does not match its authenticated token')
}

export function createAdvertisementMetadata(
  value: Omit<AdvertisementMetadata, 'version' | 'uhrpUrl' | 'hash'> & { hash: number[] }
): { customInstructions: string; metadata: AdvertisementMetadata } {
  if (!Array.isArray(value.hash) || value.hash.length !== 32) throw new Error('UHRP advertisement hash is invalid')
  const metadata = validate({
    version: 1, uhrpUrl: StorageUtils.getURLForHash(value.hash),
    objectIdentifier: value.objectIdentifier, uploaderIdentityKey: value.uploaderIdentityKey,
    hostedFileLocation: value.hostedFileLocation, hash: Utils.toHex(value.hash),
    expiryTime: value.expiryTime, fileSize: value.fileSize, contentType: value.contentType
  })
  const signature = serverPrivateKey().sign(canonical(metadata), 'utf8').toDER('hex') as string
  const customInstructions = JSON.stringify({ metadata, signature })
  if (Utils.toArray(customInstructions, 'utf8').length > 8192) throw new Error('UHRP advertisement metadata is too large')
  return { customInstructions, metadata }
}

export async function verifyAdvertisementMetadata(
  customInstructions: unknown,
  lockingScript: Parameters<typeof decodeAndVerifyUHRPAdvertisement>[0]
): Promise<AdvertisementMetadata> {
  if (
    typeof customInstructions !== 'string' || customInstructions.length < 1 ||
    Utils.toArray(customInstructions, 'utf8').length > 8192
  ) throw new Error('UHRP advertisement metadata is missing or oversized')
  let parsed: unknown
  try { parsed = JSON.parse(customInstructions) } catch { throw new Error('UHRP advertisement metadata is malformed') }
  const envelope = object(parsed, ['metadata', 'signature'], 'UHRP metadata envelope')
  const metadata = validate(envelope.metadata)
  if (typeof envelope.signature !== 'string' || !/^(?:[0-9a-f]{2}){8,80}$/i.test(envelope.signature)) {
    throw new Error('UHRP advertisement metadata signature is invalid')
  }
  const signature = Signature.fromDER(envelope.signature, 'hex')
  if (
    (signature.toDER('hex') as string).toLowerCase() !== envelope.signature.toLowerCase() ||
    !serverPrivateKey().toPublicKey().verify(canonical(metadata), signature, 'utf8')
  ) throw new Error('UHRP advertisement metadata signature is invalid')
  bind(metadata, await decodeAndVerifyUHRPAdvertisement(lockingScript))
  return metadata
}

export function advertisementTags(metadata: AdvertisementMetadata): string[] {
  return [
    `uhrp_url_${Utils.toHex(Utils.toArray(metadata.uhrpUrl, 'utf8'))}`,
    `object_identifier_${Utils.toHex(Utils.toArray(metadata.objectIdentifier, 'utf8'))}`,
    `uploader_identity_key_${metadata.uploaderIdentityKey}`,
    `expiry_time_${metadata.expiryTime}`, 'name_file', `content_type_${metadata.contentType}`,
    `size_${metadata.fileSize}`
  ]
}

export function requireAdvertisementTags(tags: unknown, metadata: AdvertisementMetadata): void {
  if (!Array.isArray(tags) || tags.length > 64) throw new Error('UHRP advertisement tags are invalid')
  const actual = new Set<string>()
  for (const tag of tags) {
    if (typeof tag !== 'string' || Utils.toArray(tag, 'utf8').length > 300 || actual.has(tag)) {
      throw new Error('UHRP advertisement tags are invalid')
    }
    actual.add(tag)
  }
  // The four lookup tags are selectors and must match signed ownership.
  // Older insertions lack descriptive tags; those fields remain authenticated
  // by the signed envelope and token, and any present descriptive tag must match.
  for (const expected of advertisementTags(metadata).slice(0, 4)) {
    if (!actual.has(expected)) throw new Error('UHRP advertisement tags do not match signed metadata')
  }
  requireDescriptiveTags(actual, metadata)
}

function requireDescriptiveTags(tags: Set<string>, metadata: AdvertisementMetadata): void {
  for (const prefix of ['content_type_', 'size_']) {
    const expected = prefix === 'size_' ? `size_${metadata.fileSize}` : `content_type_${metadata.contentType}`
    for (const tag of tags) {
      if (tag.startsWith(prefix) && tag !== expected) {
        throw new Error('UHRP advertisement tags do not match signed metadata')
      }
    }
  }
}
