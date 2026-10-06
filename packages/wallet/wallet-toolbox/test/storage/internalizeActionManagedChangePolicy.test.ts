import { PublicKey, PrivateKey, Transaction, MerklePath } from '@bsv/sdk'
import {
  BRC197_INTERNALIZATION_PROFILE,
  BRC197_COUNTERPARTY,
  brc197ChildPublicKey,
  type Brc197InternalizeActionArgs
} from '../../src/sdk/Brc197Internalization'
import { fundingFixture } from '../../src/storage/fundingRecovery/__tests__/fundingFixture'
import { P2PKH, WalletProtocol } from '@bsv/sdk'
import { isManagedChangeOutput } from '../../src/storage/methods/managedChange'
import { _tu, TestWalletNoSetup } from '../utils/TestUtilsWalletStorage'

describe('internalizeAction managed-change policy', () => {
  jest.setTimeout(30000)
  let ctx: TestWalletNoSetup

  beforeAll(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy('internalizeActionManagedChangePolicy', 'legacy')
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
    const payee = ctx.keyDeriver.derivePublicKey(protocolID, `${derivationPrefix} ${derivationSuffix}`, ctx.identityKey)
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

    const validPaymentRemittance = {
      derivationPrefix,
      derivationSuffix,
      senderIdentityKey: ctx.identityKey
    }
    await expect(
      ctx.storage.internalizeAction({
        tx: created.tx!,
        outputs: [
          {
            outputIndex: 999,
            protocol: 'basket insertion',
            insertionRemittance: { basket: 'recovered custom outputs' }
          }
        ],
        description: 'Reject output outside the transaction'
      })
    ).rejects.toThrow('a valid output index')

    await expect(
      ctx.storage.internalizeAction({
        tx: created.tx!,
        outputs: [
          {
            outputIndex: 1,
            protocol: 'basket insertion'
          }
        ],
        description: 'Require basket remittance'
      })
    ).rejects.toThrow('only insertionRemittance for basket insertion')

    await expect(
      ctx.storage.internalizeAction({
        tx: created.tx!,
        outputs: [
          {
            outputIndex: 1,
            protocol: 'basket insertion',
            insertionRemittance: { basket: 'recovered custom outputs' },
            paymentRemittance: validPaymentRemittance
          }
        ],
        description: 'Reject conflicting basket remittance'
      })
    ).rejects.toThrow('only insertionRemittance for basket insertion')

    await expect(
      ctx.storage.internalizeAction({
        tx: created.tx!,
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment'
          }
        ],
        description: 'Require payment remittance'
      })
    ).rejects.toThrow('only paymentRemittance for wallet payment')

    await expect(
      ctx.storage.internalizeAction({
        tx: created.tx!,
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: validPaymentRemittance
          },
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: { basket: 'recovered custom outputs' }
          }
        ],
        description: 'Reject duplicate output treatment'
      })
    ).rejects.toThrow('unique outputIndex values')

    await expect(
      ctx.storage.internalizeAction({
        tx: created.tx!,
        outputs: [
          {
            outputIndex: 1,
            protocol: 'basket insertion',
            insertionRemittance: { basket: 'default' }
          }
        ],
        description: 'Reject direct insertion into the default basket'
      })
    ).rejects.toThrow('a non-default basket')

    const defaultBasket = (
      await ctx.activeStorage.findOutputBaskets({
        partial: { userId: ctx.userId, name: 'default' }
      })
    )[0]
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
      outputs: [
        {
          outputIndex: 0,
          protocol: 'wallet payment' as const,
          paymentRemittance: {
            derivationPrefix,
            derivationSuffix,
            senderIdentityKey: ctx.identityKey
          }
        }
      ],
      description: 'Recover verified BRC-29 payment'
    }
    const promoted = await ctx.wallet.internalizeAction(paymentArgs)
    expect(promoted.accepted).toBe(true)
    expect(promoted.isMerge).toBe(true)
    expect(promoted.satoshis).toBe(managedSatoshis)

    const promotedRow = (
      await ctx.activeStorage.findOutputs({
        partial: { outputId: managedCandidate.outputId }
      })
    )[0]
    expect(isManagedChangeOutput(promotedRow)).toBe(true)
    expect(promotedRow.basketId).toBe(defaultBasket.basketId)
    expect(promotedRow.spendable).toBe(true)
    expect(promotedRow.spentBy).toBeUndefined()
    const promotedTx = (
      await ctx.activeStorage.findTransactions({
        partial: { userId: ctx.userId, txid: created.txid }
      })
    )[0]
    expect(['completed', 'unproven', 'nosend', 'sending']).toContain(promotedTx.status)
    expect(await ctx.wallet.balance()).toBe(balanceBefore + managedSatoshis)

    const repeated = await ctx.wallet.internalizeAction(paymentArgs)
    expect(repeated.satoshis).toBe(0)
    expect(await ctx.wallet.balance()).toBe(balanceBefore + managedSatoshis)

    // Sweeping is metadata recovery for incompatible custom rows. It does not
    // add to or subtract from wallet balance.
    const swept = await ctx.wallet.internalizeAction({
      tx: created.tx!,
      outputs: [
        {
          outputIndex: 1,
          protocol: 'basket insertion',
          insertionRemittance: { basket: 'recovered custom outputs' }
        }
      ],
      description: 'Sweep custom output from default'
    })
    expect(swept.satoshis).toBe(0)
    const sweptRow = (
      await ctx.activeStorage.findOutputs({
        partial: { outputId: customCandidate.outputId }
      })
    )[0]
    expect(sweptRow.type).toBe('custom')
    expect(sweptRow.basketId).not.toBe(defaultBasket.basketId)
    expect(await ctx.wallet.balance()).toBe(balanceBefore + managedSatoshis)

    await expect(
      ctx.wallet.internalizeAction({
        tx: created.tx!,
        outputs: [
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: { basket: 'recovered custom outputs' }
          }
        ],
        description: 'Do not reclassify managed change'
      })
    ).rejects.toThrow('wallet-managed change')

    await expect(
      ctx.wallet.internalizeAction({
        tx: created.tx!,
        outputs: [
          {
            outputIndex: 1,
            protocol: 'basket insertion',
            insertionRemittance: { basket: 'default' }
          }
        ],
        description: 'Do not insert custom output into default'
      })
    ).rejects.toThrow('non-default basket')
  })
})

