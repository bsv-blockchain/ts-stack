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

import { specOpThrowReviewActions } from '../../src/sdk/types'
import type { FundingRecoveryCommit } from '../../src/storage/fundingRecovery/FundingRecoveryCommit'

describe('fixed-child ownership refusal ordering', () => {
  let ctx: TestWalletNoSetup
  beforeAll(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy('fixed-child-refusal-ordering', 'legacy')
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
      description: 'Public ownership refusal fixture',
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
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue(f.tracker)
    return { f, args }
  }
  async function untouched(txid: string) {
    expect(await ctx.activeStorage.findTransactions({ partial: { userId: ctx.userId, txid } })).toHaveLength(0)
    expect(await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid } })).toHaveLength(0)
  }
  test.each([undefined, null, 1, 'fixed-child'])(
    'refuses a missing or non-record invocation (%s) with the profile parameter',
    value => {
      expect(() => validateBrc197InternalizeActionArgs(value as unknown as Brc197InternalizeActionArgs)).toThrow(
        new WERR_INVALID_PARAMETER('profile', BRC197_INTERNALIZATION_PROFILE)
      )
    }
  )
  test.each(['absent', 'null', 'null output', 'null remittance'] as const)(
    'refuses %s remittance as a fixed-child contract error',
    async kind => {
      const { f, args } = payment()
      const invalid = structuredClone(args)
      if (kind === 'absent') delete invalid.outputs[0].paymentRemittance
      else if (kind === 'null') invalid.outputs = null as unknown as Brc197InternalizeActionArgs['outputs']
      else if (kind === 'null output')
        invalid.outputs[0] = null as unknown as Brc197InternalizeActionArgs['outputs'][number]
      else
        invalid.outputs[0].paymentRemittance = null as unknown as NonNullable<
          Brc197InternalizeActionArgs['outputs'][number]['paymentRemittance']
        >
      await expect(ctx.wallet.internalizeBrc197Action(invalid)).rejects.toMatchObject({
        name: 'WERR_INVALID_PARAMETER',
        parameter: 'outputs',
        message:
          kind === 'null'
            ? 'The outputs parameter must be an array'
            : 'The outputs parameter must be unique BRC-197 fixed-child wallet payments'
      })
      await untouched(f.tx.id('hex'))
    }
  )
  test('rejects uppercase identity encoding with the public identity error before capability lookup', async () => {
    const { f, args } = payment(),
      capability = jest.spyOn(ctx.wallet, 'getBrc197InternalizationCapabilities')
    expect(args.recipientIdentityKey.toUpperCase()).not.toBe(args.recipientIdentityKey)
    await expect(
      ctx.wallet.internalizeBrc197Action({ ...args, recipientIdentityKey: args.recipientIdentityKey.toUpperCase() })
    ).rejects.toMatchObject({
      name: 'WERR_INVALID_PARAMETER',
      parameter: 'recipientIdentityKey',
      message: 'The recipientIdentityKey parameter must be a canonical compressed secp256k1 public key'
    })
    expect(capability).not.toHaveBeenCalled()
    await untouched(f.tx.id('hex'))
  })
  test.each(['p nosend expiry seconds 60', specOpThrowReviewActions])(
    'retains the reserved-label refusal before provider discovery (%s)',
    async label => {
      const { f, args } = payment(),
        capability = jest.spyOn(ctx.wallet, 'getBrc197InternalizationCapabilities')
      const pending = ctx.wallet.internalizeBrc197Action({ ...args, labels: [label] })
      if (label === specOpThrowReviewActions)
        await expect(pending).rejects.toMatchObject({ name: 'WERR_REVIEW_ACTIONS' })
      else
        await expect(pending).rejects.toMatchObject({
          name: 'WERR_INVALID_PARAMETER',
          parameter: 'labels',
          message: 'The labels parameter must be BRC-177 noSend expiry labels only on outgoing createAction requests'
        })
      expect(capability).not.toHaveBeenCalled()
      await untouched(f.tx.id('hex'))
    }
  )
  test('refuses an injected storage recovery hook for the fixed profile before evidence or commit', async () => {
    const { f, args } = payment(),
      auth = await ctx.storage.getAuth(true),
      commit = jest.fn(),
      evidence = jest.spyOn(ctx.services, 'getChainTracker')
    const hook = { protocol: 'wallet-funding-recovery-v1', commit } as unknown as FundingRecoveryCommit
    await expect(
      storageInternalizationCore(ctx.activeStorage, auth, args, BRC197_INTERNALIZATION_PROFILE, hook)
    ).rejects.toMatchObject({
      name: 'WERR_INVALID_PARAMETER',
      parameter: 'recovery',
      message: 'The recovery parameter must be the installed fixed-profile storage pipeline'
    })
    expect(commit).not.toHaveBeenCalled()
    expect(evidence).not.toHaveBeenCalled()
    await untouched(f.tx.id('hex'))
  })
  test('refuses a missing selected storage method without falling back to the ordinary route', async () => {
    const { f, args } = payment(),
      auth = await ctx.storage.getAuth(true),
      ordinary = jest.spyOn(ctx.storage, 'internalizeAction')
    const restore = unavailableMethod(ctx.storage, 'internalizeBrc197Action')
    try {
      await expect(
        signerInternalizationCore(ctx.wallet, auth, args, BRC197_INTERNALIZATION_PROFILE)
      ).rejects.toMatchObject({
        name: 'WERR_INVALID_PARAMETER',
        parameter: 'storage',
        message: 'The storage parameter must be local BRC-197 internalization capability'
      })
      expect(ordinary).not.toHaveBeenCalled()
      await untouched(f.tx.id('hex'))
    } finally {
      restore()
    }
  })
  test('rejects a substituted derived child even when the transaction pays the correct recipient script', async () => {
    const { f, args } = payment(),
      auth = await ctx.storage.getAuth(true)
    jest.spyOn(ctx.keyDeriver, 'derivePublicKey').mockReturnValue(new PrivateKey(92).toPublicKey())
    await expect(
      signerInternalizationCore(ctx.wallet, auth, args, BRC197_INTERNALIZATION_PROFILE)
    ).rejects.toMatchObject({
      name: 'WERR_INVALID_PARAMETER',
      parameter: 'paymentRemittance',
      message: 'The paymentRemittance parameter must be the authenticated BRC-197 fixed-child P2PKH'
    })
    await untouched(f.tx.id('hex'))
  })
  test('refuses an in-range integer that addresses no output at both signer and storage boundaries', async () => {
    const { f, args } = payment(),
      auth = await ctx.storage.getAuth(true)
    args.outputs[0].outputIndex = f.tx.outputs.length
    const refusal = {
      name: 'WERR_INVALID_PARAMETER',
      parameter: 'outputIndex',
      message: `The outputIndex parameter must be a valid output index in range 0 to ${f.tx.outputs.length - 1}`
    }
    await expect(
      signerInternalizationCore(ctx.wallet, auth, args, BRC197_INTERNALIZATION_PROFILE)
    ).rejects.toMatchObject(refusal)
    await expect(
      storageInternalizationCore(ctx.activeStorage, auth, args, BRC197_INTERNALIZATION_PROFILE)
    ).rejects.toMatchObject(refusal)
    await untouched(f.tx.id('hex'))
  })
})
import { Beef, type InternalizeActionArgs, type InternalizeOutput } from '@bsv/sdk'
import * as internalizationValidation from '@bsv/sdk/wallet/validationHelpers'

