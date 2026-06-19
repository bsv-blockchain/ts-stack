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

  it('produces a P2PKH tail (OP_DUP OP_HASH160 ... OP_EQUALVERIFY OP_CHECKSIG)', () => {
    const script = new MandalaToken().lock(assetId, 1, pubKeyHash)
    const ops = script.chunks.map(c => c.op)
    expect(ops.slice(-5)).toEqual([0x76, 0xa9, 20, 0x88, 0xac])
  })

  it('throws when decoding a non-Mandala script', () => {
    const p2pkh = new MandalaToken().lock(assetId, 1, pubKeyHash)
    const broken = new (p2pkh.constructor as any)()
    expect(() => MandalaToken.decode({ chunks: [{ op: 0x00 }] } as any)).toThrow()
    void broken
  })
})
