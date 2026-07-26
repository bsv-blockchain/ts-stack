import { StasToken } from '../StasToken.js'
import { LockingScript } from '@bsv/sdk'

// Build a synthetic classic STAS script matching stas-js CreateContract shape:
//   76a914 <owner_pkh:20> 88ac69 <engine> 6a <flags push> <symbol push> <data>
const ownerHash160 = 'ab'.repeat(20)
const engine = 'ac'.repeat(8) // opaque filler, deliberately free of 0x6a bytes
const flagsPush = '0100' // push 1 byte: flags = 0x00
const symbolPush = '04' + '54455354' // push 4 bytes: "TEST"
const stasHex = `76a914${ownerHash160}88ac69${engine}6a${flagsPush}${symbolPush}`

describe('StasToken.decode', () => {
  it('recovers owner, symbol, flags, and assetId from a classic STAS script', () => {
    const decoded = StasToken.decode(LockingScript.fromHex(stasHex))
    expect(decoded.ownerHash160).toBe(ownerHash160)
    expect(decoded.symbol).toBe('TEST')
    expect(decoded.assetId).toBe('TEST')
    expect(decoded.flagsHex).toBe('00')
  })

  it('isStas is true for a STAS script and false for plain P2PKH', () => {
    const p2pkh = `76a914${ownerHash160}88ac`
    expect(StasToken.isStas(LockingScript.fromHex(stasHex))).toBe(true)
    expect(StasToken.isStas(LockingScript.fromHex(p2pkh))).toBe(false)
  })

  it('throws when the STAS marker is absent (long P2PKH-like script)', () => {
    // ≥56 hex chars, starts with the P2PKH prefix but lacks the 88ac69 marker.
    const notStas = `76a914${ownerHash160}88accccccccccc`
    expect(() => StasToken.decode(LockingScript.fromHex(notStas))).toThrow(/STAS marker/)
  })

  it('throws when the P2PKH prefix is absent', () => {
    expect(() => StasToken.decode(LockingScript.fromHex('6a0048656c6c6f'))).toThrow(/STAS/)
  })

  it('falls back to a script-derived assetId when no symbol is present', () => {
    // OP_RETURN with only a flags push, no symbol slot.
    const noSymbol = `76a914${ownerHash160}88ac69${engine}6a${flagsPush}`
    const decoded = StasToken.decode(LockingScript.fromHex(noSymbol))
    expect(decoded.symbol).toBeNull()
    expect(decoded.assetId).toMatch(/^stas:/)
  })

  it('removes control characters from the decoded symbol', () => {
    const symbolWithSpace = '05' + '2054455354'
    const decoded = StasToken.decode(
      LockingScript.fromHex(`76a914${ownerHash160}88ac69${engine}6a${flagsPush}${symbolWithSpace}`)
    )

    expect(decoded.symbol).toBe('TEST')
  })
})
