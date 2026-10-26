import { PublicKey, StorageUtils } from '@bsv/sdk'
import { normalizeUhrpPagination } from '../resourceLimits'
import { listVerifiedAdvertisements } from './storedAdvertisements'

interface FileMetadata {
  objectIdentifier: string
  name: string
  size: string
  contentType: string
  expiryTime: number
}

function canonicalUhrpUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new Error('Invalid UHRP URL')
  }
  return StorageUtils.getURLForHash(StorageUtils.getHashFromURL(value))
}

function canonicalIdentityKey(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:02|03)[0-9a-f]{64}$/i.test(value)) {
    throw new Error('Invalid uploader identity key')
  }
  const canonical = PublicKey.fromString(value).toString().toLowerCase()
  if (canonical !== value.toLowerCase()) throw new Error('Invalid uploader identity key')
  return canonical
}

/** Return metadata only after authenticating both its local signature and on-chain token. */
export async function getMetadata(
  uhrpUrl: string,
  uploaderIdentityKey: string,
  limit?: number,
  offset?: number
): Promise<FileMetadata> {
  const canonicalUrl = canonicalUhrpUrl(uhrpUrl)
  const identityKey = canonicalIdentityKey(uploaderIdentityKey)
  const pagination = normalizeUhrpPagination(limit, offset)
  const { advertisements } = await listVerifiedAdvertisements({
    uhrpUrl: canonicalUrl,
    uploaderIdentityKey: identityKey,
    ...pagination
  })
  const selected = advertisements.reduce((farthest, candidate) =>
    farthest == null || candidate.metadata.expiryTime > farthest.metadata.expiryTime
      ? candidate
      : farthest
  , advertisements[0])
  if (selected == null) {
    throw new Error(`No authenticated advertisement found for uhrpUrl: ${canonicalUrl}`)
  }
  if (Date.now() > selected.metadata.expiryTime * 1000) {
    throw new Error(`Advertisement for uhrpUrl: ${canonicalUrl} has expired`)
  }
  return {
    objectIdentifier: selected.metadata.objectIdentifier,
    name: 'file',
    size: String(selected.metadata.fileSize),
    contentType: selected.metadata.contentType,
    expiryTime: selected.metadata.expiryTime
  }
}
