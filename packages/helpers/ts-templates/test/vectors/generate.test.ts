// Package-local BRC-162 conformance vectors (Mandala spec §8.3), generated from
// the package code. The Go overlay reads brc162.json, so a changed byte here is
// a cross-engine change.
//
//   REGENERATE_VECTORS=1 pnpm --filter @bsv/templates test test/vectors/generate.test.ts
//
// regenerates the file; a plain run is the --check mode and fails when the file
// differs from what the code produces now.
//
// Every key in the file is derived from a fixed scalar, so each one is a real
// compressed secp256k1 point (a Go port that validates points must accept all of
// them), and the deploySig signatures are deterministic (RFC 6979).
//
// Every strictCbor reject row carries the decoder's `error`. The Mandala overlay
// copies that message into its deployPayload / detailsSchema reasons, so the
// message and the order the checks run in are both part of the contract. For
// each header the decoder checks: additional info (indefinite, reserved), then
// minimality (a float or simple value with a too-small argument is
// 'non-minimal header'), then the major type; a length or count is compared with
// the TOTAL input length ('length exceeds input') before any byte is read
// ('truncated input'); a map's count is checked before its depth; and for each
// key: its header, that it is text, its UTF-8, then its order. Key rules apply to
// nested maps exactly as to the top level, and a 64-bit length is bounded before
// it is ever converted to a machine integer.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LockingScript, PrivateKey, ProtoWallet, PublicKey } from '@bsv/sdk'
import { sha256 } from '@bsv/sdk/primitives/Hash'
import {
  BSV21_MAX_AMOUNT,
  Bsv21Binary,
  Bsv21BinaryError,
  decodeAmountChunk,
  decodeStrictCbor,
  encodeAmountChunk,
  encodeStrictCbor,
  isTokenShaped,
  StrictCborError,
  tokenIdToString,
  tryDecodeStrictCbor
} from '../../mod.js'
import type { WalletProtocol } from '@bsv/sdk'
import type { Bsv21Role, StrictCborMap } from '../../mod.js'

const VECTORS_PATH = join(__dirname, 'brc162.json')

const hexOf = (bytes: ArrayLike<number>): string => Buffer.from(bytes).toString('hex')
const bytesOf = (hex: string): number[] => Array.from(Buffer.from(hex.replace(/\s/g, ''), 'hex'))
// Deterministic, position-dependent bytes: a reversed or shifted field never matches.
const patterned = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (seed + i * 7) & 0xff)

const PKH = Array.from({ length: 20 }, (_, i) => i + 1)
const PKH_HEX = hexOf(PKH)
const P2PKH_HEX = `76a914${PKH_HEX}88ac`
const TXID = 'ab'.repeat(31) + 'cd' // display order
const TOKEN_ID = `${TXID}_0`
const TOKEN_ID_WIRE_HEX = 'cd' + 'ab'.repeat(31) // natural order, as pushed on the wire
const TXID_ASCENDING = hexOf(Array.from({ length: 32 }, (_, i) => i))
const TOKEN_ID_ASCENDING = `${TXID_ASCENDING}_0`
const ID_PUSH = `20${TOKEN_ID_WIRE_HEX}`
const OP_2DROP = '6d'
const OP_5 = '55'

// ---- vector shapes ---------------------------------------------------------

interface ScriptVector {
  id: string
  tokenId: string | null
  amount: string
  pubKeyHash: string
  payload: string | null
  scriptHex: string
  role: Bsv21Role
}
interface PayloadPushVector {
  id: string
  scriptHex: string
  payload: string
  payloadCanonical: boolean
}
interface AmountChunkVector {
  id: string
  amount: string
  chunkHex: string
}
interface RejectScriptVector {
  id: string
  scriptHex: string
  tokenShaped: boolean
  error: string
}
interface StrictCborVector {
  id: string
  hex: string
  valid: boolean
  /** The decoder's message; present exactly on reject rows. */
  error?: string
}
interface CommitmentVector {
  id: string
  detailsHex: string
  commitment: string
}
interface DeploySigVector {
  id: string
  txid: string
  digestHex: string
  issuerIdentityKey: string
  protocolID: WalletProtocol
  keyID: string
  counterparty: string
  signatureHex: string
}
interface Brc162Vectors {
  id: string
  version: number
  scripts: ScriptVector[]
  payloadPushes: PayloadPushVector[]
  amountChunks: AmountChunkVector[]
  rejectScripts: RejectScriptVector[]
  strictCbor: StrictCborVector[]
  commitments: CommitmentVector[]
  deploySig: DeploySigVector[]
}

// ---- scripts: every Bsv21Binary.lock shape ---------------------------------

interface ScriptCase {
  id: string
  /** Stated here, not read back from the decoder: the role is part of the contract. */
  role: Bsv21Role
  tokenId: string | null
  amount: bigint
  payload?: Uint8Array | number[]
}

const issueDetails = { kind: 'issue', bankRef: patterned(32, 0x40) }
type Details = Parameters<typeof encodeStrictCbor>[0]
const commitmentOf = (details: Details): number[] => sha256(encodeStrictCbor(details))

// Single-byte and boundary payloads exercise the minimal push opcode of each size.
const payloadPushCases = (): ScriptCase[] => {
  const raw: Array<[string, number[]]> = [
    ['empty', []],
    ['0x01', [0x01]],
    ['0x05', [0x05]],
    ['0x10', [0x10]],
    ['0x81', [0x81]],
    ['0x00', [0x00]],
    ['0x11', [0x11]],
    ['0x80', [0x80]],
    ['75-bytes', [...patterned(75, 1)]],
    ['76-bytes', [...patterned(76, 2)]],
    ['255-bytes', [...patterned(255, 3)]],
    ['256-bytes', [...patterned(256, 4)]]
  ]
  return raw.map(([name, payload]) => ({
    id: `value-payload-${name}`,
    role: 'value' as const,
    tokenId: TOKEN_ID,
    amount: 7n,
    payload
  }))
}

