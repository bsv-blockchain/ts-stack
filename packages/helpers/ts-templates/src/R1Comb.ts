/**
 * R1C — the 1-of-N P-256 comb-verifier vault template.
 *
 * A locking script that N (1..5) P-256 keys can each open alone, with no key
 * on the chain: the lock holds salted hash160 commitments to each key's comb
 * table, and the unlock reveals one table, the salt and a P-256 signature that
 * the script verifies in full (fixed-base comb multiplication, complete mixed
 * addition) over an OP_PUSH_TX sighash preimage. Made for hardware keys that
 * sign P-256 only, such as a YubiKey PIV slot.
 *
 * Origin: @bsv/expo-wallet-toolbox `core/services/vault/r1comb.ts` (the Vault
 * of the BSV Wallet app). The script bytes are a consensus contract: every
 * lock and unlock this module builds is byte-identical to that module's, and
 * the vectors in src/__tests/R1Comb.vectors.json, generated from it, keep it
 * so. Only the curve arithmetic differs: @bsv/sdk Secp256r1 in place of
 * @noble/curves.
 *
 * Pure: no I/O. Script numbers are BSV little-endian sign-magnitude, and every
 * constant is emitted minimally.
 *
 * SECURITY: nothing secret passes through this module — public keys, per-output
 * salts, signatures a key already produced, and script bytes.
 */
import { hash160, hash256 } from '@bsv/sdk/primitives/Hash'
import { PrivateKey, Secp256r1, TransactionSignature } from '@bsv/sdk/primitives'
import { Reader, toArray, toHex } from '@bsv/sdk/primitives/utils'
import { LockingScript, OP, Script, Spend, UnlockingScript } from '@bsv/sdk/script'
import type Transaction from '@bsv/sdk/transaction/Transaction'

/** Every refusal of this module. `code` is always `template-invalid`. */
export class R1CombError extends Error {
  readonly code = 'template-invalid' as const
  constructor(message: string) {
    super(message)
    this.name = 'R1CombError'
  }
}

// ───────────────────────── comb geometry and sizes (spec §2) ─────────────────────────
export const COMB_ROWS = 6
export const COMB_COLS = 43
/** Entries per base point = 2^(COMB_ROWS − 1). */
export const TABLE_SIZE = 32
/** OP_NUM2BIN width per coordinate in the canonical (hashed) serialisation. */
export const COORD_WIDTH = 33
export const SALT_BYTES = 32
/** Declared unlockingScriptLength; the measured hard maximum is 2,539 B including the salt. */
export const R1C_UNLOCK_LEN = 2560
export const R1C_MAX_KEYS = 5
/** BIP143 preimage length with subscript `ac` (2 B) and scope 0x41. */
export const R1C_PREIMAGE_LEN = 158
/** SIGHASH_ALL | SIGHASH_FORKID — the only scope the template supports. */
export const R1C_SIGHASH = 0x41

/** Exact hardened lock size for the salt-revealing witness template. */
export function R1C_LOCK_LEN(n: number): number {
  if (n === 1) return 45199
  if (Number.isInteger(n) && n >= 2 && n <= R1C_MAX_KEYS) return 45175 + 25 * n
  throw invalid(`R1C_LOCK_LEN: N must be 1..${R1C_MAX_KEYS}, got ${String(n)}`)
}

// ───────────────────────── curve constants ─────────────────────────
const curve = new Secp256r1()
export const P256_P: bigint = curve.p
export const P256_N: bigint = curve.n
/** Largest canonical low-S P-256 signature scalar. */
export const P256_LOW_S_MAX: bigint = (P256_N - 1n) / 2n
/** secp256k1 group order — the OP_PUSH_TX leg only. */
export const SECP_N: bigint = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
/** secp256k1 generator x — the OP_PUSH_TX signature's r (nonce k = 1). */
export const SECP_GX: bigint = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n
/** Public constants used by the two total OP_PUSH_TX signature branches. */
const PUSH_TX_C1 = 1n << 248n
const PUSH_TX_C2 = PUSH_TX_C1 + 1n
const RECODE_BITS = COMB_ROWS * COMB_COLS // 258 signed digits
/** 2^258 − 1: the recode constant at H2 (ANALYSIS.md §5.2). */
export const RECODE_CONST: bigint = (1n << BigInt(RECODE_BITS)) - 1n

// ───────────────────────── bigint / byte helpers ─────────────────────────
const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m
function modpow(base: bigint, exp: bigint, m: bigint): bigint {
  let r = 1n
  let b = mod(base, m)
  let e = exp
  while (e > 0n) {
    if ((e & 1n) === 1n) r = (r * b) % m
    b = (b * b) % m
    e >>= 1n
  }
  return r
}
/** Inverse modulo a prime. */
const modinv = (a: bigint, m: bigint): bigint => modpow(a, m - 2n, m)
const bytesOf = (h: string): number[] => toArray(h, 'hex') as number[]
const beToBig = (b: number[]): bigint => BigInt('0x' + (b.length > 0 ? toHex(b) : '0'))
const leToBig = (b: number[]): bigint => beToBig([...b].reverse())
function invalid(message: string): R1CombError {
  return new R1CombError(message)
}

// ───────────────────────── script-number encoding ─────────────────────────
/** Raw data push with the minimal push opcode (direct length, PUSHDATA1/2/4). */
export function pushData(data: number[]): number[] {
  const d = [...data]
  if (d.length === 0) return [OP.OP_0]
  if (d.length <= 75) return [d.length, ...d]
  if (d.length <= 0xff) return [OP.OP_PUSHDATA1, d.length, ...d]
  if (d.length <= 0xffff) return [OP.OP_PUSHDATA2, d.length & 0xff, d.length >>> 8, ...d]
  return [
    OP.OP_PUSHDATA4,
    d.length & 0xff,
    (d.length >>> 8) & 0xff,
    (d.length >>> 16) & 0xff,
    (d.length >>> 24) & 0xff,
    ...d
  ]
}

