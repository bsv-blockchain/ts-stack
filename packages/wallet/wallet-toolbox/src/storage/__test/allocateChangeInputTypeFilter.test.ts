import { TableOutput, TableOutputBasket } from '../schema/tables'
import { _tu, TestWalletNoSetup } from '../../../test/utils/TestUtilsWalletStorage'

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
describe('StorageKnex.allocateChangeInput — only auto-selects type=P2PKH change', () => {
  jest.setTimeout(99999999)
  const ctxs: TestWalletNoSetup[] = []

  beforeAll(async () => {
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('allocateChangeInputTypeFilter'))
  })
  afterAll(async () => {
    for (const ctx of ctxs) await ctx.storage.destroy()
  })

  const p2pkhScript = [0x76, 0xa9, 0x14, ...new Array(20).fill(0x11), 0x88, 0xac]

  async function freshBasket(ctx: TestWalletNoSetup, name: string): Promise<number> {
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

  function output(ctx: TestWalletNoSetup, o: Partial<TableOutput>): TableOutput {
    return {
      outputId: 0,
      created_at: new Date(),
      updated_at: new Date(),
      userId: ctx.userId,
      transactionId: o.transactionId!,
      basketId: o.basketId!,
      spendable: true,
      change: true,
      satoshis: o.satoshis!,
      outputDescription: 'type-filter test',
      vout: o.vout!,
      type: o.type!,
      providedBy: 'storage',
      purpose: 'change',
      txid: 'allocateChangeInputTypeFilterTxid',
      derivationPrefix: 'AAAAAAAAAAA=',
      derivationSuffix: 'AAAAAAAAAAA=',
      lockingScript: p2pkhScript,
      scriptLength: p2pkhScript.length,
      scriptOffset: 0
    } as TableOutput
  }

  test('picks the P2PKH twin over a lower-outputId custom output of equal value', async () => {
    const ctx = ctxs[0]
    const storage = ctx.activeStorage
    const userId = ctx.userId
    const basketId = await freshBasket(ctx, 'type-filter-twins')
    const tx = (await storage.findTransactions({ partial: { userId, status: 'completed' } }))[0]
    expect(tx).toBeTruthy()

    const value = 424242
    // Insert the CUSTOM output FIRST → it gets the lower outputId, so the pre-fix
    // exact-match query (`orderBy outputId asc`) would have returned it.
    const customId = await storage.insertOutput(
      output(ctx, { transactionId: tx.transactionId, basketId, satoshis: value, vout: 900, type: 'custom' })
    )
    const p2pkhId = await storage.insertOutput(
      output(ctx, { transactionId: tx.transactionId, basketId, satoshis: value, vout: 901, type: 'P2PKH' })
    )
    expect(customId).toBeLessThan(p2pkhId)

    const picked = await storage.allocateChangeInput(userId, basketId, value, value, false, tx.transactionId)
    expect(picked).toBeTruthy()
    expect(picked!.type).toBe('P2PKH')
    expect(picked!.outputId).toBe(p2pkhId)
    expect(picked!.outputId).not.toBe(customId)
  })

  test('never returns a custom output even when it is the only candidate in the basket', async () => {
    const ctx = ctxs[0]
    const storage = ctx.activeStorage
    const userId = ctx.userId
    const basketId = await freshBasket(ctx, 'type-filter-custom-only')
    const tx = (await storage.findTransactions({ partial: { userId, status: 'completed' } }))[0]

    const value = 515151
    await storage.insertOutput(
      output(ctx, { transactionId: tx.transactionId, basketId, satoshis: value, vout: 902, type: 'custom' })
    )

    // Exact, >=, and < selection strategies must all skip the custom output → undefined
    // (the basket holds nothing else).
    expect(await storage.allocateChangeInput(userId, basketId, value, value, false, tx.transactionId)).toBeUndefined()
    expect(await storage.allocateChangeInput(userId, basketId, 1, undefined, false, tx.transactionId)).toBeUndefined()
    expect(
      await storage.allocateChangeInput(userId, basketId, value + 1_000_000, undefined, false, tx.transactionId)
    ).toBeUndefined()
  })
})
