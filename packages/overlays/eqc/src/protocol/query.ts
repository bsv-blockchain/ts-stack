import { Hash, Utils } from '@bsv/sdk'

import { canonicalJson } from './canonicalJson.js'

/** HTTP binding shared by client and host. */
export const ECONOMIC_PATHS = {
  params: '/economic/params',
  query: '/economic/query',
  collect: '/economic/collect'
} as const

export const DEFAULTS = {
  threshold: 3,
  topK: 5,
  raceMs: 400,
  floorFeeSats: 1000,
  maxFeeSats: 2000,
  queryTtlMs: 30_000,
  hostTimeoutMs: 5000,
  paramsTimeoutMs: 2000,
  hostsTtlMs: 300_000,
  paramsTtlMs: 300_000,
  maxHosts: 16
} as const

/** Upper bound on `threshold`, `topK`, and the length of a collect ranking. */
export const MAX_RANKED_HOSTS = 64

const MAX_PARAMS_CHARS = 65_536
const MAX_HOST_HINTS = 64
const PUBLIC_KEY_HEX = /^0[23][0-9a-f]{64}$/
const HASH_HEX = /^[0-9a-f]{64}$/
const QUERY_TYPE = /^[a-z][a-z0-9-]{0,63}$/
const QUERY_KEYS = new Set([
  'type',
  'client',
  'hostSetHint',
  'strictHosts',
  'params',
  'maxFeeSats',
  'floorFeeSats',
  'threshold',
  'topK',
  'raceMs',
  'expires',
  'nonce'
])

export interface EconomicQuery {
  type: string
  client: string
  hostSetHint?: string[]
  strictHosts?: boolean
  params: Record<string, unknown>
  maxFeeSats: number
  floorFeeSats: number
  threshold: number
  topK: number
  raceMs: number
  expires: string
  nonce: string
}

export function isPublicKeyHex(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_KEY_HEX.test(value)
}

export function isHashHex(value: unknown): value is string {
  return typeof value === 'string' && HASH_HEX.test(value)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function integerInRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

/** Validates an untrusted query body and returns a copy holding only known fields. */
export function validateQuery(value: unknown): EconomicQuery {
  if (!isPlainObject(value)) throw new TypeError('Query must be a JSON object')
  for (const key of Object.keys(value)) {
    if (!QUERY_KEYS.has(key)) throw new TypeError(`Unknown query field ${key}`)
  }
  if (typeof value.type !== 'string' || !QUERY_TYPE.test(value.type)) {
    throw new TypeError('type must be a lowercase query class name')
  }
  if (!isPublicKeyHex(value.client)) {
    throw new TypeError('client must be a compressed public key in hex')
  }
  if (!isPlainObject(value.params)) throw new TypeError('params must be a JSON object')
  if (canonicalJson(value.params).length > MAX_PARAMS_CHARS) {
    throw new TypeError('params exceed 65536 characters')
  }
  const floorFeeSats = integerInRange(
    value.floorFeeSats,
    'floorFeeSats',
    1,
    Number.MAX_SAFE_INTEGER
  )
  const maxFeeSats = integerInRange(
    value.maxFeeSats,
    'maxFeeSats',
    floorFeeSats,
    Number.MAX_SAFE_INTEGER
  )
  const threshold = integerInRange(value.threshold, 'threshold', 1, MAX_RANKED_HOSTS)
  const topK = integerInRange(value.topK, 'topK', 1, MAX_RANKED_HOSTS)
  if (threshold > 1 && topK < threshold) {
    throw new TypeError('topK must be at least threshold unless threshold is 1')
  }
  const raceMs = integerInRange(value.raceMs, 'raceMs', 0, 60_000)
  if (typeof value.expires !== 'string' || !isCanonicalTimestamp(value.expires)) {
    throw new TypeError('expires must be an ISO 8601 UTC timestamp')
  }
  if (!isHashHex(value.nonce)) throw new TypeError('nonce must be 32 bytes of lowercase hex')

  const query: EconomicQuery = {
    type: value.type,
    client: value.client,
    params: value.params,
    maxFeeSats,
    floorFeeSats,
    threshold,
    topK,
    raceMs,
    expires: value.expires,
    nonce: value.nonce
  }
  if (value.hostSetHint !== undefined) {
    const hint = value.hostSetHint
    if (!Array.isArray(hint) || hint.length > MAX_HOST_HINTS || !hint.every(isPublicKeyHex)) {
      throw new TypeError('hostSetHint must list at most 64 compressed public keys')
    }
    query.hostSetHint = [...hint]
  }
  if (value.strictHosts !== undefined) {
    if (typeof value.strictHosts !== 'boolean') throw new TypeError('strictHosts must be a boolean')
    query.strictHosts = value.strictHosts
  }
  return query
}

/** `SHA-256` of the canonical JSON of the query, as lowercase hex. */
export function computeQueryId(query: EconomicQuery): string {
  return Utils.toHex(Hash.sha256(Utils.toArray(canonicalJson(query), 'utf8')))
}
