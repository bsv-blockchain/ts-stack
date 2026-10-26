import { toHex, toUTF8 } from '@bsv/sdk/primitives/utils'
import { LockingScript, OP } from '@bsv/sdk/script'
import type { ScriptChunk } from '@bsv/sdk/script'
import { p2pkhHash } from './Bsv21Binary.js'

/**
 * Bsv21Token — decoder for BSV-21 (1Sat ordinals-style fungible token)
 * locking scripts. The token is a BRC-160 `ord` inscription envelope carrying a
 * BSV-20 JSON payload, placed before or after the spend condition:
 *
 *   OP_FALSE OP_IF "ord" OP_1 "application/bsv-20" OP_0 <json> OP_ENDIF
 *   OP_DUP OP_HASH160 <owner_pkh:20> OP_EQUALVERIFY OP_CHECKSIG
 *
 * or `<locking script> <envelope>`, or `<envelope> OP_CODESEPARATOR <locking script>`.
 * Envelope fields are tag/value pairs; a tag is OP_0..OP_16 or a single-byte push of the
 * same number (0x00 and 0x01 pushes alias OP_0 and OP_1); a repeated field's last value wins;
 * field 0, the body, ends the list.
 *
 * JSON: {"p":"bsv-20","op":"transfer"|"deploy+mint"|...,"id":"<txid_vout>","amt":"<int>",...}
 *
 * BSV-21 amounts are divisible bigints carried as strings. The spend condition may be any
 * script; `ownerHash160` is set when it is exactly P2PKH. Decode-only — building transfers
 * is the wallet's job.
 */

const ORD_TAG_HEX = '6f7264' // "ord"
const CONTENT_TYPE = 'application/bsv-20'
const CONTENT_TYPE_FIELD = 1
const BODY_FIELD = 0

export interface Bsv21TokenDecoded {
  /** Token id `<txid>_<vout>` of the deploy+mint (empty for the mint output itself). */
  id: string
  /** Raw token amount as a stringified bigint; '0' for `auth` and `deploy+auth`, which carry none. */
  amt: string
  /** Decimals (deploy+mint only). */
  dec?: number
  /** Symbol / ticker. */
  sym?: string
  /** Icon outpoint / URL. */
  icon?: string
  /** True when this is the deploy+mint output (no id in payload). */
  isMint: boolean
  /** Owner hash160 (hex) when the spend condition is exactly P2PKH; empty otherwise. */
  ownerHash160: string
  /** The payload's `op` (`transfer`, `deploy+mint`, `mint`, `burn`, ...); empty when absent. */
  op: string
  /** The parsed JSON payload. */
  payload: Record<string, unknown>
  /** The spend condition: the script without the envelope (and its OP_CODESEPARATOR). */
  lockingScript: LockingScript
}

/** A BRC-160 `ord` envelope found in a locking script. */
export interface Bsv21Envelope {
  /** Field values by tag, the last occurrence of each; the body (field 0) is `body`. */
  fields: Map<number, number[]>
  /** Field 1 as UTF-8, when present and valid. */
  contentType?: string
  /** Field 0, when present. */
  body?: number[]
  /** The script without the envelope (and an OP_CODESEPARATOR following it). */
  lockingScript: LockingScript
}

const isOrd = (chunk: ScriptChunk | undefined): boolean =>
  chunk?.data !== undefined && toHex(chunk.data) === ORD_TAG_HEX

/** OP_0..OP_16, or a single-byte push of the same number; undefined for any other chunk. */
function fieldTag(chunk: ScriptChunk): number | undefined {
  if (chunk.op === OP.OP_0) return 0
  if (chunk.op >= OP.OP_1 && chunk.op <= OP.OP_16) return chunk.op - OP.OP_1 + 1
  if (chunk.data?.length === 1) return chunk.data[0]
  return undefined
}

/** The bytes a value chunk pushes; OP_0 pushes none, OP_1..OP_16 push their number. */
function pushedBytes(chunk: ScriptChunk): number[] | undefined {
  if (chunk.data !== undefined) return [...chunk.data]
  if (chunk.op === OP.OP_0) return []
  if (chunk.op >= OP.OP_1 && chunk.op <= OP.OP_16) return [chunk.op - OP.OP_1 + 1]
  return undefined
}

function malformed(reason: string): Error {
  return new Error(`not a BSV-21 script: ${reason}`)
}

/** Parses the optional `dec` field, accepted as a number or a digit string in [0, 18]. */
function parseDecimals(payload: Record<string, unknown>): number | undefined {
  if (typeof payload.dec === 'number' && Number.isFinite(payload.dec)) return payload.dec
  if (typeof payload.dec === 'string' && /^\d+$/.test(payload.dec)) {
    const n = Number.parseInt(payload.dec, 10)
    if (n >= 0 && n <= 18) return n
  }
  return undefined
}

