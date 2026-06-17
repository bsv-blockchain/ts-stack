import { getWallet } from './walletSingleton'
import { Utils } from '@bsv/sdk'


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

  let objectIdentifier, name, contentType, size
  // Farthest expiration time given in seconds
  let maxpiry = 0
  // Finding the identifier for the file with the maxpiry date
  for (const out of outputs) {
    if (!out.tags) continue
    const objectIdTag = out.tags.find(t => t.startsWith('object_identifier_'))
    const expiryTag = out.tags.find(t => t.startsWith('expiry_time_'))
    const nameTag = out.tags.find(t => t.startsWith('name_'))
    const sizeTag = out.tags.find(t => t.startsWith('size_'))
    const contentTypeTag = out.tags.find(t => t.startsWith('content_type_'))
    if (!objectIdTag || !expiryTag || !nameTag || !sizeTag || !contentTypeTag) continue

    const expiryNum = parseInt(expiryTag.substring('expiry_time_'.length), 10) || 0

    if (expiryNum > maxpiry) {
      maxpiry = expiryNum
      objectIdentifier = Utils.toUTF8(Utils.toArray(objectIdTag.substring('object_identifier_'.length), 'hex'))
      name = nameTag
      size = sizeTag
      contentType = contentTypeTag
    }
  }

  if (!objectIdentifier || !name || !size || !contentType) {
    throw new Error(`No advertisement found for uhrpUrl: ${uhrpUrl} uploaderIdentityKey: ${uploaderIdentityKey}`)
  }

  if (Date.now() > maxpiry * 1000) {
    throw new Error(`Advertisement for uhrpUrl: ${uhrpUrl} has expired`)
  }

  return {
    objectIdentifier,
    name,
    size,
    contentType,
    expiryTime: maxpiry
  }
}