const scriptCases = (): ScriptCase[] => [
  {
    id: 'deploy-authority-empty-payload',
    role: 'deploy',
    tokenId: null,
    amount: 0n,
    payload: [0xa0]
  },
  {
    id: 'deploy-authority-metadata',
    role: 'deploy',
    tokenId: null,
    amount: 0n,
    payload: encodeStrictCbor({ sym: 'USD', dec: 2n, label: 'US Dollar', feeRatePerKb: 1000n })
  },
  {
    id: 'deploy-authority-fee-disabled',
    role: 'deploy',
    tokenId: null,
    amount: 0n,
    payload: encodeStrictCbor({ sym: 'USD', dec: 2n, label: 'US Dollar', feeRatePerKb: null })
  },
  { id: 'deploy-authority-no-payload', role: 'deploy', tokenId: null, amount: 0n },
  { id: 'deploy-fixed-supply-codec-only', role: 'deploy', tokenId: null, amount: 5n },
  { id: 'authority-no-payload', role: 'authority', tokenId: TOKEN_ID, amount: 0n },
  {
    id: 'authority-adm-commitment',
    role: 'authority',
    tokenId: TOKEN_ID,
    amount: 0n,
    payload: encodeStrictCbor({ adm: Uint8Array.from(commitmentOf(issueDetails)) })
  },
  { id: 'authority-ascending-id', role: 'authority', tokenId: TOKEN_ID_ASCENDING, amount: 0n },
  ...[1n, 5n, 16n, 17n, 127n, 128n, 255n, 256n, 5000n].map(amount => ({
    id: `value-amount-${amount}`,
    role: 'value' as const,
    tokenId: TOKEN_ID,
    amount
  })),
  ...[2n ** 53n - 1n, 2n ** 53n, BSV21_MAX_AMOUNT].map(amount => ({
    id: `value-amount-${amount}`,
    role: 'value' as const,
    tokenId: TOKEN_ID,
    amount
  })),
  { id: 'value-ascending-id', role: 'value', tokenId: TOKEN_ID_ASCENDING, amount: 1n },
  {
    id: 'value-payload-strict-cbor-map',
    role: 'value',
    tokenId: TOKEN_ID,
    amount: 7n,
    payload: encodeStrictCbor({ a: 1n })
  },
  ...payloadPushCases()
]

const LOCKER = new Bsv21Binary()

// The declared role goes into the file; the round-trip test checks the decoder agrees.
const buildScript = ({ id, role, tokenId, amount, payload }: ScriptCase): ScriptVector => {
  const payloadBytes = payload === undefined ? undefined : [...payload]
  return {
    id,
    tokenId,
    amount: amount.toString(),
    pubKeyHash: PKH_HEX,
    payload: payloadBytes === undefined ? null : hexOf(payloadBytes),
    scriptHex: LOCKER.lock(tokenId, amount, PKH, payloadBytes).toHex(),
    role
  }
}

// Scripts the encoder never emits but the decoder reads: the payload push is
// recorded as non-canonical, so the output carries no attributes (spec §3.1).
const PAYLOAD_PUSH_CASES: Array<[string, string]> = [
  ['canonical-op-1negate', `00006d4f75${P2PKH_HEX}`],
  ['canonical-op-1-value-1', `00006d5175${P2PKH_HEX}`],
  ['non-canonical-data-push-of-1', `00006d010175${P2PKH_HEX}`],
  ['non-canonical-data-push-of-0x81', `00006d018175${P2PKH_HEX}`],
  ['non-canonical-pushdata1-of-0x05', `00006d4c010575${P2PKH_HEX}`],
  ['non-canonical-pushdata1-empty', `00006d4c0075${P2PKH_HEX}`],
  ['non-canonical-pushdata1-4-bytes', `00006d4c04a161610175${P2PKH_HEX}`],
  ['non-canonical-pushdata2-76-bytes', `00006d4d4c00${'11'.repeat(76)}75${P2PKH_HEX}`],
  ['non-canonical-pushdata4-256-bytes', `00006d4e00010000${'11'.repeat(256)}75${P2PKH_HEX}`],
  ['value-non-canonical-pushdata1', `${ID_PUSH}516d4c010575${P2PKH_HEX}`]
]

const buildPayloadPush = ([id, scriptHex]: [string, string]): PayloadPushVector => {
  const { payload, payloadCanonical } = Bsv21Binary.decode(LockingScript.fromHex(scriptHex))
  return { id, scriptHex, payload: hexOf(payload ?? []), payloadCanonical }
}

// ---- amount chunks ---------------------------------------------------------

// Every width boundary of the minimal little-endian script number, plus the
// small opcodes and the 2^53 policy cap neighbours.
const amountBoundaries = (): bigint[] => {
  const amounts = new Set<bigint>([0n, 1n, 2n, 5n, 16n, 17n, 5000n, 2n ** 53n - 1n, 2n ** 53n])
  for (let bytes = 1n; bytes <= 8n; bytes++) {
    const top = 1n << (8n * bytes - 1n)
    for (const v of [top - 1n, top, top * 2n - 1n, top * 2n]) {
      if (v <= BSV21_MAX_AMOUNT) amounts.add(v)
    }
  }
  return [...amounts].sort((a, b) => Number(a - b))
}

const buildAmountChunk = (amount: bigint): AmountChunkVector => ({
  id: `amount-${amount}`,
  amount: amount.toString(),
  chunkHex: new LockingScript([encodeAmountChunk(amount)]).toHex()
})

// ---- reject scripts --------------------------------------------------------

