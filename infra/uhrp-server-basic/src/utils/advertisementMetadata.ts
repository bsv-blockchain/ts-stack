import { PrivateKey, PublicKey, Signature, StorageUtils, Utils } from '@bsv/sdk'
import { resolveCdnObjectPath } from './cdnObjectPath'
import {
  decodeAndVerifyUHRPAdvertisement,
  type VerifiedUHRPAdvertisement
} from './uhrpTokenValidation'

const MAX_METADATA_BYTES = 8192
const MAX_OBJECT_IDENTIFIER_BYTES = 256
const MAX_CONTENT_TYPE_BYTES = 200

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

export type AdvertisementMetadataSource = 'signed' | 'legacy'

function serverPrivateKey(): PrivateKey {
  const value = process.env.SERVER_PRIVATE_KEY
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('SERVER_PRIVATE_KEY must be a 32-byte hexadecimal private key')
  }
  return new PrivateKey(value, 'hex', 'be', 'error')
}

function ownDataObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is malformed`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} is malformed`)
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expectedKeys.length ||
    keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new Error(`${label} is malformed`)
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor == null || !('value' in descriptor)) throw new Error(`${label} is malformed`)
  }
  return value as Record<string, unknown>
}

function safeText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`)
  const bytes = Utils.toArray(value, 'utf8')
  if (bytes.length < 1 || bytes.length > maximumBytes || /\p{Cc}/u.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function safePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function validateMetadata(value: unknown): AdvertisementMetadata {
  const metadata = ownDataObject(
    value,
    [
      'version',
      'uhrpUrl',
      'objectIdentifier',
      'uploaderIdentityKey',
      'hostedFileLocation',
      'hash',
      'expiryTime',
      'fileSize',
      'contentType'
    ],
    'UHRP advertisement metadata'
  )
  if (metadata.version !== 1) throw new Error('UHRP advertisement metadata version is invalid')
  const hash = safeText(metadata.hash, 'UHRP advertisement hash', 64).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('UHRP advertisement hash is invalid')
  const uhrpUrl = safeText(metadata.uhrpUrl, 'UHRP URL', 128)
  if (uhrpUrl !== StorageUtils.getURLForHash(Utils.toArray(hash, 'hex'))) {
    throw new Error('UHRP advertisement metadata URL does not match its hash')
  }
  const objectIdentifier = safeText(
    metadata.objectIdentifier,
    'UHRP object identifier',
    MAX_OBJECT_IDENTIFIER_BYTES
  )
  if (resolveCdnObjectPath(objectIdentifier) === null) {
    throw new Error('UHRP object identifier is invalid')
  }
  const uploaderIdentityKey = safeText(
    metadata.uploaderIdentityKey,
    'UHRP uploader identity key',
    66
  ).toLowerCase()
  if (!/^(?:02|03)[0-9a-f]{64}$/.test(uploaderIdentityKey)) {
    throw new Error('UHRP uploader identity key is invalid')
  }
  PublicKey.fromString(uploaderIdentityKey)
  const hostedFileLocation = safeText(
    metadata.hostedFileLocation,
    'UHRP hosted file location',
    2048
  )
  const location = new URL(hostedFileLocation)
  if (
    location.protocol !== 'https:' ||
    location.username !== '' ||
    location.password !== '' ||
    location.hash !== '' ||
    location.search !== '' ||
    location.pathname !== `/cdn/${objectIdentifier}`
  ) {
    throw new Error('UHRP hosted file location is invalid')
  }
  const contentType = safeText(metadata.contentType, 'UHRP content type', MAX_CONTENT_TYPE_BYTES)
  const expiryTime = safePositiveInteger(metadata.expiryTime, 'UHRP expiry time')
  const fileSize = safePositiveInteger(metadata.fileSize, 'UHRP file size')
  return {
    version: 1,
    uhrpUrl,
    objectIdentifier,
    uploaderIdentityKey,
    hostedFileLocation,
    hash,
    expiryTime,
    fileSize,
    contentType
  }
}

function canonicalMetadata(metadata: AdvertisementMetadata): string {
  return JSON.stringify({
    version: metadata.version,
    uhrpUrl: metadata.uhrpUrl,
    objectIdentifier: metadata.objectIdentifier,
    uploaderIdentityKey: metadata.uploaderIdentityKey,
    hostedFileLocation: metadata.hostedFileLocation,
    hash: metadata.hash,
    expiryTime: metadata.expiryTime,
    fileSize: metadata.fileSize,
    contentType: metadata.contentType
  })
}

function bindMetadataToToken(
  metadata: AdvertisementMetadata,
  token: VerifiedUHRPAdvertisement
): void {
  if (
    metadata.hash !== Utils.toHex(token.hash) ||
    metadata.uhrpUrl !== StorageUtils.getURLForHash(token.hash) ||
    metadata.hostedFileLocation !== token.hostedFileLocation ||
    metadata.expiryTime !== token.expiryTime ||
    metadata.fileSize !== token.fileSize ||
    token.hostIdentityKey !== serverPrivateKey().toPublicKey().toString().toLowerCase()
  ) {
    throw new Error('UHRP advertisement metadata does not match its authenticated token')
  }
}

function legacyTagValues(tags: unknown): Map<string, string[]> {
  if (!Array.isArray(tags) || tags.length > 64) {
    throw new Error('Legacy UHRP advertisement tags are invalid')
  }
  const values = new Map<string, string[]>()
  const seen = new Set<string>()
  const prefixes = [
    'uhrp_url_',
    'object_identifier_',
    'uploader_identity_key_',
    'expiry_time_',
    'content_type_',
    'size_'
  ] as const
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index]
    if (
      !Object.prototype.hasOwnProperty.call(tags, index) ||
      typeof tag !== 'string' ||
      Utils.toArray(tag, 'utf8').length > 300 ||
      seen.has(tag)
    ) {
      throw new Error('Legacy UHRP advertisement tags are invalid')
    }
    seen.add(tag)
    const prefix = prefixes.find(candidate => tag.startsWith(candidate))
    if (prefix === undefined) continue
    const name = prefix.slice(0, -1)
    const entries = values.get(name) ?? []
    entries.push(tag.slice(prefix.length))
    values.set(name, entries)
  }
  return values
}

function oneLegacyTag(
  values: Map<string, string[]>,
  name: string,
  required = true
): string | undefined {
  const entries = values.get(name)
  if (entries == null || entries.length === 0) {
    if (required) throw new Error(`Legacy UHRP advertisement ${name} tag is missing`)
    return undefined
  }
  if (entries.length !== 1) throw new Error(`Legacy UHRP advertisement ${name} tag is ambiguous`)
  return entries[0]
}

function decodeLegacyText(value: string, label: string, maximumBytes: number): string {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value) || value.length > maximumBytes * 2) {
    throw new Error(`${label} is invalid`)
  }
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(Utils.toArray(value, 'hex'))
    )
  } catch {
    throw new Error(`${label} is invalid`)
  }
  return safeText(decoded, label, maximumBytes)
}

function canonicalLegacyInteger(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} is invalid`)
  return safePositiveInteger(Number(value), label)
}

