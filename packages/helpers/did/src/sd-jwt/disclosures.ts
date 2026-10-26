import type { DisclosureFrame, JsonObject, JsonValue } from '../types.js'
import {
  assertBoundedString,
  defineOwn,
  hasOwn,
  isPlainRecord,
  MAX_DISCLOSURE_BYTES,
  MAX_DISCLOSURES,
  MAX_IDENTIFIER_BYTES,
  MAX_JSON_DEPTH,
  snapshotJsonObject,
  snapshotJsonValue
} from '../validation.js'
import { base64UrlDecode, base64UrlDecodeJson, base64UrlEncodeJson } from '../utils/base64url.js'
import { randomSalt, sha256Base64Url } from '../utils/crypto.js'

export interface DisclosureRecord {
  disclosure: string
  digest: string
  path: string[]
  claimName: string
  claimValue: JsonValue
}

interface ParsedDisclosureValue {
  kind: 'object' | 'array'
  salt: string
  claimName?: string
  claimValue: JsonValue
}

interface PreparedDisclosure extends ParsedDisclosureValue {
  disclosure: string
  digest: string
}

interface ProcessedValue {
  value: JsonValue
  disclosed?: JsonValue
}

interface ProcessingState {
  disclosures: Map<string, PreparedDisclosure>
  usedDisclosures: Set<string>
  encounteredDigests: Set<string>
  disclosurePaths: Map<string, string[]>
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

const RESERVED_SD_KEYS = new Set(['_sd', '_sd_alg', '...'])

// Implements RFC 9901 section 4.2.1 Disclosures for Object Properties.
export function createDisclosure(
  claimName: string,
  claimValue: JsonValue,
  salt = randomSalt()
): DisclosureRecord {
  assertClaimName(claimName)
  assertBoundedString(salt, 'Disclosure salt', 256)
  const valueSnapshot = snapshotJsonValue(claimValue, `Disclosure "${claimName}" value`)
  const disclosure = base64UrlEncodeJson([salt, claimName, valueSnapshot])
  return {
    disclosure,
    digest: sha256Base64Url(disclosure),
    path: [claimName],
    claimName,
    claimValue: valueSnapshot
  }
}

// Implements RFC 9901 sections 4.2.4 and 4.2.6 by replacing selected object
// properties with their disclosure digests and recursively processing nested objects.
export function makeSdPayload(
  payload: JsonObject,
  disclosureFrame: DisclosureFrame = {}
): { payload: JsonObject; disclosures: DisclosureRecord[] } {
  const payloadSnapshot = snapshotJsonObject(payload, 'SD-JWT payload')
  const frameSnapshot = snapshotDisclosureFrame(disclosureFrame, 'Disclosure frame', 0)
  const disclosures: DisclosureRecord[] = []
  const transformed = transformObject(payloadSnapshot, frameSnapshot, [], disclosures, true)
  if (disclosures.length > 0) defineOwn(transformed, '_sd_alg', 'sha-256')
  return { payload: transformed, disclosures }
}

export function parseDisclosure(disclosure: string): {
  salt: string
  claimName: string
  claimValue: JsonValue
} {
  let parsed: ParsedDisclosureValue
  try {
    parsed = parseDisclosureValue(disclosure)
  } catch (error) {
    throw new Error('Invalid object-property Disclosure', { cause: error })
  }
  if (parsed.kind !== 'object' || parsed.claimName == null) {
    throw new Error('Invalid object-property Disclosure')
  }
  return {
    salt: parsed.salt,
    claimName: parsed.claimName,
    claimValue: parsed.claimValue
  }
}

export function disclosureDigest(disclosure: string): string {
  assertCanonicalDisclosure(disclosure, 'Disclosure')
  return sha256Base64Url(disclosure)
}

export function collectDigestPaths(payload: JsonValue, path: string[] = []): Map<string, string[]> {
  const payloadSnapshot = snapshotJsonValue(payload, 'SD-JWT payload')
  const pathSnapshot = snapshotPath(path)
  const out = new Map<string, string[]>()
  const encountered = new Set<string>()
  collectDigestPathsInto(payloadSnapshot, pathSnapshot, out, encountered, true, 0)
  return out
}

export function applyDisclosures(
  payload: JsonObject,
  disclosures: string[]
): { payload: JsonObject; disclosedClaims: JsonObject; disclosurePaths: Map<string, string[]> } {
  const payloadSnapshot = snapshotJsonObject(payload, 'SD-JWT payload')
  assertTopLevelSdAlg(payloadSnapshot)
  const prepared = prepareDisclosures(disclosures)
  const state: ProcessingState = {
    disclosures: prepared,
    usedDisclosures: new Set<string>(),
    encounteredDigests: new Set<string>(),
    disclosurePaths: new Map<string, string[]>()
  }
  const processed = processValue(payloadSnapshot, [], state, true, 0)
  if (!isPlainRecord(processed.value)) throw new Error('SD-JWT payload must be a JSON object')
  for (const digest of prepared.keys()) {
    if (!state.usedDisclosures.has(digest)) {
      throw new Error('Disclosure is not referenced by the SD-JWT')
    }
  }
  const disclosedClaims = isPlainRecord(processed.disclosed) ? processed.disclosed : {}
  return {
    payload: processed.value as JsonObject,
    disclosedClaims: disclosedClaims as JsonObject,
    disclosurePaths: state.disclosurePaths
  }
}

export function selectDisclosures(
  issuerSignedJwtPayload: JsonObject,
  disclosures: string[],
  disclosedClaims: string[]
): string[] {
  const disclosureSnapshot = snapshotDisclosureStrings(disclosures)
  const requested = snapshotRequestedClaims(disclosedClaims)
  const applied = applyDisclosures(issuerSignedJwtPayload, disclosureSnapshot)
  const candidates = new Map<string, PreparedDisclosure[]>()
  const byDigest = prepareDisclosures(disclosureSnapshot)

  for (const record of byDigest.values()) {
    const parentPath = applied.disclosurePaths.get(record.digest)
    if (parentPath == null) continue
    const fullPath =
      record.kind === 'object' && record.claimName != null
        ? [...parentPath, record.claimName]
        : parentPath
    const key = fullPath.join('.')
    const existing = candidates.get(key) ?? []
    existing.push(record)
    candidates.set(key, existing)
  }

  const selectedDigests = new Set<string>()
  for (const claim of requested) {
    const matches = candidates.get(claim) ?? []
    if (matches.length === 0) throw new Error(`Requested disclosure "${claim}" was not found`)
    if (matches.length !== 1) throw new Error(`Requested disclosure "${claim}" is ambiguous`)
    const target = matches[0]
    const targetPath = fullDisclosurePath(target, applied.disclosurePaths)
    for (const candidate of byDigest.values()) {
      const candidatePath = fullDisclosurePath(candidate, applied.disclosurePaths)
      if (isPathPrefix(candidatePath, targetPath)) selectedDigests.add(candidate.digest)
    }
  }

  return disclosureSnapshot.filter(disclosure => selectedDigests.has(disclosureDigest(disclosure)))
}

function transformObject(
  value: JsonObject,
  frame: DisclosureFrame,
  path: string[],
  disclosures: DisclosureRecord[],
  topLevel: boolean
): JsonObject {
  const out: JsonObject = {}
  const sd: string[] = []

  for (const [key, item] of Object.entries(value)) {
    if (RESERVED_SD_KEYS.has(key)) {
      throw new Error(`Unsecured payload must not contain reserved claim "${key}"`)
    }
    const frameRule = frame[key]
    if (frameRule === true) {
      if (topLevel && PROTECTED_SD_JWT_VC_CLAIMS.has(key)) {
        throw new Error(`SD-JWT VC claim "${key}" cannot be selectively disclosed`)
      }
      const record = createDisclosure(key, item as JsonValue)
      record.path = [...path]
      disclosures.push(record)
      if (disclosures.length > MAX_DISCLOSURES) throw new Error('Too many Disclosures')
      sd.push(record.digest)
    } else if (isPlainRecord(item) && isPlainRecord(frameRule)) {
      defineOwn(
        out,
        key,
        transformObject(
          item as JsonObject,
          frameRule as DisclosureFrame,
          [...path, key],
          disclosures,
          false
        )
      )
    } else if (isPlainRecord(frameRule)) {
      throw new Error(`Disclosure frame for "${key}" does not match an object claim`)
    } else {
      defineOwn(out, key, item)
    }
  }

  for (const frameKey of Object.keys(frame)) {
    if (!hasOwn(value, frameKey)) {
      throw new Error(`Disclosure frame references missing claim "${frameKey}"`)
    }
  }
  if (sd.length > 0) {
    sd.sort((left, right) => left.localeCompare(right))
    defineOwn(out, '_sd', sd)
  }
  return out
}

function processValue(
  value: JsonValue,
  path: string[],
  state: ProcessingState,
  topLevel: boolean,
  depth: number
): ProcessedValue {
  if (depth > MAX_JSON_DEPTH) throw new Error('SD-JWT disclosure graph exceeds the depth limit')
  if (Array.isArray(value)) return processArray(value, path, state, depth)
  if (!isPlainRecord(value)) return { value }
  if (!topLevel && hasOwn(value, '_sd_alg')) {
    throw new Error('_sd_alg is only permitted at the top level')
  }
  if (hasOwn(value, '...')) throw new Error('The "..." key is only valid as an array placeholder')

  const output: JsonObject = {}
  const disclosed: JsonObject = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === '_sd' || key === '_sd_alg') continue
    const child = processValue(item as JsonValue, [...path, key], state, false, depth + 1)
    defineOwn(output, key, child.value)
    if (child.disclosed !== undefined) defineOwn(disclosed, key, child.disclosed)
  }

  if (hasOwn(value, '_sd')) {
    const digests = snapshotDigestArray(value._sd, '_sd')
    for (const digest of digests) {
      encounterDigest(digest, path, state)
      const record = state.disclosures.get(digest)
      if (record == null) continue
      if (record.kind !== 'object' || record.claimName == null) {
        throw new Error('Array-element Disclosure cannot satisfy an object digest')
      }
      if (hasOwn(output, record.claimName)) {
        throw new Error('Disclosure claim collides with an existing claim')
      }
      const child = processValue(
        record.claimValue,
        [...path, record.claimName],
        state,
        false,
        depth + 1
      )
      defineOwn(output, record.claimName, child.value)
      defineOwn(
        disclosed,
        record.claimName,
        snapshotJsonValue(child.value, `Disclosed claim "${record.claimName}"`)
      )
      state.usedDisclosures.add(digest)
    }
  }

  return {
    value: output,
    ...(Object.keys(disclosed).length > 0 ? { disclosed } : {})
  }
}

