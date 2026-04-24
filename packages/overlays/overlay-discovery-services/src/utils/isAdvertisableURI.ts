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
export const isAdvertisableURI = (uri: string): boolean => {
  if (typeof uri !== 'string' || uri.trim() === '') return false

  // Helper function: validate a URL by substituting its scheme if needed.
  const validateCustomHttpsURI = (uri: string, prefix: string): boolean => {
    try {
      const modifiedURI = uri.replace(prefix, 'https://')
      const parsed = new URL(modifiedURI)
      if (parsed.hostname.toLowerCase() === 'localhost') return false
      if (parsed.pathname !== '/') return false
      return true
    } catch (e) {
      return false
    }
  }

  // HTTPS-based schemes – disallow localhost.
  if (uri.startsWith('https://')) {
    return validateCustomHttpsURI(uri, 'https://')
  }
  // Plain auth over HTTPS, but no payment can be collected
  else if (uri.startsWith('https+bsvauth://')) {
    return validateCustomHttpsURI(uri, 'https+bsvauth://')
  }
  // Auth and payment over HTTPS
  else if (uri.startsWith('https+bsvauth+smf://')) {
    return validateCustomHttpsURI(uri, 'https+bsvauth+smf://')
  }
  // A protocol allowing you to also supply sCrypt off-chain values to the topical admissibility checking context
  else if (uri.startsWith('https+bsvauth+scrypt-offchain://')) {
    return validateCustomHttpsURI(uri, 'https+bsvauth+scrypt-offchain://')
  }
  // A protocol allowing overlays that deal with real-time transactions (non-finals)
  else if (uri.startsWith('https+rtt://')) {
    return validateCustomHttpsURI(uri, 'https+rtt://')
  }
  // WSS for real-time event-listening lookups.
  else if (uri.startsWith('wss://')) {
    try {
      const parsed = new URL(uri)
      if (parsed.protocol !== 'wss:') return false
      if (parsed.hostname.toLowerCase() === 'localhost') return false
      return true
    } catch (e) {
      return false
    }
  }
  // JS8 Call–based advertisement.
  else if (uri.startsWith('js8c+bsvauth+smf:')) {
    // Expect a query string with parameters.
    const queryIndex = uri.indexOf('?')
    if (queryIndex === -1) return false

    const queryStr = uri.substring(queryIndex)
    const params = new URLSearchParams(queryStr)

    // Required parameters: lat, long, freq, and radius.
    const latStr = params.get('lat')
    const longStr = params.get('long')
    const freqStr = params.get('freq')
    const radiusStr = params.get('radius')

    if (!latStr || !longStr || !freqStr || !radiusStr) return false

    // Validate latitude and longitude ranges.
    const lat = parseFloat(latStr)
    const lon = parseFloat(longStr)
    if (isNaN(lat) || lat < -90 || lat > 90) return false
    if (isNaN(lon) || lon < -180 || lon > 180) return false

    // Validate frequency: extract the first number from the freq string.
    const freqMatch = freqStr.match(/(\d+(\.\d+)?)/)
    if (!freqMatch) return false
    const freqVal = parseFloat(freqMatch[1])
    if (isNaN(freqVal) || freqVal <= 0) return false

    // Validate radius: extract the first number from the radius string.
    const radiusMatch = radiusStr.match(/(\d+(\.\d+)?)/)
    if (!radiusMatch) return false
    const radiusVal = parseFloat(radiusMatch[1])
    if (isNaN(radiusVal) || radiusVal <= 0) return false

    // JS8 is more of a "demo" / "example". We include it to demonstrate that
    // overlays can be advertised in many, many ways.
    // If we were actually going to dothis for real we would probably want to
    // restrict the radius to a maximum value, establish and check for allowed units.
    // Doing overlays over HF radio with js8c would be very interesting none the less.
    // For now, we assume any positive numbers are acceptable.
    return true
  }

  // Add more overlay advertisement protocols here!
  // Make JS8Call actually work! Go read BRC-101!

  // If none of the known prefixes match, the URI is not advertisable.
  return false
}
