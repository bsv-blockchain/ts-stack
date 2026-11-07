import { beforeEach, describe, expect, it } from '@jest/globals'
import { Transaction, type ListOutputsResult } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { ColorPermissionModule } from '../ColorPermissionModule.js'
import { assetBasket, assetTag } from '../identifiers.js'
import type { RequiredProfileHandler } from '../profiles.js'
import type { ColorModuleStore } from '../types.js'
import { FakeProvider, FakeWallet, tokenPayment } from './fixtures.js'
import { A141A, exampleProfile, FakeStore, fixtureDeploy, TestModule } from './profileFixtures.js'

const APP = 'app.example'
const next = async (args: unknown): Promise<unknown> => args

async function listing(
  module: ColorPermissionModule,
  args: Record<string, unknown>
): Promise<ListOutputsResult> {
  return (await module.handleRequest(
    { method: 'listOutputs', originator: APP, args: { ...args } },
    next
  )) as ListOutputsResult
}

/** The `p color assets` listing with tags, keyed by outpoint. */
async function views(
  module: ColorPermissionModule,
  extra: Record<string, unknown> = {}
): Promise<Map<string, { spendable: boolean; tags?: string[] }>> {
  const result = await listing(module, { basket: 'p color assets', includeTags: true, ...extra })
  return new Map(result.outputs.map(output => [output.outpoint, output]))
}

async function balanceOf(
  module: ColorPermissionModule,
  assetId: string,
  extra: Record<string, unknown> = {}
): Promise<number> {
  const result = await listing(module, {
    basket: `p color balance ${assetTag(assetId)}`,
    ...extra
  })
  expect(result.outputs).toEqual([])
  expect(typeof result.totalOutputs).toBe('number')
  return result.totalOutputs as number
}

