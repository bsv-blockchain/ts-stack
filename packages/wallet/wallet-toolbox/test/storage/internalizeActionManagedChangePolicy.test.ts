import { P2PKH, WalletProtocol } from '@bsv/sdk'
import { isManagedChangeOutput } from '../../src/storage/methods/managedChange'
import { _tu, TestWalletNoSetup } from '../utils/TestUtilsWalletStorage'

describe('internalizeAction managed-change policy', () => {
  jest.setTimeout(30000)
  let ctx: TestWalletNoSetup

  beforeAll(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy('internalizeActionManagedChangePolicy')
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({
      isValidRootForHeight: async () => true
    } as any)
  })

  afterAll(async () => {
    await ctx.storage.destroy()
  })

  test('promotes verified BRC-29 rows, permits custom recovery sweeps, and protects managed change', async () => {
    const protocolID: WalletProtocol = [2, '3241645161d8']
    const derivationPrefix = Buffer.from('policy-prefix').toString('base64')
    const derivationSuffix = Buffer.from('policy-suffix').toString('base64')
    const payee = ctx.keyDeriver.derivePublicKey(
      protocolID,
      `${derivationPrefix} ${derivationSuffix}`,
      ctx.identityKey
    )
    const managedSatoshis = 4321
    const customSatoshis = 123
    const created = await ctx.wallet.createAction({
      description: 'Stage recovery policy outputs',
      outputs: [
        {
          satoshis: managedSatoshis,
          lockingScript: new P2PKH().lock(payee.toAddress()).toHex(),
          basket: 'recovery staging',
          outputDescription: 'BRC-29 recovery candidate'
        },
        {
          satoshis: customSatoshis,
          lockingScript: '76a914111111111111111111111111111111111111111188ac',
          basket: 'recovery staging',
          outputDescription: 'Custom recovery candidate'
        }
      ],
      options: { noSend: true, randomizeOutputs: false }
    })
    expect(created.tx).toBeDefined()
    expect(created.txid).toBeDefined()

    const defaultBasket = (await ctx.activeStorage.findOutputBaskets({
      partial: { userId: ctx.userId, name: 'default' }
    }))[0]
    const rows = await ctx.activeStorage.findOutputs({
      partial: { userId: ctx.userId, txid: created.txid }
    })
    const managedCandidate = rows.find(o => o.vout === 0)!
    const customCandidate = rows.find(o => o.vout === 1)!

    // Reproduce the legacy invalid state this policy must recover: custom
    // application rows were allowed to sit in the default basket.
    await ctx.activeStorage.updateOutput(managedCandidate.outputId, { basketId: defaultBasket.basketId })
    await ctx.activeStorage.updateOutput(customCandidate.outputId, { basketId: defaultBasket.basketId })
    const balanceBefore = await ctx.wallet.balance()

    const paymentArgs = {
      tx: created.tx!,
      outputs: [{
        outputIndex: 0,
        protocol: 'wallet payment' as const,
        paymentRemittance: {
          derivationPrefix,
          derivationSuffix,
          senderIdentityKey: ctx.identityKey
        }
      }],
      description: 'Recover verified BRC-29 payment'
    }
    const promoted = await ctx.wallet.internalizeAction(paymentArgs)
    expect(promoted.accepted).toBe(true)
    expect(promoted.isMerge).toBe(true)
    expect(promoted.satoshis).toBe(managedSatoshis)

    const promotedRow = (await ctx.activeStorage.findOutputs({
      partial: { outputId: managedCandidate.outputId }
    }))[0]
    expect(isManagedChangeOutput(promotedRow)).toBe(true)
    expect(promotedRow.basketId).toBe(defaultBasket.basketId)
    expect(promotedRow.spendable).toBe(true)
    expect(promotedRow.spentBy).toBeUndefined()
    const promotedTx = (await ctx.activeStorage.findTransactions({
      partial: { userId: ctx.userId, txid: created.txid }
    }))[0]
    expect(['completed', 'unproven', 'nosend', 'sending']).toContain(promotedTx.status)
    expect(await ctx.wallet.balance()).toBe(balanceBefore + managedSatoshis)

    const repeated = await ctx.wallet.internalizeAction(paymentArgs)
    expect(repeated.satoshis).toBe(0)
    expect(await ctx.wallet.balance()).toBe(balanceBefore + managedSatoshis)

    // Sweeping is metadata recovery for incompatible custom rows. It does not
    // add to or subtract from wallet balance.
    const swept = await ctx.wallet.internalizeAction({
      tx: created.tx!,
      outputs: [{
        outputIndex: 1,
        protocol: 'basket insertion',
        insertionRemittance: { basket: 'recovered custom outputs' }
      }],
      description: 'Sweep custom output from default'
    })
    expect(swept.satoshis).toBe(0)
    const sweptRow = (await ctx.activeStorage.findOutputs({
      partial: { outputId: customCandidate.outputId }
    }))[0]
    expect(sweptRow.type).toBe('custom')
    expect(sweptRow.basketId).not.toBe(defaultBasket.basketId)
    expect(await ctx.wallet.balance()).toBe(balanceBefore + managedSatoshis)

    await expect(ctx.wallet.internalizeAction({
      tx: created.tx!,
      outputs: [{
        outputIndex: 0,
        protocol: 'basket insertion',
        insertionRemittance: { basket: 'recovered custom outputs' }
      }],
      description: 'Do not reclassify managed change'
    })).rejects.toThrow('wallet-managed change')

    await expect(ctx.wallet.internalizeAction({
      tx: created.tx!,
      outputs: [{
        outputIndex: 1,
        protocol: 'basket insertion',
        insertionRemittance: { basket: 'default' }
      }],
      description: 'Do not insert custom output into default'
    })).rejects.toThrow('non-default basket')
  })
})
