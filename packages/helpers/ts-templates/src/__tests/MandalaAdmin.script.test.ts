import { MandalaAdmin } from '../MandalaAdmin.js'
import { ProtoWallet, PrivateKey, OP, Utils } from '@bsv/sdk'

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
    script.chunks[2] = { op: 19, data: Array.from({ length: 19 }, () => 1) }
    expect(() => MandalaAdmin.decode(script)).toThrow()
  })

  it('embeds publicData as <push JSON> OP_DROP before the P2PKH', async () => {
    const script = await MandalaAdmin.lock({ wallet: wallet as any, data, publicData: { label: 'Gold' } })
    const ops = script.chunks.map(c => c.op)
    expect(ops.slice(1)).toEqual([OP.OP_DROP, OP.OP_DUP, OP.OP_HASH160, 20, OP.OP_EQUALVERIFY, OP.OP_CHECKSIG])
    expect(JSON.parse(Utils.toUTF8(script.chunks[0].data as number[]))).toEqual({ label: 'Gold' })
  })

  it('decode round-trips publicData and pubKeyHash (7-chunk)', async () => {
    const script = await MandalaAdmin.lock({ wallet: wallet as any, data, publicData: { label: 'Gold', ticker: 'GLD' } })
    const decoded = MandalaAdmin.decode(script)
    expect(decoded.pubKeyHash).toEqual(script.chunks[4].data)
    expect(decoded.publicData).toEqual({ label: 'Gold', ticker: 'GLD' })
  })

  it('decode returns no publicData for a plain 5-chunk admin script', async () => {
    const script = await MandalaAdmin.lock({ wallet: wallet as any, data })
    const decoded = MandalaAdmin.decode(script)
    expect(decoded.pubKeyHash).toEqual(script.chunks[2].data)
    expect(decoded.publicData).toBeUndefined()
  })

  it('decode rejects a 7-chunk script whose second op is not OP_DROP', async () => {
    const script = await MandalaAdmin.lock({ wallet: wallet as any, data, publicData: { label: 'X' } })
    script.chunks[1] = { op: OP.OP_DUP }
    expect(() => MandalaAdmin.decode(script)).toThrow()
  })
})