describe('explicit local BRC-197 fixed-child ownership', () => {
  jest.setTimeout(30000)
  let ctx: TestWalletNoSetup
  beforeAll(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy('brc197-managed-policy', 'legacy')
  })
  afterAll(async () => {
    await ctx.wallet.destroy()
  })

  test('credits the exact protected child idempotently while ordinary BRC-29 remains strict', async () => {
    const fixture = fundingFixture(ctx)
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue(fixture.tracker)
    const child = brc197ChildPublicKey(ctx.identityKey)
    expect(child).toBe(ctx.keyDeriver.derivePublicKey([2, '3241645161d8'], 'brc197 authority', 'anyone').toString())
    expect(await ctx.wallet.getBrc197InternalizationCapabilities()).toEqual({
      profile: BRC197_INTERNALIZATION_PROFILE,
      recipientIdentityKey: ctx.identityKey,
      childPublicKey: child
    })
    fixture.tx.outputs[1].lockingScript = new P2PKH().lock(PublicKey.fromString(child).toAddress())
    const args: Brc197InternalizeActionArgs = {
      profile: BRC197_INTERNALIZATION_PROFILE,
      recipientIdentityKey: ctx.identityKey,
      tx: fixture.tx.toAtomicBEEF(),
      outputs: [
        {
          outputIndex: 1,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: 'brc197',
            derivationSuffix: 'authority',
            senderIdentityKey: BRC197_COUNTERPARTY
          }
        }
      ],
      description: 'Public synthetic fixed-child receipt'
    }
    const before = await ctx.wallet.balance()
    await expect(ctx.wallet.internalizeAction(args)).rejects.toThrow('base64')
    const result = await ctx.wallet.internalizeBrc197Action(args)
    expect(result.accepted).toBe(true)
    expect(result.satoshis).toBe(100)
    expect(await ctx.wallet.balance()).toBe(before + 100)
    expect((await ctx.wallet.internalizeBrc197Action(args)).satoshis).toBe(0)
    const rows = await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid: fixture.tx.id('hex') } })
    expect(rows).toHaveLength(1)
    expect(isManagedChangeOutput(rows[0])).toBe(true)
    expect(rows[0].derivationPrefix).toBe('brc197')
    expect(rows[0].derivationSuffix).toBe('authority')
    expect(rows[0].senderIdentityKey).toBe(BRC197_COUNTERPARTY)
  })

  test('rejects wrong fixed-child ownership at wallet and direct provider boundaries before credit', async () => {
    const fixture = fundingFixture(ctx)
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue(fixture.tracker)
    const args: Brc197InternalizeActionArgs = {
      profile: BRC197_INTERNALIZATION_PROFILE,
      recipientIdentityKey: ctx.identityKey,
      tx: fixture.tx.toAtomicBEEF(),
      outputs: [
        {
          outputIndex: 1,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: 'brc197',
            derivationSuffix: 'authority',
            senderIdentityKey: BRC197_COUNTERPARTY
          }
        }
      ],
      description: 'Reject ordinary payment as fixed child'
    }
    const before = await ctx.wallet.balance()
    await expect(ctx.wallet.internalizeBrc197Action(args)).rejects.toThrow('fixed-child P2PKH')
    const auth = await ctx.storage.getAuth(true)
    await expect(ctx.activeStorage.internalizeBrc197Action(auth, args)).rejects.toThrow('fixed-child P2PKH')
    await expect(
      ctx.wallet.internalizeBrc197Action({ ...args, recipientIdentityKey: new PrivateKey(81).toPublicKey().toString() })
    ).rejects.toThrow('authenticated wallet identity')
    await expect(
      ctx.wallet.internalizeBrc197Action({ ...args, outputs: [...args.outputs, ...args.outputs] })
    ).rejects.toThrow('unique BRC-197')
    const foreign = new PrivateKey(81).toPublicKey().toString()
    await expect(
      ctx.activeStorage.internalizeBrc197Action(
        { ...auth, identityKey: foreign },
        { ...args, recipientIdentityKey: foreign }
      )
    ).rejects.toThrow('authenticated storage user identity')
    expect(
      await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid: fixture.tx.id('hex') } })
    ).toHaveLength(0)
    expect(await ctx.wallet.balance()).toBe(before)
  })

  test('eight independent recipients retain literal metadata across reopen and spend through the protected wallet', async () => {
    for (let recipient = 0; recipient < 8; recipient++) {
      // Disclosed synthetic actors and proofs; no network broadcast or identity scalar
      // is obtained from a wallet API. Each recipient owns a distinct SQLite file.
      const rootKeyHex = new PrivateKey(91 + recipient).toHex()
      const databaseName = `brc197-recipient-${recipient}`
      const filePath = await _tu.newTmpFile(`${databaseName}.sqlite`, false, false, false)
      let local = await _tu.createSQLiteTestWallet({ databaseName, filePath, rootKeyHex })
      try {
        const fixture = fundingFixture(local)
        fixture.source.outputs[0].satoshis = 2000000
        fixture.source.merklePath = undefined
        // Rebuild the disclosed proof after changing the synthetic source value.
        fixture.source.merklePath = new MerklePath(1234, [[{ offset: 0, hash: fixture.source.id('hex'), txid: true }]])
        fixture.tx.inputs[0].sourceTXID = fixture.source.id('hex')
        fixture.tx.outputs[1].satoshis = 1000000
        const capability = await local.wallet.getBrc197InternalizationCapabilities()
        expect(capability.recipientIdentityKey).toBe(local.identityKey)
        expect(capability.childPublicKey).toBe(brc197ChildPublicKey(local.identityKey))
        fixture.tx.outputs[1].lockingScript = new P2PKH().lock(
          PublicKey.fromString(capability.childPublicKey).toAddress()
        )
        jest.spyOn(local.services, 'getChainTracker').mockResolvedValue(fixture.tracker)
        const args: Brc197InternalizeActionArgs = {
          profile: BRC197_INTERNALIZATION_PROFILE,
          recipientIdentityKey: local.identityKey,
          tx: fixture.tx.toAtomicBEEF(),
          outputs: [
            {
              outputIndex: 1,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix: 'brc197',
                derivationSuffix: 'authority',
                senderIdentityKey: BRC197_COUNTERPARTY
              }
            }
          ],
          description: 'Public synthetic recipient payout'
        }
        expect((await local.wallet.internalizeBrc197Action(args)).satoshis).toBe(1000000)
        await local.wallet.destroy()
        local = await _tu.createSQLiteTestWallet({ databaseName, filePath, rootKeyHex })
        jest.spyOn(local.services, 'getChainTracker').mockResolvedValue(fixture.tracker)
        expect(await local.wallet.balance()).toBe(1000000)
        expect((await local.wallet.internalizeBrc197Action(args)).satoshis).toBe(0)
        const row = (
          await local.activeStorage.findOutputs({ partial: { userId: local.userId, txid: fixture.tx.id('hex') } })
        )[0]
        expect(row.derivationPrefix).toBe('brc197')
        expect(row.derivationSuffix).toBe('authority')
        expect(row.senderIdentityKey).toBe(BRC197_COUNTERPARTY)
        const result = await local.wallet.createAction({
          description: 'Spend fixed-child payment after reopen',
          outputs: [{ satoshis: 900000, lockingScript: '51', outputDescription: 'Public synthetic destination' }],
          options: { noSend: true, randomizeOutputs: false }
        })
        expect(result.tx).toBeDefined()
        const spend = Transaction.fromAtomicBEEF(result.tx!)
        expect(spend.inputs).toHaveLength(1)
        expect(spend.inputs[0].sourceTXID).toBe(fixture.tx.id('hex'))
        expect(spend.inputs[0].sourceOutputIndex).toBe(1)
        expect(spend.inputs[0].unlockingScript?.toHex()).not.toBe('')
        expect(await spend.verify(fixture.tracker)).toBe(true)
        expect((await local.activeStorage.findOutputs({ partial: { outputId: row.outputId } }))[0].spendable).toBe(
          false
        )
      } finally {
        await local.wallet.destroy()
      }
    }
  })

  test('reports an unsupported active writer before a caller can lock listing value', async () => {
    const inherited = ctx.activeStorage.internalizeBrc197Action
    Object.defineProperty(ctx.activeStorage, 'internalizeBrc197Action', { value: undefined, configurable: true })
    try {
      await expect(ctx.wallet.getBrc197InternalizationCapabilities()).rejects.toThrow(
        'active provider does not support'
      )
    } finally {
      Object.defineProperty(ctx.activeStorage, 'internalizeBrc197Action', {
        value: inherited,
        configurable: true,
        writable: true
      })
    }
  })
})
