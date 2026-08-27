import { DstasToken } from '../DstasToken.js'
import { LockingScript } from '@bsv/sdk'

const DSTAS_OWNER = '11'.repeat(20)
const DSTAS_TOKEN_ID = '22'.repeat(20)

// First-party structural fixture. The repeated OP_1 body is deliberately
// synthetic: the decoder only relies on the documented framing fields and
// minimum engine length, not a copied or generated third-party script body.
function syntheticDstasHex(action = '00'): string {
  return `14${DSTAS_OWNER}${action}${'51'.repeat(2000)}6a14${DSTAS_TOKEN_ID}0103`
}

const DSTAS_PLAIN_HEX = syntheticDstasHex()
const DSTAS_FROZEN_HEX = syntheticDstasHex('52')

describe('DstasToken.decode (first-party structural fixtures)', () => {
  it('recovers owner, tokenId, and flags from a DSTAS-shaped script', () => {
    const d = DstasToken.decode(LockingScript.fromHex(DSTAS_PLAIN_HEX))
    expect(d.ownerHash160).toBe(DSTAS_OWNER)
    expect(d.tokenId).toBe(DSTAS_TOKEN_ID)
    expect(d.assetId).toBe(DSTAS_TOKEN_ID)
    expect(d.flagsHex).toBe('03')
    expect(d.freezeEnabled).toBe(true)
    expect(d.confiscationEnabled).toBe(true)
    expect(d.frozen).toBe(false)
  })

  it('detects the frozen marker (OP_2 action data)', () => {
    const d = DstasToken.decode(LockingScript.fromHex(DSTAS_FROZEN_HEX))
    expect(d.frozen).toBe(true)
    expect(d.tokenId).toBe(DSTAS_TOKEN_ID)
  })

  it('isDstas is true for DSTAS, false for plain P2PKH and classic STAS', () => {
    expect(DstasToken.isDstas(LockingScript.fromHex(DSTAS_PLAIN_HEX))).toBe(true)
    expect(DstasToken.isDstas(LockingScript.fromHex(`76a914${DSTAS_OWNER}88ac`))).toBe(false)
    // classic STAS prefix is 76a914… not a 20-byte owner push, and short.
    expect(
      DstasToken.isDstas(LockingScript.fromHex(`76a914${DSTAS_OWNER}88ac69` + 'ac'.repeat(8)))
    ).toBe(false)
  })

  it('throws on a short / non-DSTAS script', () => {
    expect(() => DstasToken.decode(LockingScript.fromHex(`14${DSTAS_OWNER}00`))).toThrow(/DSTAS/)
  })

  it('rejects a long script without the owner push opcode', () => {
    const malformed = `15${DSTAS_PLAIN_HEX.slice(2)}`

    expect(() => DstasToken.decode(LockingScript.fromHex(malformed))).toThrow(
      'missing 20-byte owner push'
    )
  })

  it('detects the pushed frozen action marker', () => {
    const pushedFrozenMarker = `${DSTAS_PLAIN_HEX.slice(0, 42)}0102${DSTAS_PLAIN_HEX.slice(44)}`

    expect(DstasToken.decode(LockingScript.fromHex(pushedFrozenMarker)).frozen).toBe(true)
  })
})