/** Minimal script-number encoding (sign-magnitude little-endian) == BigNumber.toSm('little'). */
export function scriptNum(v: bigint): number[] {
  if (v === 0n) return []
  const neg = v < 0n
  let m = neg ? -v : v
  const b: number[] = []
  while (m > 0n) {
    b.push(Number(m & 0xffn))
    m >>= 8n
  }
  if (((b.at(-1) as number) & 0x80) !== 0) b.push(neg ? 0x80 : 0x00)
  else if (neg) b[b.length - 1] |= 0x80
  return b
}

/** Push a number as a minimally-encoded script number (OP_0, OP_1..OP_16, OP_1NEGATE, or a data push). */
export function encNum(v: bigint | number): number[] {
  const n = BigInt(v)
  if (n === 0n) return [OP.OP_0]
  if (n >= 1n && n <= 16n) return [OP.OP_1 + Number(n) - 1]
  if (n === -1n) return [OP.OP_1NEGATE]
  return pushData(scriptNum(n))
}

// ───────────────────────── tiny assembler ─────────────────────────
// Tokens: OP_NAME | decimal integer (encNum) | <hex> (raw push) | {PARAM} | macro name.
const MACROS: Record<string, string> = {
  // reduce top mod p; p lives on the altstack and is never consumed
  MODP: 'OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_MOD',
  // BSV OP_MOD keeps the dividend's sign: normalise a negative remainder into [0, p)
  NORM: 'OP_DUP 0 OP_LESSTHAN OP_IF OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_ADD OP_ENDIF'
}
export type AsmParam = bigint | number | number[]
const OPCODES = OP as unknown as Record<string, number | undefined>

/** One asm token: macro, {PARAM}, <hex> raw push, decimal number, or opcode name. */
function asmToken(tok: string, params: Record<string, AsmParam>): number[] {
  const macro = MACROS[tok]
  if (macro !== undefined) return asm(macro, params)
  if (tok.startsWith('{') && tok.endsWith('}')) {
    const v = params[tok.slice(1, -1)]
    if (v === undefined) throw invalid(`asm: missing param ${tok}`)
    return typeof v === 'bigint' || typeof v === 'number' ? encNum(v) : pushData(v)
  }
  if (tok.startsWith('<') && tok.endsWith('>')) return pushData(bytesOf(tok.slice(1, -1)))
  if (/^-?\d+$/.test(tok)) return encNum(BigInt(tok))
  const op = OPCODES[tok]
  if (op === undefined) throw invalid(`asm: unknown opcode ${tok}`)
  return [op]
}

export function asm(text: string, params: Record<string, AsmParam> = {}): number[] {
  const out: number[] = []
  for (const tok of text.trim().split(/\s+/)) {
    if (tok !== '') out.push(...asmToken(tok, params))
  }
  return out
}

// ───────────────────────── public keys ─────────────────────────
/**
 * 65-byte SEC1 (04‖X‖Y) or 33-byte compressed hex in → 33-byte compressed lowercase hex out.
 * The card returns the 65-byte form; every comparison in the app uses the compressed form.
 */
export function compressPubkey(sec1Hex: string): string {
  if (typeof sec1Hex !== 'string' || !/^([0-9a-fA-F]{66}|[0-9a-fA-F]{130})$/.test(sec1Hex)) {
    throw invalid('compressPubkey: expected 33- or 65-byte SEC1 hex')
  }
  const lower = sec1Hex.toLowerCase()
  const prefix = lower.slice(0, 2)
  if (lower.length === 66 && prefix !== '02' && prefix !== '03')
    throw invalid('compressPubkey: bad compressed prefix')
  if (lower.length === 130 && prefix !== '04')
    throw invalid('compressPubkey: bad uncompressed prefix')
  // Secp256r1.pointFromHex reduces coordinates mod p, so a coordinate >= p
  // is refused here first: one point has one encoding.
  if (BigInt('0x' + lower.slice(2, 66)) >= P256_P)
    throw invalid('compressPubkey: not a valid P-256 point')
  if (lower.length === 130 && BigInt('0x' + lower.slice(66)) >= P256_P) {
    throw invalid('compressPubkey: not a valid P-256 point')
  }
  let P: AffinePoint | null
  try {
    P = curve.pointFromHex(lower)
  } catch {
    throw invalid('compressPubkey: not a valid P-256 point')
  }
  if (P === null) throw invalid('compressPubkey: not a valid P-256 point')
  return curve.pointToHex(P, true)
}

// ───────────────────────── comb tables (spec §2.1) ─────────────────────────
export interface AffinePoint {
  x: bigint
  y: bigint
}

/**
 * Comb table scalar for entry j (0 <= j < 32):
 *   T_j = 2^(43·5) + Σ_{k<5} (bit_k(j) ? +1 : −1) · 2^(43k)
 * The top digit is fixed +1 (the sign digit is applied in-script by negating y).
 */
export function combTableScalar(j: number): bigint {
  let s = 1n << BigInt(COMB_COLS * (COMB_ROWS - 1))
  for (let k = 0; k < COMB_ROWS - 1; k++)
    s += (((j >> k) & 1) !== 0 ? 1n : -1n) << BigInt(COMB_COLS * k)
  return s
}

/**
 * T_j·base for j in 0..31. Built from the COMB_ROWS points 2^(43k)·base by
 * doubling (215 doublings), then 5 additions or subtractions per entry, in
 * place of 32 full scalar multiplications. The points are the same as
 * combTableScalar(j)·base.
 */
function tableOf(base: AffinePoint): AffinePoint[] {
  const rows: AffinePoint[] = [base]
  for (let k = 1; k < COMB_ROWS; k++) {
    let p: AffinePoint | null = rows[k - 1]
    for (let i = 0; i < COMB_COLS; i++) p = curve.add(p, p)
    if (p === null) throw invalid('comb table: base point has small order')
    rows.push(p)
  }
  const neg = (p: AffinePoint): AffinePoint => ({ x: p.x, y: mod(-p.y, P256_P) })
  const pts: AffinePoint[] = []
  for (let j = 0; j < TABLE_SIZE; j++) {
    let acc: AffinePoint | null = rows[COMB_ROWS - 1]
    for (let k = 0; k < COMB_ROWS - 1; k++)
      acc = curve.add(acc, ((j >> k) & 1) !== 0 ? rows[k] : neg(rows[k]))
    if (acc === null) throw invalid('comb table: entry is the point at infinity')
    pts.push({ x: acc.x, y: acc.y })
  }
  return pts
}