/**
 * Reconstruct metadata for outputs created before server-signed wallet
 * metadata existed. The on-chain host token remains cryptographically
 * authoritative for public fields. Local tags supply only the legacy uploader
 * association, object name and MIME hint needed to preserve owner workflows.
 */
async function verifyLegacyAdvertisementMetadata(
  tags: unknown,
  lockingScript: Parameters<typeof decodeAndVerifyUHRPAdvertisement>[0]
): Promise<AdvertisementMetadata> {
  const token = await decodeAndVerifyUHRPAdvertisement(lockingScript)
  if (token.hostIdentityKey !== serverPrivateKey().toPublicKey().toString().toLowerCase()) {
    throw new Error('Legacy UHRP advertisement belongs to a different host')
  }
  const values = legacyTagValues(tags)
  const uhrpUrl = decodeLegacyText(oneLegacyTag(values, 'uhrp_url')!, 'Legacy UHRP URL', 128)
  const expectedUrl = StorageUtils.getURLForHash(token.hash)
  if (uhrpUrl !== expectedUrl)
    throw new Error('Legacy UHRP URL does not match its authenticated token')
  const objectIdentifier = decodeLegacyText(
    oneLegacyTag(values, 'object_identifier')!,
    'Legacy UHRP object identifier',
    MAX_OBJECT_IDENTIFIER_BYTES
  )
  if (resolveCdnObjectPath(objectIdentifier) === null) {
    throw new Error('Legacy UHRP object identifier is invalid')
  }
  const location = new URL(token.hostedFileLocation)
  if (
    location.pathname !== `/cdn/${objectIdentifier}` ||
    location.search !== '' ||
    location.hash !== ''
  ) {
    throw new Error('Legacy UHRP object identifier does not match its authenticated token')
  }
  const uploaderIdentityKey = safeText(
    oneLegacyTag(values, 'uploader_identity_key')!,
    'Legacy UHRP uploader identity key',
    66
  ).toLowerCase()
  if (!/^(?:02|03)[0-9a-f]{64}$/.test(uploaderIdentityKey)) {
    throw new Error('Legacy UHRP uploader identity key is invalid')
  }
  PublicKey.fromString(uploaderIdentityKey)
  const expiryTime = canonicalLegacyInteger(
    oneLegacyTag(values, 'expiry_time')!,
    'Legacy UHRP expiry time'
  )
  if (expiryTime !== token.expiryTime) {
    throw new Error('Legacy UHRP expiry does not match its authenticated token')
  }
  const sizeTag = oneLegacyTag(values, 'size', false)
  if (
    sizeTag !== undefined &&
    canonicalLegacyInteger(sizeTag, 'Legacy UHRP file size') !== token.fileSize
  ) {
    throw new Error('Legacy UHRP size does not match its authenticated token')
  }
  const contentTypeTag = oneLegacyTag(values, 'content_type', false)
  const contentType =
    contentTypeTag === undefined
      ? 'application/octet-stream'
      : safeText(contentTypeTag, 'Legacy UHRP content type', MAX_CONTENT_TYPE_BYTES)
  return {
    version: 1,
    uhrpUrl,
    objectIdentifier,
    uploaderIdentityKey,
    hostedFileLocation: token.hostedFileLocation,
    hash: Utils.toHex(token.hash),
    expiryTime: token.expiryTime,
    fileSize: token.fileSize,
    contentType
  }
}