// The decoder's reasons (Bsv21Binary tests pin the same strings). Each case below
// declares its own, so a case refused for the wrong reason fails the generator.
const NOT_TOKEN = 'not a BRC-162 token output'
const TRUNCATED = 'truncated push'
const BAD_ID = 'token id must be a direct 32-byte push'
const BAD_AMOUNT_PUSH = 'amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes'
const NEGATIVE = 'amount must not be negative'
const NOT_MINIMAL = 'amount is not minimally encoded'
const SMALL_AS_DATA = 'amounts 0..16 must use OP_0/OP_1..OP_16'
const TOO_LARGE = 'amount exceeds 2^64-1'

type RejectCase = [id: string, scriptHex: string, error: string]

// A token output whose amount slot holds `slotHex`.
const withAmountSlot = (slotHex: string): string => `${ID_PUSH}${slotHex}${OP_2DROP}${P2PKH_HEX}`
// A token output whose id slot holds `slotHex` and whose amount is OP_5.
const withIdSlot = (slotHex: string): string => `${slotHex}${OP_5}${OP_2DROP}${P2PKH_HEX}`

const ID_36_BYTES = withIdSlot(`24${'11'.repeat(36)}`)

const AMOUNT_REJECTS: RejectCase[] = [
  ['amount-small-as-data', withAmountSlot('0105'), SMALL_AS_DATA],
  ['amount-16-as-data', withAmountSlot('0110'), SMALL_AS_DATA],
  ['amount-zero-as-data', withAmountSlot('0100'), NOT_MINIMAL],
  ['amount-empty-pushdata1', withAmountSlot('4c00'), BAD_AMOUNT_PUSH],
  ['amount-17-pushdata1', withAmountSlot('4c0111'), BAD_AMOUNT_PUSH],
  ['amount-op-1negate', withAmountSlot('4f'), BAD_AMOUNT_PUSH],
  ['amount-negative', withAmountSlot('0181'), NEGATIVE],
  ['amount-negative-zero', withAmountSlot('0180'), NEGATIVE],
  ['amount-negative-multi-byte', withAmountSlot('021180'), NEGATIVE],
  ['amount-padded', withAmountSlot('021100'), NOT_MINIMAL],
  ['amount-double-padded', withAmountSlot('03ff0000'), NOT_MINIMAL],
  ['amount-above-2-64-1', withAmountSlot('09000000000000000001'), TOO_LARGE],
  ['amount-10-bytes', withAmountSlot('0a01000000000000000000'), BAD_AMOUNT_PUSH]
]

const ID_REJECTS: RejectCase[] = [
  ['id-36-bytes', ID_36_BYTES, BAD_ID],
  ['id-33-bytes', withIdSlot(`21${'11'.repeat(33)}`), BAD_ID],
  ['id-31-bytes', withIdSlot(`1f${'11'.repeat(31)}`), BAD_ID],
  ['id-op-1negate', withIdSlot('4f'), BAD_ID],
  ['id-op-1', withIdSlot('51'), BAD_ID],
  ['id-pushdata1', withIdSlot(`4c20${'11'.repeat(32)}`), BAD_ID],
  ['id-pushdata2', withIdSlot(`4d2000${'11'.repeat(32)}`), BAD_ID]
]

// Truncated pushes anywhere in the script, and the order the checks run in:
// truncation first, then the id, then the amount.
const TRUNCATION_AND_ORDER_REJECTS: RejectCase[] = [
  ['truncated-push-after-deploy-prefix', '00006d4c050102', TRUNCATED],
  ['truncated-push-after-value-prefix', `${ID_PUSH}516d4c050102`, TRUNCATED],
  ['truncated-push-wins-over-bad-id', `${ID_36_BYTES}4c050102`, TRUNCATED],
  ['truncated-push-wins-over-bad-amount', `${withAmountSlot('0105')}4c050102`, TRUNCATED],
  ['id-checked-before-amount', `4f0105${OP_2DROP}${P2PKH_HEX}`, BAD_ID]
]

// Not token-shaped at all: `<push> <push> OP_2DROP` is the layout marker.
const NOT_TOKEN_SHAPED: RejectCase[] = [
  ['plain-p2pkh', P2PKH_HEX, NOT_TOKEN],
  ['empty-script', '', NOT_TOKEN],
  ['two-chunks', '0000', NOT_TOKEN],
  ['third-chunk-op-drop', '000075', NOT_TOKEN],
  ['first-chunk-op-dup', `76006d${P2PKH_HEX}`, NOT_TOKEN],
  ['second-chunk-op-dup', `${ID_PUSH}76${OP_2DROP}${P2PKH_HEX}`, NOT_TOKEN],
  ['second-chunk-op-nop', `0061${OP_2DROP}${P2PKH_HEX}`, NOT_TOKEN],
  ['second-chunk-op-reserved', `0050${OP_2DROP}${P2PKH_HEX}`, NOT_TOKEN]
]

const rejectCases = (): RejectCase[] => [
  ...AMOUNT_REJECTS,
  ...ID_REJECTS,
  ...TRUNCATION_AND_ORDER_REJECTS,
  ...NOT_TOKEN_SHAPED
]

// The reason string is whatever the decoder says; the test compares it with the declared one.
const decodeError = (script: LockingScript): string => {
  let message = ''
  try {
    Bsv21Binary.decode(script)
  } catch (e) {
    message = (e as Error).message
  }
  return message
}

const buildReject = ([id, scriptHex]: RejectCase): RejectScriptVector => {
  const script = LockingScript.fromHex(scriptHex)
  return { id, scriptHex, tokenShaped: isTokenShaped(script), error: decodeError(script) }
}

// ---- strict CBOR -----------------------------------------------------------

// a1 6161 59 <len16> <zeros>: a one-entry map holding a byte string.
const mapWithBytes = (dataLength: number): string =>
  `a1616159${dataLength.toString(16).padStart(4, '0')}${'00'.repeat(dataLength)}`