let gTableCache: AffinePoint[] | null = null
const copyTable = (table: readonly AffinePoint[]): AffinePoint[] =>
  table.map(({ x, y }) => ({ x, y }))
/** table(G) — computed once on first use (32 scalar multiplications), then constant. */
export function gTable(): AffinePoint[] {
  gTableCache ??= tableOf(curve.g as AffinePoint)
  // Never expose the cache itself: callers may freely mutate the returned table
  // without changing future locks or commitments.
  return copyTable(gTableCache)
}

const TABLE_CACHE_MAX = 8
const qTableCache = new Map<string, AffinePoint[]>()
/** table(Q): 32 affine points T_j·Q. Memoised per compressed pubkey (Map, FIFO, max 8). Never persisted. */
export function combTable(pubkeyHex33: string): AffinePoint[] {
  const key = compressPubkey(pubkeyHex33)
  const hit = qTableCache.get(key)
  if (hit !== undefined) return copyTable(hit)
  const table = tableOf(curve.pointFromHex(key) as AffinePoint)
  if (qTableCache.size >= TABLE_CACHE_MAX) {
    const oldest = qTableCache.keys().next().value
    if (oldest !== undefined) qTableCache.delete(oldest)
  }
  qTableCache.set(key, table)
  return copyTable(table)
}

// ───────────────────────── commitment (spec §2.2) ─────────────────────────
/** OP_NUM2BIN(v, 33) for a non-negative v: minimal LE scriptnum zero-padded to 33 bytes. */
export function le33(v: bigint): number[] {
  if (v < 0n) throw invalid('le33: negative coordinate')
  const b = scriptNum(v)
  if (b.length > COORD_WIDTH) throw invalid('le33: value does not fit in 33 bytes')
  while (b.length < COORD_WIDTH) b.push(0)
  return b
}

/** le33(x_0) ‖ le33(y_0) ‖ … ‖ le33(y_31) — 2,112 bytes; injective over integer values. */
export function canonicalTableBytes(pubkeyHex33: string): number[] {
  const out: number[] = []
  for (const { x, y } of combTable(pubkeyHex33)) out.push(...le33(x), ...le33(y))
  return out
}

function saltBytes(saltHex64: string): number[] {
  if (typeof saltHex64 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(saltHex64)) {
    throw invalid(`salt must be ${SALT_BYTES} bytes as 64 hex chars`)
  }
  return bytesOf(saltHex64)
}

/** hash160(salt ‖ canonicalTableBytes(Q)) as 40 lowercase hex chars — the value baked into the lock. */
export function commitment(pubkeyHex33: string, saltHex64: string): string {
  return toHex(hash160([...saltBytes(saltHex64), ...canonicalTableBytes(pubkeyHex33)]))
}

// ───────────────────────── scalar recoding (spec §2.4, ANALYSIS.md §5.2) ─────────────────────────
/** u' = ((u odd ? u : u + n) + 2^258 − 1) / 2 — exactly the H2 arithmetic. u' < 2^258 and bit 257 is always set. */
export function recode(u: bigint): bigint {
  let v = mod(u, P256_N)
  if (v % 2n === 0n) v += P256_N
  return (v + RECODE_CONST) / 2n
}

// ───────────────────────── header H0–H5 (spec §2.3, gen2.mjs emitHeader2) ─────────────────────────
/** 64 Q coordinates pushed by the unlocker. */
const K_Q = 2 * TABLE_SIZE

/**
 * H0–H3: identical for every lock. Stack in (unlock):
 * [r u2' u1' Q0..Q63 s sInv preimage salt]. The preimage and salt are
 * staged on alt in that order, then n is placed above them. Stack out:
 * [r u2' u1' Q0..Q63] alt [preimage salt n].
 */
let headerBeforeSaltCache: number[] | null = null
function emitHeaderBeforeSalt(): number[] {
  if (headerBeforeSaltCache !== null) return headerBeforeSaltCache
  const one = 'OP_DUP 2 OP_MOD OP_NOTIF {N} OP_ADD OP_ENDIF {C} OP_ADD 2 OP_DIV OP_SWAP'
  const out: number[] = [
    // Canonical witness shape: reject extra bottom pushes as well as missing fields.
    ...asm('OP_DEPTH {DEPTH} OP_NUMEQUALVERIFY', { DEPTH: 3 + K_Q + 4 }),
    // H0: bind withdrawals to transaction version 1 at consensus level, then
    // e = unsigned-LE(hash256(preimage)); preimage -> alt. OP_PUSH_TX later binds
    // this exact preimage to the transaction being evaluated.
    ...asm(`
    OP_OVER 4 OP_SPLIT OP_DROP <01000000> OP_EQUALVERIFY
    OP_OVER OP_HASH256 <00> OP_CAT OP_BIN2NUM
    2 OP_ROLL OP_TOALTSTACK OP_SWAP OP_TOALTSTACK
  `),
    // H1: n -> alt; enforce canonical r, low-S s and sInv before any modular
    // arithmetic; s*sInv == 1; u1 = e*sInv; u2 = r*sInv. The r checks are
    // consensus-critical: without 1 <= r < p and r != n, CRT can give r one
    // residue modulo n for scalar multiplication and another modulo p for the
    // final affine-x check, permitting a signature-free spend.
    //     [.. s sInv u1]: u1(0) sInv(1) s(2) Q63(3) .. Q0(2+K) u1'(3+K) u2'(4+K) r(5+K)
    ...asm(
      `
    {N} OP_TOALTSTACK
    2 OP_PICK 1 {HALFP1} OP_WITHIN OP_VERIFY
    OP_OVER 1 OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_WITHIN OP_VERIFY
    {RDEPTH} OP_PICK OP_DUP 1 {P} OP_WITHIN OP_VERIFY
      OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_NUMNOTEQUAL OP_VERIFY
    2 OP_PICK 2 OP_PICK OP_MUL MODP 1 OP_NUMEQUALVERIFY
    OP_OVER OP_MUL MODP
    {RDEPTH} OP_PICK 2 OP_PICK OP_MUL MODP
    2 OP_ROLL OP_DROP 2 OP_ROLL OP_DROP
  `,
      { N: P256_N, HALFP1: P256_LOW_S_MAX + 1n, P: P256_P, RDEPTH: K_Q + 5 }
    ),
    // H2: recode u2 then u1 -> [.. Q63 u1' u2']
    ...asm(`${one} ${one}`, { N: P256_N, C: RECODE_CONST }),
    // H3: computed u2' == pushed u2' (depth K+3), then computed u1' == pushed u1' (depth K+1) -> [r u2' u1' Q..]
    ...asm('{DU2} OP_PICK OP_NUMEQUALVERIFY {DU1} OP_PICK OP_NUMEQUALVERIFY', {
      DU2: K_Q + 3,
      DU1: K_Q + 1
    })
  ]
  headerBeforeSaltCache = out
  return out
}

