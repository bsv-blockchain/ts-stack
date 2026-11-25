interface Constants {
  storageURL: string
  storageURLs: string[]
}

// Local, staging, and production storage URLs. The public production and
// staging endpoints are Babbage-hosted defaults, not protocol requirements.
const storageProdURL = 'https://nanostore.babbage.systems'
const storageStagingURL = 'https://staging-nanostore.babbage.systems'
const storageLocalURL = 'http://localhost:3104'

// List of possible storage URLs (used for drop-downs, etc.)
const storageURLs = [storageProdURL, storageStagingURL, storageLocalURL]

function defaultStorageUrl(host: string): string {
  if (host.startsWith('localhost')) return storageLocalURL
  if (host.startsWith('staging') || import.meta.env.DEV) return storageStagingURL
  return storageProdURL
}

const constants: Constants = {
  storageURL: defaultStorageUrl(window.location.host),
  storageURLs
}

export default constants
