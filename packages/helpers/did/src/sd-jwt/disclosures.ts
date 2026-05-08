import type { DisclosureFrame, JsonObject, JsonValue } from '../types.js'
import { base64UrlDecodeJson, base64UrlEncodeJson } from '../utils/base64url.js'
import { randomSalt, sha256Base64Url } from '../utils/crypto.js'

export interface DisclosureRecord {
  disclosure: string
  digest: string
  path: string[]
  claimName: string
  claimValue: JsonValue
}

const PROTECTED_SD_JWT_VC_CLAIMS = new Set([
  'iss',
  'nbf',
  'exp',
  'cnf',
  'vct',
  'vct#integrity',
  'status',
  '_sd',
  '_sd_alg',
  '...'
])

// Implements RFC 9901 section 4.2.1 Disclosures for Object Properties.
export function createDisclosure (claimName: string, claimValue: JsonValue, salt = randomSalt()): DisclosureRecord {
  const disclosure = base64UrlEncodeJson([salt, claimName, claimValue])
  return {
    disclosure,
    digest: sha256Base64Url(disclosure),
    path: [claimName],
    claimName,
    claimValue
  }
}

// Implements RFC 9901 sections 4.2.4 and 4.2.6 by replacing selected object
// properties with their disclosure digests and recursively processing nested objects.
export function makeSdPayload (
  payload: JsonObject,
  disclosureFrame: DisclosureFrame = {}
): { payload: JsonObject, disclosures: DisclosureRecord[] } {
  const disclosures: DisclosureRecord[] = []
  const transformed = transformObject(payload, disclosureFrame, [], disclosures, true)
  if (disclosures.length > 0) transformed._sd_alg = 'sha-256'
  return { payload: transformed, disclosures }
}

export function parseDisclosure (disclosure: string): { salt: string, claimName: string, claimValue: JsonValue } {
  const parsed = base64UrlDecodeJson<unknown>(disclosure)
  if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
    throw new Error('Invalid object-property Disclosure')
  }
  return {
    salt: parsed[0],
    claimName: parsed[1],
    claimValue: parsed[2] as JsonValue
  }
}

export function disclosureDigest (disclosure: string): string {
  return sha256Base64Url(disclosure)
}

export function collectDigestPaths (payload: JsonValue, path: string[] = []): Map<string, string[]> {
  const out = new Map<string, string[]>()
  collectDigestPathsInto(payload, path, out)
  return out
}

export function applyDisclosures (
  payload: JsonObject,
  disclosures: string[]
): { payload: JsonObject, disclosedClaims: JsonObject, disclosurePaths: Map<string, string[]> } {
  assertSupportedSdAlg(payload)
  const digestPaths = collectDigestPaths(payload)
  const cloned = cloneJson(payload)
  const disclosedClaims: JsonObject = {}
  const seen = new Set<string>()

  for (const disclosure of disclosures) {
    const digest = disclosureDigest(disclosure)
    if (seen.has(digest)) throw new Error('Duplicate Disclosure detected')
    seen.add(digest)

    const path = digestPaths.get(digest)
    if (path == null) throw new Error('Disclosure is not referenced by the SD-JWT')
    const { claimName, claimValue } = parseDisclosure(disclosure)
    setAtPath(cloned, [...path, claimName], claimValue)
    setAtPath(disclosedClaims, [...path, claimName], claimValue)
  }

  stripSdMetadata(cloned)
  return { payload: cloned, disclosedClaims, disclosurePaths: digestPaths }
}

export function selectDisclosures (
  issuerSignedJwtPayload: JsonObject,
  disclosures: string[],
  disclosedClaims: string[]
): string[] {
  const wanted = new Set(disclosedClaims)
  const digestPaths = collectDigestPaths(issuerSignedJwtPayload)

  return disclosures.filter((disclosure) => {
    const digest = disclosureDigest(disclosure)
    const path = digestPaths.get(digest)
    if (path == null) return false
    const { claimName } = parseDisclosure(disclosure)
    const fullPath = [...path, claimName].join('.')
    return wanted.has(fullPath) || wanted.has(claimName)
  })
}

function transformObject (
  value: JsonObject,
  frame: DisclosureFrame,
  path: string[],
  disclosures: DisclosureRecord[],
  topLevel: boolean
): JsonObject {
  const out: JsonObject = {}
  const sd: string[] = []

  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    const frameRule = frame[key]
    if (frameRule === true) {
      if (topLevel && PROTECTED_SD_JWT_VC_CLAIMS.has(key)) {
        throw new Error(`SD-JWT VC claim "${key}" cannot be selectively disclosed`)
      }
      const record = createDisclosure(key, item)
      record.path = path
      disclosures.push(record)
      sd.push(record.digest)
    } else if (isPlainObject(item) && isPlainObject(frameRule)) {
      out[key] = transformObject(item, frameRule, [...path, key], disclosures, false)
    } else {
      out[key] = item
    }
  }

  if (sd.length > 0) out._sd = sd.sort()
  return out
}

function collectDigestPathsInto (value: JsonValue, path: string[], out: Map<string, string[]>): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectDigestPathsInto(item, [...path, String(index)], out))
    return
  }
  if (!isPlainObject(value)) return

  const sd = value._sd
  if (Array.isArray(sd)) {
    for (const digest of sd) {
      if (typeof digest === 'string') out.set(digest, path)
    }
  }

  for (const [key, item] of Object.entries(value)) {
    if (key === '_sd' || key === '_sd_alg') continue
    collectDigestPathsInto(item as JsonValue, [...path, key], out)
  }
}

function setAtPath (target: JsonObject, path: string[], value: JsonValue): void {
  let cursor = target
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]
    const next = cursor[segment]
    if (!isPlainObject(next)) cursor[segment] = {}
    cursor = cursor[segment] as JsonObject
  }
  cursor[path[path.length - 1]] = value
}

function stripSdMetadata (value: JsonValue): void {
  if (Array.isArray(value)) {
    value.forEach(item => stripSdMetadata(item))
    return
  }
  if (!isPlainObject(value)) return
  delete value._sd
  delete value._sd_alg
  Object.values(value).forEach(item => stripSdMetadata(item as JsonValue))
}

function assertSupportedSdAlg (value: JsonValue): void {
  if (Array.isArray(value)) {
    value.forEach(item => assertSupportedSdAlg(item))
    return
  }
  if (!isPlainObject(value)) return

  if (value._sd_alg != null && value._sd_alg !== 'sha-256') {
    throw new Error('Unsupported SD-JWT hash algorithm')
  }

  Object.values(value).forEach(item => assertSupportedSdAlg(item as JsonValue))
}

function cloneJson<T extends JsonValue> (value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isPlainObject (value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