/** H4: recover and consume the witness salt, then hash160(salt || canonical table). */
let headerAfterSaltCache: number[] | null = null
function emitHeaderAfterSalt(): number[] {
  if (headerAfterSaltCache !== null) return headerAfterSaltCache
  // alt enters [preimage salt n]. Preserve n above preimage for emitPreloop,
  // while returning salt to the main stack for its exact byte-length check.
  const out: number[] = [
    ...asm(
      'OP_FROMALTSTACK OP_FROMALTSTACK OP_SWAP OP_TOALTSTACK OP_SIZE {SALT_BYTES} OP_NUMEQUALVERIFY',
      {
        SALT_BYTES
      }
    )
  ]
  for (let m = 0; m < K_Q; m++)
    out.push(...asm('{D} OP_PICK {W} OP_NUM2BIN OP_CAT', { D: K_Q - m, W: COORD_WIDTH }))
  out.push(OP.OP_HASH160)
  headerAfterSaltCache = out
  return out
}

/** H0–H4. The salt is supplied by the unlocking script and never appears here. */
function emitHeaderPrefix(): number[] {
  return [...emitHeaderBeforeSalt(), ...emitHeaderAfterSalt()]
}

/** H5: H must equal one of the N baked 20-byte commitments. 22 B (N = 1) or 25N − 2 B (N >= 2). */
function emitH5(commitments: number[][]): number[] {
  const out: number[] = []
  if (commitments.length === 1) {
    out.push(...asm('{C} OP_EQUALVERIFY', { C: commitments[0] }))
    return out
  }
  for (let i = 0; i < commitments.length - 1; i++)
    out.push(...asm('OP_DUP {C} OP_EQUAL OP_SWAP', { C: commitments[i] }))
  out.push(...asm('{C} OP_EQUAL', { C: commitments.at(-1) as number[] }))
  for (let i = 0; i < commitments.length - 1; i++) out.push(OP.OP_BOOLOR)
  out.push(OP.OP_VERIFY)
  return out
}

// ───────────────────────── hardened suffix: G table, pre-loop, complete comb loop, tail ─────────────────────────
function emitGTable(): number[] {
  const out: number[] = []
  for (const { x, y } of gTable()) out.push(...encNum(x), ...encNum(y))
  return out
}

/** Push p; swap altstack top n -> p; accumulator := Jacobian infinity (1, 1, 0). */
function emitPreloop(): number[] {
  return asm('{P} OP_FROMALTSTACK OP_DROP OP_TOALTSTACK 1 1 0', { P: P256_P })
}

// Jacobian doubling, a = -3 (dbl-2001-b): M = 3(X-Z^2)(X+Z^2), S = 4XY^2,
// X3 = M^2 - 2S, Y3 = M(S - X3) - 8Y^4, Z3 = 2YZ. Only X3, Y3, Z3 are reduced.
const DOUBLE = `
  OP_DUP OP_DUP OP_MUL
  3 OP_PICK OP_OVER OP_SUB
  4 OP_PICK 2 OP_ROLL OP_ADD
  1 OP_ROLL 1 OP_ROLL
  OP_MUL 3 OP_MUL
  2 OP_PICK OP_DUP OP_MUL
  4 OP_ROLL OP_OVER OP_MUL 4 OP_MUL
  2 OP_PICK OP_DUP OP_MUL
  OP_OVER OP_2MUL
  1 OP_ROLL 1 OP_ROLL
  OP_SUB MODP NORM
  1 OP_ROLL OP_OVER OP_SUB
  3 OP_ROLL 1 OP_ROLL OP_MUL
  2 OP_ROLL OP_DUP OP_MUL 8 OP_MUL
  1 OP_ROLL 1 OP_ROLL OP_SUB MODP NORM
  3 OP_ROLL 3 OP_ROLL OP_MUL OP_2MUL MODP NORM
  2 OP_ROLL 2 OP_ROLL 2 OP_ROLL
`

// Digit extraction + table lookup + conditional negation. Stack in: [.. X Y Z]; out: [.. X Y Z x y].
// Row 0 bit = sign digit; rows 1..4 are XNOR'd against it to form the 5-bit table index j.
const DIGITS_AND_LOOKUP = `
  {DEPTH0} OP_PICK {SHIFT0} OP_RSHIFTNUM 2 OP_MOD
  {DEPTH1} OP_PICK {SHIFT1} OP_RSHIFTNUM 2 OP_MOD OP_OVER OP_NUMEQUAL OP_2MUL
  {DEPTH2} OP_PICK {SHIFT2} OP_RSHIFTNUM 2 OP_MOD 2 OP_PICK OP_NUMEQUAL OP_ADD OP_2MUL
  {DEPTH2} OP_PICK {SHIFT3} OP_RSHIFTNUM 2 OP_MOD 2 OP_PICK OP_NUMEQUAL OP_ADD OP_2MUL
  {DEPTH2} OP_PICK {SHIFT4} OP_RSHIFTNUM 2 OP_MOD 2 OP_PICK OP_NUMEQUAL OP_ADD OP_2MUL
  {DEPTH2} OP_PICK {SHIFT5} OP_RSHIFTNUM 2 OP_MOD 2 OP_PICK OP_NUMEQUAL OP_ADD
  OP_DUP OP_2MUL {BASE} OP_SWAP OP_SUB OP_PICK
  OP_OVER OP_2MUL {BASE} OP_SWAP OP_SUB OP_PICK
  2 OP_ROLL OP_DROP 2 OP_ROLL
  OP_NOTIF OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_SWAP OP_SUB OP_ENDIF
`

