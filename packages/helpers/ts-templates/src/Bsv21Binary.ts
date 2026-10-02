// BRC-162 (BSV-21 binary) token-output codec with Mandala's push canonicality
// (spec §3.1): every value has exactly one accepted encoding, so every engine
// and every script that compares bytes reads the same token output.
//
//   <id32 | OP_0> <amount | OP_0> OP_2DROP [<payload> OP_DROP] <rest of script>
//
// Token id: a direct 32-byte push (deploy txid, natural order), or OP_0 on a
// deploy. Amount: OP_0, OP_1..OP_16, or a direct push (0x01..0x09) of the
// minimal little-endian script number, 0..2^64-1. Anything else in those two
// slots is token-shaped but invalid. The payload is opaque bytes here.
import { LockingScript, OP, P2PKH } from '@bsv/sdk/script'
import type { ScriptChunk, ScriptTemplate, ScriptTemplateUnlock } from '@bsv/sdk/script'
import type { PrivateKey } from '@bsv/sdk/primitives'
import { hash160 } from '@bsv/sdk/primitives/Hash'
import { toArray, toHex } from '@bsv/sdk/primitives/utils'
import type { WalletCounterparty, WalletInterface, WalletProtocol } from '@bsv/sdk/wallet'

export const BSV21_MAX_AMOUNT = (1n << 64n) - 1n

export type Bsv21Role = 'deploy' | 'authority' | 'value'

export interface Bsv21BinaryDecoded {
  role: Bsv21Role
  /** 32 bytes, natural (internal) order; absent for deploy. */
  tokenId?: number[]
  amount: bigint
  /** Raw payload bytes when a payload push + OP_DROP follows OP_2DROP. */
  payload?: number[]
  /** True when the payload uses the minimal push opcode for its bytes (or there is no payload). */
  payloadCanonical: boolean
  /** The locking script after the prefix. */
  restChunks: ScriptChunk[]
  /** Set when restChunks is exactly a canonical P2PKH (direct 20-byte push). */
  restPubKeyHash?: number[]
}

export class Bsv21BinaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Bsv21BinaryError'
  }
}

const fail = (message: string): never => {
  throw new Bsv21BinaryError(message)
}

const TOKEN_ID_BYTES = 32
const PKH_BYTES = 20
const MAX_AMOUNT_BYTES = 9
const P2PKH_OPS = [OP.OP_DUP, OP.OP_HASH160, PKH_BYTES, OP.OP_EQUALVERIFY, OP.OP_CHECKSIG]

const isSmallIntOp = (op: number): boolean => op >= OP.OP_1 && op <= OP.OP_16
const isPushOp = (op: number): boolean =>
  op <= OP.OP_PUSHDATA4 || op === OP.OP_1NEGATE || isSmallIntOp(op)

export function encodeAmountChunk(amount: bigint): ScriptChunk {
  if (typeof amount !== 'bigint') fail('amount must be a bigint')
  if (amount < 0n || amount > BSV21_MAX_AMOUNT) fail('amount outside 0..2^64-1')
  if (amount === 0n) return { op: OP.OP_0 }
  if (amount <= 16n) return { op: OP.OP_1 + Number(amount) - 1 }
  const data: number[] = []
  let top = 0
  for (let v = amount; v > 0n; v >>= 8n) {
    top = Number(v & 0xffn)
    data.push(top)
  }
  if ((top & 0x80) !== 0) data.push(0x00)
  return { op: data.length, data }
}

const isDirectAmountPush = (chunk: ScriptChunk): chunk is ScriptChunk & { data: number[] } =>
  chunk.op >= 1 && chunk.op <= MAX_AMOUNT_BYTES && chunk.data?.length === chunk.op

// The top byte may be zero only as the sign pad of a value byte with its high bit set.
const isMinimalScriptNum = (data: readonly number[]): boolean => {
  const [top, below] = [...data].reverse()
  return (top & 0x7f) !== 0 || (data.length > 1 && (below & 0x80) !== 0)
}

