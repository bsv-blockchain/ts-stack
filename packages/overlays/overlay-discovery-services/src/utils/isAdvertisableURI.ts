/**
 * Checks if the provided URI is advertisable, with a recognized URI prefix.
 * Applies scheme-specific validation rules as defined by the BRC-101 overlay advertisement spec.
 *
 * - For HTTPS-based schemes (https://, https+bsvauth+smf://, https+bsvauth+scrypt-offchain://, https+rtt://)
 *   - Uses the URL parser (after substituting the custom scheme with "https:" where needed)
 *   - Disallows "localhost" as hostname
 * - For wss:// URIs (for real-time lookup streaming)
 *   - Ensures valid URL with protocol "wss:" and non-"localhost" hostname
 * - For JS8 Call–based URIs (js8c+bsvauth+smf:)
 *   - Requires a query string with parameters: lat, long, freq, and radius.
 *   - Validates that lat is between -90 and 90 and long between -180 and 180.
 *   - Validates that freq and radius each include a positive number.
 *
 * @param uri - The URI to validate.
 * @returns True if the URI is valid and advertisable, false otherwise.
 */
const HTTPS_URI_PREFIXES = [
  'https://',
  'https+bsvauth://',
  'https+bsvauth+smf://',
  'https+bsvauth+scrypt-offchain://',
  'https+rtt://'
] as const

const parsePositiveMeasurement = (value: string): number | undefined => {
  const match = /^(\d+(?:\.\d+)?)(?:[a-zA-Z][a-zA-Z0-9/_-]*)?$/.exec(value.trim())
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

const validateCustomHttpsURI = (uri: string, prefix: string): boolean => {
  try {
    const modifiedURI = uri.replace(prefix, 'https://')
    const parsed = new URL(modifiedURI)
    if (parsed.hostname.toLowerCase() === 'localhost') return false
    if (parsed.pathname !== '/') return false
    return true
  } catch {
    return false
  }
}

const validateWssURI = (uri: string): boolean => {
  try {
    const parsed = new URL(uri)
    if (parsed.hostname.toLowerCase() === 'localhost') return false
    return true
  } catch {
    return false
  }
}

const validateJs8URI = (uri: string): boolean => {
  const queryIndex = uri.indexOf('?')
  if (queryIndex === -1) return false

  const params = new URLSearchParams(uri.substring(queryIndex))
  const latStr = params.get('lat')
  const longStr = params.get('long')
  const freqStr = params.get('freq')
  const radiusStr = params.get('radius')

  if (!latStr || !longStr || !freqStr || !radiusStr) return false

  const lat = Number.parseFloat(latStr)
  const lon = Number.parseFloat(longStr)
  if (Number.isNaN(lat) || lat < -90 || lat > 90) return false
  if (Number.isNaN(lon) || lon < -180 || lon > 180) return false

  if (
    parsePositiveMeasurement(freqStr) === undefined ||
    parsePositiveMeasurement(radiusStr) === undefined
  ) {
    return false
  }

  return true
}

export const isAdvertisableURI = (uri: string): boolean => {
  if (typeof uri !== 'string' || uri.trim() === '') return false

  const httpsPrefix = HTTPS_URI_PREFIXES.find(prefix => uri.startsWith(prefix))
  if (httpsPrefix !== undefined) return validateCustomHttpsURI(uri, httpsPrefix)
  if (uri.startsWith('wss://')) return validateWssURI(uri)
  if (uri.startsWith('js8c+bsvauth+smf:')) return validateJs8URI(uri)

  // Add more overlay advertisement protocols here!
  // Make JS8Call actually work! Go read BRC-101!

  // If none of the known prefixes match, the URI is not advertisable.
  return false
}
