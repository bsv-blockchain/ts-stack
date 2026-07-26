import { MandalaAdmin, ADMIN_PROTOCOL } from '../MandalaAdmin.js'

describe('MandalaAdmin canonicalize/commitment', () => {
  it('is insensitive to key ordering', () => {
    const a = MandalaAdmin.canonicalize({ kind: 'issue', amount: 5, assetId: 'x.0' } as any)
    const b = MandalaAdmin.canonicalize({ assetId: 'x.0', kind: 'issue', amount: 5 } as any)
    expect(a).toBe(b)
  })

  it('orders nested object keys', () => {
    const s = MandalaAdmin.canonicalize({ kind: 'issue', meta: { z: 1, a: 2 } } as any)
    expect(s).toBe('{"kind":"issue","meta":{"a":2,"z":1}}')
  })

  it('produces a stable 64-hex commitment', () => {
    const c = MandalaAdmin.commitment({ kind: 'register', assetId: 'x.0' })
    expect(c).toMatch(/^[0-9a-f]{64}$/)
    expect(c).toBe(MandalaAdmin.commitment({ assetId: 'x.0', kind: 'register' } as any))
  })

  it('locks the output to keyID = commitment(data) with counterparty self by default', async () => {
    const calls: any[] = []
    const wallet: any = {
      getPublicKey: async (args: any) => {
        calls.push(args)
        return { publicKey: '02' + 'a'.repeat(64) }
      }
    }
    const data = { kind: 'issue', assetId: 'x.0', amount: 10 } as const
    await MandalaAdmin.lock({ wallet, data })
    expect(calls[0].protocolID).toEqual(ADMIN_PROTOCOL)
    expect(calls[0].keyID).toBe(MandalaAdmin.commitment(data))
    expect(calls[0].counterparty).toBe('self')
  })
})
