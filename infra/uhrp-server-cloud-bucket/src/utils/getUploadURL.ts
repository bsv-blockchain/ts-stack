import { Storage } from '@google-cloud/storage'
import { PublicKey } from '@bsv/sdk'
import { log } from '../logger'

const { NODE_ENV, GCP_BUCKET_NAME, GCP_PROJECT_ID, GCP_STORAGE_CREDS } = process.env

interface UploadParams {
  size: number
  expiryTime: number
  objectIdentifier: string
  uploaderIdentityKey: string
}

interface UploadResponse {
  uploadURL: string
  requiredHeaders: Record<string, string>
}

const devUploadFunction = (): Promise<UploadResponse> => {
  log.info({ operation: 'upload_url.dev', upload_url: 'http://localhost:8080/upload' }, 'Returning pretend upload URL')
  return Promise.resolve({ uploadURL: 'http://localhost:8080/upload', requiredHeaders: {} })
}

/**
 * Creates a V4 signed URL for uploading an object to Google Cloud Storage.
 * The signed URL includes metadata headers that must be provided by the client.
 *
 * @param {UploadParams} params - Parameters for file upload.
 * @returns {Promise<UploadResponse>} - The signed upload URL.
 *
 * Note: Although we include the metadata (uploaderIdentityKey and custom time) in the signed URL,
 * the client must include these headers in the PUT request. GCS requires that signed headers
 * be present on the request. There is no way to force these headers solely via the URL.
 */
const prodUploadFunction = async ({
  size,
  expiryTime,
  objectIdentifier,
  uploaderIdentityKey
}: UploadParams): Promise<UploadResponse> => {
  if (!GCP_BUCKET_NAME || !GCP_PROJECT_ID) {
    throw new Error('Missing required Google Cloud Storage environment variables.')
  }
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('Invalid upload size')
  if (!Number.isSafeInteger(expiryTime) || expiryTime < 1) throw new Error('Invalid upload expiry')
  if (!/^[1-9A-HJ-NP-Za-km-z]{1,128}$/.test(objectIdentifier)) {
    throw new Error('Invalid upload object identifier')
  }
  if (!/^(?:02|03)[0-9a-f]{64}$/i.test(uploaderIdentityKey)) {
    throw new Error('Invalid uploader identity key')
  }
  const canonicalUploader = PublicKey.fromString(uploaderIdentityKey).toString().toLowerCase()
  if (canonicalUploader !== uploaderIdentityKey.toLowerCase()) throw new Error('Invalid uploader identity key')
  const now = Date.now()
  const remainingMs = (expiryTime * 1000) - now
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new Error('Upload expiry is in the past')
  
  const storage = new Storage({
    projectId: GCP_PROJECT_ID,
    credentials: GCP_STORAGE_CREDS == null || GCP_STORAGE_CREDS === ''
      ? undefined
      : JSON.parse(GCP_STORAGE_CREDS)
  })

  const bucket = storage.bucket(GCP_BUCKET_NAME)
  const bucketFile = bucket.file(`cdn/${objectIdentifier}`)

  // Calculate the custom time (e.g., expiry time plus 5 minutes in this example)
  const customTime = new Date((expiryTime + 300) * 1000).toISOString()

  // Generate the signed URL including the metadata headers.
  // The extensionHeaders are part of the signature and must be included by the client in the PUT request.
  const [uploadURL] = await bucketFile.getSignedUrl({
    version: 'v4',
    action: 'write',
    // Keep the write capability short-lived and never valid beyond the paid
    // retention window. A generation precondition makes it single-use.
    expires: now + Math.min(15 * 60 * 1000, remainingMs),
    extensionHeaders: {
      'content-length': String(size),
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment',
      'x-goog-if-generation-match': '0',
      'x-goog-meta-uploaderidentitykey': canonicalUploader,
      'x-goog-custom-time': customTime
    }
  })

  return {
    uploadURL,
    requiredHeaders: {
      'content-length': String(size),
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment',
      'x-goog-if-generation-match': '0',
      'x-goog-meta-uploaderidentitykey': canonicalUploader,
      'x-goog-custom-time': customTime
    }
  }
}

export default NODE_ENV === 'development' ? devUploadFunction : prodUploadFunction