describe('pending (color_offline) views and markSettled', () => {
  let wallet: FakeWallet
  let provider: FakeProvider
  let store: FakeStore
  let ex: RequiredProfileHandler
  let assetId: string
  let module: TestModule
  let t40: Transaction
  let t60: Transaction
  let t25: Transaction

  /** A held value output of the asset paying `amount`, with stored `tags`. */
  function hold(amount: bigint, tags?: string[]): Transaction {
    const tx = new Transaction()
    tx.addOutput({
      lockingScript: new OneColor().lock(assetId, amount, Array(20).fill(0x33)),
      satoshis: 1
    })
    wallet.store(
      tx,
      0,
      assetBasket(assetId, 'value'),
      JSON.stringify({ version: 1, assetId }),
      tags
    )
    return tx
  }

  const op = (tx: Transaction): string => `${tx.id('hex')}.0`

  beforeEach(async () => {
    wallet = new FakeWallet()
    provider = new FakeProvider()
    store = new FakeStore()
    ex = exampleProfile()
    const deploy = fixtureDeploy(A141A.C)
    assetId = deploy.assetId
    provider.admit(assetId, deploy.tx, 0)
    module = new TestModule({
      wallet: wallet.asWallet(),
      provider,
      requestTokenAccess: async () => true,
      profiles: { [ex.id]: ex },
      store
    })
    t40 = hold(40n)
    t60 = hold(60n, ['color_offline'])
    t25 = hold(25n)
    wallet.outputs.get(op(t25))!.reservedBy = 'reference-x'
    await module.markSettled(t40.id('hex'))
  })

  it('a pending output is available with color_offline and counts in the balance', async () => {
    const listed = await views(module)
    expect(listed.get(op(t60))).toMatchObject({
      spendable: true,
      tags: ['color_offline', 'color_state_available']
    })
    expect(listed.get(op(t40))).toMatchObject({
      spendable: true,
      tags: ['color_state_available']
    })
    expect(listed.get(op(t25))).toMatchObject({
      spendable: false,
      tags: ['color_state_reserved']
    })
    await expect(
      listing(module, { basket: `p color balance ${assetTag(assetId)}` })
    ).resolves.toEqual({ totalOutputs: 100, outputs: [] })
  })

  it('markSettled removes color_offline from views, durably and once', async () => {
    const txid = t60.id('hex')
    const settledWrites = (): string[] =>
      store.writes.filter(key => key === `color.v1.settled.${txid}`)
    await module.markSettled(txid)
    expect(settledWrites()).toHaveLength(1)
    expect((await views(module)).get(op(t60))?.tags).toEqual(['color_state_available'])
    // Idempotent: a second call writes nothing.
    await module.markSettled(txid)
    expect(settledWrites()).toHaveLength(1)
    // Durable: a new module instance over the same store sees it; the wallet is never touched.
    const restarted = new TestModule({
      wallet: wallet.asWallet(),
      provider,
      requestTokenAccess: async () => true,
      profiles: { [ex.id]: ex },
      store
    })
    expect((await views(restarted)).get(op(t60))?.tags).toEqual(['color_state_available'])
    expect(wallet.outputs.get(op(t60))?.tags).toEqual(['color_offline'])
  })

  it('markSettled takes only a lowercase hex txid', async () => {
    const writes = store.writes.length
    for (const txid of ['', 'xyz', 'AB'.repeat(32), '11'.repeat(31), 7 as unknown as string]) {
      await expect(module.markSettled(txid)).rejects.toThrow(
        'BRC-207: markSettled takes a lowercase hex txid'
      )
    }
    expect(store.writes).toHaveLength(writes)
  })

  it('markSettled does nothing without profiles', async () => {
    const plain = new ColorPermissionModule({
      wallet: wallet.asWallet(),
      provider,
      requestTokenAccess: async () => true,
      store
    })
    const writes = store.writes.length
    await expect(plain.markSettled(t60.id('hex'))).resolves.toBeUndefined()
    await expect(plain.markSettled('xyz')).rejects.toThrow(TypeError)
    expect(store.writes).toHaveLength(writes)
  })

  it('markSettled is not reachable through the BRC-100 surface', async () => {
    await expect(
      module.handleRequest(
        { method: 'markSettled', originator: APP, args: { txid: t60.id('hex') } },
        next
      )
    ).rejects.toThrow('markSettled is not available in the p color namespace')
    await expect(
      module.onRequest({ method: 'markSettled', originator: APP, args: {} })
    ).rejects.toThrow('markSettled is not available in the p color namespace')
    expect((await views(module)).get(op(t60))?.tags).toContain('color_offline')
  })

  it('store loss keeps the coin offline', async () => {
    await module.markSettled(t60.id('hex'))
    expect((await views(module)).get(op(t60))?.tags).not.toContain('color_offline')
    store.clear()
    expect((await views(module)).get(op(t60))?.tags).toContain('color_offline')
    expect(await balanceOf(module, assetId)).toBe(100)
  })

  it('a torn settled record keeps the coin offline', async () => {
    await store.set(`color.v1.settled.${t60.id('hex')}`, '{"outputs":[0],"sig')
    expect((await views(module)).get(op(t60))?.tags).toContain('color_offline')
    await store.set(`color.v1.settled.${t60.id('hex')}`, '')
    expect((await views(module)).get(op(t60))?.tags).toContain('color_offline')
  })

  it('tag filters and balances use the view color_offline tag', async () => {
    const offline = await views(module, { tags: ['color_offline'] })
    expect([...offline.keys()]).toEqual([op(t60)])
    expect(await balanceOf(module, assetId, { tags: ['color_offline'] })).toBe(60)
    await module.markSettled(t60.id('hex'))
    expect((await views(module, { tags: ['color_offline'] })).size).toBe(0)
    expect(await balanceOf(module, assetId, { tags: ['color_offline'] })).toBe(0)
    expect(
      await balanceOf(module, assetId, {
        tags: ['color_offline', 'color_state_available'],
        tagQueryMode: 'any'
      })
    ).toBe(100)
  })

  it('views are unchanged without profiles', async () => {
    const untouchable: ColorModuleStore = {
      get: async () => {
        throw new Error('store read')
      },
      set: async () => {
        throw new Error('store write')
      },
      delete: async () => {
        throw new Error('store delete')
      },
      keys: async () => {
        throw new Error('store keys')
      }
    }
    const plainWallet = new FakeWallet()
    const sender = new FakeWallet()
    const plainAsset = `${'cd'.repeat(32)}_0`
    const { tx, customInstructions } = await tokenPayment(sender, plainWallet, plainAsset, 7n)
    plainWallet.store(tx, 0, assetBasket(plainAsset, 'value'), customInstructions, [
      'color_offline',
      'mine',
      'color_state_reserved'
    ])
    const plain = new ColorPermissionModule({
      wallet: plainWallet.asWallet(),
      provider,
      requestTokenAccess: async () => true,
      store: untouchable
    })
    await expect(listing(plain, { basket: 'p color assets', includeTags: true })).resolves.toEqual({
      totalOutputs: 1,
      outputs: [
        {
          outpoint: `${tx.id('hex')}.0`,
          satoshis: 1000,
          spendable: true,
          tags: ['color_offline', 'mine', 'color_state_available']
        }
      ]
    })
  })

  it("A.142 inventory omits an unsupported asset's outputs", async () => {
    const u = fixtureDeploy(A141A.U)
    provider.admit(u.assetId, u.tx, 0)
    wallet.store(u.tx, 0, assetBasket(u.assetId, 'value'), JSON.stringify({ version: 1 }))
    const successor = new Transaction()
    successor.addOutput({
      lockingScript: new OneColor().lock(u.assetId, 3n, Array(20).fill(0x44)),
      satoshis: 1
    })
    wallet.store(successor, 0, assetBasket(u.assetId, 'value'), JSON.stringify({ version: 1 }))
    const c = fixtureDeploy(A141A.C)
    wallet.store(c.tx, 0, assetBasket(c.assetId, 'value'), JSON.stringify({ version: 1 }))

    const first = await views(module)
    expect(first.has(op(u.tx))).toBe(false)
    expect(first.has(op(successor))).toBe(false)
    expect(first.has(op(c.tx))).toBe(true)
    expect([...first.keys()].sort()).toEqual([op(c.tx), op(t25), op(t40), op(t60)].sort())
    // U is resolved once in the listing (one admission for U, one for the supported asset).
    expect(provider.calls.admission).toBe(2)

    const admissions = provider.calls.admission
    const second = await views(module)
    expect(second.has(op(u.tx))).toBe(false)
    expect(provider.calls.admission).toBe(admissions)
  })
})