function processArray(
  value: JsonValue[],
  path: string[],
  state: ProcessingState,
  depth: number
): ProcessedValue {
  const output: JsonValue[] = []
  let hasDisclosed = false
  for (let index = 0; index < value.length; index++) {
    const item = value[index]
    if (isPlainRecord(item) && hasOwn(item, '...')) {
      if (Object.keys(item).length !== 1 || typeof item['...'] !== 'string') {
        throw new Error('Invalid array Disclosure placeholder')
      }
      const digest = item['...']
      assertDigest(digest)
      const outputIndexPath = [...path, String(output.length)]
      encounterDigest(digest, outputIndexPath, state)
      const record = state.disclosures.get(digest)
      if (record == null) continue
      if (record.kind !== 'array') {
        throw new Error('Object-property Disclosure cannot satisfy an array digest')
      }
      const child = processValue(record.claimValue, outputIndexPath, state, false, depth + 1)
      output.push(child.value)
      hasDisclosed = true
      state.usedDisclosures.add(digest)
      continue
    }
    const child = processValue(item, [...path, String(output.length)], state, false, depth + 1)
    output.push(child.value)
    if (child.disclosed !== undefined) hasDisclosed = true
  }
  return {
    value: output,
    ...(hasDisclosed ? { disclosed: snapshotJsonValue(output, 'Disclosed array claims') } : {})
  }
}