// The decoder's messages. Each reject case declares its own, so a payload refused
// for the wrong reason (a check run out of order) fails the generator.
const NON_MINIMAL = 'non-minimal header'
const INDEFINITE = 'indefinite length'
const RESERVED = 'reserved additional info'
const SIMPLE = 'simple value or float not allowed'
const majorType = (major: number): string => `major type ${major} not allowed`
const TRUNCATED_INPUT = 'truncated input'
const LENGTH_EXCEEDS = 'length exceeds input'
const TOO_DEEP = 'map nesting deeper than 4'
const KEY_NOT_TEXT = 'map key must be text'
const UNSORTED = 'map keys unsorted or duplicated'
const BAD_UTF8 = 'invalid UTF-8'
const NOT_A_MAP = 'top level must be a map'
const TRAILING = 'trailing bytes'
const INPUT_TOO_LARGE = 'input exceeds 4096 bytes'

// [id, hex, error]: error null is an accepted map. Hex is written out, never
// derived from the encoder, so the verdicts stay an independent statement of
// spec §3.5.
type CborCase = [id: string, hex: string, error: string | null]

const CBOR_ACCEPTS: CborCase[] = [
  ['spec-sym-dec', 'a263646563026373796d63555344', null],
  ['empty-map', 'a0', null],
  ['uint-max-2-64-1', 'a161611bffffffffffffffff', null],
  ['uint-0', 'a1616100', null],
  ['uint-23', 'a1616117', null],
  ['uint-24', 'a16161 1818', null],
  ['uint-255', 'a16161 18ff', null],
  ['uint-256', 'a16161 190100', null],
  ['uint-65535', 'a16161 19ffff', null],
  ['uint-65536', 'a16161 1a00010000', null],
  ['uint-4294967295', 'a16161 1affffffff', null],
  ['uint-4294967296', 'a16161 1b0000000100000000', null],
  ['all-value-kinds', 'a5 6162 420102 6166 f4 616d a1 6178 01 616e f6 6174 f5', null],
  ['depth-4', 'a1 6161 a1 6162 a1 6163 a1 6164 01', null],
  ['keys-length-first', 'a2 6162 01 626161 02', null],
  ['keys-same-length-sorted', 'a2 6161 01 6162 02', null],
  ['key-with-24-bytes', `a1 7818 ${'61'.repeat(24)} 01`, null],
  ['bytes-with-24-bytes', `a1 6161 5818 ${'00'.repeat(24)}`, null],
  ['text-utf8-3-byte', 'a1 6161 63 e282ac', null],
  ['text-utf8-4-byte', 'a1 6161 64 f09f9880', null],
  ['text-utf8-2-byte', 'a1 6161 62 c2a2', null],
  ['text-leading-bom', 'a1 6161 64 efbbbf78', null],
  ['text-utf8-smallest-2-byte', 'a1 6161 62 c280', null],
  ['text-utf8-smallest-3-byte', 'a1 6161 63 e0a080', null],
  ['text-utf8-smallest-4-byte', 'a1 6161 64 f0908080', null],
  ['text-utf8-below-surrogates', 'a1 6161 63 ed9fbf', null],
  ['text-utf8-above-surrogates', 'a1 6161 63 ee8080', null],
  ['text-utf8-max-code-point', 'a1 6161 64 f48fbfbf', null],
  ['key-utf8', 'a1 63e282ac 63e282ac', null],
  ['key-proto', 'a1 695f5f70726f746f5f5f a1 6161 01', null],
  ['nested-keys-length-first', 'a1 6161 a2 6162 01 626161 02', null],
  ['size-limit-4096', mapWithBytes(4090), null]
]

// Values and headers outside the subset.
const CBOR_VALUE_REJECTS: CborCase[] = [
  ['float-1', 'a16161fb3ff0000000000000', SIMPLE],
  ['float16', 'a1 6161 f93c00', SIMPLE],
  ['float32', 'a1 6161 fa3f800000', SIMPLE],
  ['tag-42', 'a1 6161 d82a 4100', majorType(6)],
  ['negative-int', 'a1 6161 20', majorType(1)],
  ['array', 'a1 6161 8101', majorType(4)],
  ['undefined', 'a1 6161 f7', SIMPLE],
  ['simple-32', 'a1 6161 f820', SIMPLE],
  ['simple-20-two-byte-form', 'a1 6161 f814', NON_MINIMAL],
  ['non-minimal-uint', 'a1 6161 1805', NON_MINIMAL],
  ['non-minimal-uint-16-bit', 'a1 6161 190005', NON_MINIMAL],
  ['non-minimal-uint-32-bit', 'a1 6161 1a0000ffff', NON_MINIMAL],
  ['non-minimal-uint-64-bit', 'a1 6161 1b00000000ffffffff', NON_MINIMAL],
  ['non-minimal-length', 'b801 6161 01', NON_MINIMAL],
  ['non-minimal-key-header', 'a1 7801 61 01', NON_MINIMAL],
  ['indefinite-map', 'bf 6161 01 ff', INDEFINITE],
  ['indefinite-text', 'a1 6161 7f6161ff', INDEFINITE],
  ['indefinite-bytes', 'a1 6161 5f4100ff', INDEFINITE],
  ['break-byte-as-value', 'a1 6161 ff', INDEFINITE],
  ['reserved-additional-info', 'a1 6161 1c', RESERVED],
  ['reserved-additional-info-30', 'a1 6161 1e', RESERVED],
  ['top-level-text', '6161', NOT_A_MAP],
  ['top-level-array', '8101', NOT_A_MAP],
  ['empty-input', '', TRUNCATED_INPUT],
  ['trailing-byte', 'a1 6161 01 00', TRAILING],
  ['depth-5', 'a1 6161 a1 6161 a1 6161 a1 6161 a1 6161 01', TOO_DEEP],
  ['truncated-value', 'a1 6161', TRUNCATED_INPUT],
  ['truncated-key', 'a1 61', TRUNCATED_INPUT],
  ['truncated-header', 'a1 6161 19 01', TRUNCATED_INPUT],
  ['size-over-4096', mapWithBytes(4091), INPUT_TOO_LARGE]
]