// Mixed Jacobian + affine addition: U2 = xZ^2, S2 = yZ^3, H = U2 - X, R = S2 - Y,
// X3 = R^2 - H^3 - 2XH^2, Y3 = R(XH^2 - X3) - YH^3, Z3 = ZH. Only X3, Y3, Z3 are reduced.
const MADD = `
  2 OP_PICK OP_DUP OP_MUL
  2 OP_ROLL OP_OVER OP_MUL
  3 OP_PICK 2 OP_ROLL OP_MUL
  2 OP_ROLL 1 OP_ROLL OP_MUL
  1 OP_ROLL 4 OP_PICK OP_SUB
  1 OP_ROLL 3 OP_PICK OP_SUB
  OP_OVER OP_DUP OP_MUL
  2 OP_PICK OP_OVER OP_MUL
  6 OP_ROLL 2 OP_ROLL OP_MUL
  2 OP_PICK OP_DUP OP_MUL
  OP_OVER OP_2MUL
  1 OP_ROLL 3 OP_PICK OP_SUB
  1 OP_ROLL OP_SUB MODP NORM
  1 OP_ROLL OP_OVER OP_SUB
  3 OP_ROLL 1 OP_ROLL OP_MUL
  5 OP_ROLL 3 OP_ROLL OP_MUL
  1 OP_ROLL 1 OP_ROLL OP_SUB MODP NORM
  3 OP_ROLL 3 OP_ROLL OP_MUL MODP NORM
  2 OP_ROLL 2 OP_ROLL 2 OP_ROLL
`

// Complete wrapper for mixed addition. The fast formula above is undefined
// when the accumulator is infinity or H = 0. Handle those cases explicitly:
// infinity + P = P; P + P = DOUBLE(P); P + (-P) = infinity. This is required
// for availability for every valid key/signature, rather than relying on the
// exceptional relations being improbable.
const COMPLETE_MADD = `
  2 OP_PICK 0 OP_NUMEQUAL
  OP_IF
    OP_TOALTSTACK OP_TOALTSTACK OP_DROP OP_DROP OP_DROP
    OP_FROMALTSTACK OP_FROMALTSTACK 1
  OP_ELSE
    2 OP_PICK OP_DUP OP_MUL MODP
    2 OP_PICK OP_MUL
    5 OP_PICK OP_SUB MODP NORM
    0 OP_NUMEQUAL
    OP_IF
      2 OP_PICK OP_DUP OP_MUL MODP
      3 OP_PICK OP_MUL
      1 OP_PICK OP_MUL
      4 OP_PICK OP_SUB MODP NORM
      0 OP_NUMEQUAL
      OP_IF
        OP_2DROP
        ${DOUBLE}
      OP_ELSE
        OP_2DROP OP_2DROP OP_DROP 1 1 0
      OP_ENDIF
    OP_ELSE
      ${MADD}
    OP_ENDIF
  OP_ENDIF
`

/** Complete Jacobian-plus-affine addition fragment; p must be the altstack top. */
export function completeMixedAddScript(): number[] {
  return asm(COMPLETE_MADD)
}

/** Stack layout beneath the accumulator: [r u2' u1' C[0..K-1]] with K = 128 table coordinates (Q[0..63] then G[0..63]). */
const K_CONSTS = 2 * 2 * TABLE_SIZE // 128
const BELOW = 3 + K_CONSTS // 131 items under the accumulator (X Y Z)
// With [.. X Y Z] on top (BELOW + 3 items): stack index 1 (= u2') is at depth 132, index 2 (= u1') at 131.
const scalarDepth = (half: 0 | 1): number => BELOW + 1 - half
// C[m] sits at depth 132 − m once [.. X Y Z sign j] is on top; half 0 -> C[0..63] (= Q), half 1 -> C[64..127] (= G).
const tableBase = (half: 0 | 1): number => BELOW + 1 - 2 * TABLE_SIZE * half
/** Shift for column c, row k: bit position 43k + 42 − c of the recoded scalar = 257 − c − 43k. */
export const shiftFor = (c: number, k: number): number =>
  COMB_COLS * (COMB_ROWS - 1 - k) + (COMB_COLS - 1 - c)

function emitAdd(half: 0 | 1, c: number): number[] {
  const params: Record<string, AsmParam> = {
    DEPTH0: scalarDepth(half),
    DEPTH1: scalarDepth(half) + 1,
    DEPTH2: scalarDepth(half) + 2,
    BASE: tableBase(half)
  }
  for (let k = 0; k < COMB_ROWS; k++) params[`SHIFT${k}`] = shiftFor(c, k)
  return [...asm(DIGITS_AND_LOOKUP, params), ...completeMixedAddScript()]
}

/** 43 columns, Horner: acc = 2·acc + d2(c)·TQ[j2] + d1(c)·TG[j1], with complete mixed additions. */
function emitCombLoop(): number[] {
  const out: number[] = []
  for (let c = 0; c < COMB_COLS; c++) {
    // index-1 scalar (u2') with C[0..63] (Q), then index-2 scalar (u1') with C[64..127] (G)
    out.push(...asm(DOUBLE), ...emitAdd(0, c), ...emitAdd(1, c))
  }
  return out
}

/** DER INTEGER for a non-negative bigint: minimal big-endian with a 0x00 pad if the top bit is set. */
function derIntBytes(v: bigint): number[] {
  let h = v.toString(16)
  if (h.length % 2 === 1) h = '0' + h
  const b = bytesOf(h)
  if ((b[0] & 0x80) !== 0) b.unshift(0)
  return [0x02, b.length, ...b]
}

