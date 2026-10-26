import { CHIRPError } from './errors.js'
import { hashForObjectIdentifier } from './hash.js'

const CHIRP_URI = /^chirp:(?:\/\/)?([^/?#]+)$/i

export interface ParsedCHIRPURL {
  chirpURL: string
  uhrpURL: string
  rootIdentifier: string
}

export function parseCHIRPURL(value: string): ParsedCHIRPURL {
  if (typeof value !== 'string') {
    throw new CHIRPError('ERR_CHIRP_URL', 'CHIRP URL must be a string.')
  }
  const match = CHIRP_URI.exec(value)
  const rootIdentifier = match?.[1]
  if (rootIdentifier == null || !isCanonicalObjectIdentifier(rootIdentifier)) {
    throw new CHIRPError('ERR_CHIRP_URL', 'Invalid CHIRP URL.')
  }
  return {
    chirpURL: `chirp://${rootIdentifier}`,
    uhrpURL: `uhrp://${rootIdentifier}`,
    rootIdentifier
  }
}

export function chirpURLForIdentifier(rootIdentifier: string): string {
  if (!isCanonicalObjectIdentifier(rootIdentifier)) {
    throw new CHIRPError('ERR_CHIRP_IDENTIFIER', 'Invalid CHIRP root identifier.')
  }
  return `chirp://${rootIdentifier}`
}

export function deriveCHIRPObjectURL(
  advertisedRootURL: string,
  rootIdentifier: string,
  objectIdentifier: string,
  allowInsecureHTTP = false
): string {
  if (
    !isCanonicalObjectIdentifier(rootIdentifier) ||
    !isCanonicalObjectIdentifier(objectIdentifier)
  ) {
    throw new CHIRPError(
      'ERR_CHIRP_IDENTIFIER',
      'CHIRP root and object identifiers must be canonical BRC-26 identifiers.'
    )
  }
  let parsed: URL
  try {
    parsed = new URL(advertisedRootURL)
  } catch {
    throw new CHIRPError('ERR_CHIRP_HOST_URL', 'Invalid advertised CHIRP root URL.')
  }
  if (parsed.protocol !== 'https:' && !(allowInsecureHTTP && parsed.protocol === 'http:')) {
    throw new CHIRPError('ERR_CHIRP_HOST_URL', 'CHIRP hosts must use HTTPS.')
  }
  if (
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new CHIRPError('ERR_CHIRP_HOST_URL', 'Advertised CHIRP URL has forbidden components.')
  }
  const suffix = `/chirp/v1/${rootIdentifier}/objects/${rootIdentifier}`
  if (!parsed.pathname.endsWith(suffix)) {
    throw new CHIRPError('ERR_CHIRP_HOST_URL', 'Advertised CHIRP root URL has an invalid path.')
  }
  parsed.pathname = `${parsed.pathname.slice(0, -rootIdentifier.length)}${objectIdentifier}`
  return parsed.toString()
}

function isCanonicalObjectIdentifier(identifier: unknown): identifier is string {
  if (typeof identifier !== 'string') return false
  try {
    hashForObjectIdentifier(identifier)
    return true
  } catch {
    return false
  }
}
