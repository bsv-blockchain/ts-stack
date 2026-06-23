import { MandalaToken } from '../MandalaToken'
import { Hash, PrivateKey } from '@bsv/sdk'

describe('MandalaToken lock/decode', () => {
  const assetId = `${'a'.repeat(64)}.0`
  const pubKeyHash = Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])

  it('builds a script that decodes back to its inputs', () => {
    const script = new MandalaToken().lock(assetId, 1000, pubKeyHash)
    const decoded = MandalaToken.decode(script)
    expect(decoded.assetId).toBe(assetId)
    expect(decoded.amount).toBe(1000)
    expect(decoded.pubKeyHash).toEqual(pubKeyHash)
  })

  // Regression: amounts 1..16 are minimally encoded as OP_1..OP_16 opcodes (no
  // data bytes) by createMinimallyEncodedScriptChunk. decode must read those
  // back, not mis-read them as 0 and reject the script as a bad amount.
  it('round-trips small amounts encoded as OP_N opcodes (1..16)', () => {
    for (let amount = 1; amount <= 16; amount++) {
      const script = new MandalaToken().lock(assetId, amount, pubKeyHash)
      const decoded = MandalaToken.decode(script)
      expect(decoded.amount).toBe(amount)
    }
  })

  it('round-trips the boundary amount 17 (first data-push encoding)', () => {
    const decoded = MandalaToken.decode(new MandalaToken().lock(assetId, 17, pubKeyHash))
    expect(decoded.amount).toBe(17)
  })

  it('produces a P2PKH tail (OP_DUP OP_HASH160 ... OP_EQUALVERIFY OP_CHECKSIG)', () => {
    const script = new MandalaToken().lock(assetId, 1, pubKeyHash)
    const ops = script.chunks.map(c => c.op)
    expect(ops.slice(-5)).toEqual([0x76, 0xa9, 20, 0x88, 0xac])
  })

  it('throws when decoding a non-Mandala script', () => {
    expect(() => MandalaToken.decode({ chunks: [{ op: 0x00 }] } as any)).toThrow()
  })

  it('decode throws when the amount chunk is empty/zero', () => {
    const assetId = `${'a'.repeat(64)}.0`
    const pkh = new Array(20).fill(1)
    const script = new MandalaToken().lock(assetId, 5, pkh)
    // Replace the amount push (chunk index 2) with an empty (OP_0) push.
    script.chunks[2] = { op: 0 }
    expect(() => MandalaToken.decode(script)).toThrow()
  })

  it('decode rejects a non-minimal (PUSHDATA1) marker encoding', () => {
    const assetId = `${'a'.repeat(64)}.0`
    const pkh = new Array(20).fill(1)
    const script = new MandalaToken().lock(assetId, 5, pkh)
    // Re-encode the marker push (chunk 0) as PUSHDATA1 of the same byte.
    script.chunks[0] = { op: 0x4c, data: [0x21] }
    expect(() => MandalaToken.decode(script)).toThrow()
  })
})
