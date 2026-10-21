import { LockingScript, OP } from '@bsv/sdk/script'
import { Bsv21Binary, Bsv21BinaryError } from '../Bsv21Binary.js'
import { OneColor } from '../OneColor.js'

const TXID = 'ab'.repeat(31) + 'cd'
const PKH = Array.from({ length: 20 }, (_, i) => i + 1)

describe('OneColor', () => {
  it('writes the same bytes as Bsv21Binary for a 32-byte id', () => {
    expect(new OneColor().lock(`${TXID}_0`, 500n, PKH).toHex()).toBe(
      new Bsv21Binary().lock(`${TXID}_0`, 500n, PKH).toHex()
    )
    expect(new OneColor().lock(null, 7n, PKH, [1, 2]).toHex()).toBe(
      new Bsv21Binary().lock(null, 7n, PKH, [1, 2]).toHex()
    )
  })

  it('round-trips a 36-byte legacy id as txid in natural order and little-endian vout', () => {
    const id = `${TXID}_258`
    const wire = OneColor.tokenIdFromString(id)
    expect(wire).toHaveLength(36)
    expect(wire.slice(0, 32)).toEqual(OneColor.tokenIdFromString(`${TXID}_0`))
    expect(wire.slice(32)).toEqual([0x02, 0x01, 0, 0])
    expect(OneColor.tokenIdToString(wire)).toBe(id)
    const decoded = OneColor.decode(new OneColor().lock(id, 9n, PKH))
    expect(decoded.role).toBe('value')
    expect(decoded.amount).toBe(9n)
    expect(OneColor.tokenIdToString(decoded.tokenId!)).toBe(id)
    expect(decoded.restPubKeyHash).toEqual(PKH)
  })

  it('reads the maximum vout and rejects one beyond uint32', () => {
    const id = `${TXID}_4294967295`
    expect(OneColor.tokenIdToString(OneColor.tokenIdFromString(id))).toBe(id)
    expect(() => OneColor.tokenIdFromString(`${TXID}_4294967296`)).toThrow('exceeds uint32')
  })

  it('rejects a 36-byte id whose vout is 0', () => {
    const wire = [...OneColor.tokenIdFromString(`${TXID}_0`), 0, 0, 0, 0]
    expect(() => OneColor.tokenIdToString(wire)).toThrow('non-canonical')
    const script = new LockingScript([
      { op: 36, data: wire },
      { op: OP.OP_5 },
      { op: OP.OP_2DROP },
      { op: OP.OP_TRUE }
    ])
    expect(() => OneColor.decode(script)).toThrow(Bsv21BinaryError)
    expect(() => OneColor.decode(script)).toThrow('non-canonical')
  })

  it('rejects other id lengths and malformed id strings', () => {
    const script = new LockingScript([
      { op: 20, data: PKH },
      { op: OP.OP_5 },
      { op: OP.OP_2DROP },
      { op: OP.OP_TRUE }
    ])
    expect(() => OneColor.decode(script)).toThrow('32- or 36-byte')
    expect(() => OneColor.tokenIdToString(PKH)).toThrow('32 or 36 bytes')
    for (const id of [`${TXID}_01`, `${TXID.toUpperCase()}_1`, `${TXID}.1`, 'ab_1']) {
      expect(() => OneColor.tokenIdFromString(id)).toThrow('<64 lowercase hex>_<vout>')
    }
  })

  it('leaves Bsv21Binary rejecting 36-byte ids', () => {
    const script = new OneColor().lock(`${TXID}_3`, 9n, PKH)
    expect(() => Bsv21Binary.decode(script)).toThrow('direct 32-byte push')
  })

  it('locks to a wallet-derived key and unlocks with P2PKH', async () => {
    const publicKey = '02' + '11'.repeat(32)
    const wallet = { getPublicKey: async () => ({ publicKey }) }
    const template = new OneColor(wallet as never, 'app.example')
    const script = await template.lockBRC29(`${TXID}_2`, 3n, [2, 'p color'], 'color', 'self')
    expect(OneColor.decode(script).restPubKeyHash).toHaveLength(20)
    await expect(
      new OneColor().lockBRC29(null, 1n, [2, 'p color'], 'color', 'self')
    ).rejects.toThrow('requires a wallet')
    expect(typeof template.unlock({} as never).sign).toBe('function')
  })
})
