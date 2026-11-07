import { LockingScript, OP, P2PKH } from '@bsv/sdk'
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

describe('OneColor.lockRemainder', () => {
  const pushDrop = new LockingScript([{ op: OP.OP_5 }, { op: OP.OP_DROP }, { op: OP.OP_TRUE }])

  it('writes OP_0 OP_DROP before a remainder that starts with <push> OP_DROP (0162:105)', () => {
    const s = OneColor.lockRemainder(`${TXID}_0`, 500n, pushDrop)
    expect(s.toHex().endsWith('6d' + '0075' + '557551')).toBe(true)
    const d = OneColor.decode(s)
    expect(d.payload).toEqual([])
    expect(d.amount).toBe(500n)
    expect(d.role).toBe('value')
    expect(new LockingScript(d.restChunks).toHex()).toBe(pushDrop.toHex())
  })

  it.each([
    ['OP_0', OP.OP_0],
    ['OP_1NEGATE', OP.OP_1NEGATE],
    ['OP_1', OP.OP_1],
    ['OP_16', OP.OP_16]
  ])(
    'RF4: a remainder starting %s OP_DROP decodes with payload [] and the remainder intact',
    (_, op) => {
      const r = new LockingScript([{ op }, { op: OP.OP_DROP }, { op: OP.OP_TRUE }])
      const d = OneColor.decode(OneColor.lockRemainder(`${TXID}_0`, 3n, r))
      expect(d.payload).toEqual([])
      expect(new LockingScript(d.restChunks).toHex()).toBe(r.toHex())
    }
  )

  it('RF4: keeps a non-minimal remainder byte-exact', () => {
    const r = LockingScript.fromHex('4c01077551') // OP_PUSHDATA1 0x07, OP_DROP, OP_1
    const s = OneColor.lockRemainder(null, 0n, r)
    expect(s.toHex()).toBe('00' + '00' + '6d' + '0075' + '4c01077551')
    expect(new LockingScript(OneColor.decode(s).restChunks).toHex()).toBe('4c01077551')
  })

  it('equals lock() for a P2PKH remainder (no marker)', () => {
    for (const [id, amt, payload] of [
      [`${TXID}_0`, 500n, undefined],
      [null, 7n, [1, 2]],
      [`${TXID}_258`, 0n, undefined]
    ] as const) {
      expect(OneColor.lockRemainder(id, amt, new P2PKH().lock(PKH), payload as never).toHex()).toBe(
        new OneColor().lock(id, amt, PKH, payload as never).toHex()
      )
    }
  })

  it('an explicit payload replaces the marker; an explicit [] writes OP_0 OP_DROP', () => {
    const d = OneColor.decode(OneColor.lockRemainder(`${TXID}_0`, 9n, pushDrop, [1, 2]))
    expect(d.payload).toEqual([1, 2])
    expect(new LockingScript(d.restChunks).toHex()).toBe(pushDrop.toHex())
    expect(OneColor.lockRemainder(`${TXID}_0`, 9n, new P2PKH().lock(PKH), []).toHex()).toContain(
      '6d0075'
    )
  })

  it('validates id and amount like lock()', () => {
    expect(() => OneColor.lockRemainder(`${TXID}_0`, 1n << 64n, pushDrop)).toThrow(Bsv21BinaryError)
    expect(() => OneColor.lockRemainder('x_0', 1n, pushDrop)).toThrow('<64 lowercase hex>_<vout>')
  })

  it('rejects a remainder that ends in a truncated push, as decode would', () => {
    // 05 0102: a 5-byte push with only two bytes left.
    const truncated = LockingScript.fromHex('7551' + '050102')
    expect(truncated.chunks.some(chunk => chunk.invalidLength === true)).toBe(true)
    expect(() => OneColor.lockRemainder(`${TXID}_0`, 1n, truncated)).toThrow('truncated push')
    expect(() => OneColor.lockRemainder(null, 0n, truncated, [1])).toThrow(Bsv21BinaryError)
  })

  it('never aliases the remainder chunks or their data', () => {
    const r = LockingScript.fromHex('020102' + '75' + '51')
    const s = OneColor.lockRemainder(`${TXID}_0`, 1n, r)
    const before = r.toHex()
    s.chunks[s.chunks.length - 3].data![0] = 0xff
    s.chunks.push({ op: OP.OP_NOP })
    expect(r.toHex()).toBe(before)
    expect(r.chunks).toHaveLength(3)
  })
})