/**
 * An OP_PUSH_TX dummy key d·G on secp256k1 for the public constant C,
 * d = C·Gx⁻¹ mod n_k1. With nonce k = 1 the corresponding signature is
 * (r, s) = (Gx, e + C mod n_k1). Nothing about these keys is secret.
 */
const pushTxPubKeyCache = new Map<bigint, number[]>()
function pushTxPubKey(constant: bigint): number[] {
  let key = pushTxPubKeyCache.get(constant)
  if (!key) {
    const d = mod(constant * modinv(SECP_GX, SECP_N), SECP_N)
    key = new PrivateKey(d.toString(16).padStart(64, '0'), 16)
      .toPublicKey()
      .encode(true) as number[]
    pushTxPubKeyCache.set(constant, key)
  }
  return key.slice()
}

/**
 * Tail: Z != 0 and X == r·Z² (mod p); clear the stack; total OP_PUSH_TX with
 * k = 1 on secp256k1 (ANALYSIS.md §6).
 *
 * Ordinarily C1 = 2^248 and dummy key d1 produce s = e + C1 (mod n). For the
 * single digest where that scalar is zero, the script selects C2 = C1 + 1 and
 * dummy key d2, which produces s = 1. Two distinct constants cannot both be
 * zero for one e, so the covenant signature is defined for every digest; no
 * probabilistic transaction-sequence retry is part of spend availability.
 */
function emitTail(): number[] {
  // r (item index 0) with [.. X Y Z Z^2] on top (BELOW + 4 items) is at depth BELOW + 3 = 134
  const rCheck = asm(
    `
    OP_DUP 0 OP_NUMEQUAL OP_NOTIF
      OP_DUP OP_DUP OP_MUL MODP
      {RDEPTH} OP_PICK OP_OVER OP_MUL MODP
      4 OP_PICK OP_NUMEQUAL
    OP_ELSE 0 OP_ENDIF OP_VERIFY
    OP_FROMALTSTACK OP_DROP
  `,
    { RDEPTH: BELOW + 3 }
  )
  // stack now holds BELOW + 4 items (r u2' u1' C[] X Y Z Z^2): drop them all
  const leftover = BELOW + 4
  const clear: number[] = [
    ...Array.from({ length: Math.floor(leftover / 2) }, () => OP.OP_2DROP),
    ...(leftover % 2 === 1 ? [OP.OP_DROP] : [])
  ]
  // e_k1 = BE(hash256(preimage)); normally s = lowS((e_k1 + C1) mod n_k1).
  // If that is zero, use C2 and its public key, for which s is exactly 1.
  const rev31 = Array.from({ length: 31 }, () => 'OP_SWAP OP_CAT').join(' ')
  const pushTx = asm(
    `
    OP_FROMALTSTACK {SIGHASH} OP_TOALTSTACK OP_HASH256
    ${Array.from({ length: 31 }, () => '1 OP_SPLIT').join(' ')}
    ${rev31}
    <00> OP_CAT OP_BIN2NUM
    0 31 OP_NUM2BIN 1 OP_CAT OP_ADD
    {NK} OP_TUCK 2 OP_DIV OP_OVER OP_LESSTHAN
    OP_IF OP_OVER OP_MOD OP_OVER 2 OP_DIV OP_OVER OP_LESSTHAN OP_IF OP_SUB OP_ELSE OP_NIP OP_ENDIF
    OP_ELSE OP_NIP OP_ENDIF
    OP_DUP OP_0NOTEQUAL
    OP_IF {PUBKEY1} OP_SWAP
    OP_ELSE OP_DROP {PUBKEY2} 1 OP_ENDIF
    ${Array.from({ length: 31 }, () => 'OP_SIZE OP_0NOTEQUAL OP_SPLIT').join(' ')}
    ${rev31}
    OP_SIZE OP_SWAP OP_CAT
    {DERPREFIX} OP_SWAP OP_CAT
    OP_SIZE OP_SWAP OP_CAT
    <30> OP_SWAP OP_CAT
    OP_FROMALTSTACK OP_CAT
    OP_SWAP OP_CODESEPARATOR OP_CHECKSIG
  `,
    {
      SIGHASH: [R1C_SIGHASH],
      NK: SECP_N,
      DERPREFIX: [...derIntBytes(SECP_GX), 0x02], // 02 20 <Gx> 02  (s INTEGER tag appended)
      PUBKEY1: pushTxPubKey(PUSH_TX_C1),
      PUBKEY2: pushTxPubKey(PUSH_TX_C2)
    }
  )
  return [...rCheck, ...clear, ...pushTx]
}

let sharedSuffixCache: number[] | null = null
/** G table + pre-loop + complete comb loop + total covenant tail: 44,388 B. Computed once. */
export function sharedSuffix(): number[] {
  sharedSuffixCache ??= [...emitGTable(), ...emitPreloop(), ...emitCombLoop(), ...emitTail()]
  return sharedSuffixCache.slice()
}

// ───────────────────────── public: buildLock / bakedCommitments (spec §2.3) ─────────────────────────
function parseCommitments(commitments: unknown): number[][] {
  if (!Array.isArray(commitments) || commitments.length < 1 || commitments.length > R1C_MAX_KEYS) {
    throw invalid(`buildLock: commitments must be 1..${R1C_MAX_KEYS} hash160 hex strings`)
  }
  const lower: string[] = commitments.map(c => {
    if (typeof c !== 'string' || !/^[0-9a-fA-F]{40}$/.test(c))
      throw invalid('buildLock: commitment must be 40 hex chars')
    return c.toLowerCase()
  })
  if (new Set(lower).size !== lower.length) throw invalid('buildLock: duplicate commitment')
  return lower.map(bytesOf)
}

/** N in 1..5 salted table commitments. saltHex64 is validated but never emitted into the lock. */
export function buildLock(a: { commitments: string[]; saltHex64: string }): LockingScript {
  const cs = parseCommitments(a.commitments)
  saltBytes(a.saltHex64)
  const bytes = [...emitHeaderPrefix(), ...emitH5(cs), ...sharedSuffix()]
  const expected = R1C_LOCK_LEN(cs.length)
  if (bytes.length !== expected)
    throw invalid(`buildLock: emitted ${bytes.length} bytes, expected ${expected}`)
  return new LockingScript(Script.fromBinary(bytes).chunks)
}