// Key rules, at the top level and inside a nested map.
const CBOR_KEY_REJECTS: CborCase[] = [
  ['unsorted-keys', 'a2 6162 01 6161 01', UNSORTED],
  ['keys-wrong-length-first-order', 'a2 626161 01 6162 01', UNSORTED],
  ['duplicate-keys', 'a2 6161 01 6161 02', UNSORTED],
  ['integer-key', 'a1 01 01', KEY_NOT_TEXT],
  ['bytes-key', 'a1 4161 01', KEY_NOT_TEXT],
  ['nested-unsorted-keys', 'a1 6161 a2 6162 01 6161 01', UNSORTED],
  ['nested-keys-wrong-length-first-order', 'a1 6161 a2 626161 01 6162 01', UNSORTED],
  ['nested-duplicate-keys', 'a1 6161 a2 6161 01 6161 02', UNSORTED],
  ['nested-integer-key', 'a1 6161 a1 01 01', KEY_NOT_TEXT],
  ['nested-bytes-key', 'a1 6161 a1 4161 01', KEY_NOT_TEXT],
  ['nested-invalid-utf8-key', 'a1 6161 a1 61ff 01', BAD_UTF8]
]

// Lengths and counts: bounded by the whole input before any byte is read, and
// before a 64-bit value is ever narrowed.
const CBOR_LENGTH_REJECTS: CborCase[] = [
  ['byte-string-longer-than-input', 'a1 6161 4a 01', LENGTH_EXCEEDS],
  ['byte-string-longer-than-the-rest', 'a1 6161 44 010203', TRUNCATED_INPUT],
  ['bytes-length-2-64-1', 'a1 6161 5b ffffffffffffffff', LENGTH_EXCEEDS],
  ['text-length-2-64-1', 'a1 6161 7b ffffffffffffffff', LENGTH_EXCEEDS],
  ['key-length-2-64-1', 'a1 7b ffffffffffffffff', LENGTH_EXCEEDS],
  ['map-count-2-64-1', 'bb ffffffffffffffff', LENGTH_EXCEEDS],
  ['nested-map-count-longer-than-input', 'a1 6161 b8ff', LENGTH_EXCEEDS]
]

// UTF-8 (RFC 3629), in values and keys.
const CBOR_UTF8_REJECTS: CborCase[] = [
  ['invalid-utf8', 'a1 6161 61ff', BAD_UTF8],
  ['utf8-overlong-c080', 'a1 6161 62 c080', BAD_UTF8],
  ['utf8-overlong-c1bf', 'a1 6161 62 c1bf', BAD_UTF8],
  ['utf8-overlong-3-byte', 'a1 6161 63 e09fbf', BAD_UTF8],
  ['utf8-overlong-4-byte', 'a1 6161 64 f08fbfbf', BAD_UTF8],
  ['utf8-last-surrogate-edbfbf', 'a1 6161 63 edbfbf', BAD_UTF8],
  ['utf8-lead-f5', 'a1 6161 64 f5808080', BAD_UTF8],
  ['utf8-surrogate-eda080', 'a1 6161 63 eda080', BAD_UTF8],
  ['utf8-above-10ffff', 'a1 6161 64 f4908080', BAD_UTF8],
  ['utf8-truncated-sequence', 'a1 6161 62 e282', BAD_UTF8],
  ['utf8-lone-continuation', 'a1 6161 61 80', BAD_UTF8],
  ['utf8-bad-continuation', 'a1 6161 62 c241', BAD_UTF8],
  ['utf8-five-byte-lead', 'a1 6161 65 f888808080', BAD_UTF8],
  ['utf8-invalid-in-key', 'a1 61ff 01', BAD_UTF8]
]

// Which check wins when one input breaks two rules.
const CBOR_ORDER_REJECTS: CborCase[] = [
  // minimality is checked before the major type
  ['order-minimal-before-float64', 'a16161fb0000000000000000', NON_MINIMAL],
  ['order-minimal-before-float32', 'a16161fa00000000', NON_MINIMAL],
  ['order-minimal-before-float16', 'a16161f90000', NON_MINIMAL],
  ['order-minimal-before-negative-int', 'a161613800', NON_MINIMAL],
  ['order-negative-int-minimal-header', 'a1616138ff', majorType(1)],
  // the map count, then the depth, then the key
  ['order-count-before-depth', 'a1 6161 a1 6162 a1 6163 a1 6164 b8ff', LENGTH_EXCEEDS],
  ['order-depth-before-key', 'a1 6161 a1 6162 a1 6163 a1 6164 a1 4161', TOO_DEEP],
  // a key must be text, and valid UTF-8, before its order is judged
  ['order-key-text-before-key-order', 'a2 6162 01 4161 01', KEY_NOT_TEXT],
  ['order-key-utf8-before-key-order', 'a2 6162 01 61ff 01', BAD_UTF8],
  // the top level is checked to be a map before its trailing bytes
  ['order-top-level-before-trailing', '01 00', NOT_A_MAP]
]

const CBOR_CASES: CborCase[] = [
  ...CBOR_ACCEPTS,
  ...CBOR_VALUE_REJECTS,
  ...CBOR_KEY_REJECTS,
  ...CBOR_LENGTH_REJECTS,
  ...CBOR_UTF8_REJECTS,
  ...CBOR_ORDER_REJECTS
]

// The message is whatever the decoder says; the test compares it with the declared one.
const cborError = (bytes: number[]): string | undefined => {
  try {
    decodeStrictCbor(bytes)
    return undefined
  } catch (e) {
    return (e as Error).message
  }
}

