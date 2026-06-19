import { MandalaAdmin } from '../MandalaAdmin.js'
import { PrivateKey, OP } from '@bsv/sdk'

describe('MandalaAdmin lock/decode', () => {
  it('round-trips the boundKey and has the ! OP_DROP <key> OP_CHECKSIG shape', () => {
    const boundKey = PrivateKey.fromRandom().toPublicKey().toString()
    const admin = new MandalaAdmin({} as any)
    const script = admin.lock(boundKey)
    const ops = script.chunks.map(c => c.op)
    expect(script.chunks[0].data).toEqual([0x21])
    expect(ops[1]).toBe(OP.OP_DROP)
    expect(ops[3]).toBe(OP.OP_CHECKSIG)
    expect(MandalaAdmin.decode(script).boundKey).toBe(boundKey)
  })

  it('decode throws on non-admin scripts', () => {
    expect(() => MandalaAdmin.decode({ chunks: [{ op: 0x00 }] } as any)).toThrow()
  })
})
