// /utils/getMetadata.ts
import { Storage } from '@google-cloud/storage'
import { getWallet } from './walletSingleton'
import upload from '../routes/upload'
import { Utils } from '@bsv/sdk'

const storage = new Storage()
const { GCP_BUCKET_NAME } = process.env

interface FileMetadata {
  objectIdentifier: string
  name: string
  size: string
  contentType: string
  expiryTime: number  // minutes since the Unix epoch
}

/**
 * Finds the 'objectIdentifier' by scanning the 'uhrp advertisements' basket
 * for a matching `uhrp_url_{uhrpUrl}` tag, then fetches GCS metadata.
 *
 * @param uhrpUrl The UHRP URL
 * @returns {Promise<FileMetadata>} An object containing file info.
 * @throws If no matching advertisement is found or GCS metadata fails.
 */
export async function getMetadata(uhrpUrl: string, uploaderIdentityKey: string, limit?: number, offset?: number): Promise<FileMetadata> {
  const wallet = await getWallet()
  const { outputs } = await wallet.listOutputs({
    basket: 'uhrp advertisements',
    tags: [`uhrp_url_${Utils.toHex(Utils.toArray(uhrpUrl, 'utf8'))}`, `uploader_identity_key_${uploaderIdentityKey}`],
    tagQueryMode: 'all',
    includeTags: true,
    limit: limit !== undefined ? limit : 200,
    offset: offset !== undefined ? offset : 0
  })

  let objectIdentifier
  // Farthest expiration time given in seconds
  let maxpiry = 0
  // Finding the identifier for the file with the maxpiry date
  for (const out of outputs) {
    if (!out.tags) continue
    const objectIdTag = out.tags.find(t => t.startsWith('object_identifier_'))
    const expiryTag = out.tags.find(t => t.startsWith('expiry_time_'))
    if (!objectIdTag || !expiryTag) continue

    const expiryNum = parseInt(expiryTag.substring('expiry_time_'.length), 10) || 0

    if (expiryNum > maxpiry) {
      maxpiry = expiryNum
      objectIdentifier = Utils.toUTF8(Utils.toArray(objectIdTag.substring('object_identifier_'.length), 'hex'))
    }
  }

  if (!objectIdentifier) {
    throw new Error(`No advertisement found for uhrpUrl: ${uhrpUrl} uploaderIdentityKey: ${uploaderIdentityKey}`)
  }

  if (Date.now() > maxpiry * 1000) {
    throw new Error(`Advertisement for uhrpUrl: ${uhrpUrl} has expired`)
  }

  // Fetch GCS metadata
  const file = storage.bucket(GCP_BUCKET_NAME!).file(`cdn/${objectIdentifier}`)
  const [gcsMetadata] = await file.getMetadata()

  const {
    name = '',
    size,
    contentType = '',
  } = gcsMetadata

  return {
    objectIdentifier,
    name,
    size: String(size ?? ''),
    contentType,
    expiryTime: maxpiry
  }
}
