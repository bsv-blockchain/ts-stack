import { stringifyBRC100 } from '@bsv/sdk/wallet/BRC100ByteEncoding'
import { isValidCompressedPublicKey } from '@bsv/sdk/wallet/Secp256k1Validation'
import type { WalletProtocol } from '@bsv/sdk/wallet/Wallet.interfaces'
import type {
  PairingParams,
  RpcRequest,
  RpcResponse,
  SessionInfo,
  SessionStatus,
  WireEnvelope
} from '../types.js'
import { base64urlToBytes } from './encoding.js'
import { requirePairingUri, requireQrDataUrl } from './artifacts.js'

export { requirePairingUri, requireQrDataUrl } from './artifacts.js'

export const MAX_HTTP_RESPONSE_BYTES = 256 * 1024
export const MAX_WIRE_PAYLOAD_BYTES = 64 * 1024
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000
export const DEFAULT_MAX_SESSIONS = 1_000
export const MAX_CONFIGURED_SESSIONS = 100_000

const sessionStatuses = new Set<SessionStatus>(['pending', 'connected', 'disconnected', 'expired'])
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])
const textEncoder = new TextEncoder()

type UnknownRecord = Record<string, unknown>

function invalid(context: string, expectation: string): never {
  throw new TypeError(`${context} must be ${expectation}`)
}

export function requirePlainRecord(value: unknown, context: string): UnknownRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(context, 'a plain object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(context, 'a plain object')
  }
  for (const key of Object.keys(value)) {
    if (unsafeKeys.has(key)) invalid(context, 'an object without unsafe property names')
  }
  return value as UnknownRecord
}

export function requireBoundedString(
  value: unknown,
  context: string,
  minimum: number,
  maximum: number
): string {
  if (typeof value !== 'string') invalid(context, 'a string')
  const bytes = textEncoder.encode(value).length
  if (bytes < minimum || bytes > maximum) {
    invalid(context, `${minimum}–${maximum} UTF-8 bytes`)
  }
  return value
}

export function requireSessionId(value: unknown, context = 'session ID'): string {
  const id = requireBoundedString(value, context, 43, 43)
  if (!/^[A-Za-z0-9_-]{43}$/u.test(id)) invalid(context, 'a canonical 32-byte base64url token')
  return id
}

/**
 * Legacy pairing helpers have always accepted caller-supplied URL-safe topics.
 * The built-in relay still uses requireSessionId() for its 256-bit identifiers,
 * while this bounded form preserves the public pairing URI wire contract.
 */
export function requirePairingTopic(value: unknown, context = 'pairing topic'): string {
  const topic = requireBoundedString(value, context, 1, 256)
  if (!/^[A-Za-z0-9._~-]+$/u.test(topic)) invalid(context, 'a bounded URL-safe token')
  return topic
}

export function requireDesktopToken(value: unknown, context = 'desktop token'): string {
  const token = requireBoundedString(value, context, 32, 32)
  if (!/^[A-Za-z0-9_-]{32}$/u.test(token)) {
    invalid(context, 'a canonical 24-byte base64url token')
  }
  return token
}

export function requirePublicKey(value: unknown, context: string): string {
  const key = requireBoundedString(value, context, 66, 66)
  if (!isValidCompressedPublicKey(key)) invalid(context, 'a valid compressed public key')
  return key
}

export function requireSafeSequence(value: unknown, context = 'RPC sequence'): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid(context, 'a positive safe integer')
  }
  return value as number
}

export function requireRpcId(value: unknown, context = 'RPC ID'): string {
  const id = requireBoundedString(value, context, 36, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    invalid(context, 'a canonical UUIDv4')
  }
  return id
}

export function requireProtocolId(value: unknown, context = 'protocolID'): WalletProtocol {
  let parsed: unknown
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    invalid(context, 'the mobile wallet session protocol')
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    invalid(context, 'a wallet protocol tuple')
  }
  if (!Number.isInteger(parsed[0]) || (parsed[0] as number) < 0 || (parsed[0] as number) > 2) {
    invalid(context, 'a wallet protocol with security level 0, 1, or 2')
  }
  const name = requireBoundedString(parsed[1], `${context} name`, 5, 400)
  const canonicalName = name.toLowerCase().trim()
  if (
    canonicalName.length < 5 ||
    canonicalName.includes('  ') ||
    !/^[a-z0-9 ]+$/u.test(canonicalName) ||
    canonicalName.endsWith(' protocol')
  ) {
    invalid(context, 'a valid wallet protocol tuple')
  }
  return [parsed[0] as 0 | 1 | 2, canonicalName]
}