describe('shared internalization refuses inconsistent dependencies without ownership effects', () => {
  let ctx: TestWalletNoSetup
  let nonce = 400
  beforeAll(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy('internalization-dependency-refusals', 'legacy')
  })
  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    await ctx.wallet.destroy()
  })

  function payment() {
    const f = fundingFixture(ctx)
    f.tx.lockTime = nonce++
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue(f.tracker)
    jest
      .spyOn(ctx.services, 'postBeef')
      .mockRejectedValue(new Error('Synthetic dependency tests never publish'))
    const args: InternalizeActionArgs = {
      tx: f.tx.toAtomicBEEF(),
      description: 'Synthetic ordinary ownership boundary',
      outputs: [
        {
          outputIndex: 1,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: 'cHVibGljLWZpeHR1cmU=',
            derivationSuffix: 'cGF5bWVudA==',
            senderIdentityKey: new PrivateKey(81).toPublicKey().toString()
          }
        }
      ]
    }
    return { f, args }
  }
  async function untouched(txid: string) {
    expect(
      await ctx.activeStorage.findTransactions({ partial: { userId: ctx.userId, txid } })
    ).toHaveLength(0)
    expect(
      await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid } })
    ).toHaveLength(0)
    expect(await ctx.activeStorage.findProvenTxReqs({ partial: { txid } })).toHaveLength(0)
    expect(ctx.services.postBeef).not.toHaveBeenCalled()
  }
  async function invoke(boundary: 'signer' | 'storage', args: InternalizeActionArgs) {
    const auth = await ctx.storage.getAuth(true)
    return boundary === 'signer'
      ? await signerInternalizationCore(ctx.wallet, auth, args, null)
      : await storageInternalizationCore(ctx.activeStorage, auth, args, null)
  }

  test.each(['signer', 'storage'] as const)(
    'rejects a negative evidence verdict at the %s boundary',
    async boundary => {
      const { f, args } = payment()
      jest.spyOn(Beef.prototype, 'verify').mockResolvedValue(false)
      await expect(invoke(boundary, args)).rejects.toMatchObject({
        name: 'WERR_INVALID_PARAMETER',
        parameter: 'tx',
        message: 'The tx parameter must be valid AtomicBEEF'
      })
      await untouched(f.tx.id('hex'))
    }
  )
  test.each(['signer', 'storage'] as const)(
    'rejects a verifier that loses the atomic subject at the %s boundary',
    async boundary => {
      const { f, args } = payment()
      jest.spyOn(Beef.prototype, 'verify').mockImplementation(async function (this: Beef) {
        this.atomicTxid = undefined
        return true
      })
      await expect(invoke(boundary, args)).rejects.toMatchObject({
        name: 'WERR_INVALID_PARAMETER',
        parameter: 'tx',
        message: 'The tx parameter must be valid AtomicBEEF'
      })
      await untouched(f.tx.id('hex'))
    }
  )
  test.each(['signer', 'storage'] as const)(
    'rejects a verifier that loses the subject transaction at the %s boundary',
    async boundary => {
      const { f, args } = payment(),
        txid = f.tx.id('hex')
      jest.spyOn(Beef.prototype, 'verify').mockImplementation(async function (this: Beef) {
        this.findTxid = () => undefined
        return true
      })
      await expect(invoke(boundary, args)).rejects.toMatchObject({
        name: 'WERR_INVALID_PARAMETER',
        parameter: 'tx',
        message: `The tx parameter must be valid AtomicBEEF with newest txid of ${txid}`
      })
      await untouched(txid)
    }
  )
  test('the signer rejects a well-formed remittance paying a different ordinary BRC-29 script', async () => {
    const { f, args } = payment()
    args.outputs[0].paymentRemittance!.derivationSuffix = 'ZGlmZmVyZW50'
    await expect(invoke('signer', args)).rejects.toMatchObject({
      name: 'WERR_INVALID_PARAMETER',
      parameter: 'paymentRemittance',
      message: 'The paymentRemittance parameter must be locked by script conforming to BRC-29'
    })
    await untouched(f.tx.id('hex'))
  })

  // These deliberately inconsistent port results check the cores' independent
  // defenses after their ordinary validator, without weakening that validator.
  test.each([
    ['unknown', undefined, undefined],
    ['wallet payment', undefined, undefined],
    ['basket insertion', undefined, undefined],
    ['basket insertion', { basket: 'records' }, 'conflicting payment'],
    ['wallet payment', { basket: 'records' }, 'payment'],
    ['basket insertion', { basket: 'default' }, undefined]
  ] as const)(
    'storage refuses an inconsistent validated %s treatment (%s/%s)',
    async (protocol, insertion, remittance) => {
      const { f, args } = payment(),
        valid = internalizationValidation.validateInternalizeActionArgs(args)
      const output = {
        outputIndex: 1,
        protocol,
        insertionRemittance: insertion,
        paymentRemittance: remittance === undefined ? undefined : args.outputs[0].paymentRemittance
      } as unknown as InternalizeOutput
      valid.outputs = [output]
      jest.spyOn(internalizationValidation, 'validateInternalizeActionArgs').mockReturnValue(valid)
      let expected: { name: string; parameter?: string; message: string }
      if (protocol === 'unknown')
        expected = { name: 'WERR_INTERNAL', message: 'unexpected protocol unknown' }
      else if (protocol === 'basket insertion' && insertion?.basket === 'default')
        expected = {
          name: 'WERR_INVALID_PARAMETER',
          parameter: 'insertionRemittance.basket',
          message: 'The insertionRemittance.basket parameter must be a non-default basket'
        }
      else
        expected = {
          name: 'WERR_INVALID_PARAMETER',
          parameter: protocol,
          message:
            protocol === 'basket insertion'
              ? 'The basket insertion parameter must be valid insertionRemittance and no paymentRemittance'
              : 'The wallet payment parameter must be valid paymentRemittance and no insertionRemittance'
        }
      await expect(invoke('storage', args)).rejects.toMatchObject(expected)
      await untouched(f.tx.id('hex'))
      expect(
        await ctx.activeStorage.findOutputBaskets({
          partial: { userId: ctx.userId, name: 'records' }
        })
      ).toHaveLength(0)
    }
  )
  test.each(['unknown', 'wallet payment', 'basket insertion'] as const)(
    'signer refuses an inconsistent validated %s treatment',
    async protocol => {
      const { f, args } = payment(),
        valid = internalizationValidation.validateInternalizeActionArgs(args)
      valid.outputs = [{ outputIndex: 1, protocol } as unknown as InternalizeOutput]
      jest.spyOn(internalizationValidation, 'validateInternalizeActionArgs').mockReturnValue(valid)
      const expected =
        protocol === 'unknown'
          ? { name: 'WERR_INTERNAL', message: 'unexpected protocol unknown' }
          : {
              name: 'WERR_INVALID_PARAMETER',
              parameter:
                protocol === 'wallet payment' ? 'paymentRemittance' : 'insertionRemittance',
              message: `The ${protocol === 'wallet payment' ? 'paymentRemittance' : 'insertionRemittance'} parameter must be valid for protocol ${protocol}`
            }
      await expect(invoke('signer', args)).rejects.toMatchObject(expected)
      await untouched(f.tx.id('hex'))
    }
  )
  test.each(['same x', 'infinity'] as const)(
    'fixed-child derivation refuses a %s result from the derivation port',
    async defect => {
      const { f } = payment(),
        root = PublicKey.fromString(ctx.identityKey)
      const substituted = defect === 'same x' ? root : new PublicKey(null, null)
      const derive = jest.spyOn(PublicKey.prototype, 'deriveChild').mockReturnValue(substituted)
      expect(() => brc197ChildPublicKey(ctx.identityKey)).toThrow(
        new WERR_INVALID_PARAMETER('recipientIdentityKey', 'a nondegenerate BRC-197 child')
      )
      expect(derive).toHaveBeenCalledTimes(1)
      await untouched(f.tx.id('hex'))
    }
  )
  test.each(['bad point', 'noncanonical point', 'infinity'] as const)(
    'fixed-child identity refuses a %s parser result',
    async defect => {
      const { f } = payment(),
        parsed = PublicKey.fromString(ctx.identityKey)
      if (defect === 'infinity') jest.spyOn(parsed, 'isInfinity').mockReturnValue(true)
      else if (defect === 'bad point') jest.spyOn(parsed, 'validate').mockReturnValue(false)
      else
        jest.spyOn(parsed, 'toString').mockReturnValue(new PrivateKey(93).toPublicKey().toString())
      jest.spyOn(PublicKey, 'fromString').mockReturnValue(parsed)
      expect(() => brc197ChildPublicKey(ctx.identityKey)).toThrow(
        new WERR_INVALID_PARAMETER(
          'recipientIdentityKey',
          'a canonical compressed secp256k1 public key'
        )
      )
      await untouched(f.tx.id('hex'))
    }
  )

  test('a transaction inserted after ownership discovery is refused as a race and rolled back', async () => {
    const { f, args } = payment(),
      original = ctx.activeStorage.findOrInsertTransaction.bind(ctx.activeStorage)
    const insertion = jest
      .spyOn(ctx.activeStorage, 'findOrInsertTransaction')
      .mockImplementation(async (value, trx) => {
        const inserted = await original(value, trx)
        return { ...inserted, isNew: false }
      })
    await expect(invoke('storage', args)).rejects.toMatchObject({
      name: 'WERR_INVALID_PARAMETER',
      parameter: 'tx',
      message:
        'The tx parameter must be target transaction of internalizeAction is undergoing active changes.'
    })
    expect(insertion).toHaveBeenCalledTimes(1)
    await untouched(f.tx.id('hex'))
  })
  test.each(['new', 'nosend'] as const)(
    'a missing mined header refuses %s ownership and retains the prior state',
    async lifecycle => {
      const { f, args } = payment(),
        txid = f.tx.id('hex')
      f.tx.merklePath = new MerklePath(1500, [[{ offset: 0, hash: txid, txid: true }]])
      args.tx = f.tx.toAtomicBEEF()
      jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({
        currentHeight: async () => 2000,
        isValidRootForHeight: async () => true
      })
      // Deliberately broken service-port result: the runtime defense must survive
      // a provider that violates its non-null static return contract.
      jest
        .spyOn(ctx.services, 'getHeaderForHeight')
        .mockResolvedValue(undefined as unknown as number[])
      if (lifecycle === 'nosend') {
        const now = new Date()
        await ctx.activeStorage.insertTransaction({
          created_at: now,
          updated_at: now,
          transactionId: 0,
          userId: ctx.userId,
          txid,
          status: 'nosend',
          reference: `public-header-${nonce}`,
          isOutgoing: false,
          satoshis: 0,
          description: 'Synthetic pending header'
        })
      }
      await expect(invoke('storage', args)).rejects.toMatchObject({
        name: 'WERR_INTERNAL',
        message: 'Block header not found for height 1500'
      })
      expect(
        await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid } })
      ).toHaveLength(0)
      const transactions = await ctx.activeStorage.findTransactions({
        partial: { userId: ctx.userId, txid }
      })
      expect(transactions).toHaveLength(lifecycle === 'nosend' ? 1 : 0)
      if (lifecycle === 'nosend') expect(transactions[0].status).toBe('nosend')
      expect(await ctx.activeStorage.findProvenTxs({ partial: { txid } })).toHaveLength(0)
      expect(ctx.services.postBeef).not.toHaveBeenCalled()
    }
  )
})

