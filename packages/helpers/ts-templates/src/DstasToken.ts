import { LockingScript } from '@bsv/sdk'

/**
 * DstasToken — decoder for DSTAS (Divisible STAS / STAS 3.0) locking scripts.
 *
 * DSTAS uses the dxs-bsv-token-sdk template:
 *
 *   <owner pkh:20> <action data> [ENGINE ~2.9KB] OP_RETURN
 *     <redemption/protoID pkh:20 = tokenId> <flags> <service field per flag> <optional data...>
 *
 * Unlike the dxs SDK's full `LockingScriptReader` (which template-matches the
 * whole body), this is a minimal *structural* recogniser sufficient for an
 * overlay indexer: it extracts the owner, the tokenId (redemption pkh), the
 * flags, and the frozen marker. DSTAS is satoshi-denominated, so the token
 * amount is the containing output's satoshi value (read by the caller).
 *
 * Recognition signals (validated against real dxs SDK output):
 *  - the script opens with a 20-byte push (the owner) — `14 <20 bytes>`;
 *  - the body is large (the ~2.9KB engine);
 *  - `6a 14 <20 bytes>` (OP_RETURN + redemption push) appears once, near the
 *    end — the engine body contains no `6a14`.
 *
 * Decode-only; building DSTAS scripts is the dxs SDK's job.
 */

export interface DstasTokenDecoded {
  /** Token identity for indexing + conservation — the redemption/protoID pkh. */
  assetId: string
  /** Same value as assetId; the redemption (protoID) pkh, hex. */
  tokenId: string
  /** Owner public-key hash (20-byte hex). */
  ownerHash160: string
  /** Flags byte(s), hex (bit 0x01 = freezable, 0x02 = confiscatable). */
  flagsHex: string
  freezeEnabled: boolean
  confiscationEnabled: boolean
  /** True when the action-data marker indicates a frozen UTXO. */
  frozen: boolean
}

const OWNER_PUSH_OP = '14' // push 20 bytes
// DSTAS scripts carry the ~2.9KB engine; anything smaller is not DSTAS.
const MIN_HEX_LEN = 4000

function isSinglePush (op: string): boolean {
  const code = parseInt(op, 16)
  return code >= 0x01 && code <= 0x4b
}

export class DstasToken {
  static isDstas (script: LockingScript): boolean {
    try {
      DstasToken.decode(script)
      return true
    } catch {
      return false
    }
  }

  /**
   * Decodes a DSTAS locking script's identity fields.
   * @throws if the script is not a recognisable DSTAS script.
   */
  static decode (script: LockingScript): DstasTokenDecoded {
    const hex = script.toHex().toLowerCase()
    if (hex.length < MIN_HEX_LEN) throw new Error('not a DSTAS script: too short')
    if (!hex.startsWith(OWNER_PUSH_OP)) throw new Error('not a DSTAS script: missing 20-byte owner push')

    const ownerHash160 = hex.substring(2, 42)

    // OP_RETURN (0x6a) + redemption push (0x14) — unique in a DSTAS body.
    const ri = hex.lastIndexOf('6a14')
    if (ri < 0) throw new Error('not a DSTAS script: missing OP_RETURN + redemption')
    const tokenId = hex.substring(ri + 4, ri + 44)
    if (tokenId.length !== 40) throw new Error('not a DSTAS script: truncated redemption')

    // Flags push immediately follows the redemption push.
    let flagsHex = ''
    const flagsLenOp = hex.substring(ri + 44, ri + 46)
    if (isSinglePush(flagsLenOp)) {
      const len = parseInt(flagsLenOp, 16)
      flagsHex = hex.substring(ri + 46, ri + 46 + len * 2)
    }
    const flagsByte = flagsHex.length >= 2 ? parseInt(flagsHex.substring(0, 2), 16) : 0
    const freezeEnabled = (flagsByte & 0x01) !== 0
    const confiscationEnabled = (flagsByte & 0x02) !== 0

    // Action-data marker sits right after the owner push:
    //   OP_0 (00) = neutral; OP_2 (52) = frozen; push prefixed 0x02 = frozen.
    const actionOp = hex.substring(42, 44)
    const frozen =
      actionOp === '52' ||
      (isSinglePush(actionOp) && hex.substring(44, 46) === '02')

    return {
      assetId: tokenId,
      tokenId,
      ownerHash160,
      flagsHex,
      freezeEnabled,
      confiscationEnabled,
      frozen
    }
  }
}