const CANONICAL_IPV4 = /^(?:(?:0|[1-9]\d{0,2})\.){3}(?:0|[1-9]\d{0,2})$/u
const UNIQUE_LOCAL_IPV6 = /^\[f[cd][0-9a-f]{2}:[0-9a-f:]*\]$/u

/** Opt-in for plain `http:`/`ws:` on private-network IP addresses (development only). */
export interface LocalNetworkHttpOptions {
  /**
   * Accept plain `http:`/`ws:` on private-network IP literals (10.0.0.0/8,
   * 172.16.0.0/12, 192.168.0.0/16, IPv6 fc00::/7) for same-LAN development.
   * Such origins are unauthenticated: an on-path attacker can rewrite the
   * session lookup and relay URL. Never enable in production. Default: false.
   */
  allowLocalNetworkHttp?: boolean
}

/** Internal: transport policy plus whether a rejection may name `allowLocalNetworkHttp`. */
interface TransportPolicy extends LocalNetworkHttpOptions {
  /** Server/desktop errors only: append the `allowLocalNetworkHttp` hint. Default false. */
  developerHint?: boolean
}

/** Reads an optional boolean option without coercion; `undefined` means false. */
export function requireOptionalBoolean(value: unknown, context: string): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') invalid(context, 'a boolean')
  return value
}

/**
 * Classifies a WHATWG-parsed `URL.hostname` for plain-transport development:
 * `'loopback'` for `localhost`, `*.localhost`, 127.0.0.0/8 and `[::1]`;
 * `'local-network'` for 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 and IPv6
 * fc00::/7; otherwise null. Integer/hex IPv4 forms are expected to be already
 * canonical. Other names (including `*.local` and wildcard-DNS names) and
 * IPv4-mapped IPv6 literals return null.
 */
export function developmentHostKind(hostname: string): 'loopback' | 'local-network' | null {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]') return 'loopback'
  if (UNIQUE_LOCAL_IPV6.test(host)) return 'local-network'
  if (!CANONICAL_IPV4.test(host)) return null
  const octets = host.split('.').map(Number)
  if (octets.some(octet => octet > 255)) return null
  const [a, b] = octets as [number, number]
  if (a === 127) return 'loopback'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return 'local-network'
  }
  return null
}

/**
 * Returns null when `url` may be used, otherwise the expectation for an error
 * message (e.g. "HTTPS, except for loopback development"). The secure scheme
 * is always allowed; its plain counterpart only on loopback, or on
 * private-network IPs when `allowLocalNetworkHttp` is true. Pass
 * `developerHint: true` only for server/desktop errors; the default text is
 * shown to wallet users and does not suggest the `allowLocalNetworkHttp` option.
 */
export function plainTransportRejection(
  url: URL,
  secure: 'https:' | 'wss:',
  allowLocalNetworkHttp: boolean,
  developerHint = false
): string | null {
  if (url.protocol === secure) return null
  const plain = secure === 'https:' ? 'http:' : 'ws:'
  const kind = url.protocol === plain ? developmentHostKind(url.hostname) : null
  if (kind === 'loopback' || (kind === 'local-network' && allowLocalNetworkHttp)) return null
  const name = secure === 'https:' ? 'HTTPS' : 'WSS'
  if (allowLocalNetworkHttp) return `${name}, except for loopback or local-network development`
  if (kind === 'local-network' && developerHint) {
    return `${name}, except for loopback development (set allowLocalNetworkHttp: true to allow private-network IP addresses in development)`
  }
  return `${name}, except for loopback development`
}

