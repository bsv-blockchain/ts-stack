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
import { Wallet } from '../../src/Wallet'

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
    expect(child).toBe(
      ctx.keyDeriver.derivePublicKey([2, '3241645161d8'], 'brc197 authority', 'anyone', true).toString()
    )
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

  test.each(['auto', 'legacy'] as const)(
    'eight independent recipients retain literal metadata across reopen and spend through the protected wallet (%s)',
    async mode => {
      for (let recipient = 0; recipient < 8; recipient++) {
        // Disclosed synthetic actors and proofs; no network broadcast or identity scalar
        // is obtained from a wallet API. Each recipient owns a distinct SQLite file.
        const rootKeyHex = new PrivateKey(91 + recipient).toHex()
        const databaseName = `brc197-recipient-${mode}-${recipient}`
        const filePath = await _tu.newTmpFile(`${databaseName}.sqlite`, false, false, false)
        const open = async () => {
          const reopened = await _tu.createSQLiteTestWallet({ databaseName, filePath, rootKeyHex })
          if (mode === 'legacy') {
            reopened.wallet = new Wallet({
              chain: reopened.chain,
              keyDeriver: reopened.keyDeriver,
              storage: reopened.storage,
              services: reopened.services,
              monitor: reopened.monitor,
              actionBatchMode: mode
            })
          }
          return reopened
        }
        let local = await open()
        try {
          const fixture = fundingFixture(local)
          fixture.source.outputs[0].satoshis = 2000000
          fixture.source.merklePath = undefined
          // Rebuild the disclosed proof after changing the synthetic source value.
          fixture.source.merklePath = new MerklePath(1234, [
            [{ offset: 0, hash: fixture.source.id('hex'), txid: true }]
          ])
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
          local = await open()
          jest.spyOn(local.services, 'getChainTracker').mockResolvedValue(fixture.tracker)
          jest.spyOn(local.activeStorage, 'getServices').mockReturnValue(local.services)
          _tu.mockPostServicesAsSuccess([local])
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
          expect(local.wallet.actionBatch.mode).toBe(mode)
          expect(local.wallet.actionBatch.hasWorkspace).toBe(mode === 'auto')
          const outpoint = `${fixture.tx.id('hex')}.1`
          expect(
            (await local.wallet.listOutputs({ basket: 'default' })).outputs.map(output => output.outpoint)
          ).not.toContain(outpoint)
          expect(await local.wallet.balance()).toBeLessThan(100000)
          if (mode === 'auto') {
            // noSend reserves the input in the default workspace. The stored
            // spend flag changes at commit, rather than when the action is staged.
            expect(await local.activeStorage.findReservedActionBatchOutputIds([row.outputId])).toContain(row.outputId)
            expect((await local.activeStorage.findOutputs({ partial: { outputId: row.outputId } }))[0].spendable).toBe(
              true
            )
          }
          const committed = await local.wallet.createAction({
            description: 'Persist protected child spend through public sendWith',
            options: { sendWith: [result.txid!], acceptDelayedBroadcast: false }
          })
          expect(committed.sendWithResults).toContainEqual(expect.objectContaining({ txid: result.txid }))
          expect(local.services.postBeef).toHaveBeenCalledTimes(1)
          expect(local.wallet.actionBatch.hasWorkspace).toBe(false)
          expect(await local.activeStorage.findReservedActionBatchOutputIds([row.outputId])).toEqual([])
          expect((await local.activeStorage.findOutputs({ partial: { outputId: row.outputId } }))[0].spendable).toBe(
            false
          )
          const storedSpend = await local.activeStorage.findTransactions({
            partial: { userId: local.userId, txid: result.txid },
            noRawTx: true
          })
          expect(storedSpend).toHaveLength(1)
          expect((await local.activeStorage.findOutputs({ partial: { outputId: row.outputId } }))[0].spentBy).toBe(
            storedSpend[0].transactionId
          )
          await local.wallet.destroy()
          local = await open()
          expect((await local.activeStorage.findOutputs({ partial: { outputId: row.outputId } }))[0]).toMatchObject({
            spendable: false,
            spentBy: storedSpend[0].transactionId,
            derivationPrefix: 'brc197',
            derivationSuffix: 'authority',
            senderIdentityKey: BRC197_COUNTERPARTY
          })
          expect(
            (await local.wallet.listOutputs({ basket: 'default' })).outputs.map(output => output.outpoint)
          ).not.toContain(outpoint)
        } finally {
          await local.wallet.destroy()
        }
      }
    }
  )

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

