const crypto = require('crypto')
const { StorageUtils } = require('@bsv/sdk')
const { Storage } = require('@google-cloud/storage')
const axios = require('axios')

const {
  HOSTING_DOMAIN,
  ADMIN_TOKEN
} = process.env
const storage = new Storage()

const hashToUhrpUrl = (hash) => StorageUtils.getURLForHash([...hash])
exports.hashToUhrpUrl = hashToUhrpUrl

/**
 * UHRP Storage Notifier to be triggered by Cloud Storage.
 *
 * @param {object} file The Cloud Storage file metadata.
 * @param {object} context The event metadata.
 */
exports.notifier = async (file, context) => {
  const objectIdentifier = file.name.split('/').pop()
  console.log(`  Event: ${context.eventId}`)
  console.log(`  Event Type: ${context.eventType}`)
  console.log(`  Bucket: ${file.bucket}`)
  console.log(`  File: ${file.name}`)
  console.log(`  Metageneration: ${file.metageneration}`)
  console.log(`  Created: ${file.timeCreated}`)
  console.log(`  Updated: ${file.updated}`)
  console.log(`  Object ID: ${objectIdentifier}`)
  console.log(file)

  if (!file.name.startsWith('cdn/')) {
    // Only files uploaded to the CDN folder are advertised this way.
    return
  }

  const storageFile = storage.bucket(file.bucket).file(file.name)
  const [metadata] = await storageFile.getMetadata()
  console.log('File metadata', metadata)
  let uploaderIdentityKey = ''
  if (typeof metadata.metadata === 'object') {
    uploaderIdentityKey = metadata.metadata.uploaderidentitykey
  }
  const expiryTime = Math.round(new Date(metadata.customTime).getTime() / 1000)
  const digest = crypto.createHash('sha256')
  for await (const chunk of storageFile.createReadStream()) {
    digest.update(chunk)
  }
  const uhrpUrl = hashToUhrpUrl(digest.digest())
  console.log('Got UHRP URL', uhrpUrl)
  await axios.post(
    `${HOSTING_DOMAIN}/advertise`,
    {
      adminToken: ADMIN_TOKEN,
      uhrpUrl,
      uploaderIdentityKey,
      objectIdentifier,
      expiryTime,
      fileSize: file.size
    }
  )
  return true
}
