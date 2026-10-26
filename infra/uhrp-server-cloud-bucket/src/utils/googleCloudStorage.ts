import { Storage, type StorageOptions } from '@google-cloud/storage'

/** Use the same configured identity for advertisement, metadata and renewal I/O. */
export function createGoogleCloudStorage(env: NodeJS.ProcessEnv = process.env): Storage {
  let credentials: StorageOptions['credentials']
  if (env.GCP_STORAGE_CREDS) {
    try {
      const parsed: unknown = JSON.parse(env.GCP_STORAGE_CREDS)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid credentials')
      credentials = parsed as StorageOptions['credentials']
    } catch {
      throw new Error('GCP_STORAGE_CREDS must contain a JSON credentials object')
    }
  }
  return new Storage({ projectId: env.GCP_PROJECT_ID, credentials })
}
