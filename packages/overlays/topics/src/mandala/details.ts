// Mandala admin action details (spec §3.3) and the deploy / authority payloads
// (§3.2), all read through the strict CBOR subset (§3.5). Details travel
// off-chain; the committed authority output carries only SHA-256 of their bytes.
//
// Every `detail` string here ends up in a reason string, which the Go overlay
// copies byte for byte. Codec failures pass the StrictCborError message
// through, as layer A does with the token-output codec's messages.
import { PublicKey } from '@bsv/sdk'
import { sha256 } from '@bsv/sdk/primitives/Hash'
import { toArray, toHex } from '@bsv/sdk/primitives/utils'
import {
  StrictCborError,
  decodeStrictCbor,
  encodeStrictCbor,
  tryDecodeStrictCbor
} from '@bsv/templates'
import type { StrictCborMap, StrictCborValue } from '@bsv/templates'
import { Reasons } from './reject.js'
import type { MandalaReject } from './reject.js'

export type AdminKind =
  | 'issue'
  | 'redeem'
  | 'reissue'
  | 'pause'
  | 'unpause'
  | 'blockIdentity'
  | 'unblockIdentity'
  | 'allowIdentity'
  | 'unallowIdentity'
  | 'setAccessMode'
  | 'freezeOutput'
  | 'unfreezeOutput'
  | 'setFeeRate'
export type RegistryKind = 'admitIdentity' | 'revokeIdentity'

export const ADMIN_KINDS: readonly AdminKind[] = [
  'issue',
  'redeem',
  'reissue',
  'pause',
  'unpause',
  'blockIdentity',
  'unblockIdentity',
  'allowIdentity',
  'unallowIdentity',
  'setAccessMode',
  'freezeOutput',
  'unfreezeOutput',
  'setFeeRate'
]
export const REGISTRY_KINDS: readonly RegistryKind[] = ['admitIdentity', 'revokeIdentity']

export interface AdminDetails {
  kind: AdminKind | RegistryKind
  /** 32 bytes. */
  bankRef?: number[]
  /** `<display txid>.<vout>`. */
  outpoint?: string
  /** Compressed public key, lowercase hex. */
  recipient?: string
  /** Compressed public key, lowercase hex. */
  identityKey?: string
  mode?: 'denylist' | 'allowlist'
  feeRatePerKb?: number | null
  reason?: string
}

type Field = Exclude<keyof AdminDetails, 'kind'>
type FieldValue = AdminDetails[Field]

interface KindSchema {
  required: readonly Field[]
  optional: readonly Field[]
}

const NO_KEYS: KindSchema = { required: [], optional: [] }
const IDENTITY: KindSchema = { required: ['identityKey'], optional: [] }
const OUTPOINT: KindSchema = { required: ['outpoint'], optional: [] }

