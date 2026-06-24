import { DstasToken } from '../DstasToken'
import { LockingScript } from '@bsv/sdk'
import { DSTAS_PLAIN_HEX, DSTAS_FROZEN_HEX, DSTAS_OWNER, DSTAS_TOKEN_ID } from './dstas-fixtures'

describe('DstasToken.decode (against real dxs-bsv-token-sdk output)', () => {
  it('recovers owner, tokenId, flags from a real DSTAS script', () => {
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
    expect(DstasToken.isDstas(LockingScript.fromHex(`76a914${DSTAS_OWNER}88ac69` + 'ac'.repeat(8)))).toBe(false)
  })

  it('throws on a short / non-DSTAS script', () => {
    expect(() => DstasToken.decode(LockingScript.fromHex(`14${DSTAS_OWNER}00`))).toThrow(/DSTAS/)
  })
})
