import { RelinquishOutputArgs } from '@bsv/sdk'
import { _tu, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'

describe('RelinquishOutputArgs tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('relinquishActionTests'))
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('relinquishActionTests'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  test('1_default', async () => {
    // Regression note: this legacy fixture output (txid.0) has no basket
    // assignment at all (`basketId` is null in the fixture). The old
    // `relinquishOutput` cleared `basketId` unconditionally without ever
    // checking `args.basket` against the output's actual basket, so this
    // call used to "succeed" as a no-op despite the output never having
    // belonged to 'default'. The fix requires the output to actually belong
    // to the claimed basket; an unbasketed output is correctly rejected now
    // (see also the 'basket authorization' / 4_unbasketed_output_rejected
    // test below, which covers the same case with a freshly created output).
    const outputTxid = '2795b293c698b2244147aaba745db887a632d21990c474df46d842ec3e52f122'

    for (const { wallet, activeStorage: _storage } of ctxs) {
      const args: RelinquishOutputArgs = {
        basket: 'default',
        output: `${outputTxid}.0`
      }

      await expect(wallet.relinquishOutput(args)).rejects.toThrow(/basket/i)
    }
  })

  /**
   * Regression tests: relinquishOutput must confirm the output actually
   * belongs to the caller-claimed basket before clearing it. Without this,
   * an app holding basket-removal permission for ANY basket could relinquish
   * (freeing for reuse by whichever app claims the output next) an output
   * that actually belongs to a different basket entirely — including another
   * app's basket or the admin 'default' change basket — by outpoint alone.
   * WalletPermissionsManager only checks access to the *claimed* basket, so
   * this storage-layer check is the actual authorization boundary.
   *
   * Uses its own wallet copies (actionBatchMode 'legacy', matching
   * internalizeActionManagedChangePolicy.test.ts) so each createAction call
   * used to set up a scenario commits its output/basket rows immediately,
   * rather than sharing the outer describe's default-mode fixture.
   */
  describe('basket authorization', () => {
    jest.setTimeout(99999999)
    const innerCtxs: TestWalletNoSetup[] = []
    let seq = 0

    beforeAll(async () => {
      if (env.runMySQL) {
        innerCtxs.push(await _tu.createLegacyWalletMySQLCopy('relinquishActionBasketAuthTests', 'legacy'))
      }
      innerCtxs.push(await _tu.createLegacyWalletSQLiteCopy('relinquishActionBasketAuthTests', 'legacy'))
    })

    afterAll(async () => {
      for (const ctx of innerCtxs) {
        await ctx.storage.destroy()
      }
    })

    const fundOutput = async (
      ctx: TestWalletNoSetup,
      basket: string
    ): Promise<{ txid: string; output: string; outputId: number }> => {
      seq += 1
      const created = await ctx.wallet.createAction({
        description: `Fund basket-authorization test output ${seq}`,
        outputs: [
          {
            satoshis: 550 + seq,
            lockingScript: `76a914${seq.toString(16).padStart(40, '0')}88ac`,
            basket,
            outputDescription: `basket-authorization test output ${seq}`
          }
        ],
        options: { noSend: true, randomizeOutputs: false }
      })
      const txid = created.txid!
      // Locate the exact row via the freshly (and uniquely) named basket
      // rather than assuming a vout, since a wallet-funded change output may
      // also appear in the same transaction.
      const outputBasket = (
        await ctx.activeStorage.findOutputBaskets({ partial: { userId: ctx.userId, name: basket } })
      )[0]
      expect(outputBasket).toBeDefined()
      const rows = await ctx.activeStorage.findOutputs({
        partial: { userId: ctx.userId, txid, basketId: outputBasket.basketId },
        noScript: true
      })
      expect(rows).toHaveLength(1)
      return { txid, output: `${txid}.${rows[0].vout}`, outputId: rows[0].outputId }
    }

    test('2_wrong_basket_rejected', async () => {
      for (const ctx of innerCtxs) {
        const owned = await fundOutput(ctx, 'basket-authorization-a')
        // Establish a second, real basket the caller could otherwise claim.
        await fundOutput(ctx, 'basket-authorization-b')

        await expect(
          ctx.wallet.relinquishOutput({ basket: 'basket-authorization-b', output: owned.output })
        ).rejects.toThrow(/basket/i)
      }
    })

    test('3_nonexistent_basket_rejected', async () => {
      for (const ctx of innerCtxs) {
        const owned = await fundOutput(ctx, 'basket-authorization-c')

        await expect(
          ctx.wallet.relinquishOutput({ basket: 'basket-authorization-never-created', output: owned.output })
        ).rejects.toThrow(/basket/i)
      }
    })

    test('4_unbasketed_output_rejected', async () => {
      for (const ctx of innerCtxs) {
        const owned = await fundOutput(ctx, 'basket-authorization-d')
        await ctx.activeStorage.updateOutput(owned.outputId, { basketId: undefined })

        await expect(
          ctx.wallet.relinquishOutput({ basket: 'basket-authorization-d', output: owned.output })
        ).rejects.toThrow(/basket/i)
      }
    })

    test('5_correct_basket_relinquishes_and_clears_basketId', async () => {
      for (const ctx of innerCtxs) {
        const owned = await fundOutput(ctx, 'basket-authorization-e')

        const result = await ctx.wallet.relinquishOutput({ basket: 'basket-authorization-e', output: owned.output })
        expect(result).toEqual({ relinquished: true })

        const rows = await ctx.activeStorage.findOutputs({ partial: { outputId: owned.outputId }, noScript: true })
        expect(rows).toHaveLength(1)
        expect(rows[0].basketId).toBeUndefined()
      }
    })
  })
})