function prepareDisclosures(disclosures: string[]): Map<string, PreparedDisclosure> {
  const snapshot = snapshotDisclosureStrings(disclosures)
  const prepared = new Map<string, PreparedDisclosure>()
  for (const disclosure of snapshot) {
    const parsed = parseDisclosureValue(disclosure)
    const digest = disclosureDigest(disclosure)
    if (prepared.has(digest)) throw new Error('Duplicate Disclosure detected')
    prepared.set(digest, { ...parsed, disclosure, digest })
  }
  return prepared
}

function parseDisclosureValue(disclosure: string): ParsedDisclosureValue {
  assertCanonicalDisclosure(disclosure, 'Disclosure')
  const parsed = base64UrlDecodeJson<unknown>(disclosure)
  if (!Array.isArray(parsed) || (parsed.length !== 2 && parsed.length !== 3)) {
    throw new Error('Invalid Disclosure')
  }
  const descriptors = Object.getOwnPropertyDescriptors(parsed)
  const values: unknown[] = []
  for (let index = 0; index < parsed.length; index++) {
    const descriptor = descriptors[String(index)]
    if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('Invalid Disclosure')
    }
    values.push(descriptor.value)
  }
  const salt = values[0]
  assertBoundedString(salt, 'Disclosure salt', 256)
  if (parsed.length === 2) {
    return {
      kind: 'array',
      salt,
      claimValue: snapshotJsonValue(values[1], 'Array Disclosure value')
    }
  }
  const claimName = values[1]
  assertClaimName(claimName)
  return {
    kind: 'object',
    salt,
    claimName,
    claimValue: snapshotJsonValue(values[2], `Disclosure "${claimName}" value`)
  }
}

