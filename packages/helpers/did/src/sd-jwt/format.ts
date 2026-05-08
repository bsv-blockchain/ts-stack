export interface ParsedSdJwt {
  issuerSignedJwt: string
  disclosures: string[]
  kbJwt?: string
}

// Implements RFC 9901 section 4 SD-JWT and SD-JWT+KB compact formats.
export function serializeSdJwt (issuerSignedJwt: string, disclosures: string[], kbJwt?: string): string {
  if (kbJwt != null) return [issuerSignedJwt, ...disclosures, kbJwt].join('~')
  return `${[issuerSignedJwt, ...disclosures].join('~')}~`
}

export function parseSdJwt (sdJwt: string): ParsedSdJwt {
  const parts = sdJwt.split('~')
  if (parts.length < 2) throw new Error('Invalid SD-JWT serialization')
  const issuerSignedJwt = parts[0]
  const last = parts[parts.length - 1]
  const hasKeyBinding = last !== ''
  const disclosures = hasKeyBinding ? parts.slice(1, -1) : parts.slice(1, -1)
  return {
    issuerSignedJwt,
    disclosures,
    ...(hasKeyBinding ? { kbJwt: last } : {})
  }
}