import {
  validateBrc197InternalizeActionArgs,
  ownBrc197InternalizeActionArgs,
  assertBrc197Recipient
} from '../../src/sdk/Brc197Internalization'
import { WERR_INVALID_PARAMETER } from '../../src/sdk/WERR_errors'
import { internalizeActionCore as signerInternalizationCore } from '../../src/signer/methods/internalizeActionCore'
import { internalizeActionCore as storageInternalizationCore } from '../../src/storage/methods/internalizeActionCore'

function unavailableMethod(target: object, name: string): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, name)
  Object.defineProperty(target, name, { configurable: true, writable: true, value: undefined })
  return () => {
    if (descriptor) Object.defineProperty(target, name, descriptor)
    else Reflect.deleteProperty(target, name)
  }
}

describe('fixed-child contract refusals and fresh ownership', () => {
  let ctx: TestWalletNoSetup
  beforeAll(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy('brc197-contract-boundaries', 'legacy')
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })
  afterAll(async () => {
    await ctx.wallet.destroy()
  })
  function payment() {
    const f = fundingFixture(ctx)
    f.tx.outputs[1].lockingScript = new P2PKH().lock(
      PublicKey.fromString(brc197ChildPublicKey(ctx.identityKey)).toAddress()
    )
    const args: Brc197InternalizeActionArgs = {
      profile: BRC197_INTERNALIZATION_PROFILE,
      recipientIdentityKey: ctx.identityKey,
      tx: f.tx.toAtomicBEEF(),
      description: 'Independent fixed-child contract boundaries',
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
      ]
    }
    return { f, args }
  }
  function altered(args: Brc197InternalizeActionArgs, field: string): Brc197InternalizeActionArgs {
    const copy = structuredClone(args),
      output = copy.outputs[0]
    switch (field) {
      case 'profile':
        return { ...copy, profile: 'future' } as unknown as Brc197InternalizeActionArgs
      case 'identity type':
        return { ...copy, recipientIdentityKey: 1 } as unknown as Brc197InternalizeActionArgs
      case 'identity encoding':
        copy.recipientIdentityKey = '04' + '11'.repeat(32)
        break
      case 'identity point':
        copy.recipientIdentityKey = '02' + 'ff'.repeat(32)
        break
      case 'output collection':
        return { ...copy, outputs: null } as unknown as Brc197InternalizeActionArgs
      case 'protocol':
        output.protocol = 'basket insertion'
        break
      case 'insertion':
        output.insertionRemittance = { basket: 'other' }
        break
      case 'prefix':
        output.paymentRemittance!.derivationPrefix = 'other'
        break
      case 'suffix':
        output.paymentRemittance!.derivationSuffix = 'other'
        break
      case 'counterparty':
        output.paymentRemittance!.senderIdentityKey = ctx.identityKey
        break
      case 'duplicate':
        copy.outputs.push(structuredClone(output))
        break
      default:
        throw new Error('Unknown boundary fixture')
    }
    return copy
  }
  test.each([
    ['profile', 'profile'],
    ['identity type', 'recipientIdentityKey'],
    ['identity encoding', 'recipientIdentityKey'],
    ['identity point', 'recipientIdentityKey'],
    ['output collection', 'outputs'],
    ['protocol', 'outputs'],
    ['insertion', 'outputs'],
    ['prefix', 'outputs'],
    ['suffix', 'outputs'],
    ['counterparty', 'outputs'],
    ['duplicate', 'outputs']
  ])('refuses %s with the stable parameter identity before ownership effects', async (field, parameter) => {
    const { f, args } = payment(),
      invalid = altered(args, field)
    expect(() => validateBrc197InternalizeActionArgs(invalid)).toThrow(WERR_INVALID_PARAMETER)
    const capability = jest.spyOn(ctx.wallet, 'getBrc197InternalizationCapabilities')
    await expect(ctx.wallet.internalizeBrc197Action(invalid)).rejects.toMatchObject({
      name: 'WERR_INVALID_PARAMETER',
      parameter
    })
    expect(capability).not.toHaveBeenCalled()
    expect(await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid: f.tx.id('hex') } })).toHaveLength(
      0
    )
  })
  test('owns ordinary bytes and remittance without leaving placeholder invoice fields', () => {
    const { args } = payment(),
      expected = structuredClone(args),
      owned = ownBrc197InternalizeActionArgs(args)
    expect(owned).toMatchObject(expected)
    expect(owned.tx).not.toBe(args.tx)
    expect(owned.outputs).not.toBe(args.outputs)
    expect(owned.outputs[0]).not.toBe(args.outputs[0])
    expect(owned.outputs[0].paymentRemittance).not.toBe(args.outputs[0].paymentRemittance)
    args.tx[0] ^= 1
    args.outputs[0].paymentRemittance!.derivationPrefix = 'changed'
    args.recipientIdentityKey = new PrivateKey(91).toPublicKey().toString()
    expect(owned.tx).toEqual(expected.tx)
    expect(owned.outputs[0].paymentRemittance).toEqual(expected.outputs[0].paymentRemittance)
    expect(owned.recipientIdentityKey).toBe(expected.recipientIdentityKey)
    expect(() => assertBrc197Recipient(owned, expected.recipientIdentityKey)).not.toThrow()
    expect(() => assertBrc197Recipient(owned, args.recipientIdentityKey)).toThrow('the authenticated wallet identity')
  })
  test.each(['profile', 'recipientIdentityKey', 'childPublicKey'] as const)(
    'rejects a provider capability with wrong %s before credit',
    async field => {
      const { f, args } = payment(),
        actual = await ctx.storage.getBrc197InternalizationCapabilities()
      const invalid = { ...actual, [field]: 'wrong' }
      jest.spyOn(ctx.storage, 'getBrc197InternalizationCapabilities').mockResolvedValue(invalid)
      await expect(ctx.wallet.internalizeBrc197Action(args)).rejects.toMatchObject({
        name: 'WERR_INVALID_PARAMETER',
        parameter: 'storage'
      })
      expect(
        await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid: f.tx.id('hex') } })
      ).toHaveLength(0)
    }
  )
  test('queries the own fixed child with the exact public protocol selection', async () => {
    const getKey = jest.spyOn(ctx.wallet, 'getPublicKey'),
      result = await ctx.wallet.getBrc197InternalizationCapabilities()
    expect(getKey.mock.calls).toEqual([
      [{ identityKey: true }],
      [{ protocolID: [2, '3241645161d8'], keyID: 'brc197 authority', counterparty: 'anyone', forSelf: true }]
    ])
    expect(result).toEqual({
      profile: BRC197_INTERNALIZATION_PROFILE,
      recipientIdentityKey: ctx.identityKey,
      childPublicKey: brc197ChildPublicKey(ctx.identityKey)
    })
  })
  test('refuses missing wallet-storage and writer capability without fallback', async () => {
    const restoreStorage = unavailableMethod(ctx.storage, 'getBrc197InternalizationCapabilities')
    try {
      await expect(ctx.wallet.getBrc197InternalizationCapabilities()).rejects.toMatchObject({
        name: 'WERR_NOT_IMPLEMENTED',
        message: 'Local BRC-197 fixed-child internalization is unsupported.'
      })
    } finally {
      restoreStorage()
    }
    const restoreWriter = unavailableMethod(ctx.activeStorage, 'internalizeBrc197Action')
    try {
      await expect(ctx.storage.getBrc197InternalizationCapabilities()).rejects.toMatchObject({
        name: 'WERR_NOT_IMPLEMENTED',
        message: 'The active provider does not support local BRC-197 fixed-child internalization.'
      })
      await expect(ctx.storage.internalizeBrc197Action(payment().args)).rejects.toMatchObject({
        name: 'WERR_NOT_IMPLEMENTED',
        message: 'The active provider does not support local BRC-197 fixed-child internalization.'
      })
    } finally {
      restoreWriter()
    }
  })
  test.each([0, -1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'refuses unauthenticated storage user %s before ownership',
    async userId => {
      const { f, args } = payment(),
        auth = await ctx.storage.getAuth(true),
        find = jest.spyOn(ctx.activeStorage, 'findUsers')
      await expect(ctx.activeStorage.internalizeBrc197Action({ ...auth, userId }, args)).rejects.toMatchObject({
        name: 'WERR_INVALID_PARAMETER',
        parameter: 'auth'
      })
      expect(find).not.toHaveBeenCalled()
      expect(
        await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid: f.tx.id('hex') } })
      ).toHaveLength(0)
    }
  )
  test('rejects an authenticated identity that differs from the stored user', async () => {
    const { f, args } = payment(),
      auth = await ctx.storage.getAuth(true),
      foreign = new PrivateKey(91).toPublicKey().toString()
    await expect(
      ctx.activeStorage.internalizeBrc197Action(
        { ...auth, identityKey: foreign },
        { ...args, recipientIdentityKey: foreign }
      )
    ).rejects.toMatchObject({
      name: 'WERR_INVALID_PARAMETER',
      parameter: 'auth',
      message: 'The auth parameter must be the authenticated storage user identity'
    })
    expect(await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid: f.tx.id('hex') } })).toHaveLength(
      0
    )
  })
  test('refuses unknown core profiles and foreign hooks before evidence or storage writes', async () => {
    const { args } = payment(),
      auth = await ctx.storage.getAuth(true),
      future = 'future' as typeof BRC197_INTERNALIZATION_PROFILE
    await expect(signerInternalizationCore(ctx.wallet, auth, args, future)).rejects.toMatchObject({
      name: 'WERR_INVALID_PARAMETER',
      parameter: 'profile'
    })
    await expect(storageInternalizationCore(ctx.activeStorage, auth, args, future)).rejects.toMatchObject({
      name: 'WERR_INVALID_PARAMETER',
      parameter: 'profile'
    })
    const commit = jest.fn(async () => {
      throw new Error('Hook must not run')
    })
    await expect(
      signerInternalizationCore(ctx.wallet, auth, args, BRC197_INTERNALIZATION_PROFILE, commit)
    ).rejects.toMatchObject({ name: 'WERR_INVALID_PARAMETER', parameter: 'commit' })
    expect(commit).not.toHaveBeenCalled()
  })
})

