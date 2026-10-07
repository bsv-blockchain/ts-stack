import PublicKey from '../primitives/PublicKey.js'
import PrivateKey from '../primitives/PrivateKey.js'
import { sha256 } from '../primitives/Hash.js'
import { toArray, toBase64, toHex } from '../primitives/utils.js'
import * as SignedMessage from '../messages/SignedMessage.js'
import { outputAssert, OutputProtocolError } from './OutputProtocolError.js'
import {
  canonicalOutputJSON,
  isOutputPlainObject,
  OUTPUT_JSON_LIMITS,
  type OutputJSONObject
} from './OutputProtocolJSON.js'

export type OutputHex32 = ReturnType<typeof outputHex32>
export type OutputIdentity = ReturnType<typeof outputIdentity>
export type OutputBytes = ReturnType<typeof toBase64>
export type OutputU64 = ReturnType<bigint['toString']>
export type OutputU32 = ReturnType<typeof outputU32>

export interface OutputChain {
  network: string
  genesisHash: OutputHex32
}
export interface OutputOutpoint {
  chain: OutputChain
  txid: OutputHex32
  outputIndex: OutputU32
}
export interface OutputPartition {
  application: string
  account: string
  access: string
}
export interface OutputScope {
  chain: OutputChain
  provider: string
  service: string
  queryDigest: OutputHex32
  rulesDigest: OutputHex32
  access: string
  epoch: string
}
export interface OutputEvidence {
  txid: OutputHex32
  outputIndex: OutputU32
  beef: OutputBytes
}
export interface OutputExtensions {
  extensions?: OutputJSONObject
  critical?: string[]
}
export interface OutputSignedPacket<T> {
  body: T
  signature: OutputBytes
}

/** Registered digest domains. New protocols must register a distinct domain. */
export const OUTPUT_DIGEST_DOMAINS = Object.freeze([
  'capabilities',
  'lookup-query',
  'service-rules',
  'proposal-policy',
  'proposal',
  'private-publication',
  'publication-request',
  'acquisition',
  'acquire-request',
  'wallet-funding',
  'purchase',
  'purchase-request',
  'purchase-terms',
  'potatoes',
  'processor-acceptance',
  'release-evidence',
  'sale-listing',
  'sale-genesis',
  'lch-lookup-settlement',
  'lch-covenant-settlement',
  'root-eviction-request',
  'root-eviction-result',
  'root-eviction-decision',
  'root-advertisement',
  'transaction-fact',
  'assessment',
  'knowledge-mutation'
] as const)
export type OutputDigestDomain = (typeof OUTPUT_DIGEST_DOMAINS)[number]

const utf8 = new TextEncoder()
const maximumU64 = 18446744073709551615n
// Only immutable mathematical facts are retained. No packet body, signature,
// private material, authorization, expiry or chain-currentness verdict is held.
// A hostile stream cannot grow these process-local caches without bound.
const mathematicalCacheEntries = 256
const curvePoints = new Set<string>()
const packetSignatures = new Set<string>()
function rememberMathematicalFact(cache: Set<string>, key: string): void {
  if (cache.size >= mathematicalCacheEntries) cache.delete(cache.values().next().value!)
  cache.add(key)
}

export function outputU64(value: unknown): bigint {
  outputAssert(
    typeof value === 'string' && value.length <= 20 && /^(0|[1-9]\d*)$/.test(value),
    'Expected canonical U64'
  )
  const integer = BigInt(value)
  outputAssert(integer <= maximumU64, 'U64 overflow')
  return integer
}

export function incrementOutputU64(value: OutputU64): OutputU64 {
  const integer = outputU64(value)
  outputAssert(integer < maximumU64, 'U64 revision exhausted; explicit reset required', 'limited')
  return (integer + 1n).toString()
}

export function outputU32(value: unknown): number {
  outputAssert(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
    'Expected U32'
  )
  return value
}

export function outputHex32(value: unknown): string {
  outputAssert(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'Expected Hex32')
  return value
}

export function outputString(value: unknown): string {
  outputAssert(
    typeof value === 'string' && value.length > 0 && value.length <= 1024,
    'Expected bounded string'
  )
  // Canonicalization also rejects unpaired surrogates before encoding.
  canonicalOutputJSON(value)
  outputAssert(utf8.encode(value).length <= 1024, 'String exceeds 1024 UTF-8 bytes')
  return value
}

export function outputIdentity(value: unknown): string {
  outputAssert(
    typeof value === 'string' && /^(02|03)[0-9a-f]{64}$/.test(value),
    'Expected compressed identity'
  )
  if (curvePoints.has(value)) return value
  outputAssert(
    BigInt('0x' + value.slice(2)) <
      0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn,
    'Identity coordinate outside field'
  )
  try {
    const key = PublicKey.fromString(value)
    outputAssert(key.validate() && key.toString() === value, 'Identity is not a curve point')
  } catch {
    throw new OutputProtocolError('invalid', 'Invalid identity curve point')
  }
  rememberMathematicalFact(curvePoints, value)
  return value
}

