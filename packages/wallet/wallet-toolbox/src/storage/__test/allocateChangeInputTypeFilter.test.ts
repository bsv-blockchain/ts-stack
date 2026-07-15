import { TableOutput, TableOutputBasket } from '../schema/tables'
import {
  _tu,
  TestWalletNoSetup,
  TestWalletProviderNoSetup
} from '../../../test/utils/TestUtilsWalletStorage'
import 'fake-indexeddb/auto'
import { managedChangeOutputFields } from '../methods/managedChange'
import { specOpWalletManagedUtxos } from '../../sdk/types'

/**
 * allocateChangeInput must only auto-select change the SABPPP signer can sign.
 *
 * `buildSignableTransaction` signs storage-selected (Type 2) inputs exclusively via
 * the BRC-29 template, which requires `type === 'P2PKH'` and throws on anything else.
 * Imported/foreign outputs are P2PKH by *script* but stored `type: 'custom'` (see
 * `internalizeAction`), so before this fix the amount-ordered allocator could pick one
 * to fund a fee and then fail signing — most visibly on a fee-only createAction, whose
 * tiny funding target makes a small `custom` output a likely pick.
 *
 * These tests insert into a FRESH basket (no seeded-fixture collisions) and assert the
 * allocator never hands back a `custom` output.
 */
