import { LockingScript, Utils } from '@bsv/sdk'

/**
 * Bsv21Token — decoder for BSV-21 (1Sat ordinals-style fungible token)
 * locking scripts. The token is an ord-inscription envelope carrying a
 * BSV-20 JSON payload, followed by a standard P2PKH owner lock:
 *
 *   OP_FALSE OP_IF "ord" OP_1 "application/bsv-20" OP_0 <json> OP_ENDIF
 *   OP_DUP OP_HASH160 <owner_pkh:20> OP_EQUALVERIFY OP_CHECKSIG
 *
 * JSON: {"p":"bsv-20","op":"transfer"|"deploy+mint","id":"<txid_vout>","amt":"<int>",...}
 *
 * BSV-21 amounts are divisible bigints carried as strings; ownership is plain
 * P2PKH. Decode-only — building transfers is the wallet's job (see the 1sat
 * inscription builder). Mirrors the wallet's `parseBsv21LockingScript`.
 */

const ORD_TAG_HEX = '6f7264' // "ord"
const CONTENT_TYPE = 'application/bsv-20'
const OP_FALSE_HEX = '00'
const OP_IF_HEX = '63'
const OP_ENDIF_HEX = '68'
const OP_DUP_HEX = '76'
const OP_HASH160_HEX = 'a9'
const OP_EQUALVERIFY_HEX = '88'
const OP_CHECKSIG_HEX = 'ac'
const PKH_PUSH_LEN_HEX = '14'

export interface Bsv21TokenDecoded {
  /** Token id `<txid>_<vout>` of the deploy+mint (empty for the mint output itself). */
  id: string
  /** Raw token amount as a stringified bigint. */
  amt: string
  /** Decimals (deploy+mint only). */
  dec?: number
  /** Symbol / ticker. */
  sym?: string
  /** Icon outpoint / URL. */
  icon?: string
  /** True when this is the deploy+mint output (no id in payload). */
  isMint: boolean
  /** Trailing P2PKH owner hash160 (hex). */
  ownerHash160: string
}

class HexReader {
  pos = 0
  constructor (public readonly hex: string) {}
  readByteHex (): string | null {
    if (this.pos + 2 > this.hex.length) return null
    const b = this.hex.substring(this.pos, this.pos + 2)
    this.pos += 2
    return b
  }

  readBytesHex (n: number): string | null {
    if (this.pos + n * 2 > this.hex.length) return null
    const out = this.hex.substring(this.pos, this.pos + n * 2)
    this.pos += n * 2
    return out
  }

  readPushHex (): string | null {
    const op = this.readByteHex()
    if (op === null) return null
    const code = Number.parseInt(op, 16)
    if (code === 0) return ''
    if (code >= 0x01 && code <= 0x4b) return this.readBytesHex(code)
    if (code === 0x4c) {
      const lenHex = this.readByteHex()
      if (lenHex === null) return null
      return this.readBytesHex(Number.parseInt(lenHex, 16))
    }
    if (code === 0x4d) {
      const b1 = this.readByteHex(); const b2 = this.readByteHex()
      if (b1 === null || b2 === null) return null
      return this.readBytesHex(Number.parseInt(b2 + b1, 16))
    }
    if (code === 0x4e) {
      const b1 = this.readByteHex(); const b2 = this.readByteHex()
      const b3 = this.readByteHex(); const b4 = this.readByteHex()
      if (b1 === null || b2 === null || b3 === null || b4 === null) return null
      return this.readBytesHex(Number.parseInt(b4 + b3 + b2 + b1, 16))
    }
    return null
  }
}

function hexToUtf8 (hex: string): string {
  if (hex === '') return ''
  try {
    return Utils.toUTF8(Utils.toArray(hex, 'hex'))
  } catch {
    return ''
  }
}