/** Decode canonical standard base64, charging the allocation before decoding. */
export function decodeOutputBytes(
  value: unknown,
  maximumBytes = OUTPUT_JSON_LIMITS.bytes
): number[] {
  outputAssert(
    Number.isSafeInteger(maximumBytes) &&
      maximumBytes >= 0 &&
      maximumBytes <= OUTPUT_JSON_LIMITS.bytes,
    'Invalid byte limit'
  )
  outputAssert(typeof value === 'string', 'Expected base64 bytes')
  outputAssert(value.length <= 4 * Math.ceil(maximumBytes / 3), 'Decoded byte limit', 'limited')
  outputAssert(
    value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
    'Noncanonical base64'
  )
  const decoded: number[] = toArray(value, 'base64')
  outputAssert(decoded.length <= maximumBytes, 'Decoded byte limit', 'limited')
  outputAssert(toBase64(decoded) === value, 'Nonzero base64 padding bits')
  return decoded
}

/** Validate one closed object. Call this for each nested protocol object too. */
export function closedOutputObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): asserts value is Record<string, unknown> {
  outputAssert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected object'
  )
  outputAssert(isOutputPlainObject(value), 'Expected plain object')
  outputAssert(Object.getOwnPropertySymbols(value).length === 0, 'Unexpected symbol key')
  // Retain one captured schema snapshot with indexed SameValueZero membership.
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.hasOwn(value, key)) outputAssert(false, `Missing ${key}`)
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) outputAssert(false, `Unknown ${key}`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    outputAssert(
      descriptor?.enumerable && 'value' in descriptor,
      'Accessor or hidden protocol field'
    )
  }
}

export function validateOutputExtensions(
  value: OutputExtensions,
  supported: readonly string[] = []
): void {
  if (value.extensions !== undefined) {
    outputAssert(
      value.extensions !== null &&
        typeof value.extensions === 'object' &&
        !Array.isArray(value.extensions),
      'Invalid extensions'
    )
    outputAssert(Object.keys(value.extensions).length <= 32, 'Extension limit', 'limited')
    canonicalOutputJSON(value.extensions)
    for (const iri of Object.keys(value.extensions)) {
      outputString(iri)
      outputAssert(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(iri), 'Expected absolute extension IRI')
    }
  }
  validateCriticalExtensions(value, supported, value.critical)
}

function validateCriticalExtensions(
  value: OutputExtensions,
  supported: readonly string[],
  critical: unknown = []
): void {
  outputAssert(Array.isArray(critical) && critical.length <= 32, 'Invalid critical extensions')
  outputAssert(new Set(critical).size === critical.length, 'Duplicate critical extension')
  for (const iri of critical) {
    outputString(iri)
    outputAssert(
      value.extensions !== undefined && Object.hasOwn(value.extensions, iri),
      'Missing critical extension value'
    )
    outputAssert(supported.includes(iri), 'Unsupported critical extension', 'unsupported')
  }
}

function outputPacketPreimageBytes(domain: OutputDigestDomain, body: unknown): Uint8Array {
  outputAssert(
    (OUTPUT_DIGEST_DOMAINS as readonly string[]).includes(domain),
    'Unregistered output digest domain',
    'unsupported'
  )
  const prefix = utf8.encode(`BRC-OUTPUT/1/${domain}\0`)
  const payload = utf8.encode(canonicalOutputJSON(body))
  const preimage = new Uint8Array(prefix.length + payload.length)
  preimage.set(prefix)
  preimage.set(payload, prefix.length)
  return preimage
}

export function outputPacketPreimage(domain: OutputDigestDomain, body: unknown): number[] {
  return Array.from(outputPacketPreimageBytes(domain, body))
}

export function outputPacketDigest(domain: OutputDigestDomain, body: unknown): OutputHex32 {
  // Hash the freshly validated owned bytes without a number-array round trip.
  return toHex(sha256(outputPacketPreimageBytes(domain, body)))
}

/** Signing is an explicit caller action, never a side effect of ingestion. */
export function signOutputPacket<T>(
  domain: OutputDigestDomain,
  body: T,
  signer: PrivateKey
): OutputSignedPacket<T> {
  // Snapshot the body so a caller cannot mutate it after its signature was made.
  const snapshot = JSON.parse(canonicalOutputJSON(body)) as T
  return {
    body: snapshot,
    signature: toBase64(SignedMessage.sign(outputPacketPreimage(domain, snapshot), signer))
  }
}

/**
 * Verify an anyone-verifiable BRC-77 packet against a separately selected signer.
 * The caller must validate the body schema, expiry and authorization for its role.
 */
export function verifyOutputPacket<T>(
  domain: OutputDigestDomain,
  packet: OutputSignedPacket<T>,
  expectedSigner: OutputIdentity
): boolean {
  outputIdentity(expectedSigner)
  closedOutputObject(packet, ['body', 'signature'])
  const signature = decodeOutputBytes(packet.signature, 174)
  outputAssert(signature[37] === 0, 'Output packets require the anyone verifier')
  outputAssert(
    toHex(signature.slice(4, 37)) === expectedSigner,
    'Unexpected packet signer',
    'unauthorized'
  )
  try {
    // Canonicalization and every representation/signer check still run on a
    // repeated packet. The domain-separated preimage and complete signature
    // both participate in this key; only successful BRC77 mathematics is cached.
    const preimage = outputPacketPreimageBytes(domain, packet.body),
      key = toHex(sha256(preimage)) + ':' + toHex(sha256(signature))
    if (packetSignatures.has(key)) return true
    const verified = SignedMessage.verify(Array.from(preimage), signature)
    if (verified) rememberMathematicalFact(packetSignatures, key)
    return verified
  } catch (error) {
    if (error instanceof OutputProtocolError) throw error
    throw new OutputProtocolError('invalid', 'Malformed BRC-77 output packet')
  }
}