describe('allocateChangeInput managed-change policy', () => {
  jest.setTimeout(99999999)
  type Ctx = TestWalletNoSetup | TestWalletProviderNoSetup
  const ctxs: Ctx[] = []

  beforeAll(async () => {
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('allocateChangeInputTypeFilter'))
    ctxs.push(await _tu.createIdbLegacyWalletCopy('allocateChangeInputTypeFilterIdb'))
  })
  afterAll(async () => {
    for (const ctx of ctxs) await ctx.storage.destroy()
  })

  const p2pkhScript = [0x76, 0xa9, 0x14, ...new Array(20).fill(0x11), 0x88, 0xac]

  async function freshBasket(ctx: Ctx, name: string): Promise<number> {
    const basket: TableOutputBasket = {
      created_at: new Date(),
      updated_at: new Date(),
      basketId: 0,
      userId: ctx.userId,
      name,
      numberOfDesiredUTXOs: 0,
      minimumDesiredUTXOValue: 0,
      isDeleted: false
    }
    return await ctx.activeStorage.insertOutputBasket(basket)
  }

  function output(ctx: Ctx, o: Partial<TableOutput>): TableOutput {
    return {
      outputId: 0,
      created_at: new Date(),
      updated_at: new Date(),
      userId: ctx.userId,
      transactionId: o.transactionId!,
      basketId: o.basketId!,
      spendable: true,
      change: o.change ?? true,
      satoshis: o.satoshis!,
      outputDescription: 'type-filter test',
      vout: o.vout!,
      type: o.type!,
      providedBy: o.providedBy ?? 'storage',
      purpose: o.purpose ?? 'change',
      txid: 'allocateChangeInputTypeFilterTxid',
      derivationPrefix: o.derivationPrefix ?? 'AAAAAAAAAAA=',
      derivationSuffix: o.derivationSuffix ?? 'AAAAAAAAAAA=',
      lockingScript: p2pkhScript,
      scriptLength: p2pkhScript.length,
      scriptOffset: 0
    } as TableOutput
  }

  test('picks the P2PKH twin over a lower-outputId custom output of equal value', async () => {
    for (const [backend, ctx] of ctxs.entries()) {
      const storage = ctx.activeStorage
      const userId = ctx.userId
      const basketId = await freshBasket(ctx, `type-filter-twins-${backend}`)
      const tx = (await storage.findTransactions({ partial: { userId, status: 'completed' } }))[0]
      expect(tx).toBeTruthy()

      const value = 424242
      const customId = await storage.insertOutput(
        output(ctx, {
          transactionId: tx.transactionId,
          basketId,
          satoshis: value,
          vout: 900,
          type: 'custom',
          change: false,
          providedBy: 'you',
          purpose: ''
        })
      )
      const p2pkhId = await storage.insertOutput(
        output(ctx, { transactionId: tx.transactionId, basketId, satoshis: value, vout: 901, ...managedChangeOutputFields })
      )
      expect(customId).toBeLessThan(p2pkhId)

      const picked = await storage.allocateChangeInput(userId, basketId, value, value, false, tx.transactionId)
      expect(picked?.outputId).toBe(p2pkhId)
      expect(picked?.outputId).not.toBe(customId)
    }
  })

  test('never returns a custom output even when it is the only candidate in the basket', async () => {
    for (const [backend, ctx] of ctxs.entries()) {
      const storage = ctx.activeStorage
      const userId = ctx.userId
      const basketId = await freshBasket(ctx, `type-filter-custom-only-${backend}`)
      const tx = (await storage.findTransactions({ partial: { userId, status: 'completed' } }))[0]
      const value = 515151
      await storage.insertOutput(
        output(ctx, {
          transactionId: tx.transactionId,
          basketId,
          satoshis: value,
          vout: 902,
          type: 'custom',
          change: false,
          providedBy: 'you',
          purpose: ''
        })
      )

      expect(await storage.allocateChangeInput(userId, basketId, value, value, false, tx.transactionId)).toBeUndefined()
      expect(await storage.allocateChangeInput(userId, basketId, 1, undefined, false, tx.transactionId)).toBeUndefined()
      expect(
        await storage.allocateChangeInput(userId, basketId, value + 1_000_000, undefined, false, tx.transactionId)
      ).toBeUndefined()
      expect(await storage.countChangeInputs(userId, basketId, false)).toBe(0)
    }
  })

  test('requires complete managed-change metadata for allocation and counting', async () => {
    for (const [backend, ctx] of ctxs.entries()) {
      const storage = ctx.activeStorage
      const userId = ctx.userId
      const basketId = await freshBasket(ctx, `managed-metadata-${backend}`)
      const tx = (await storage.findTransactions({ partial: { userId, status: 'completed' } }))[0]
      const value = 616161

      await storage.insertOutput(
        output(ctx, {
          transactionId: tx.transactionId,
          basketId,
          satoshis: value,
          vout: 903,
          ...managedChangeOutputFields,
          derivationSuffix: ''
        })
      )
      const eligibleId = await storage.insertOutput(
        output(ctx, {
          transactionId: tx.transactionId,
          basketId,
          satoshis: value,
          vout: 904,
          ...managedChangeOutputFields
        })
      )

      expect(await storage.countChangeInputs(userId, basketId, false)).toBe(1)
      const picked = await storage.allocateChangeInput(userId, basketId, value, value, false, tx.transactionId)
      expect(picked?.outputId).toBe(eligibleId)
    }
  })

  test('default balance and UTXO APIs exclude custom rows without hiding them from recovery', async () => {
    for (const [backend, ctx] of ctxs.entries()) {
      const storage = ctx.activeStorage
      const defaultBasket = (await storage.findOutputBaskets({
        partial: { userId: ctx.userId, name: 'default' }
      }))[0]
      const tx = (await storage.findTransactions({ partial: { userId: ctx.userId, status: 'completed' } }))[0]
      const baseline = await ctx.wallet.balance()
      const managedBefore = await ctx.wallet.listOutputs({ basket: specOpWalletManagedUtxos, limit: 1 })
      const value = 717171 + backend
      const customVout = 910 + backend * 2
      const managedVout = customVout + 1

      const customId = await storage.insertOutput(
        output(ctx, {
          transactionId: tx.transactionId,
          basketId: defaultBasket.basketId,
          satoshis: value,
          vout: customVout,
          type: 'custom',
          change: false,
          providedBy: 'you',
          purpose: ''
        })
      )
      const managedId = await storage.insertOutput(
        output(ctx, {
          transactionId: tx.transactionId,
          basketId: defaultBasket.basketId,
          satoshis: value,
          vout: managedVout,
          ...managedChangeOutputFields
        })
      )
      await storage.insertOutput(
        output(ctx, {
          transactionId: tx.transactionId,
          basketId: defaultBasket.basketId,
          satoshis: value,
          vout: managedVout + 100,
          ...managedChangeOutputFields,
          derivationSuffix: ''
        })
      )

      expect(await ctx.wallet.balance()).toBe(baseline + value)
      const managedAfter = await ctx.wallet.listOutputs({ basket: specOpWalletManagedUtxos, limit: 1 })
      expect(managedAfter.totalOutputs).toBe(managedBefore.totalOutputs + 1)
      const balance = await ctx.wallet.balanceAndUtxos()
      expect(balance.utxos.some(u => u.outpoint.endsWith(`.${managedVout}`))).toBe(true)
      expect(balance.utxos.some(u => u.outpoint.endsWith(`.${customVout}`))).toBe(false)

      const raw = await storage.findOutputs({
        partial: { userId: ctx.userId, basketId: defaultBasket.basketId }
      })
      expect(raw.some(o => o.outputId === customId)).toBe(true)
      expect(raw.some(o => o.outputId === managedId)).toBe(true)
    }
  })
})