function collectDigestPathsInto(
  value: JsonValue,
  path: string[],
  out: Map<string, string[]>,
  encountered: Set<string>,
  topLevel: boolean,
  depth: number
): void {
  if (depth > MAX_JSON_DEPTH) throw new Error('SD-JWT disclosure graph exceeds the depth limit')
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const item = value[index]
      if (isPlainRecord(item) && hasOwn(item, '...')) {
        if (Object.keys(item).length !== 1 || typeof item['...'] !== 'string') {
          throw new Error('Invalid array Disclosure placeholder')
        }
        addDigestPath(item['...'], [...path, String(index)], out, encountered)
      } else {
        collectDigestPathsInto(item, [...path, String(index)], out, encountered, false, depth + 1)
      }
    }
    return
  }
  if (!isPlainRecord(value)) return
  if (!topLevel && hasOwn(value, '_sd_alg')) {
    throw new Error('_sd_alg is only permitted at the top level')
  }
  if (hasOwn(value, '...')) throw new Error('The "..." key is only valid as an array placeholder')
  if (hasOwn(value, '_sd')) {
    for (const digest of snapshotDigestArray(value._sd, '_sd')) {
      addDigestPath(digest, path, out, encountered)
    }
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === '_sd' || key === '_sd_alg') continue
    collectDigestPathsInto(item as JsonValue, [...path, key], out, encountered, false, depth + 1)
  }
}

function encounterDigest(digest: string, path: string[], state: ProcessingState): void {
  assertDigest(digest)
  if (state.encounteredDigests.has(digest)) {
    throw new Error('The same Disclosure digest appears more than once')
  }
  state.encounteredDigests.add(digest)
  state.disclosurePaths.set(digest, [...path])
}

function addDigestPath(
  digest: string,
  path: string[],
  out: Map<string, string[]>,
  encountered: Set<string>
): void {
  assertDigest(digest)
  if (encountered.has(digest)) throw new Error('The same Disclosure digest appears more than once')
  encountered.add(digest)
  out.set(digest, [...path])
}

function snapshotDigestArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_DISCLOSURES) {
    throw new Error(`${label} must be a bounded array of digests`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const out = Array.from({ length: value.length }, () => '')
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)]
    if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(`${label}[${index}] must be an own data digest`)
    }
    assertDigest(descriptor.value)
    out[index] = descriptor.value
  }
  return out
}

function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('Invalid sha-256 Disclosure digest')
  }
  const bytes = base64UrlDecode(value, 32)
  if (bytes.length !== 32) throw new Error('Invalid sha-256 Disclosure digest')
}