import { Utils } from '@bsv/sdk'
import {
  genesisHeader,
  serializeBaseBlockHeader,
  blockHash
} from '../../src/services/chaintracker/chaintracks/util/blockHeaderUtilities'
import { EntityProvenTxReq } from '../../src/storage/schema/entities/EntityProvenTxReq'

describe('shared internalization lifecycle and persisted metadata', () => {
  let ctx: TestWalletNoSetup
  beforeAll(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy('shared-internalization-contract', 'legacy')
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })
  afterAll(async () => {
    await ctx.wallet.destroy()
  })
  test.each(['new mined', 'nosend mined', 'nosend unmined'] as const)(
    'retains exact fixed-child ownership through %s',
    async lifecycle => {
      const f = fundingFixture(ctx),
        child = brc197ChildPublicKey(ctx.identityKey)
      f.tx.lockTime = 100 + ['new mined', 'nosend mined', 'nosend unmined'].indexOf(lifecycle)
      f.tx.outputs[1].lockingScript = new P2PKH().lock(PublicKey.fromString(child).toAddress())
      const txid = f.tx.id('hex'),
        mined = lifecycle !== 'nosend unmined'
      if (mined) f.tx.merklePath = new MerklePath(1500, [[{ offset: 0, hash: txid, txid: true }]])
      const header = serializeBaseBlockHeader({ ...genesisHeader(ctx.chain), merkleRoot: txid })
      jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({
        currentHeight: async () => 2000,
        isValidRootForHeight: async (root, height) =>
          (mined && root === txid && height === 1500) || (await f.tracker.isValidRootForHeight(root, height))
      })
      jest.spyOn(ctx.services, 'getHeaderForHeight').mockResolvedValue(header)
      const broadcast = jest
        .spyOn(ctx.services, 'postBeef')
        .mockRejectedValue(new Error('No network publication in lifecycle fixtures'))
      let transactionId: number | undefined
      if (lifecycle.startsWith('nosend')) {
        const now = new Date()
        transactionId = await ctx.activeStorage.insertTransaction({
          created_at: now,
          updated_at: now,
          transactionId: 0,
          userId: ctx.userId,
          txid,
          status: 'nosend',
          reference: Utils.toBase64(Utils.toArray('public-' + lifecycle, 'utf8')),
          isOutgoing: false,
          satoshis: 0,
          description: 'Synthetic pending receipt'
        })
        const req = EntityProvenTxReq.fromTxid(txid, f.tx.toBinary(), f.tx.toAtomicBEEF())
        req.status = 'nosend'
        await ctx.activeStorage.insertProvenTxReq(req.toApi())
      }
      const args: Brc197InternalizeActionArgs = {
        profile: BRC197_INTERNALIZATION_PROFILE,
        recipientIdentityKey: ctx.identityKey,
        tx: f.tx.toAtomicBEEF(),
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
        description: 'Public fixed-child lifecycle receipt',
        labels: ['fixed receipt']
      }
      const before = await ctx.wallet.balance(),
        result = await ctx.wallet.internalizeBrc197Action(args)
      expect(result).toMatchObject({ accepted: true, isMerge: lifecycle.startsWith('nosend'), txid, satoshis: 100 })
      expect(await ctx.wallet.balance()).toBe(before + 100)
      const transactions = await ctx.activeStorage.findTransactions({ partial: { userId: ctx.userId, txid } })
      expect(transactions).toHaveLength(1)
      const row = transactions[0]
      expect(row).toMatchObject({
        userId: ctx.userId,
        txid,
        status: mined ? 'completed' : 'unproven',
        // Merging preserves the pre-existing transaction's accounting amount.
        satoshis: lifecycle.startsWith('nosend') ? 0 : 100,
        isOutgoing: false
      })
      if (transactionId !== undefined) expect(row.transactionId).toBe(transactionId)
      const basket = (
        await ctx.activeStorage.findOutputBaskets({ partial: { userId: ctx.userId, name: 'default' } })
      )[0]
      const outputs = await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid } })
      expect(outputs).toHaveLength(1)
      expect(outputs[0]).toMatchObject({
        transactionId: row.transactionId,
        userId: ctx.userId,
        vout: 1,
        txid,
        satoshis: 100,
        basketId: basket.basketId,
        spendable: true,
        type: 'P2PKH',
        providedBy: 'storage',
        purpose: 'change',
        change: true,
        derivationPrefix: 'brc197',
        derivationSuffix: 'authority',
        senderIdentityKey: BRC197_COUNTERPARTY,
        outputDescription: ''
      })
      expect(Utils.toHex(outputs[0].lockingScript!)).toBe(f.tx.outputs[1].lockingScript.toHex())
      expect(outputs[0].spentBy).toBeUndefined()
      expect(outputs[0].customInstructions).toBeUndefined()
      const proofs = await ctx.activeStorage.findProvenTxs({ partial: { txid } })
      expect(proofs).toHaveLength(mined ? 1 : 0)
      if (mined) {
        expect(proofs[0]).toMatchObject({
          txid,
          height: 1500,
          index: 0,
          blockHash: blockHash(header),
          merkleRoot: txid
        })
        expect(Utils.toHex(proofs[0].rawTx)).toBe(f.tx.toHex())
        expect(Utils.toHex(proofs[0].merklePath)).toBe(Utils.toHex(f.tx.merklePath!.toBinary()))
        expect(row.provenTxId).toBe(proofs[0].provenTxId)
      }
      const reqs = await ctx.activeStorage.findProvenTxReqs({ partial: { txid } })
      if (lifecycle.startsWith('nosend')) {
        expect(reqs).toHaveLength(1)
        expect(reqs[0].status).toBe(mined ? 'completed' : 'unmined')
        expect(reqs[0].history).toContain(mined ? 'internalizeAction-bumpRetire' : 'internalizeAction-nosendRetire')
        if (mined) expect(reqs[0].provenTxId).toBe(row.provenTxId)
      } else expect(reqs).toHaveLength(0)
      expect((await ctx.wallet.internalizeBrc197Action(args)).satoshis).toBe(0)
      expect(await ctx.wallet.balance()).toBe(before + 100)
      expect(broadcast).not.toHaveBeenCalled()
      expect(
        await ctx.activeStorage.findTxLabels({ partial: { userId: ctx.userId, label: 'fixed receipt' } })
      ).toHaveLength(1)
    }
  )
  test('persists complete custom metadata and updates only the same application basket on replay', async () => {
    const f = fundingFixture(ctx)
    f.tx.lockTime = 200
    const txid = f.tx.id('hex')
    f.tx.merklePath = new MerklePath(1500, [[{ offset: 0, hash: txid, txid: true }]])
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({
      currentHeight: async () => 2000,
      isValidRootForHeight: async (root, height) =>
        (root === txid && height === 1500) || (await f.tracker.isValidRootForHeight(root, height))
    })
    jest
      .spyOn(ctx.services, 'getHeaderForHeight')
      .mockResolvedValue(serializeBaseBlockHeader({ ...genesisHeader(ctx.chain), merkleRoot: txid }))
    const broadcast = jest
      .spyOn(ctx.services, 'postBeef')
      .mockRejectedValue(new Error('No network publication in metadata fixtures'))
    const args = {
      tx: f.tx.toAtomicBEEF(),
      outputs: [0, 1].map(outputIndex => ({
        outputIndex,
        protocol: 'basket insertion' as const,
        insertionRemittance: {
          basket: 'public contract records',
          customInstructions: 'original contract instructions',
          tags: ['visible record', 'shared contract']
        }
      })),
      description: 'Public custom-output metadata fixture',
      labels: ['custom receipt']
    }
    expect(await ctx.wallet.internalizeAction(args)).toMatchObject({
      accepted: true,
      isMerge: false,
      txid,
      satoshis: 0
    })
    const first = await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid } })
    expect(first).toHaveLength(2)
    const basket = (
      await ctx.activeStorage.findOutputBaskets({ partial: { userId: ctx.userId, name: 'public contract records' } })
    )[0]
    for (const output of first) {
      expect(output).toMatchObject({
        userId: ctx.userId,
        txid,
        spendable: true,
        type: 'custom',
        change: false,
        providedBy: 'you',
        purpose: '',
        customInstructions: 'original contract instructions',
        basketId: basket.basketId,
        outputDescription: '',
        satoshis: f.tx.outputs[output.vout].satoshis
      })
      expect(Utils.toHex(output.lockingScript!)).toBe(f.tx.outputs[output.vout].lockingScript.toHex())
      expect(output.derivationPrefix).toBeUndefined()
      expect(output.derivationSuffix).toBeUndefined()
      expect(output.senderIdentityKey).toBeUndefined()
      expect(output.spentBy).toBeUndefined()
    }
    expect(
      await ctx.activeStorage.findOutputTags({ partial: { userId: ctx.userId, tag: 'visible record' } })
    ).toHaveLength(1)
    expect(
      await ctx.activeStorage.findOutputTags({ partial: { userId: ctx.userId, tag: 'shared contract' } })
    ).toHaveLength(1)
    const changed = {
      ...args,
      outputs: args.outputs.map(output => ({
        ...output,
        insertionRemittance: { ...output.insertionRemittance, customInstructions: 'revised contract instructions' }
      }))
    }
    expect(await ctx.wallet.internalizeAction(changed)).toMatchObject({
      accepted: true,
      isMerge: true,
      txid,
      satoshis: 0
    })
    const second = await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid } })
    expect(second.map(output => output.outputId).sort()).toEqual(first.map(output => output.outputId).sort())
    for (const output of second)
      expect(output).toMatchObject({
        basketId: basket.basketId,
        type: 'custom',
        change: false,
        customInstructions: 'revised contract instructions',
        providedBy: 'you',
        purpose: ''
      })
    expect((await ctx.activeStorage.findTransactions({ partial: { userId: ctx.userId, txid } }))[0].satoshis).toBe(0)
    expect(broadcast).not.toHaveBeenCalled()
  })
})