export function createAdvertisementMetadata(
  value: Omit<AdvertisementMetadata, 'version' | 'uhrpUrl' | 'hash'> & { hash: number[] }
): { customInstructions: string; metadata: AdvertisementMetadata } {
  if (!Array.isArray(value.hash) || value.hash.length !== 32) {
    throw new Error('UHRP advertisement hash is invalid')
  }
  const metadata = validateMetadata({
    version: 1,
    uhrpUrl: StorageUtils.getURLForHash(value.hash),
    objectIdentifier: value.objectIdentifier,
    uploaderIdentityKey: value.uploaderIdentityKey,
    hostedFileLocation: value.hostedFileLocation,
    hash: Utils.toHex(value.hash),
    expiryTime: value.expiryTime,
    fileSize: value.fileSize,
    contentType: value.contentType
  })
  const signature = serverPrivateKey()
    .sign(canonicalMetadata(metadata), 'utf8')
    .toDER('hex') as string
  const customInstructions = JSON.stringify({ metadata, signature })
  if (Utils.toArray(customInstructions, 'utf8').length > MAX_METADATA_BYTES) {
    throw new Error('UHRP advertisement metadata is too large')
  }
  return { customInstructions, metadata }
}

export async function verifyAdvertisementMetadata(
  customInstructions: unknown,
  lockingScript: Parameters<typeof decodeAndVerifyUHRPAdvertisement>[0]
): Promise<AdvertisementMetadata> {
  if (
    typeof customInstructions !== 'string' ||
    customInstructions.length < 1 ||
    Utils.toArray(customInstructions, 'utf8').length > MAX_METADATA_BYTES
  ) {
    throw new Error('UHRP advertisement metadata is missing or oversized')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(customInstructions)
  } catch {
    throw new Error('UHRP advertisement metadata is malformed')
  }
  const envelope = ownDataObject(decoded, ['metadata', 'signature'], 'UHRP metadata envelope')
  const metadata = validateMetadata(envelope.metadata)
  if (
    typeof envelope.signature !== 'string' ||
    !/^(?:[0-9a-f]{2}){8,80}$/i.test(envelope.signature)
  ) {
    throw new Error('UHRP advertisement metadata signature is invalid')
  }
  const signature = Signature.fromDER(envelope.signature, 'hex')
  if ((signature.toDER('hex') as string).toLowerCase() !== envelope.signature.toLowerCase()) {
    throw new Error('UHRP advertisement metadata signature is not canonical')
  }
  if (!serverPrivateKey().toPublicKey().verify(canonicalMetadata(metadata), signature, 'utf8')) {
    throw new Error('UHRP advertisement metadata signature is invalid')
  }
  const token = await decodeAndVerifyUHRPAdvertisement(lockingScript)
  bindMetadataToToken(metadata, token)
  return metadata
}