import * as internalizationPublication from '../../src/storage/methods/processAction'

describe('internalization preserves inputs and metadata across failed publication', () => {
  let ctx: TestWalletNoSetup
  beforeAll(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy('internalization-publication-rollback', 'legacy')
  })
  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    await ctx.wallet.destroy()
  })
  test('restores only transitioned own and foreign inputs and does not admit requested outputs or labels', async () => {
    const f = fundingFixture(ctx)
    f.tx.lockTime = 701
    const txid = f.tx.id('hex'),
      sourceTxid = f.source.id('hex')
    const user = (await ctx.activeStorage.findUsers({ partial: { userId: ctx.userId } }))[0]
    const foreign = await _tu.insertTestUser(
      ctx.activeStorage,
      new PrivateKey(94).toPublicKey().toString()
    )
    const basket = (
      await ctx.activeStorage.findOutputBaskets({
        partial: { userId: ctx.userId, name: 'default' }
      })
    )[0]
    const foreignBasket = await _tu.insertTestOutputBasket(ctx.activeStorage, foreign)
    const { tx: owner } = await _tu.insertTestTransaction(ctx.activeStorage, user, false, {
      txid: sourceTxid
    })
    const { tx: foreignOwner } = await _tu.insertTestTransaction(
      ctx.activeStorage,
      foreign,
      false,
      { txid: sourceTxid }
    )
    const own = await _tu.insertTestOutput(ctx.activeStorage, owner, 0, 1000, basket, false, {
      txid: sourceTxid,
      spendable: true,
      spentBy: undefined
    })
    const other = await _tu.insertTestOutput(
      ctx.activeStorage,
      foreignOwner,
      0,
      1000,
      foreignBasket,
      false,
      { txid: sourceTxid, spendable: true, spentBy: undefined }
    )
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue(f.tracker)
    // This synthetic provider advertises a newly inserted request. The concrete
    // provider omits optional isNew; that ordinary path does not publish here.
    const getProvenOrReq = ctx.activeStorage.getProvenOrReq.bind(ctx.activeStorage)
    const requests = jest
      .spyOn(ctx.activeStorage, 'getProvenOrReq')
      .mockImplementation(async (id, req, trx) => {
        const retained = await getProvenOrReq(id, req, trx)
        return req === undefined ? retained : { ...retained, isNew: true }
      })
    const originalInputs = await Promise.all(
      [own, other].map(
        async output =>
          (await ctx.activeStorage.findOutputs({ partial: { outputId: output.outputId } }))[0]
      )
    )
    const publish = jest
      .spyOn(internalizationPublication, 'shareReqsWithWorld')
      .mockImplementation(async () => {
        const target = (
          await ctx.activeStorage.findTransactions({ partial: { userId: ctx.userId, txid } })
        )[0]
        expect(target).toBeDefined()
        const spentOwn = (
          await ctx.activeStorage.findOutputs({ partial: { outputId: own.outputId } })
        )[0]
        const spentForeign = (
          await ctx.activeStorage.findOutputs({ partial: { outputId: other.outputId } })
        )[0]
        expect(spentOwn).toMatchObject({ spendable: false, spentBy: target.transactionId })
        expect(spentForeign.spendable).toBe(false)
        expect(spentForeign.spentBy).toBeUndefined()
        return {
          swr: [{ txid, status: 'failed' }],
          ndr: [{ txid, status: 'serviceError' }]
        }
      })
    const network = jest
      .spyOn(ctx.services, 'postBeef')
      .mockRejectedValue(new Error('Synthetic publication port only'))
    const auth = await ctx.storage.getAuth(true)
    const result = await storageInternalizationCore(
      ctx.activeStorage,
      auth,
      {
        tx: f.tx.toAtomicBEEF(),
        description: 'Synthetic failed publication',
        labels: ['pending public receipt'],
        outputs: [
          {
            outputIndex: 1,
            protocol: 'basket insertion',
            insertionRemittance: { basket: 'pending records', tags: ['pending tag'] }
          }
        ]
      },
      null
    )
    expect(result).toMatchObject({
      accepted: true,
      isMerge: false,
      txid,
      satoshis: 0,
      sendWithResults: [{ txid, status: 'failed' }],
      notDelayedResults: [{ txid, status: 'serviceError' }]
    })
    expect(requests).toHaveBeenCalledTimes(1)
    expect(requests.mock.calls[0][0]).toBe(txid)
    expect(requests.mock.calls[0][1]).toMatchObject({ txid, status: 'unsent' })
    expect(publish).toHaveBeenCalledTimes(1)
    const call = publish.mock.calls[0]
    expect(call.slice(0, 4)).toEqual([ctx.activeStorage, ctx.userId, [], false])
    expect(call[4]?.details).toMatchObject([{ txid, status: 'readyToSend' }])
    expect(call[4]?.beef.atomicTxid).toBe(txid)
    for (const [index, output] of [own, other].entries()) {
      const retained = (
        await ctx.activeStorage.findOutputs({ partial: { outputId: output.outputId } })
      )[0]
      expect(retained).toMatchObject({
        userId: output.userId,
        transactionId: output.transactionId,
        txid: sourceTxid,
        vout: 0,
        spendable: true
      })
      expect(retained.spentBy).toBeUndefined()
      expect({ ...retained, updated_at: originalInputs[index].updated_at }).toEqual(
        originalInputs[index]
      )
    }
    expect(
      await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid } })
    ).toHaveLength(0)
    expect(
      await ctx.activeStorage.findTxLabels({
        partial: { userId: ctx.userId, label: 'pending public receipt' }
      })
    ).toHaveLength(0)
    expect(
      await ctx.activeStorage.findOutputBaskets({
        partial: { userId: ctx.userId, name: 'pending records' }
      })
    ).toHaveLength(0)
    expect(
      await ctx.activeStorage.findOutputTags({
        partial: { userId: ctx.userId, tag: 'pending tag' }
      })
    ).toHaveLength(0)
    expect(
      await ctx.activeStorage.findTransactions({ partial: { userId: ctx.userId, txid } })
    ).toHaveLength(1)
    expect(network).not.toHaveBeenCalled()
  })
})

