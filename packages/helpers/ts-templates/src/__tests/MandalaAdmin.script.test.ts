import { MandalaAdmin } from '../MandalaAdmin.js'
import { ProtoWallet, PrivateKey, OP } from '@bsv/sdk'

describe('MandalaAdmin lock/decode', () => {
  const wallet = new ProtoWallet(PrivateKey.fromRandom())
  const data = { kind: 'register', assetId: `${'a'.repeat(64)}.0` } as const

  it('builds a standard P2PKH script (OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG)', async () => {
    const script = await MandalaAdmin.lock({ wallet: wallet as any, data })
    const ops = script.chunks.map(c => c.op)
    expect(ops).toEqual([OP.OP_DUP, OP.OP_HASH160, 20, OP.OP_EQUALVERIFY, OP.OP_CHECKSIG])
    expect(script.chunks[2].data?.length).toBe(20)
  })

  it('decode returns the pubKeyHash', async () => {
    const script = await MandalaAdmin.lock({ wallet: wallet as any, data })
    const decoded = MandalaAdmin.decode(script)
    expect(decoded.pubKeyHash).toEqual(script.chunks[2].data)
  })

  it('decode throws on non-admin scripts', () => {
    expect(() => MandalaAdmin.decode({ chunks: [{ op: 0x00 }] } as any)).toThrow()
  })

  it('decode throws when the hash push is not 20 bytes', async () => {
    const script = await MandalaAdmin.lock({ wallet: wallet as any, data })
    script.chunks[2] = { op: 19, data: new Array(19).fill(1) }
    expect(() => MandalaAdmin.decode(script)).toThrow()
  })
})