/**
 * Verify current signed metadata, or explicitly reconstruct a legacy output
 * only when custom instructions are absent. Malformed or forged present-day
 * envelopes never downgrade to the legacy path.
 */
export async function verifyStoredAdvertisementMetadata(
  customInstructions: unknown,
  tags: unknown,
  lockingScript: Parameters<typeof decodeAndVerifyUHRPAdvertisement>[0]
): Promise<{ metadata: AdvertisementMetadata; source: AdvertisementMetadataSource }> {
  if (customInstructions === undefined) {
    return {
      metadata: await verifyLegacyAdvertisementMetadata(tags, lockingScript),
      source: 'legacy'
    }
  }
  return {
    metadata: await verifyAdvertisementMetadata(customInstructions, lockingScript),
    source: 'signed'
  }
}

export function advertisementTags(metadata: AdvertisementMetadata): string[] {
  return [
    `uhrp_url_${Utils.toHex(Utils.toArray(metadata.uhrpUrl, 'utf8'))}`,
    `object_identifier_${Utils.toHex(Utils.toArray(metadata.objectIdentifier, 'utf8'))}`,
    `uploader_identity_key_${metadata.uploaderIdentityKey}`,
    `expiry_time_${metadata.expiryTime}`,
    'name_file',
    `content_type_${metadata.contentType}`,
    `size_${metadata.fileSize}`
  ]
}

export function requireAdvertisementTags(tags: unknown, metadata: AdvertisementMetadata): void {
  if (!Array.isArray(tags) || tags.length > 64)
    throw new Error('UHRP advertisement tags are invalid')
  const actual = new Set<string>()
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index]
    if (
      !Object.prototype.hasOwnProperty.call(tags, index) ||
      typeof tag !== 'string' ||
      Utils.toArray(tag, 'utf8').length > 300 ||
      actual.has(tag)
    ) {
      throw new Error('UHRP advertisement tags are invalid')
    }
    actual.add(tag)
  }
  for (const expected of advertisementTags(metadata)) {
    if (!actual.has(expected))
      throw new Error('UHRP advertisement tags do not match signed metadata')
  }
}
