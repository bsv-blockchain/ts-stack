import { _tu, TestWalletNoSetup } from '../utils/TestUtilsWalletStorage'

/**
 * Regression tests: internalizeAction's basket-insertion merge path must
 * refuse to move an existing output between baskets on an already-known
 * transaction. `validateBasketMerges()` previously only rejected reclassifying
 * wallet-managed change; any other existing output could be silently moved
 * into whatever basket the caller named. WalletPermissionsManager only checks
 * the *requested* basket's insertion permission, never the output's *current*
 * basket, so an app with insertion permission on basket X only could
 * internalize an already-known tx and move another app's output from basket Y
 * into X, then spend it as if it had always owned it.
 *
 * These tests exercise the storage-level `internalizeAction` method directly
 * (via `ctx.wallet.internalizeAction`, which forwards to storage), since the
 * trust boundary being fixed lives in storage, not in WalletPermissionsManager.
 */
describe('internalizeAction basket reclassification authorization', () => {
  jest.setTimeout(30000)
  let ctx: TestWalletNoSetup

  beforeAll(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy('internalizeActionBasketReclassification', 'legacy')
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({
      isValidRootForHeight: async () => true
    } as any)
  })

  afterAll(async () => {
    await ctx.storage.destroy()
  })

  test('rejects cross-basket reclassification, rejects into a nonexistent basket without creating it, leaves the output untouched, and allows same-basket re-internalize', async () => {
    const created = await ctx.wallet.createAction({
      description: 'Stage a basket-owned output',
      outputs: [
        {
          satoshis: 741,
          lockingScript: '76a914444444444444444444444444444444444444444488ac',
          basket: 'owned-by-app-a',
          outputDescription: 'App A basket insertion'
        }
      ],
      options: { noSend: true, randomizeOutputs: false }
    })
    expect(created.tx).toBeDefined()
    expect(created.txid).toBeDefined()

    const originalBasket = (
      await ctx.activeStorage.findOutputBaskets({ partial: { userId: ctx.userId, name: 'owned-by-app-a' } })
    )[0]
    expect(originalBasket).toBeDefined()

    // An app with insertion permission on 'owned-by-app-b' internalizes the
    // SAME already-known transaction, requesting the SAME output be
    // reclassified into ITS basket. Storage must refuse: it never actually
    // belonged to 'owned-by-app-b'.
    await expect(
      ctx.wallet.internalizeAction({
        tx: created.tx!,
        outputs: [
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: { basket: 'owned-by-app-b' }
          }
        ],
        description: 'Reject cross-basket reclassification'
      })
    ).rejects.toThrow(/already assigned/i)

    // A rejected request must not create the target basket as a side effect.
    const shouldNotExist = await ctx.activeStorage.findOutputBaskets({
      partial: { userId: ctx.userId, name: 'owned-by-app-b' }
    })
    expect(shouldNotExist).toHaveLength(0)

    // Reclassifying into a basket that has never existed at all is rejected
    // the same way (and must not create it either).
    await expect(
      ctx.wallet.internalizeAction({
        tx: created.tx!,
        outputs: [
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: { basket: 'never-created-basket' }
          }
        ],
        description: 'Reject reclassification into a nonexistent basket'
      })
    ).rejects.toThrow(/already assigned/i)
    const neverCreated = await ctx.activeStorage.findOutputBaskets({
      partial: { userId: ctx.userId, name: 'never-created-basket' }
    })
    expect(neverCreated).toHaveLength(0)

    // The output must remain exactly where it started after both rejections.
    const afterRejections = await ctx.activeStorage.findOutputs({
      partial: { userId: ctx.userId, txid: created.txid, vout: 0 },
      noScript: true
    })
    expect(afterRejections[0].basketId).toBe(originalBasket.basketId)

    // Idempotent re-internalization into the SAME basket must keep working.
    const repeated = await ctx.wallet.internalizeAction({
      tx: created.tx!,
      outputs: [
        {
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: { basket: 'owned-by-app-a' }
        }
      ],
      description: 'Idempotent re-internalize into the same basket'
    })
    expect(repeated.accepted).toBe(true)
    const afterRepeat = await ctx.activeStorage.findOutputs({
      partial: { userId: ctx.userId, txid: created.txid, vout: 0 },
      noScript: true
    })
    expect(afterRepeat[0].basketId).toBe(originalBasket.basketId)
  })

  test('allows inserting a currently-unbasketed, non-managed-change output into a basket', async () => {
    const created = await ctx.wallet.createAction({
      description: 'Stage an output that will be unbasketed',
      outputs: [
        {
          satoshis: 742,
          lockingScript: '76a914555555555555555555555555555555555555555588ac',
          basket: 'temp-holding',
          outputDescription: 'temp holding output'
        }
      ],
      options: { noSend: true, randomizeOutputs: false }
    })
    const rows = await ctx.activeStorage.findOutputs({
      partial: { userId: ctx.userId, txid: created.txid, vout: 0 },
      noScript: true
    })
    expect(rows).toHaveLength(1)
    await ctx.activeStorage.updateOutput(rows[0].outputId, { basketId: undefined })

    const result = await ctx.wallet.internalizeAction({
      tx: created.tx!,
      outputs: [
        {
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: { basket: 'newly-claimed' }
        }
      ],
      description: 'Insert unbasketed output into a real basket'
    })
    expect(result.accepted).toBe(true)

    const after = await ctx.activeStorage.findOutputs({ partial: { outputId: rows[0].outputId }, noScript: true })
    const target = await ctx.activeStorage.findOutputBaskets({
      partial: { userId: ctx.userId, name: 'newly-claimed' }
    })
    expect(target).toHaveLength(1)
    expect(after[0].basketId).toBe(target[0].basketId)
  })
})