const littleEndianValue = (data: readonly number[]): bigint => {
  let v = 0n
  for (let i = data.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(data[i])
  return v
}

export function decodeAmountChunk(chunk: ScriptChunk): bigint {
  if (chunk.op === OP.OP_0) return 0n
  if (isSmallIntOp(chunk.op)) return BigInt(chunk.op - OP.OP_1 + 1)
  if (!isDirectAmountPush(chunk)) {
    return fail('amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes')
  }
  const { data } = chunk
  const [top] = [...data].reverse()
  if ((top & 0x80) !== 0) fail('amount must not be negative')
  if (!isMinimalScriptNum(data)) fail('amount is not minimally encoded')
  const v = littleEndianValue(data)
  if (v <= 16n) fail('amounts 0..16 must use OP_0/OP_1..OP_16')
  if (v > BSV21_MAX_AMOUNT) fail('amount exceeds 2^64-1')
  return v
}

const TOKEN_ID_RE = /^[0-9a-f]{64}_0$/

/** Parses `<64 lowercase hex, display order>_0` into the 32 wire bytes (natural order). */
export function tokenIdFromString(id: string): number[] {
  if (!TOKEN_ID_RE.test(id)) fail('token id must be <64 lowercase hex>_0')
  return toArray(id.slice(0, 64), 'hex').reverse()
}

/** Formats 32 wire bytes (natural order) as `<64 hex, display order>_0`. */
export function tokenIdToString(tokenId: readonly number[]): string {
  if (tokenId.length !== TOKEN_ID_BYTES) fail('token id must be 32 bytes')
  return `${toHex([...tokenId].reverse())}_0`
}

/** True when the script begins with `<push> <push> OP_2DROP`, the BRC-162 layout marker. */
export function isTokenShaped(script: LockingScript): boolean {
  const c = script.chunks
  return c.length >= 3 && isPushOp(c[0].op) && isPushOp(c[1].op) && c[2].op === OP.OP_2DROP
}

// Minimal push opcode for raw bytes (MINIMALDATA).
const canonicalPushOp = (data: readonly number[]): number => {
  if (data.length === 0) return OP.OP_0
  if (data.length === 1 && data[0] >= 1 && data[0] <= 16) return OP.OP_1 + data[0] - 1
  if (data.length === 1 && data[0] === 0x81) return OP.OP_1NEGATE
  if (data.length <= 75) return data.length
  if (data.length <= 0xff) return OP.OP_PUSHDATA1
  if (data.length <= 0xffff) return OP.OP_PUSHDATA2
  return OP.OP_PUSHDATA4
}

// OP_0, OP_1..OP_16 and OP_1NEGATE carry no data; every other push carries its bytes.
const payloadChunk = (data: readonly number[]): ScriptChunk => {
  const op = canonicalPushOp(data)
  return op === OP.OP_0 || op > OP.OP_PUSHDATA4 ? { op } : { op, data: [...data] }
}

const pushedBytes = (chunk: ScriptChunk): number[] => {
  if (chunk.op === OP.OP_1NEGATE) return [0x81]
  if (isSmallIntOp(chunk.op)) return [chunk.op - OP.OP_1 + 1]
  return [...(chunk.data ?? [])]
}

interface PayloadSplit {
  payload?: number[]
  payloadCanonical: boolean
  rest: ScriptChunk[]
}

// BRC-162: a single push followed by OP_DROP right after OP_2DROP is the payload.
const splitPayload = (afterPrefix: ScriptChunk[]): PayloadSplit => {
  const [first, second] = afterPrefix
  if (second === undefined || !isPushOp(first.op) || second.op !== OP.OP_DROP) {
    return { payloadCanonical: true, rest: afterPrefix }
  }
  const payload = pushedBytes(first)
  return {
    payload,
    payloadCanonical: first.op === canonicalPushOp(payload),
    rest: afterPrefix.slice(2)
  }
}

const p2pkhHash = (rest: readonly ScriptChunk[]): number[] | undefined => {
  if (rest.length !== P2PKH_OPS.length || rest.some((c, i) => c.op !== P2PKH_OPS[i])) {
    return undefined
  }
  const pkh = rest[2].data
  return pkh?.length === PKH_BYTES ? [...pkh] : undefined
}

const decodeTokenId = (chunk: ScriptChunk): number[] | undefined => {
  if (chunk.op === OP.OP_0) return undefined
  if (chunk.op !== TOKEN_ID_BYTES || chunk.data?.length !== TOKEN_ID_BYTES) {
    return fail('token id must be a direct 32-byte push')
  }
  return [...chunk.data]
}

const roleOf = (tokenId: number[] | undefined, amount: bigint): Bsv21Role => {
  if (tokenId === undefined) return 'deploy'
  return amount === 0n ? 'authority' : 'value'
}

export class Bsv21Binary implements ScriptTemplate {
  readonly wallet?: WalletInterface
  readonly originator?: string

  constructor(wallet?: WalletInterface, originator?: string) {
    this.wallet = wallet
    this.originator = originator
  }

  /** Decodes a token-shaped locking script; throws Bsv21BinaryError on any non-canonical prefix. */
  static decode(script: LockingScript): Bsv21BinaryDecoded {
    if (!isTokenShaped(script)) fail('not a BRC-162 token output')
    const c = script.chunks
    if (c.some(chunk => chunk.invalidLength === true)) fail('truncated push')
    const tokenId = decodeTokenId(c[0])
    const amount = decodeAmountChunk(c[1])
    const { payload, payloadCanonical, rest } = splitPayload(c.slice(3))
    return {
      role: roleOf(tokenId, amount),
      tokenId,
      amount,
      payload,
      payloadCanonical,
      restChunks: rest,
      restPubKeyHash: p2pkhHash(rest)
    }
  }

  /** Builds `<id|OP_0> <amount> OP_2DROP [<payload> OP_DROP]` + P2PKH; `tokenId` null is a deploy. */
  lock(
    tokenId: string | null,
    amount: bigint,
    pubKeyHash: readonly number[],
    payload?: readonly number[]
  ): LockingScript {
    if (pubKeyHash.length !== PKH_BYTES) fail('pubKeyHash must be 20 bytes')
    const chunks: ScriptChunk[] = [
      tokenId === null ? { op: OP.OP_0 } : { op: TOKEN_ID_BYTES, data: tokenIdFromString(tokenId) },
      encodeAmountChunk(amount),
      { op: OP.OP_2DROP }
    ]
    if (payload !== undefined) chunks.push(payloadChunk(payload), { op: OP.OP_DROP })
    chunks.push(
      { op: OP.OP_DUP },
      { op: OP.OP_HASH160 },
      { op: PKH_BYTES, data: [...pubKeyHash] },
      { op: OP.OP_EQUALVERIFY },
      { op: OP.OP_CHECKSIG }
    )
    return new LockingScript(chunks)
  }

  /** `lock` to hash160 of the wallet-derived (BRC-29 style) public key. */
  async lockBRC29(
    tokenId: string | null,
    amount: bigint,
    protocolID: WalletProtocol,
    keyID: string,
    counterparty: WalletCounterparty,
    payload?: readonly number[]
  ): Promise<LockingScript> {
    const wallet = this.wallet ?? fail('lockBRC29 requires a wallet')
    const { publicKey } = await wallet.getPublicKey(
      { protocolID, keyID, counterparty },
      this.originator
    )
    return this.lock(tokenId, amount, hash160(toArray(publicKey, 'hex')), payload)
  }

  /**
   * The sighash subscript is the source output's full locking script, so a
   * P2PKH unlocker spends the prefixed output unchanged.
   */
  unlock(
    privateKey: PrivateKey,
    signOutputs: 'all' | 'none' | 'single' = 'all',
    anyoneCanPay = false
  ): ScriptTemplateUnlock {
    return new P2PKH().unlock(privateKey, signOutputs, anyoneCanPay)
  }
}
