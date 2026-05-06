import { Storage } from '@google-cloud/storage'

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
  console.log('[DEV] Returning pretend upload URL http://localhost:8080/upload')
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
  
  const storage = new Storage({
    projectId: GCP_PROJECT_ID,
    credentials: JSON.parse(GCP_STORAGE_CREDS as string)
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
    expires: Date.now() + 604000 * 1000, // 1 week
    extensionHeaders: {
      'x-goog-meta-uploaderidentitykey': uploaderIdentityKey,
      'x-goog-custom-time': customTime
    }
  })

  return {
    uploadURL,
    requiredHeaders: {
      'x-goog-meta-uploaderidentitykey': uploaderIdentityKey,
      'x-goog-custom-time': customTime
    }
  }
}

export default NODE_ENV === 'development' ? devUploadFunction : prodUploadFunction