import { LockingScript, Utils } from '@bsv/sdk'

/**
 * StasToken — decoder for **classic STAS** (legacy P2STAS / STAS 1.0) locking
 * scripts. Unlike {@link MandalaToken}, classic STAS is satoshi-denominated:
 * the token amount IS the output's satoshi value, so this template only
 * recovers the on-chain *identity* fields (owner PKH + symbol). The amount is
 * read from the containing output by the caller.
 *
 * Script shape produced by stas-js CreateContract:
 *
 *   76a914 <owner_pkh:20> 88ac69 <engine ~2.9KB> 6a <flags> <symbol> <data...>
 *
 * The owner hash160 sits at the well-known P2PKH-like prefix. The engine body
 * is large and opaque (and may contain incidental `6a` bytes), so the OP_RETURN
 * trailer is located by scanning from the end, matching the wallet's
 * `parseClassicStasMetadata` source of truth.
 *
 * Building/unlocking classic STAS scripts is the stas-js engine's job; this
 * template is decode-only.
 */

export interface StasTokenDecoded {
  /** Token identity used for indexing + conservation grouping (the symbol). */
  assetId: string
  /** Token symbol parsed from the OP_RETURN trailer, or null if absent. */
  symbol: string | null
  /** Owner public-key hash (20-byte hex) from the P2PKH-like prefix. */
  ownerHash160: string
  /** Flags byte (hex) from the OP_RETURN trailer, or null if absent. */
  flagsHex: string | null
}

const P2PKH_PREFIX = '76a914'
const STAS_MARKER = '88ac69'

interface PushLength { len: number, dataStart: number }

/** Resolves a push opcode's payload length + data offset, or null for a non-push opcode. */
function pushDataLength (scriptHex: string, opcode: number, pos: number): PushLength | null {
  if (opcode >= 0x01 && opcode <= 0x4b) return { len: opcode, dataStart: pos }
  if (opcode === 0x4c) {
    if (pos + 2 > scriptHex.length) return null
    return { len: Number.parseInt(scriptHex.substring(pos, pos + 2), 16), dataStart: pos + 2 }
  }
  if (opcode === 0x4d) {
    if (pos + 4 > scriptHex.length) return null
    const b1 = scriptHex.substring(pos, pos + 2)
    const b2 = scriptHex.substring(pos + 2, pos + 4)
    return { len: Number.parseInt(b2 + b1, 16), dataStart: pos + 4 }
  }
  if (opcode === 0x4e) {
    if (pos + 8 > scriptHex.length) return null
    const b1 = scriptHex.substring(pos, pos + 2)
    const b2 = scriptHex.substring(pos + 2, pos + 4)
    const b3 = scriptHex.substring(pos + 4, pos + 6)
    const b4 = scriptHex.substring(pos + 6, pos + 8)
    return { len: Number.parseInt(b4 + b3 + b2 + b1, 16), dataStart: pos + 8 }
  }
  return null
}

/** Reads push-data slots starting at a hex offset (after OP_RETURN). */
function readPushes (scriptHex: string, startPos: number, max = 8): string[] {
  const pushes: string[] = []
  let pos = startPos
  while (pos < scriptHex.length && pushes.length < max) {
    if (pos + 2 > scriptHex.length) break
    const opcode = Number.parseInt(scriptHex.substring(pos, pos + 2), 16)
    if (Number.isNaN(opcode)) break
    pos += 2
    if (opcode === 0) {
      pushes.push('')
      continue
    }
    const push = pushDataLength(scriptHex, opcode, pos)
    if (push === null) break // non-push opcode (or truncated length) after OP_RETURN — stop
    pushes.push(scriptHex.substring(push.dataStart, push.dataStart + push.len * 2))
    pos = push.dataStart + push.len * 2
  }
  return pushes
}

function hexToUtf8 (hex: string): string {
  if (hex === '') return ''
  try {
    return Utils.toUTF8(Utils.toArray(hex, 'hex'))
  } catch {
    return ''
  }
}

export class StasToken {
  /** True if the script carries the classic STAS prefix + marker. */
  static isStas (script: LockingScript): boolean {
    const hex = script.toHex()
    return hex.startsWith(P2PKH_PREFIX) && hex.substring(46, 52) === STAS_MARKER
  }

  /**
   * Decodes a classic STAS locking script into its identity fields.
   * @throws if the script is not a classic STAS script.
   */
  static decode (script: LockingScript): StasTokenDecoded {
    const hex = script.toHex()
    if (hex.length < 56) throw new Error('not a STAS script: too short')
    if (!hex.startsWith(P2PKH_PREFIX)) throw new Error('not a STAS script: missing P2PKH prefix')
    if (hex.substring(46, 52) !== STAS_MARKER) throw new Error('not a STAS script: missing STAS marker')

    const ownerHash160 = hex.substring(6, 46)

    // OP_RETURN (0x6a) is placed by CreateContract as the last opcode before
    // the data region. The engine body may contain incidental 0x6a bytes, so
    // scan from the back.
    const opReturnIdx = hex.lastIndexOf('6a')
    let symbol: string | null = null
    let flagsHex: string | null = null
    if (opReturnIdx >= 0) {
      const pushes = readPushes(hex, opReturnIdx + 2)
      // Layout after OP_RETURN: [flagsByte, symbol, data, ...].
      flagsHex = pushes[0]?.length === 2 ? pushes[0] : null
      const symbolHex = pushes[1] ?? null
      symbol = (symbolHex != null && symbolHex !== '')
        ? (Array.from(hexToUtf8(symbolHex))
            .filter(character => (character.codePointAt(0) ?? 0) > 0x20)
            .join('')
            .trim() || null)
        : null
    }

    // assetId groups inputs/outputs of the same token for conservation. The
    // symbol is the only identity carried in a classic STAS script; tokens
    // with no symbol fall back to the owner-agnostic script tail hash so the
    // grouping is still stable within a single transfer.
    const assetId = symbol ?? `stas:${hex.substring(52, 68)}`

    return { assetId, symbol, ownerHash160, flagsHex }
  }
}