/**
 * Reads the `tag value` pairs of an ord envelope from `start` up to its OP_ENDIF, stopping early
 * at the body field. Returns the fields, the body if present, and the OP_ENDIF's chunk index.
 */
function readEnvelopeFields(
  chunks: LockingScript['chunks'],
  start: number
): { fields: Map<number, number[]>; body: number[] | undefined; end: number } {
  const fields = new Map<number, number[]>()
  let body: number[] | undefined
  let index = start
  while (chunks[index]?.op !== OP.OP_ENDIF) {
    const tagChunk = chunks[index]
    const valueChunk = chunks[index + 1]
    if (tagChunk === undefined || valueChunk === undefined)
      throw malformed('unterminated ord envelope')
    const tag = fieldTag(tagChunk)
    if (tag === undefined && tagChunk.data === undefined)
      throw malformed('invalid ord envelope field tag')
    const value = pushedBytes(valueChunk)
    if (value === undefined) throw malformed('ord envelope field value is not a push')
    index += 2
    if (tag === undefined) continue // a multi-byte tag names a field this decoder does not use
    if (tag === BODY_FIELD) {
      body = value
      break
    }
    fields.set(tag, value)
  }
  if (chunks[index]?.op !== OP.OP_ENDIF) throw malformed('missing OP_ENDIF')
  return { fields, body, end: index }
}

/** Decodes a content-type field as UTF-8; undefined when absent or not valid UTF-8. */
function decodeContentType(bytes: number[] | undefined): string | undefined {
  if (bytes === undefined) return undefined
  try {
    return toUTF8(bytes)
  } catch {
    return undefined
  }
}

/** Parses an envelope body as a JSON object. */
function parseJsonObject(body: number[]): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(toUTF8(body))
  } catch {
    throw malformed('invalid JSON payload')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw malformed('invalid JSON payload')
  return parsed as Record<string, unknown>
}

export class Bsv21Token {
  static isBsv21(script: LockingScript): boolean {
    try {
      Bsv21Token.decode(script)
      return true
    } catch {
      return false
    }
  }

  /**
   * Locates the first `OP_FALSE OP_IF "ord"` envelope anywhere in the script and reads its
   * fields. Returns undefined when the script has no envelope.
   * @throws when an envelope is present but malformed (a bad field, no value, no OP_ENDIF).
   */
  static envelope(script: LockingScript): Bsv21Envelope | undefined {
    const chunks = script.chunks
    const start = chunks.findIndex(
      (chunk, index) =>
        chunk.op === OP.OP_0 && chunks[index + 1]?.op === OP.OP_IF && isOrd(chunks[index + 2])
    )
    if (start === -1) return undefined
    const { fields, body, end } = readEnvelopeFields(chunks, start + 3)
    let rest = chunks.slice(end + 1)
    if (rest[0]?.op === OP.OP_CODESEPARATOR) rest = rest.slice(1)
    const contentType = decodeContentType(fields.get(CONTENT_TYPE_FIELD))
    return {
      fields,
      contentType,
      body,
      lockingScript: new LockingScript([...chunks.slice(0, start), ...rest])
    }
  }

  /**
   * Decodes a BSV-21 locking script.
   * @throws if the script is not a recognisable BSV-21 output.
   */
  static decode(script: LockingScript): Bsv21TokenDecoded {
    const envelope = Bsv21Token.envelope(script)
    if (envelope === undefined) throw malformed('missing OP_FALSE OP_IF "ord" envelope')
    if (envelope.contentType !== CONTENT_TYPE) throw malformed('wrong content-type')
    if (envelope.body === undefined) throw malformed('missing JSON payload')
    const payload = parseJsonObject(envelope.body)
    if (payload.p !== 'bsv-20') throw malformed('not bsv-20')

    const op = typeof payload.op === 'string' ? payload.op : ''
    const authority = op === 'auth' || op === 'deploy+auth'
    const amt = authority ? '0' : payload.amt
    if (authority && payload.amt !== undefined)
      throw malformed('an authority output carries no amount')
    if (typeof amt !== 'string' || !/^\d+$/.test(amt)) throw malformed('bad amount')

    const isMint = op === 'deploy+mint'
    const deploy = isMint || op === 'deploy+auth'
    const id = !deploy && typeof payload.id === 'string' ? payload.id : ''
    const owner = p2pkhHash(envelope.lockingScript.chunks)

    return {
      id,
      amt,
      dec: parseDecimals(payload),
      sym: typeof payload.sym === 'string' ? payload.sym : undefined,
      icon: typeof payload.icon === 'string' ? payload.icon : undefined,
      isMint,
      ownerHash160: owner === undefined ? '' : toHex(owner),
      op,
      payload,
      lockingScript: envelope.lockingScript
    }
  }
}