const buildStrictCbor = ([id, hex]: CborCase): StrictCborVector => {
  const compact = hex.replace(/\s/g, '')
  const bytes = bytesOf(compact)
  const valid = tryDecodeStrictCbor(bytes) !== undefined
  const error = cborError(bytes)
  return error === undefined ? { id, hex: compact, valid } : { id, hex: compact, valid, error }
}

// ---- commitments: one details map per §3.3 kind ----------------------------

// Compressed SEC1 public keys (33 bytes), each from its own fixed scalar so that a swapped
// field never matches. A patterned 33-byte string is not a valid point.
const publicKeyOf = (scalar: Uint8Array): Uint8Array =>
  Uint8Array.from(PrivateKey.fromHex(hexOf(scalar)).toPublicKey().toDER() as number[])
const identityKey = publicKeyOf(patterned(32, 0x21))
const recipientKey = publicKeyOf(patterned(32, 0x35))
// 36-byte sighash layout: txid in natural order, then the uint32 LE vout (here 1).
const outpoint = Uint8Array.from([...patterned(32, 0x10), 1, 0, 0, 0])

const DETAILS_CASES: Array<[string, Details]> = [
  ['issue-bankref', issueDetails],
  ['issue-no-bankref', { kind: 'issue' }],
  ['issue-bankref-reason', { kind: 'issue', bankRef: patterned(32, 0x40), reason: 'wire 4711' }],
  ['redeem', { kind: 'redeem' }],
  ['reissue', { kind: 'reissue', outpoint, recipient: recipientKey }],
  ['pause', { kind: 'pause' }],
  ['unpause', { kind: 'unpause', reason: 'incident closed' }],
  ['blockIdentity', { kind: 'blockIdentity', identityKey }],
  ['unblockIdentity', { kind: 'unblockIdentity', identityKey }],
  ['allowIdentity', { kind: 'allowIdentity', identityKey }],
  ['unallowIdentity', { kind: 'unallowIdentity', identityKey }],
  ['setAccessMode-denylist', { kind: 'setAccessMode', mode: 'denylist' }],
  ['setAccessMode-allowlist', { kind: 'setAccessMode', mode: 'allowlist' }],
  ['freezeOutput', { kind: 'freezeOutput', outpoint }],
  ['unfreezeOutput', { kind: 'unfreezeOutput', outpoint }],
  ['setFeeRate', { kind: 'setFeeRate', feeRatePerKb: 1000n }],
  ['setFeeRate-disabled', { kind: 'setFeeRate', feeRatePerKb: null }],
  ['admitIdentity', { kind: 'admitIdentity', identityKey }],
  ['revokeIdentity', { kind: 'revokeIdentity', identityKey }]
]

const buildCommitment = ([id, details]: [string, Details]): CommitmentVector => ({
  id,
  detailsHex: hexOf(encodeStrictCbor(details)),
  commitment: hexOf(commitmentOf(details))
})

// ---- deploySig (spec §5.3) -------------------------------------------------
// The signed data is the UTF-8 bytes of "mandala-deploy:" + txid. The issuer signs it with
// wallet createSignature (protocol [2, 'mandala deploy'], keyID '1', counterparty 'anyone')
// and the overlay verifies it with ProtoWallet('anyone') against the issuer identity key.
// The SDK signs with RFC 6979 and low S, so the bytes are deterministic. A reader only has to
// verify them: it does not need to reproduce this signer's S normalisation.

const DEPLOY_PROTOCOL: WalletProtocol = [2, 'mandala deploy']
const DEPLOY_KEY_ID = '1'
const DEPLOY_COUNTERPARTY = 'anyone'
const DEPLOY_ISSUER = new ProtoWallet(PrivateKey.fromHex(hexOf(patterned(32, 0x49))))

const DEPLOY_TXIDS: Array<[string, string]> = [
  ['digest-1', TXID],
  ['digest-2', TXID_ASCENDING]
]

const deployDigest = (txid: string): number[] => [...Buffer.from(`mandala-deploy:${txid}`, 'utf8')]

const buildDeploySig = async ([id, txid]: [string, string]): Promise<DeploySigVector> => {
  const digest = deployDigest(txid)
  const { publicKey } = await DEPLOY_ISSUER.getPublicKey({ identityKey: true })
  const { signature } = await DEPLOY_ISSUER.createSignature({
    data: digest,
    protocolID: DEPLOY_PROTOCOL,
    keyID: DEPLOY_KEY_ID,
    counterparty: DEPLOY_COUNTERPARTY
  })
  return {
    id,
    txid,
    digestHex: hexOf(digest),
    issuerIdentityKey: publicKey,
    protocolID: DEPLOY_PROTOCOL,
    keyID: DEPLOY_KEY_ID,
    counterparty: DEPLOY_COUNTERPARTY,
    signatureHex: hexOf(signature)
  }
}

// ---- assembly --------------------------------------------------------------

const buildVectors = async (): Promise<Brc162Vectors> => ({
  id: 'mandala.brc162',
  version: 1,
  scripts: scriptCases().map(buildScript),
  payloadPushes: PAYLOAD_PUSH_CASES.map(buildPayloadPush),
  amountChunks: amountBoundaries().map(buildAmountChunk),
  rejectScripts: rejectCases().map(buildReject),
  strictCbor: CBOR_CASES.map(buildStrictCbor),
  commitments: DETAILS_CASES.map(buildCommitment),
  deploySig: await Promise.all(DEPLOY_TXIDS.map(buildDeploySig))
})

const serialize = (vectors: Brc162Vectors): string => `${JSON.stringify(vectors, null, 2)}\n`

// ---- tests -----------------------------------------------------------------