/** Reads the ord-inscription envelope up to and including OP_ENDIF, returning its JSON payload. */
function readOrdEnvelope (r: HexReader): any {
  if (r.readPushHex() !== ORD_TAG_HEX) throw new Error('not a BSV-21 script: missing "ord" tag')

  // Content-type field id: accept canonical OP_1 (0x51) or non-minimal push-of-0x01.
  const peek = r.hex.substring(r.pos, r.pos + 2)
  if (peek === '51') {
    r.pos += 2
  } else if (r.readPushHex() !== '01') {
    throw new Error('not a BSV-21 script: bad content-type field id')
  }

  const ctHex = r.readPushHex()
  if (ctHex === null || hexToUtf8(ctHex) !== CONTENT_TYPE) throw new Error('not a BSV-21 script: wrong content-type')

  if (r.readByteHex() !== '00') throw new Error('not a BSV-21 script: missing OP_0 separator')

  const contentHex = r.readPushHex()
  if (contentHex === null) throw new Error('not a BSV-21 script: missing JSON payload')
  let payload: any
  try {
    payload = JSON.parse(hexToUtf8(contentHex))
  } catch {
    throw new Error('not a BSV-21 script: invalid JSON payload')
  }
  if (payload?.p !== 'bsv-20') throw new Error('not a BSV-21 script: not bsv-20')

  if (r.readByteHex() !== OP_ENDIF_HEX) throw new Error('not a BSV-21 script: missing OP_ENDIF')
  return payload
}

/** Reads the trailing standard P2PKH owner lock, returning the owner hash160 (hex). */
function readP2pkhOwner (r: HexReader): string {
  const dup = r.readByteHex()
  const hash160Op = r.readByteHex()
  const pushLen = r.readByteHex()
  if (dup !== OP_DUP_HEX || hash160Op !== OP_HASH160_HEX || pushLen !== PKH_PUSH_LEN_HEX) {
    throw new Error('not a BSV-21 script: bad P2PKH owner lock')
  }
  const ownerHash160 = r.readBytesHex(20)
  if (ownerHash160 === null) throw new Error('not a BSV-21 script: truncated owner hash')
  if (r.readByteHex() !== OP_EQUALVERIFY_HEX || r.readByteHex() !== OP_CHECKSIG_HEX) {
    throw new Error('not a BSV-21 script: bad P2PKH tail')
  }
  return ownerHash160
}

/** Parses the optional `dec` field, accepted as a number or a digit string in [0, 18]. */
function parseDecimals (payload: any): number | undefined {
  if (typeof payload.dec === 'number' && Number.isFinite(payload.dec)) return payload.dec
  if (typeof payload.dec === 'string' && /^\d+$/.test(payload.dec)) {
    const n = Number.parseInt(payload.dec, 10)
    if (n >= 0 && n <= 18) return n
  }
  return undefined
}

export class Bsv21Token {
  static isBsv21 (script: LockingScript): boolean {
    try {
      Bsv21Token.decode(script)
      return true
    } catch {
      return false
    }
  }

  /**
   * Decodes a BSV-21 locking script.
   * @throws if the script is not a recognisable BSV-21 output.
   */
  static decode (script: LockingScript): Bsv21TokenDecoded {
    const lower = script.toHex().toLowerCase()
    if (lower.length < 60) throw new Error('not a BSV-21 script: too short')
    if (!lower.startsWith(OP_FALSE_HEX + OP_IF_HEX)) throw new Error('not a BSV-21 script: missing OP_FALSE OP_IF')

    const r = new HexReader(lower)
    r.pos = 4 // past OP_FALSE OP_IF

    const payload = readOrdEnvelope(r)
    const ownerHash160 = readP2pkhOwner(r)

    const amt: string | undefined = payload.amt
    if (typeof amt !== 'string' || !/^\d+$/.test(amt)) throw new Error('not a BSV-21 script: bad amount')

    const isMint = payload.op === 'deploy+mint'
    const dec = parseDecimals(payload)
    const id = !isMint && typeof payload.id === 'string' ? payload.id : ''

    return {
      id,
      amt,
      dec,
      sym: typeof payload.sym === 'string' ? payload.sym : undefined,
      icon: typeof payload.icon === 'string' ? payload.icon : undefined,
      isMint,
      ownerHash160
    }
  }
}