describe('shared internalization checks late evidence and inclusion lookup ports', () => {
  let ctx: TestWalletNoSetup
  let nonce = 800
  beforeAll(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy('internalization-late-evidence', 'legacy')
  })
  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    await ctx.wallet.destroy()
  })
  async function fixture(lifecycle: 'new' | 'nosend') {
    const f = fundingFixture(ctx)
    f.tx.lockTime = nonce++
    const txid = f.tx.id('hex')
    f.tx.merklePath = new MerklePath(1500, [[{ offset: 0, hash: txid, txid: true }]])
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({
      currentHeight: async () => 2000,
      isValidRootForHeight: async () => true
    })
    const header = jest
      .spyOn(ctx.services, 'getHeaderForHeight')
      .mockResolvedValue(
        serializeBaseBlockHeader({ ...genesisHeader(ctx.chain), merkleRoot: txid })
      )
    const network = jest
      .spyOn(ctx.services, 'postBeef')
      .mockRejectedValue(new Error('Synthetic inclusion port only'))
    if (lifecycle === 'nosend') {
      const now = new Date()
      await ctx.activeStorage.insertTransaction({
        created_at: now,
        updated_at: now,
        transactionId: 0,
        userId: ctx.userId,
        txid,
        status: 'nosend',
        reference: `public-inclusion-${nonce}`,
        isOutgoing: false,
        satoshis: 0,
        description: 'Synthetic pending inclusion'
      })
    }
    const args: InternalizeActionArgs = {
      tx: f.tx.toAtomicBEEF(),
      description: 'Synthetic inclusion refusal',
      labels: ['unadmitted inclusion'],
      outputs: [
        {
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: { basket: 'unadmitted inclusion', tags: ['unadmitted tag'] }
        }
      ]
    }
    return { f, txid, args, header, network, auth: await ctx.storage.getAuth(true) }
  }
  async function unchanged(txid: string, lifecycle: 'new' | 'nosend') {
    const transactions = await ctx.activeStorage.findTransactions({
      partial: { userId: ctx.userId, txid }
    })
    expect(transactions).toHaveLength(lifecycle === 'nosend' ? 1 : 0)
    if (lifecycle === 'nosend') expect(transactions[0].status).toBe('nosend')
    expect(
      await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid } })
    ).toHaveLength(0)
    expect(await ctx.activeStorage.findProvenTxs({ partial: { txid } })).toHaveLength(0)
    expect(
      await ctx.activeStorage.findTxLabels({
        partial: { userId: ctx.userId, label: 'unadmitted inclusion' }
      })
    ).toHaveLength(0)
  }
  test.each(['new', 'nosend'] as const)(
    'refuses a %s proof lookup with no subject leaf before header access or ownership',
    async lifecycle => {
      const { txid, args, auth, header, network } = await fixture(lifecycle)
      const malformed = new MerklePath(1500, [[{ offset: 0, hash: '11'.repeat(32), txid: true }]])
      jest.spyOn(malformed, 'computeRoot').mockReturnValue(txid)
      const original = Beef.prototype.findBump
      jest.spyOn(Beef.prototype, 'findBump').mockImplementation(function (this: Beef, requested) {
        return requested === txid ? malformed : original.call(this, requested)
      })
      await expect(
        storageInternalizationCore(ctx.activeStorage, auth, args, null)
      ).rejects.toMatchObject({
        name: 'WERR_INTERNAL',
        message: `Could not determine transaction index for txid ${txid} in bump path. Expected to find txid in bump.path[0]: ${JSON.stringify(malformed.path[0])}`
      })
      expect(header).not.toHaveBeenCalled()
      expect(network).not.toHaveBeenCalled()
      await unchanged(txid, lifecycle)
    }
  )
  test.each(['new', 'nosend'] as const)(
    'refuses a %s subject lost after initial verification before ownership commits',
    async lifecycle => {
      const { txid, args, auth, network } = await fixture(lifecycle)
      const original = Beef.prototype.verify
      jest.spyOn(Beef.prototype, 'verify').mockImplementation(async function (
        this: Beef,
        tracker,
        allowTxidOnly
      ) {
        const valid = await original.call(this, tracker, allowTxidOnly)
        const find = this.findTxid.bind(this)
        let reads = 0
        this.findTxid = requested => {
          if (requested === txid && ++reads > 1) return undefined
          return find(requested)
        }
        return valid
      })
      await expect(
        storageInternalizationCore(ctx.activeStorage, auth, args, null)
      ).rejects.toMatchObject({
        name: 'WERR_INTERNAL',
        message: `Could not find transaction ${txid} in AtomicBEEF`
      })
      expect(network).not.toHaveBeenCalled()
      await unchanged(txid, lifecycle)
    }
  )
})

