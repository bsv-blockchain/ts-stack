// BRC-162 1Color token-output codec. Same prefix rules as Bsv21Binary, plus the
// 36-byte token id of an asset first deployed under BRC-161 at a nonzero output:
// txid in natural order ‖ uint32 little-endian vout. A 36-byte id with vout 0 is
// non-canonical and invalid.
import { LockingScript, OP } from '@bsv/sdk/script'
import type { ScriptChunk, ScriptTemplate, ScriptTemplateUnlock } from '@bsv/sdk/script'
import type { PrivateKey } from '@bsv/sdk/primitives'
import { hash160 } from '@bsv/sdk/primitives/Hash'
import { toArray, toHex } from '@bsv/sdk/primitives/utils'
import type { WalletCounterparty, WalletInterface, WalletProtocol } from '@bsv/sdk/wallet'
import {
  Bsv21Binary,
  Bsv21BinaryError,
  decodeAmountChunk,
  encodeAmountChunk,
  isTokenShaped,
  p2pkhHash,
  payloadChunk,
  roleOf,
  splitPayload,
  type Bsv21BinaryDecoded
} from './Bsv21Binary.js'

/** A decoded 1Color output; `tokenId` is 32 bytes, or 36 for a legacy nonzero-index deploy. */
export type OneColorDecoded = Bsv21BinaryDecoded

const TXID_BYTES = 32
const PKH_BYTES = 20
const LEGACY_ID_BYTES = 36
const TOKEN_ID_RE = /^([0-9a-f]{64})_(0|[1-9]\d{0,9})$/

const fail = (message: string): never => {
  throw new Bsv21BinaryError(message)
}

const legacyVout = (tokenId: readonly number[]): number =>
  (tokenId[32] | (tokenId[33] << 8) | (tokenId[34] << 16) | (tokenId[35] << 24)) >>> 0

const readTokenId = (chunk: ScriptChunk): number[] | undefined => {
  if (chunk.op === OP.OP_0) return undefined
  const length = chunk.data?.length
  if (chunk.op !== length || (length !== TXID_BYTES && length !== LEGACY_ID_BYTES)) {
    return fail('token id must be a direct 32- or 36-byte push')
  }
  const tokenId = [...(chunk.data as number[])]
  if (length === LEGACY_ID_BYTES && legacyVout(tokenId) === 0) {
    fail('a 36-byte token id with vout 0 is non-canonical')
  }
  return tokenId
}

export class OneColor implements ScriptTemplate {
  readonly wallet?: WalletInterface
  readonly originator?: string

  constructor(wallet?: WalletInterface, originator?: string) {
    this.wallet = wallet
    this.originator = originator
  }

  /** Parses `<64 lowercase hex, display order>_<vout>` into the canonical 32- or 36-byte wire id. */
  static tokenIdFromString(id: string): number[] {
    const match = TOKEN_ID_RE.exec(id) ?? fail('token id must be <64 lowercase hex>_<vout>')
    const vout = Number(match[2])
    if (vout > 0xffffffff) fail('token id vout exceeds uint32')
    const txid = toArray(match[1], 'hex').reverse()
    if (vout === 0) return txid
    return [...txid, vout & 0xff, (vout >>> 8) & 0xff, (vout >>> 16) & 0xff, vout >>> 24]
  }

  /** Formats a canonical 32- or 36-byte wire id as `<64 hex, display order>_<vout>`. */
  static tokenIdToString(tokenId: readonly number[]): string {
    if (tokenId.length !== TXID_BYTES && tokenId.length !== LEGACY_ID_BYTES) {
      fail('token id must be 32 or 36 bytes')
    }
    const txid = toHex(tokenId.slice(0, TXID_BYTES).reverse())
    if (tokenId.length === TXID_BYTES) return `${txid}_0`
    const vout = legacyVout(tokenId)
    if (vout === 0) fail('a 36-byte token id with vout 0 is non-canonical')
    return `${txid}_${vout}`
  }

  /** Decodes a token-shaped locking script; throws Bsv21BinaryError on any non-canonical prefix. */
  static decode(script: LockingScript): OneColorDecoded {
    if (!isTokenShaped(script)) fail('not a BRC-162 token output')
    const c = script.chunks
    if (c.some(chunk => chunk.invalidLength === true)) fail('truncated push')
    const tokenId = readTokenId(c[0])
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
    const id = tokenId === null ? null : OneColor.tokenIdFromString(tokenId)
    const chunks: ScriptChunk[] = [
      id === null ? { op: OP.OP_0 } : { op: id.length, data: id },
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
    return new Bsv21Binary().unlock(privateKey, signOutputs, anyoneCanPay)
  }
}