export function normalizeHttpOrigin(
  value: unknown,
  context = 'origin',
  options: TransportPolicy = {}
): string {
  const allowLocalNetworkHttp = requireOptionalBoolean(
    options.allowLocalNetworkHttp,
    'allowLocalNetworkHttp'
  )
  const encoded = requireBoundedString(value, context, 1, 2_048)
  let parsed: URL
  try {
    parsed = new URL(encoded)
  } catch {
    return invalid(context, 'a canonical HTTP(S) origin')
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.pathname !== '/'
  ) {
    invalid(context, 'a canonical HTTP(S) origin')
  }
  const rejection = plainTransportRejection(
    parsed,
    'https:',
    allowLocalNetworkHttp,
    options.developerHint === true
  )
  if (rejection !== null) invalid(context, rejection)
  return parsed.origin
}

export function normalizeRelayUrl(
  value: unknown,
  context = 'relay URL',
  options: TransportPolicy = {}
): string {
  const allowLocalNetworkHttp = requireOptionalBoolean(
    options.allowLocalNetworkHttp,
    'allowLocalNetworkHttp'
  )
  const encoded = requireBoundedString(value, context, 1, 2_048)
  let parsed: URL
  try {
    parsed = new URL(encoded)
  } catch {
    return invalid(context, 'a canonical WebSocket base URL')
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    invalid(context, 'a credential-free WebSocket base URL without query or fragment')
  }
  const rejection = plainTransportRejection(
    parsed,
    'wss:',
    allowLocalNetworkHttp,
    options.developerHint === true
  )
  if (rejection !== null) invalid(context, rejection)
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '')
  return parsed.toString().replace(/\/$/u, '')
}

export function validatePairingParams(
  params: PairingParams,
  options: TransportPolicy = {}
): PairingParams {
  requirePairingTopic(params.topic, 'pairing topic')
  requirePublicKey(params.backendIdentityKey, 'pairing backend identity key')
  requireProtocolId(params.protocolID, 'pairing protocolID')
  normalizeHttpOrigin(params.origin, 'pairing origin', options)
  if (!/^(?:0|[1-9]\d*)$/u.test(params.expiry)) invalid('pairing expiry', 'a Unix timestamp')
  const expiry = Number(params.expiry)
  if (!Number.isSafeInteger(expiry) || expiry < Date.now() / 1_000) {
    invalid('pairing expiry', 'an unexpired Unix timestamp')
  }
  if (params.sig !== undefined) {
    const signature = requireBoundedString(params.sig, 'pairing signature', 1, 128)
    const decoded = base64urlToBytes(signature)
    if (decoded.length < 1 || decoded.length > 80)
      invalid('pairing signature', 'a bounded signature')
  }
  return params
}

export function parseWireEnvelope(value: unknown, topic: string): WireEnvelope {
  const envelope = requirePlainRecord(value, 'wire envelope')
  if (
    Object.keys(envelope).some(
      key => key !== 'topic' && key !== 'ciphertext' && key !== 'mobileIdentityKey'
    )
  ) {
    invalid('wire envelope', 'an exact protocol object')
  }
  if (envelope.topic !== topic) invalid('wire envelope topic', 'the connected session topic')
  const ciphertext = requireBoundedString(
    envelope.ciphertext,
    'wire envelope ciphertext',
    1,
    MAX_WIRE_PAYLOAD_BYTES
  )
  base64urlToBytes(ciphertext)
  const mobileIdentityKey =
    envelope.mobileIdentityKey === undefined
      ? undefined
      : requirePublicKey(envelope.mobileIdentityKey, 'wire envelope mobile identity key')
  return { topic, ciphertext, ...(mobileIdentityKey === undefined ? {} : { mobileIdentityKey }) }
}

export function parseRpcMessage(value: unknown): RpcRequest | RpcResponse {
  const message = requirePlainRecord(value, 'RPC message')
  const id = requireRpcId(message.id)
  const seq = requireSafeSequence(message.seq)
  if (typeof message.method === 'string') {
    if (
      Object.keys(message).some(
        key => key !== 'id' && key !== 'seq' && key !== 'method' && key !== 'params'
      )
    )
      invalid('RPC request', 'an exact protocol object')
    const method = requireBoundedString(message.method, 'RPC method', 1, 100)
    return { id, seq, method, params: message.params }
  }
  const hasResult = Object.prototype.hasOwnProperty.call(message, 'result')
  const hasError = Object.prototype.hasOwnProperty.call(message, 'error')
  if (hasResult === hasError) invalid('RPC response', 'exactly one result or error')
  const payloadKey = hasError ? 'error' : 'result'
  if (Object.keys(message).some(key => key !== 'id' && key !== 'seq' && key !== payloadKey))
    invalid('RPC response', 'an exact protocol object')
  if (hasError) {
    const error = requirePlainRecord(message.error, 'RPC response error')
    if (Object.keys(error).some(key => key !== 'code' && key !== 'message')) {
      invalid('RPC response error', 'an exact code/message object')
    }
    if (
      !Number.isSafeInteger(error.code) ||
      (error.code as number) < -0x80000000 ||
      (error.code as number) > 0x7fffffff
    ) {
      invalid('RPC response error code', 'a signed 32-bit integer')
    }
    const text = requireBoundedString(error.message, 'RPC response error message', 1, 1_000)
    return { id, seq, error: { code: error.code as number, message: text } }
  }
  return { id, seq, result: message.result }
}