describe('BRC-162 templates vectors', () => {
  let vectors: Brc162Vectors

  beforeAll(async () => {
    vectors = await buildVectors()
    if (process.env.REGENERATE_VECTORS === '1') writeFileSync(VECTORS_PATH, serialize(vectors))
  })

  it('brc162.json is exactly what the package code produces (--check)', () => {
    const text = readFileSync(VECTORS_PATH, 'utf8')
    expect(JSON.parse(text)).toEqual(vectors)
    expect(text).toBe(serialize(vectors))
  })

  it('has enough cases and unique ids per section', () => {
    expect(vectors.scripts.length).toBeGreaterThanOrEqual(20)
    expect(vectors.rejectScripts.length).toBeGreaterThanOrEqual(15)
    expect(vectors.strictCbor.length).toBeGreaterThanOrEqual(25)
    const sections = [
      vectors.scripts,
      vectors.payloadPushes,
      vectors.amountChunks,
      vectors.rejectScripts,
      vectors.strictCbor,
      vectors.commitments,
      vectors.deploySig
    ]
    for (const section of sections) {
      expect(new Set(section.map(v => v.id)).size).toBe(section.length)
    }
  })

  it('every script decodes back to the fields it was built from', () => {
    for (const v of vectors.scripts) {
      const d = Bsv21Binary.decode(LockingScript.fromHex(v.scriptHex))
      expect(d.role).toBe(v.role)
      expect(d.tokenId === undefined ? null : tokenIdToString(d.tokenId)).toBe(v.tokenId)
      expect(d.amount.toString()).toBe(v.amount)
      expect(d.payload === undefined ? null : hexOf(d.payload)).toBe(v.payload)
      expect(d.payloadCanonical).toBe(true)
      expect(hexOf(d.restPubKeyHash ?? [])).toBe(v.pubKeyHash)
    }
  })

  it('covers all three roles', () => {
    expect(new Set(vectors.scripts.map(v => v.role))).toEqual(
      new Set(['deploy', 'authority', 'value'])
    )
  })

  it('records the payload canonicality the decoder reports', () => {
    for (const v of vectors.payloadPushes) {
      expect(v.payloadCanonical).toBe(v.id.startsWith('canonical-'))
    }
    expect(vectors.payloadPushes.filter(v => !v.payloadCanonical)).toHaveLength(8)
  })

  it('amount chunks are the minimal canonical push and round-trip', () => {
    for (const v of vectors.amountChunks) {
      const amount = BigInt(v.amount)
      const [chunk] = LockingScript.fromHex(v.chunkHex).chunks
      expect(decodeAmountChunk(chunk)).toBe(amount)
      expect(hexOf(chunk.data ?? [])).toBe(amount <= 16n ? '' : v.chunkHex.slice(2))
      expect(v.chunkHex).toHaveLength(amount <= 16n ? 2 : (chunk.op + 1) * 2)
      if (amount > 16n) expect(chunk.op).toBe(Math.floor(amount.toString(2).length / 8) + 1)
    }
    expect(vectors.amountChunks[0]).toEqual({ id: 'amount-0', amount: '0', chunkHex: '00' })
    expect(vectors.amountChunks.find(v => v.id === 'amount-17')?.chunkHex).toBe('0111')
    expect(vectors.amountChunks.at(-1)?.amount).toBe(BSV21_MAX_AMOUNT.toString())
  })

  it('every reject script is refused for the reason its case declares', () => {
    expect(vectors.rejectScripts.map(v => [v.id, v.scriptHex, v.error])).toEqual(rejectCases())
    for (const v of vectors.rejectScripts) {
      const script = LockingScript.fromHex(v.scriptHex)
      expect(isTokenShaped(script)).toBe(v.tokenShaped)
      expect(() => Bsv21Binary.decode(script)).toThrow(Bsv21BinaryError)
      expect(() => Bsv21Binary.decode(script)).toThrow(v.error)
    }
  })

  it('the reject vectors exercise every decoder reason and every non-shaped case', () => {
    expect(new Set(vectors.rejectScripts.map(v => v.error))).toEqual(
      new Set([
        NOT_TOKEN,
        TRUNCATED,
        BAD_ID,
        BAD_AMOUNT_PUSH,
        NEGATIVE,
        NOT_MINIMAL,
        SMALL_AS_DATA,
        TOO_LARGE
      ])
    )
    const notShaped = vectors.rejectScripts.filter(v => !v.tokenShaped).map(v => v.id)
    expect(notShaped).toEqual(NOT_TOKEN_SHAPED.map(([id]) => id))
  })

  it('the strict CBOR verdicts match the declared accept/reject set', () => {
    expect(vectors.strictCbor.map(v => v.valid)).toEqual(CBOR_CASES.map(([, , e]) => e === null))
    expect(vectors.strictCbor.find(v => v.id === 'spec-sym-dec')).toEqual({
      id: 'spec-sym-dec',
      hex: 'a263646563026373796d63555344',
      valid: true
    })
    expect(vectors.strictCbor.filter(v => !v.valid).length).toBeGreaterThanOrEqual(25)
  })

  it('every strict CBOR reject carries the message its case declares, and only rejects do', () => {
    expect(vectors.strictCbor.map(v => [v.id, v.error ?? null])).toEqual(
      CBOR_CASES.map(([id, , error]) => [id, error])
    )
    for (const v of vectors.strictCbor) {
      expect('error' in v).toBe(!v.valid)
      if (v.error === undefined) continue
      expect(() => decodeStrictCbor(bytesOf(v.hex))).toThrow(StrictCborError)
      expect(() => decodeStrictCbor(bytesOf(v.hex))).toThrow(v.error)
    }
  })

  it('the strict CBOR rejects exercise every decoder message', () => {
    expect(new Set(vectors.strictCbor.flatMap(v => v.error ?? []))).toEqual(
      new Set([
        NON_MINIMAL,
        INDEFINITE,
        RESERVED,
        SIMPLE,
        majorType(1),
        majorType(4),
        majorType(6),
        TRUNCATED_INPUT,
        LENGTH_EXCEEDS,
        TOO_DEEP,
        KEY_NOT_TEXT,
        UNSORTED,
        BAD_UTF8,
        NOT_A_MAP,
        TRAILING,
        INPUT_TOO_LARGE
      ])
    )
  })

  it('valid strict CBOR re-encodes to identical bytes', () => {
    for (const v of vectors.strictCbor.filter(c => c.valid)) {
      expect(encodeStrictCbor(decodeStrictCbor(bytesOf(v.hex)))).toEqual(bytesOf(v.hex))
    }
  })

  it('encodes {"sym":"USD","dec":2} to the spec bytes', () => {
    expect(hexOf(encodeStrictCbor({ sym: 'USD', dec: 2n }))).toBe('a263646563026373796d63555344')
  })

  it('commitments are SHA-256 of strict details bytes, one map per §3.3 kind', () => {
    const kinds = new Set<string>()
    for (const v of vectors.commitments) {
      const bytes = Buffer.from(v.detailsHex, 'hex')
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(v.commitment)
      const details: StrictCborMap = decodeStrictCbor(bytes)
      expect(hexOf(encodeStrictCbor(details))).toBe(v.detailsHex)
      kinds.add(details.kind as string)
    }
    expect(kinds).toEqual(
      new Set([
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
        'setFeeRate',
        'admitIdentity',
        'revokeIdentity'
      ])
    )
  })

  it('commitment details carry real keys and outpoints (§3.3)', () => {
    const keys: string[] = []
    const outpoints: Uint8Array[] = []
    for (const v of vectors.commitments) {
      const details = decodeStrictCbor(Buffer.from(v.detailsHex, 'hex'))
      for (const field of ['identityKey', 'recipient']) {
        const value = details[field]
        if (value instanceof Uint8Array) keys.push(hexOf(value))
      }
      if (details.outpoint instanceof Uint8Array) outpoints.push(details.outpoint)
    }
    // reissue.recipient plus six identity kinds
    expect(keys).toHaveLength(7)
    for (const key of keys) {
      expect(key).toHaveLength(66)
      // PublicKey.fromString throws 'Invalid point' for an x that is not on the curve
      expect(PublicKey.fromString(key).toString()).toBe(key)
    }
    // reissue, freezeOutput, unfreezeOutput: txid (32) then a uint32 LE vout
    expect(outpoints).toHaveLength(3)
    for (const outpoint of outpoints) {
      expect(outpoint).toHaveLength(36)
      expect(Buffer.from(outpoint).readUInt32LE(32)).toBe(1)
    }
  })

  it('the adm authority payload is {adm: sha256(issue details)}', () => {
    const issue = vectors.commitments.find(v => v.id === 'issue-bankref')
    const authority = vectors.scripts.find(v => v.id === 'authority-adm-commitment')
    // a1 (map of 1) 63 "adm" 58 20 (32 byte string) <commitment>
    expect(authority?.payload).toBe(`a16361646d5820${issue?.commitment}`)
  })

  it('deploySig digests are the UTF-8 bytes of "mandala-deploy:" + txid', () => {
    for (const v of vectors.deploySig) {
      expect(v.txid).toMatch(/^[0-9a-f]{64}$/)
      expect(Buffer.from(v.digestHex, 'hex').toString('utf8')).toBe(`mandala-deploy:${v.txid}`)
    }
    expect(vectors.deploySig).toHaveLength(2)
  })

  describe('deploySig signatures', () => {
    const anyone = new ProtoWallet('anyone')
    // The overlay's check: any throw counts as invalid.
    const verifies = async (
      v: DeploySigVector,
      digestHex: string,
      signatureHex: string,
      key: string
    ) =>
      anyone
        .verifySignature({
          data: [...Buffer.from(digestHex, 'hex')],
          signature: [...Buffer.from(signatureHex, 'hex')],
          protocolID: v.protocolID,
          keyID: v.keyID,
          counterparty: key
        })
        .then(
          r => r.valid,
          () => false
        )

    it('carry the §5.3 parameters and one issuer identity key that is a real point', () => {
      for (const v of vectors.deploySig) {
        expect(v.protocolID).toEqual([2, 'mandala deploy'])
        expect(v.keyID).toBe('1')
        expect(v.counterparty).toBe('anyone')
        expect(PublicKey.fromString(v.issuerIdentityKey).toString()).toBe(v.issuerIdentityKey)
        expect(v.signatureHex).toMatch(/^30[0-9a-f]+$/)
      }
      expect(new Set(vectors.deploySig.map(v => v.issuerIdentityKey)).size).toBe(1)
    })

    it('verify against their own digest and issuer identity key', async () => {
      for (const v of vectors.deploySig) {
        expect(await verifies(v, v.digestHex, v.signatureHex, v.issuerIdentityKey)).toBe(true)
      }
    })

    it('do not verify for another txid, another issuer or a damaged signature', async () => {
      const [a, b] = vectors.deploySig
      const otherIssuer = (
        await new ProtoWallet(PrivateKey.fromHex(hexOf(patterned(32, 0x5d)))).getPublicKey({
          identityKey: true
        })
      ).publicKey
      expect(await verifies(a, b.digestHex, a.signatureHex, a.issuerIdentityKey)).toBe(false)
      expect(await verifies(a, a.digestHex, b.signatureHex, a.issuerIdentityKey)).toBe(false)
      expect(await verifies(a, a.digestHex, a.signatureHex, otherIssuer)).toBe(false)
      expect(await verifies(a, a.digestHex, a.signatureHex.slice(0, -2), a.issuerIdentityKey)).toBe(
        false
      )
      expect(await verifies(a, a.digestHex, 'zz', a.issuerIdentityKey)).toBe(false)
    })

    it('are deterministic: signing again gives the same bytes', async () => {
      const again = await Promise.all(DEPLOY_TXIDS.map(buildDeploySig))
      expect(again).toEqual(vectors.deploySig)
    })
  })
})