describe('mined recovery and optional basket metadata retain ownership facts', () => {
  let ctx: TestWalletNoSetup
  beforeAll(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy('internalization-mined-recovery-merge', 'legacy')
  })
  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    await ctx.wallet.destroy()
  })
  function mined(lockTime: number) {
    const f = fundingFixture(ctx)
    f.tx.lockTime = lockTime
    const txid = f.tx.id('hex')
    f.tx.merklePath = new MerklePath(1500, [[{ offset: 0, hash: txid, txid: true }]])
    const header = serializeBaseBlockHeader({ ...genesisHeader(ctx.chain), merkleRoot: txid })
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({
      currentHeight: async () => 2000,
      isValidRootForHeight: async (root, height) =>
        (root === txid && height === 1500) || (await f.tracker.isValidRootForHeight(root, height))
    })
    jest.spyOn(ctx.services, 'getHeaderForHeight').mockResolvedValue(header)
    const network = jest
      .spyOn(ctx.services, 'postBeef')
      .mockRejectedValue(new Error('Synthetic mined receipt only'))
    return { f, txid, network }
  }
  test('merges a mined ordinary payment into an existing recovery transaction with its exact proof and balance', async () => {
    const { f, txid, network } = mined(801),
      now = new Date()
    const transactionId = await ctx.activeStorage.insertTransaction({
      created_at: now,
      updated_at: now,
      transactionId: 0,
      userId: ctx.userId,
      txid,
      status: 'unproven',
      reference: Utils.toBase64(Utils.toArray('recovery-merge', 'utf8')),
      isOutgoing: false,
      satoshis: 7,
      description: 'Synthetic retained recovery receipt'
    })
    const request = EntityProvenTxReq.fromTxid(txid, f.tx.toBinary(), f.tx.toAtomicBEEF())
    request.status = 'unsent'
    await ctx.activeStorage.insertProvenTxReq(request.toApi())
    const hook: FundingRecoveryCommit = {
      protocol: 'wallet-funding-recovery-v1',
      reject: jest.fn(),
      commit: jest.fn(async run => await ctx.activeStorage.transaction(run))
    }
    const auth = await ctx.storage.getAuth(true)
    const result = await storageInternalizationCore(
      ctx.activeStorage,
      auth,
      {
        tx: f.tx.toAtomicBEEF(),
        description: 'Synthetic mined recovery merge',
        labels: ['retained recovery'],
        outputs: [
          {
            outputIndex: 1,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: 'cHVibGljLWZpeHR1cmU=',
              derivationSuffix: 'cGF5bWVudA==',
              senderIdentityKey: new PrivateKey(81).toPublicKey().toString()
            }
          }
        ]
      },
      null,
      hook
    )
    expect(result).toMatchObject({ accepted: true, isMerge: true, txid, satoshis: 100 })
    expect(hook.commit).toHaveBeenCalledTimes(1)
    expect(hook.reject).not.toHaveBeenCalled()
    const transactions = await ctx.activeStorage.findTransactions({
      partial: { userId: ctx.userId, txid }
    })
    expect(transactions).toHaveLength(1)
    expect(transactions[0]).toMatchObject({ transactionId, status: 'completed', satoshis: 107 })
    const proof = await ctx.activeStorage.findProvenTxs({ partial: { txid } })
    expect(proof).toHaveLength(1)
    expect(proof[0]).toMatchObject({
      height: 1500,
      index: 0,
      merkleRoot: txid,
      merklePath: f.tx.merklePath!.toBinary(),
      rawTx: f.tx.toBinary()
    })
    expect(transactions[0].provenTxId).toBe(proof[0].provenTxId)
    const requests = await ctx.activeStorage.findProvenTxReqs({ partial: { txid } })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ status: 'completed', provenTxId: proof[0].provenTxId })
    expect(requests[0].history).toContain('fundingRecovery-proof')
    const outputs = await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid } })
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({
      transactionId,
      vout: 1,
      satoshis: 100,
      spendable: true,
      type: 'P2PKH',
      change: true,
      providedBy: 'storage'
    })
    expect(isManagedChangeOutput(outputs[0])).toBe(true)
    expect(network).not.toHaveBeenCalled()
  })
  test('an optional-tag validator port retains a mined custom output without creating tags', async () => {
    const { f, txid, network } = mined(802),
      auth = await ctx.storage.getAuth(true)
    const tagsBefore = await ctx.activeStorage.findOutputTags({ partial: { userId: ctx.userId } })
    const args: InternalizeActionArgs = {
      tx: f.tx.toAtomicBEEF(),
      description: 'Synthetic tag-free record',
      labels: [],
      outputs: [
        {
          outputIndex: 1,
          protocol: 'basket insertion',
          insertionRemittance: { basket: 'tag-free records' }
        }
      ]
    }
    const valid = internalizationValidation.validateInternalizeActionArgs(args)
    delete valid.outputs[0].insertionRemittance!.tags
    const validation = jest
      .spyOn(internalizationValidation, 'validateInternalizeActionArgs')
      .mockReturnValue(valid)
    expect(await storageInternalizationCore(ctx.activeStorage, auth, args, null)).toMatchObject({
      accepted: true,
      isMerge: false,
      txid,
      satoshis: 0
    })
    expect(validation).toHaveBeenCalledTimes(1)
    const basket = await ctx.activeStorage.findOutputBaskets({
      partial: { userId: ctx.userId, name: 'tag-free records' }
    })
    expect(basket).toHaveLength(1)
    const outputs = await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId, txid } })
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({
      vout: 1,
      satoshis: 100,
      basketId: basket[0].basketId,
      type: 'custom',
      change: false,
      spendable: true,
      providedBy: 'you'
    })
    expect(
      await ctx.activeStorage.findOutputTagMaps({ partial: { outputId: outputs[0].outputId } })
    ).toHaveLength(0)
    expect(await ctx.activeStorage.findOutputTags({ partial: { userId: ctx.userId } })).toEqual(
      tagsBefore
    )
    expect(network).not.toHaveBeenCalled()
  })
})