export function validateSessionInfo(
  value: unknown,
  options: {
    expectedId?: string
    requireCreationSecrets?: boolean
    canonicalId?: boolean
  } & TransportPolicy = {}
): SessionInfo {
  const record = requirePlainRecord(value, 'session response')
  const sessionId =
    options.canonicalId === false
      ? requirePairingTopic(record.sessionId, 'session response sessionId')
      : requireSessionId(record.sessionId, 'session response sessionId')
  if (options.expectedId !== undefined && sessionId !== options.expectedId) {
    invalid('session response sessionId', 'the requested session')
  }
  if (!sessionStatuses.has(record.status as SessionStatus)) {
    invalid('session response status', 'a supported session status')
  }
  const status = record.status as SessionStatus
  const result: SessionInfo = { sessionId, status }
  if (record.relay !== undefined) {
    // Forward the whole policy so developerHint is not dropped.
    result.relay = normalizeRelayUrl(record.relay, 'relay URL', options)
  }
  if (record.backendIdentityKey !== undefined) {
    result.backendIdentityKey = requirePublicKey(
      record.backendIdentityKey,
      'session response backendIdentityKey'
    )
  }
  if (record.qrDataUrl !== undefined) {
    result.qrDataUrl = requireQrDataUrl(record.qrDataUrl, 'session QR data URL')
  }
  if (record.pairingUri !== undefined) {
    result.pairingUri = requirePairingUri(record.pairingUri, 'session pairing URI')
  }
  if (record.desktopToken !== undefined) {
    result.desktopToken = requireDesktopToken(record.desktopToken)
  }
  if (
    options.requireCreationSecrets &&
    (result.desktopToken === undefined || result.pairingUri === undefined)
  ) {
    invalid('session creation response', 'a desktop token and pairing URI')
  }
  return result
}

async function readBoundedText(
  response: Response,
  context: string,
  maximum: number
): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(declared) || Number(declared) > maximum) {
      throw new Error(`${context} exceeded the ${maximum}-byte limit`)
    }
  }
  const reader = response.body?.getReader()
  if (reader == null) {
    // React Native fetch implementations do not always expose a ReadableStream.
    // Without streaming, a bounded Content-Length is the only pre-allocation
    // signal available; verify the actual buffer length again after reading.
    if (declared === null) {
      throw new Error(`${context} could not be read within the ${maximum}-byte limit`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > maximum) {
      throw new Error(`${context} exceeded the ${maximum}-byte limit`)
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error(`${context} was not valid UTF-8`)
    }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maximum) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`${context} exceeded the ${maximum}-byte limit`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${context} was not valid UTF-8`)
  }
}

export async function fetchBoundedJson(
  input: string,
  init: RequestInit,
  context: string,
  options: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<{ response: Response; value: unknown }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    invalid(`${context} timeout`, 'an integer from 1 to 120000 ms')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(input, { ...init, redirect: 'error', signal: controller.signal })
    const text = await readBoundedText(
      response,
      context,
      options.maxBytes ?? MAX_HTTP_RESPONSE_BYTES
    )
    if (text === '') return { response, value: null }
    try {
      return { response, value: JSON.parse(text) }
    } catch {
      throw new Error(`${context} was not valid JSON`)
    }
  } finally {
    clearTimeout(timer)
  }
}

export function encodedWireSize(value: unknown): number {
  return textEncoder.encode(stringifyBRC100(value)).length
}