/**
 * Parse and validate a lock built by buildLock. The H5 skeleton and whole
 * salt-free template must be byte-identical to a rebuilt lock.
 */
function parseBakedLock(lock: Script): { commitments: string[] } {
  const bin = lock.toBinary()
  let n = -1
  for (let k = 1; k <= R1C_MAX_KEYS; k++) if (bin.length === R1C_LOCK_LEN(k)) n = k
  if (n < 0) throw invalid(`bakedCommitments: ${bin.length} bytes is not an R1C lock length`)
  const prefix = emitHeaderPrefix()
  const suffix = sharedSuffix()
  const h5 = bin.slice(prefix.length, bin.length - suffix.length)
  const cs: number[][] = []
  if (n === 1) {
    cs.push(h5.slice(1, 21))
  } else {
    for (let i = 0; i < n - 1; i++) cs.push(h5.slice(24 * i + 2, 24 * i + 22))
    cs.push(h5.slice(24 * (n - 1) + 1, 24 * (n - 1) + 21))
  }
  const rebuilt = [...prefix, ...emitH5(cs), ...suffix]
  if (rebuilt.length !== bin.length || rebuilt.some((b, i) => b !== bin[i])) {
    throw invalid('bakedCommitments: not an R1C lock')
  }
  return { commitments: cs.map(c => toHex(c)) }
}

/** Commitments baked into an exact current R1C lock, in order. */
export function bakedCommitments(lock: Script): string[] {
  return parseBakedLock(lock).commitments
}

// ───────────────────────── sighash preimage and signer digest (spec §2.5) ─────────────────────────
/** OP_CODESEPARATOR OP_CHECKSIG ⇒ the scriptCode the lock's CHECKSIG hashes is the single byte `ac`. */
const SUBSCRIPT = Script.fromHex('ac')

function requirePreimage(preimage: number[], where: string): void {
  if (!Array.isArray(preimage) || preimage.length !== R1C_PREIMAGE_LEN) {
    throw invalid(`${where}: preimage must be ${R1C_PREIMAGE_LEN} bytes`)
  }
  const version = new Reader(preimage.slice(0, 4)).readUInt32LE()
  if (version !== 1)
    throw invalid(
      `${where}: vault withdrawals require transaction version 1; this preimage carries version ${version}`
    )
}

/** Version-1 BIP143 preimage, subscript `ac`, scope 0x41, for input `inputIndex` of `tx` whose source output carried `sourceSatoshis`. */
export function sighashPreimage(
  tx: Transaction,
  inputIndex: number,
  sourceSatoshis: number
): number[] {
  const input = tx.inputs[inputIndex]
  if (input === undefined) throw invalid(`sighashPreimage: input ${inputIndex} does not exist`)
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
  if (sourceTXID === undefined)
    throw invalid('sighashPreimage: input needs sourceTXID or sourceTransaction')
  if (!Number.isSafeInteger(sourceSatoshis) || sourceSatoshis < 0)
    throw invalid('sighashPreimage: sourceSatoshis must be a non-negative integer')
  const preimage = TransactionSignature.format({
    sourceTXID,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
    outputs: tx.outputs,
    inputIndex,
    subscript: SUBSCRIPT,
    inputSequence: input.sequence ?? 0xffffffff,
    lockTime: tx.lockTime,
    scope: R1C_SIGHASH
  })
  requirePreimage(preimage, 'sighashPreimage')
  return preimage
}

/** reverse(hash256(preimage)) as 64 lowercase hex — the raw digest the P-256 signer signs (the script reads e little-endian). */
export function signerDigest(preimage: number[]): string {
  requirePreimage(preimage, 'signerDigest')
  return toHex([...hash256(preimage)].reverse())
}

// ───────────────────────── OP_PUSH_TX model (ANALYSIS.md §6) ─────────────────────────
/**
 * The nonzero s the tail assembles. It uses lowS((BE(hash256(preimage)) +
 * C1) mod n_k1), except that the zero case selects C2 and therefore s = 1.
 * In both branches r is fixed at Gx (nonce k = 1).
 */
export function pushTxSignatureS(preimage: number[]): bigint {
  const e = beToBig(hash256(preimage))
  const first = mod(e + PUSH_TX_C1, SECP_N)
  const t = first === 0n ? mod(e + PUSH_TX_C2, SECP_N) : first
  return t > (SECP_N - 1n) / 2n ? SECP_N - t : t
}

/**
 * Pre-sign check for the fixed OP_PUSH_TX signature. The byte-reversal loop
 * uses OP_SIZE rather than parsing arbitrary suffix bytes as script numbers,
 * so every positive low-S encoding is accepted. The two-key covenant branch
 * makes s nonzero for every digest; `ok` is retained for caller compatibility.
 */
export function pushTxDerCheck(preimage: number[]): { ok: boolean; s: bigint } {
  requirePreimage(preimage, 'pushTxDerCheck')
  const s = pushTxSignatureS(preimage)
  return { ok: true, s }
}

// ───────────────────────── DER ─────────────────────────
/** Strict DER `SEQUENCE { INTEGER r, INTEGER s }` → (r, s), both in [1, n−1]. Short-form lengths only (max 72 B). */
export function decodeDerSignature(der: number[]): { r: bigint; s: bigint } {
  const fail = (why: string): never => {
    throw invalid(`decodeDerSignature: ${why}`)
  }
  if (!Array.isArray(der) || der.length < 8 || der.length > 72) fail('length')
  if (der[0] !== 0x30) fail('not a SEQUENCE')
  if (der[1] !== der.length - 2) fail('bad SEQUENCE length')
  let pos = 2
  const readInt = (): bigint => {
    if (der[pos] !== 0x02) fail('expected INTEGER')
    const len = der[pos + 1]
    if (len === undefined || len === 0 || len > 33 || pos + 2 + len > der.length)
      fail('bad INTEGER length')
    const body = der.slice(pos + 2, pos + 2 + len)
    if ((body[0] & 0x80) !== 0) fail('negative INTEGER')
    if (len > 1 && body[0] === 0x00 && (body[1] & 0x80) === 0) fail('non-minimal INTEGER')
    pos += 2 + len
    return beToBig(body)
  }
  const r = readInt()
  const s = readInt()
  if (pos !== der.length) fail('trailing bytes')
  if (r === 0n || r >= P256_N || s === 0n || s >= P256_N) fail('scalar out of range')
  return { r, s }
}