function assertCanonicalDisclosure(value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label, MAX_DISCLOSURE_BYTES)
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError(`${label} is not canonical base64url`)
}

function assertClaimName(value: unknown): asserts value is string {
  assertBoundedString(value, 'Disclosure claim name', MAX_IDENTIFIER_BYTES, true)
  if (RESERVED_SD_KEYS.has(value)) throw new Error(`Disclosure claim name "${value}" is reserved`)
}

function assertTopLevelSdAlg(payload: JsonObject): void {
  if (hasOwn(payload, '_sd_alg') && payload._sd_alg !== 'sha-256') {
    throw new Error('Unsupported SD-JWT hash algorithm')
  }
}

function snapshotDisclosureStrings(disclosures: string[]): string[] {
  if (!Array.isArray(disclosures) || disclosures.length > MAX_DISCLOSURES) {
    throw new TypeError('Disclosures must be a bounded array')
  }
  const descriptors = Object.getOwnPropertyDescriptors(disclosures)
  const out = Array.from({ length: disclosures.length }, () => '')
  let aggregateBytes = 0
  for (let index = 0; index < disclosures.length; index++) {
    const descriptor = descriptors[String(index)]
    if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`Disclosure ${index} must be an own data string`)
    }
    assertCanonicalDisclosure(descriptor.value, `Disclosure ${index}`)
    aggregateBytes += new TextEncoder().encode(descriptor.value).length
    if (aggregateBytes > 1_048_576) throw new TypeError('Disclosures exceed the aggregate limit')
    out[index] = descriptor.value
  }
  return out
}

function snapshotRequestedClaims(claims: string[]): string[] {
  if (!Array.isArray(claims) || claims.length > MAX_DISCLOSURES) {
    throw new TypeError('Requested claims must be a bounded array')
  }
  const descriptors = Object.getOwnPropertyDescriptors(claims)
  const out = Array.from({ length: claims.length }, () => '')
  const seen = new Set<string>()
  for (let index = 0; index < claims.length; index++) {
    const descriptor = descriptors[String(index)]
    if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`Requested claim ${index} must be an own data string`)
    }
    assertBoundedString(descriptor.value, `Requested claim ${index}`, MAX_IDENTIFIER_BYTES)
    if (seen.has(descriptor.value)) throw new Error('Requested claims must be unique')
    seen.add(descriptor.value)
    out[index] = descriptor.value
  }
  return out
}

function snapshotDisclosureFrame(value: unknown, label: string, depth: number): DisclosureFrame {
  if (depth > MAX_JSON_DEPTH || !isPlainRecord(value)) {
    throw new TypeError(`${label} must be a bounded plain object`)
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must not contain symbol properties`)
  }
  const out: DisclosureFrame = {}
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label}.${key} must be an enumerable own data property`)
    }
    const rule = descriptor.value
    if (typeof rule === 'boolean') defineOwn(out, key, rule)
    else defineOwn(out, key, snapshotDisclosureFrame(rule, `${label}.${key}`, depth + 1))
  }
  return out
}

function snapshotPath(path: string[]): string[] {
  if (!Array.isArray(path) || path.length > MAX_JSON_DEPTH) throw new TypeError('Invalid path')
  const descriptors = Object.getOwnPropertyDescriptors(path)
  const out: string[] = []
  for (let index = 0; index < path.length; index++) {
    const descriptor = descriptors[String(index)]
    if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`Path segment ${index} must be an own data string`)
    }
    assertBoundedString(descriptor.value, `Path segment ${index}`, MAX_IDENTIFIER_BYTES, true)
    out.push(descriptor.value)
  }
  return out
}

function fullDisclosurePath(record: PreparedDisclosure, paths: Map<string, string[]>): string[] {
  const parent = paths.get(record.digest)
  if (parent == null) throw new Error('Disclosure graph is incomplete')
  return record.kind === 'object' && record.claimName != null
    ? [...parent, record.claimName]
    : [...parent]
}

function isPathPrefix(candidate: string[], target: string[]): boolean {
  return (
    candidate.length <= target.length &&
    candidate.every((segment, index) => segment === target[index])
  )
}
