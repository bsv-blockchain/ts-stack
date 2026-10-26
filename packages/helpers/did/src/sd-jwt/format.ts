import {
  assertBoundedString,
  MAX_DISCLOSURE_BYTES,
  MAX_DISCLOSURES,
  MAX_SD_JWT_BYTES
} from '../validation.js'

export interface ParsedSdJwt {
  issuerSignedJwt: string
  disclosures: string[]
  kbJwt?: string
}

// Implements RFC 9901 section 4 SD-JWT and SD-JWT+KB compact formats.
export function serializeSdJwt(
  issuerSignedJwt: string,
  disclosures: string[],
  kbJwt?: string
): string {
  assertCompactJwt(issuerSignedJwt, 'Issuer-signed JWT')
  const disclosureSnapshot = snapshotDisclosures(disclosures)
  if (kbJwt !== undefined) assertCompactJwt(kbJwt, 'Key Binding JWT')
  const serialized =
    kbJwt !== undefined
      ? [issuerSignedJwt, ...disclosureSnapshot, kbJwt].join('~')
      : `${[issuerSignedJwt, ...disclosureSnapshot].join('~')}~`
  assertBoundedString(serialized, 'SD-JWT', MAX_SD_JWT_BYTES)
  return serialized
}

export function parseSdJwt(sdJwt: string): ParsedSdJwt {
  assertBoundedString(sdJwt, 'SD-JWT', MAX_SD_JWT_BYTES)
  const parts = sdJwt.split('~')
  if (parts.length < 2) throw new Error('Invalid SD-JWT serialization')
  const issuerSignedJwt = parts[0]
  assertCompactJwt(issuerSignedJwt, 'Issuer-signed JWT')
  const last = parts.at(-1)
  if (last == null) throw new Error('Invalid SD-JWT serialization')
  const hasKeyBinding = last !== ''
  if (hasKeyBinding) assertCompactJwt(last, 'Key Binding JWT')
  const disclosures = snapshotDisclosures(parts.slice(1, -1))
  return {
    issuerSignedJwt,
    disclosures,
    ...(hasKeyBinding ? { kbJwt: last } : {})
  }
}

function snapshotDisclosures(disclosures: string[]): string[] {
  if (!Array.isArray(disclosures) || disclosures.length > MAX_DISCLOSURES) {
    throw new TypeError('Disclosures must be a bounded array')
  }
  const descriptors = Object.getOwnPropertyDescriptors(disclosures)
  const snapshot = Array.from({ length: disclosures.length }, () => '')
  for (let index = 0; index < disclosures.length; index++) {
    const descriptor = descriptors[String(index)]
    if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`Disclosure ${index} must be an enumerable own data property`)
    }
    const disclosure = descriptor.value
    assertBoundedString(disclosure, `Disclosure ${index}`, MAX_DISCLOSURE_BYTES)
    if (!/^[A-Za-z0-9_-]+$/.test(disclosure)) {
      throw new TypeError(`Disclosure ${index} is not canonical base64url`)
    }
    snapshot[index] = disclosure
  }
  return snapshot
}

function assertCompactJwt(value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label, MAX_SD_JWT_BYTES)
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(`${label} is not a compact JWT`)
  }
}