// ───────────────────────── strict verification flags ─────────────────────────
/**
 * Explicit @bsv/sdk Spend flags. With flags given, every rule is flag-driven and ignores the transaction
 * version: MINIMALDATA (minimal pushes and script numbers),
 * UTXO_AFTER_CHRONICLE (post-Genesis limits off, OP_RSHIFTNUM/OP_2MUL live), SIGHASH_FORKID + STRICTENC
 * (strict DER, defined hash type, FORKID required), and CLEANSTACK + SIGPUSHONLY + LOW_S to rule out
 * otherwise-valid witness encodings. Vault withdrawals are version 1 as an additional network-policy guard.
 */
export const R1C_VERIFY_FLAGS: readonly string[] = [
  'MINIMALDATA',
  'UTXO_AFTER_CHRONICLE',
  'SIGHASH_FORKID',
  'STRICTENC',
  'CLEANSTACK',
  'SIGPUSHONLY',
  'LOW_S'
]

// ───────────────────────── fullR / buildUnlock (spec §2.4) ─────────────────────────
/**
 * R = u1·G + u2·Q for e = LE(hash256(preimage)), u1 = e·s⁻¹, u2 = rSig·s⁻¹ (mod n).
 * Returns the FULL affine x (in [0, p)), or null if R is the point at infinity. Throws on s ≡ 0.
 */
export function fullR(a: {
  preimage: number[]
  rSig: bigint
  s: bigint
  pubkeyHex33: string
}): bigint | null {
  requirePreimage(a.preimage, 'fullR')
  const Q = curve.pointFromHex(compressPubkey(a.pubkeyHex33))
  const s = mod(a.s, P256_N)
  if (s === 0n) throw invalid('fullR: s ≡ 0 (mod n)')
  const e = leToBig(hash256(a.preimage))
  const sInv = modinv(s, P256_N)
  const u1 = mod(e * sInv, P256_N)
  const u2 = mod(a.rSig * sInv, P256_N)
  const R = curve.add(
    u1 === 0n ? null : curve.multiplyBase(u1),
    u2 === 0n ? null : curve.multiply(Q, u2)
  )
  if (R === null) return null
  return R.x
}

/**
 * The 71-push unlocking script: r, u2', u1', 64 coords of table(Q), s, s⁻¹,
 * preimage, and the 32-byte salt (spec §2.4).
 * Refuses: wrong preimage length, preimage version ≠ 1,
 * bad key / DER, R = O. It does NOT verify the signature against Q: the interpreter is the arbiter
 * (Plan 2 runs verifyVaultInput on every input before signAction).
 */
export function buildUnlock(a: {
  preimage: number[]
  derSig: number[]
  pubkeyHex33: string
  saltHex64: string
}): UnlockingScript {
  const { preimage } = a
  requirePreimage(preimage, 'buildUnlock')
  const key = compressPubkey(a.pubkeyHex33)
  const decoded = decodeDerSignature(a.derSig)
  const rSig = decoded.r
  // (r, n-s) verifies whenever (r, s) does and has the same R.x. Normalising
  // here lets hardware return either valid form while the consensus script has
  // one canonical scalar representation.
  const s = decoded.s > P256_LOW_S_MAX ? P256_N - decoded.s : decoded.s
  const Rx = fullR({ preimage, rSig, s, pubkeyHex33: key })
  if (Rx === null) throw invalid('buildUnlock: R is the point at infinity')
  const e = leToBig(hash256(preimage))
  const sInv = modinv(s, P256_N)
  const u1 = mod(e * sInv, P256_N)
  const u2 = mod(Rx * sInv, P256_N) // the lock derives u2 from the PUSHED r (≡ rSig mod n), so recode that
  const bytes: number[] = [...encNum(Rx), ...encNum(recode(u2)), ...encNum(recode(u1))]
  for (const { x, y } of combTable(key)) bytes.push(...encNum(x), ...encNum(y))
  bytes.push(
    ...encNum(s),
    ...encNum(sInv),
    ...pushData(preimage),
    ...pushData(saltBytes(a.saltHex64))
  )
  if (bytes.length > R1C_UNLOCK_LEN)
    throw invalid(`buildUnlock: ${bytes.length} bytes exceeds R1C_UNLOCK_LEN`)
  return new UnlockingScript(Script.fromBinary(bytes).chunks)
}

// ───────────────────────── strict local verification ─────────────────────────
/** Run @bsv/sdk Spend with R1C_VERIFY_FLAGS for one input. Returns true or throws the interpreter's error. */
export function verifyVaultInput(a: {
  tx: Transaction
  inputIndex: number
  sourceSatoshis: number
  lockingScript: LockingScript
  unlockingScript: UnlockingScript
}): true {
  const { tx, inputIndex } = a
  const input = tx.inputs[inputIndex]
  if (input === undefined) throw invalid(`verifyVaultInput: input ${inputIndex} does not exist`)
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
  if (sourceTXID === undefined)
    throw invalid('verifyVaultInput: input needs sourceTXID or sourceTransaction')
  const spend = new Spend({
    sourceTXID,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: a.sourceSatoshis,
    lockingScript: a.lockingScript,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
    outputs: tx.outputs,
    inputIndex,
    unlockingScript: a.unlockingScript,
    inputSequence: input.sequence ?? 0xffffffff,
    lockTime: tx.lockTime,
    verifyFlags: [...R1C_VERIFY_FLAGS]
  })
  if (spend.validate() !== true) throw invalid('verifyVaultInput: script evaluated to false')
  return true
}