// Keys per kind (§3.3). Every kind also accepts `reason`, read last.
const SCHEMAS: Readonly<Record<AdminKind | RegistryKind, KindSchema>> = {
  issue: { required: [], optional: ['bankRef'] },
  redeem: NO_KEYS,
  reissue: { required: ['outpoint', 'recipient'], optional: [] },
  pause: NO_KEYS,
  unpause: NO_KEYS,
  blockIdentity: IDENTITY,
  unblockIdentity: IDENTITY,
  allowIdentity: IDENTITY,
  unallowIdentity: IDENTITY,
  setAccessMode: { required: ['mode'], optional: [] },
  freezeOutput: OUTPOINT,
  unfreezeOutput: OUTPOINT,
  setFeeRate: { required: ['feeRatePerKb'], optional: [] },
  admitIdentity: IDENTITY,
  revokeIdentity: IDENTITY
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const TXID_BYTES = 32
const BANK_REF_BYTES = 32
const OUTPOINT_BYTES = 36
const KEY_BYTES = 33
const ADM_BYTES = 32
const LOWERCASE_HEX = /^([0-9a-f]{2})+$/
const OUTPOINT_TEXT = /^([0-9a-f]{64})\.(0|[1-9]\d{0,9})$/
const MAX_VOUT = 0xffffffff
const utf8 = new TextEncoder()

// ---- field readers: decoded value, or undefined when the value is invalid ----

const readBytes = (value: StrictCborValue, length: number): Uint8Array | undefined =>
  value instanceof Uint8Array && value.length === length ? value : undefined

const readBankRef = (value: StrictCborValue): number[] | undefined => {
  const bytes = readBytes(value, BANK_REF_BYTES)
  return bytes === undefined ? undefined : Array.from(bytes)
}

// 36-byte sighash layout: txid in natural order, then the uint32 LE vout.
const readOutpoint = (value: StrictCborValue): string | undefined => {
  const bytes = readBytes(value, OUTPOINT_BYTES)
  if (bytes === undefined) return undefined
  const txid = toHex(Array.from(bytes.subarray(0, TXID_BYTES)).reverse())
  const vout = bytes[32] + bytes[33] * 0x100 + bytes[34] * 0x10000 + bytes[35] * 0x1000000
  return `${txid}.${vout}`
}

// Compressed SEC1 only, and canonical: the SDK reduces x mod p, so x ≥ p would
// otherwise alias a valid key under different bytes.
const readPublicKey = (value: StrictCborValue): string | undefined => {
  const bytes = readBytes(value, KEY_BYTES)
  if (bytes === undefined) return undefined
  const hex = toHex(Array.from(bytes))
  try {
    return PublicKey.fromDER(Array.from(bytes)).toDER('hex') === hex ? hex : undefined
  } catch {
    return undefined
  }
}

const readMode = (value: StrictCborValue): AdminDetails['mode'] =>
  value === 'denylist' || value === 'allowlist' ? value : undefined

const readFeeRate = (value: StrictCborValue): number | null | undefined => {
  if (value === null) return null
  return typeof value === 'bigint' && value >= 1n && value <= MAX_SAFE ? Number(value) : undefined
}

const readText = (value: StrictCborValue): string | undefined =>
  typeof value === 'string' ? value : undefined

interface FieldSpec {
  read: (value: StrictCborValue) => FieldValue | undefined
  rule: string
}

const FEE_RATE_RULE = 'feeRatePerKb must be a safe integer >= 1 or null'

const FIELDS: Readonly<Record<Field, FieldSpec>> = {
  bankRef: { read: readBankRef, rule: 'bankRef must be 32 bytes' },
  outpoint: { read: readOutpoint, rule: 'outpoint must be 36 bytes' },
  recipient: { read: readPublicKey, rule: 'recipient must be a 33-byte compressed public key' },
  identityKey: {
    read: readPublicKey,
    rule: 'identityKey must be a 33-byte compressed public key'
  },
  mode: { read: readMode, rule: 'mode must be denylist or allowlist' },
  feeRatePerKb: { read: readFeeRate, rule: FEE_RATE_RULE },
  reason: { read: readText, rule: 'reason must be text' }
}

// ---- shared helpers ----

type Fail = (detail: string) => MandalaReject

const decodeMap = (bytes: readonly number[], fail: Fail): StrictCborMap => {
  try {
    return decodeStrictCbor(bytes)
  } catch (e) {
    throw e instanceof StrictCborError ? fail(e.message) : e
  }
}

// Strict CBOR orders text keys by encoded bytes: shorter UTF-8 first, then
// bytewise. A fixed-width length prefix makes that a plain string comparison.
const cborKeyRank = (key: string): string => {
  const bytes = Array.from(utf8.encode(key))
  return `${bytes.length.toString(16).padStart(4, '0')}${toHex(bytes)}`
}

const firstInCborOrder = (keys: readonly string[]): string | undefined => {
  const ranked = keys.map(key => ({ key, rank: cborKeyRank(key) }))
  ranked.sort((a, b) => (a.rank < b.rank ? -1 : 1))
  return ranked[0]?.key
}

// ---- admin details ----

function readKind(
  map: StrictCborMap,
  allowed: readonly string[],
  fail: Fail
): AdminDetails['kind'] {
  const { kind } = map
  if (kind === undefined) throw fail('missing key kind')
  if (typeof kind !== 'string') throw fail('kind must be text')
  if (!allowed.includes(kind) || !Object.hasOwn(SCHEMAS, kind)) {
    throw fail(`kind ${kind} is not allowed`)
  }
  return kind as AdminDetails['kind']
}

const keysOf = (schema: KindSchema): Field[] => [...schema.required, ...schema.optional, 'reason']

function rejectUnknownKeys(map: StrictCborMap, schema: KindSchema, fail: Fail): void {
  const known = new Set<string>(['kind', ...keysOf(schema)])
  const unknown = firstInCborOrder(Object.keys(map).filter(key => !known.has(key)))
  if (unknown !== undefined) throw fail(`unknown key ${unknown}`)
}

function readField(field: Field, value: StrictCborValue, fail: Fail): FieldValue {
  const decoded = FIELDS[field].read(value)
  if (decoded === undefined) throw fail(FIELDS[field].rule)
  return decoded
}

function readFields(
  map: StrictCborMap,
  schema: KindSchema,
  fail: Fail
): Omit<AdminDetails, 'kind'> {
  const fields: Partial<Record<Field, FieldValue>> = {}
  for (const field of keysOf(schema)) {
    const value = map[field]
    if (value !== undefined) fields[field] = readField(field, value, fail)
    else if (schema.required.includes(field)) throw fail(`missing key ${field}`)
  }
  return fields as Omit<AdminDetails, 'kind'>
}

/**
 * Reads admin details against §3.3. Checks run in a fixed order so both
 * engines report the same reason: bytes, kind, unknown keys (first in CBOR key
 * order), then each key of the kind (required, optional, `reason`).
 */
export function decodeAdminDetails(
  detailsHex: string,
  allowed: readonly string[],
  outputIndex: number
): { details: AdminDetails; commitment: number[] } {
  const fail: Fail = detail => Reasons.detailsSchema(outputIndex, detail)
  if (!LOWERCASE_HEX.test(detailsHex)) throw fail('details must be lowercase hex')
  const bytes = toArray(detailsHex, 'hex')
  const map = decodeMap(bytes, fail)
  const kind = readKind(map, allowed, fail)
  const schema = SCHEMAS[kind]
  rejectUnknownKeys(map, schema, fail)
  const details: AdminDetails = { kind, ...readFields(map, schema, fail) }
  return { details, commitment: sha256(bytes) }
}

const ifPresent = <T, R>(value: T | undefined, map: (v: T) => R): R | undefined =>
  value === undefined ? undefined : map(value)

const outpointBytes = (outpoint: string): Uint8Array => {
  const match = OUTPOINT_TEXT.exec(outpoint)
  const vout = match === null ? Number.NaN : Number(match[2])
  if (match === null || vout > MAX_VOUT) {
    throw new Error('outpoint must be <64 lowercase hex txid>.<vout 0..4294967295>')
  }
  const txid = toArray(match[1], 'hex').reverse()
  return Uint8Array.from([
    ...txid,
    vout & 0xff,
    (vout >>> 8) & 0xff,
    (vout >>> 16) & 0xff,
    vout >>> 24
  ])
}

const keyBytes = (hex: string): Uint8Array => Uint8Array.from(toArray(hex, 'hex'))

/** Strict CBOR bytes for `d`, binary fields per §3.3; absent keys left out, no schema check. */
export function encodeAdminDetails(d: AdminDetails): number[] {
  const entries: Record<string, StrictCborValue | number | undefined> = {
    kind: d.kind,
    bankRef: ifPresent(d.bankRef, bytes => Uint8Array.from(bytes)),
    outpoint: ifPresent(d.outpoint, outpointBytes),
    recipient: ifPresent(d.recipient, keyBytes),
    identityKey: ifPresent(d.identityKey, keyBytes),
    mode: d.mode,
    feeRatePerKb: d.feeRatePerKb,
    reason: d.reason
  }
  const present = Object.entries(entries).filter(
    (entry): entry is [string, StrictCborValue | number] => entry[1] !== undefined
  )
  return encodeStrictCbor(Object.fromEntries(present))
}

// ---- deploy and authority payloads (§3.2) ----

// Length in Unicode code points (Go: utf8.RuneCountInString).
const readLabel = (value: StrictCborValue, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const length = [...value].length
  return length >= 1 && length <= max ? value : undefined
}

const readDecimals = (value: StrictCborValue): number | undefined =>
  typeof value === 'bigint' && value <= 18n ? Number(value) : undefined

function requireKey<T>(
  map: StrictCborMap,
  key: string,
  read: (value: StrictCborValue) => T | undefined,
  rule: string
): T {
  const value = map[key]
  if (value === undefined) throw Reasons.deployPayload(`missing key ${key}`)
  const decoded = read(value)
  if (decoded === undefined) throw Reasons.deployPayload(rule)
  return decoded
}

/**
 * The deploy payload `{sym, dec, label, feeRatePerKb?}`. Unknown keys are
 * ignored (BRC-162); a missing, non-canonically pushed or non-strict payload,
 * or a bad value, refuses the deploy. Keys are checked in that order.
 */
export function deployMetadata(
  payload: number[] | undefined,
  payloadCanonical: boolean
): { sym: string; dec: number; label: string; feeRatePerKb: number | null } {
  if (payload === undefined) throw Reasons.deployPayload('missing payload')
  if (!payloadCanonical) throw Reasons.deployPayload('non-canonical payload push')
  const map = decodeMap(payload, Reasons.deployPayload)
  const sym = requireKey(map, 'sym', v => readLabel(v, 32), 'sym must be text of 1-32 characters')
  const dec = requireKey(map, 'dec', readDecimals, 'dec must be an integer 0-18')
  const label = requireKey(
    map,
    'label',
    v => readLabel(v, 64),
    'label must be text of 1-64 characters'
  )
  const feeRatePerKb = readFeeRate(map.feeRatePerKb ?? null)
  if (feeRatePerKb === undefined) throw Reasons.deployPayload(FEE_RATE_RULE)
  return { sym, dec, label, feeRatePerKb }
}

/** The commitment in an authority payload `{adm: bytes(32)}` (other keys ignored), or undefined. */
export function commitmentOf(
  payload: number[] | undefined,
  payloadCanonical: boolean
): number[] | undefined {
  if (payload === undefined || !payloadCanonical) return undefined
  const adm = tryDecodeStrictCbor(payload)?.adm
  return adm instanceof Uint8Array && adm.length === ADM_BYTES ? Array.from(adm) : undefined
}
