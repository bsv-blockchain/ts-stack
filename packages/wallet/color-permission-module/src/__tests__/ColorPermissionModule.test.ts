import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import {
  Beef,
  LockingScript,
  MerklePath,
  OP,
  Signature,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  type CreateActionArgs,
  type CreateActionResult,
  type InternalizeActionArgs,
  type ListOutputsResult,
  type SignActionArgs,
  type SignActionResult
} from '@bsv/sdk'
import { hash160 } from '@bsv/sdk/primitives/Hash'
import { toArray } from '@bsv/sdk/primitives/utils'
import { OneColor } from '@bsv/templates'
import {
  encryptMetadata,
  maybeDecryptMetadata,
  type PermissionsModuleAction
} from '@bsv/wallet-toolbox-client'
import { ColorPlan } from '../ColorPlan.js'
import { ColorPermissionModule } from '../ColorPermissionModule.js'
import {
  assetBasket,
  assetTag,
  COLOR_KEY_ID,
  colorProtocolID,
  colorTopic,
  derivationSuffixTag
} from '../identifiers.js'
import {
  createModule,
  deployAsset,
  FakeProvider,
  FakeWallet,
  holdTokens,
  legacyDeploy,
  remittanceString,
  tokenPayment,
  validInput
} from './fixtures.js'

const APP = 'app.example'

function transferPlan(assetId: string): string[] {
  return ColorPlan.toLabels({
    version: 1,
    assets: [assetId],
    ownedOutputs: [],
    operations: [{ assetId, operation: 'transfer' }],
    inputPositions: [],
    changePositions: [],
    sighashTypes: []
  })
}

async function recipientOutput(
  sender: FakeWallet,
  recipient: FakeWallet,
  assetId: string,
  amount: bigint
) {
  const { tx } = await tokenPayment(sender, recipient, assetId, amount)
  return {
    lockingScript: tx.outputs[0].lockingScript.toHex(),
    satoshis: 1,
    outputDescription: 'Token payment'
  }
}

describe('ColorPermissionModule', () => {
  let wallet: FakeWallet
  let provider: FakeProvider
  let prompts: Array<{ app: string; request: Record<string, unknown> }>
  let module: ColorPermissionModule
  let assetId: string

  beforeEach(async () => {
    wallet = new FakeWallet()
    provider = new FakeProvider()
    prompts = []
    module = createModule(wallet, provider, async (app, message) => {
      prompts.push({ app, request: JSON.parse(message) })
      return true
    })
    assetId = (await deployAsset(new FakeWallet(), provider, 1_000_000n)).assetId
  })

  /** The action a WalletPermissionsManager passes to signAction hooks for a signable result. */
  function signingAction(created: CreateActionResult, noSend = false): PermissionsModuleAction {
    const signable = created.signableTransaction!
    return {
      reference: signable.reference,
      transaction: Transaction.fromAtomicBEEF(signable.tx),
      noSend,
      createArgs: wallet.pending.get(signable.reference)!.args
    }
  }

  async function send(args: Partial<CreateActionArgs>): Promise<SignActionResult> {
    const funded = (
      await module.onRequest({
        method: 'createAction',
        args: {
          description: 'Send tokens',
          labels: transferPlan(assetId),
          ...args,
          options: { randomizeOutputs: false, ...args.options }
        },
        originator: APP
      })
    ).args as CreateActionArgs
    const created = (await module.onResponse(await wallet.createAction(funded), {
      method: 'createAction',
      originator: APP
    })) as CreateActionResult
    const action = signingAction(created, args.options?.noSend === true)
    const signArgs = (
      await module.onRequest({
        method: 'signAction',
        args: { reference: action.reference, spends: {} },
        originator: APP,
        action
      })
    ).args as { reference: string; spends: Record<number, { unlockingScript: string }> }
    return (await module.onResponse(await wallet.signAction(signArgs), {
      method: 'signAction',
      originator: APP,
      action
    })) as SignActionResult
  }

  describe('receive', () => {
    async function receipt(
      customInstructions: string,
      basket = assetBasket(assetId, 'value'),
      tx?: Transaction
    ) {
      const args: InternalizeActionArgs = {
        tx: tx!.toAtomicBEEF(),
        description: 'Receive tokens',
        outputs: [
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: { basket, customInstructions }
          }
        ]
      }
      return await module.onRequest({ method: 'internalizeAction', args, originator: APP })
    }

    it('accepts an admitted output locked to this wallet', async () => {
      const { tx, customInstructions } = await tokenPayment(new FakeWallet(), wallet, assetId, 25n)
      provider.admit(assetId, tx, 0)
      await expect(receipt(customInstructions, undefined, tx)).resolves.toEqual(
        expect.objectContaining({ args: expect.anything() })
      )
    })

    it('rejects a receipt the overlay has not admitted', async () => {
      const { tx, customInstructions } = await tokenPayment(new FakeWallet(), wallet, assetId, 25n)
      provider.admit(assetId, tx, 0)
      provider.spend(`${tx.id('hex')}.0`)
      await expect(receipt(customInstructions, undefined, tx)).rejects.toThrow(
        'not admitted and unspent'
      )
    })

    it('accepts an admitted output spending inputs it cannot read as BRC-162', async () => {
      const legacyId = legacyDeploy(provider, 1)
      const { tx, customInstructions } = await tokenPayment(new FakeWallet(), wallet, legacyId, 25n)
      // A BRC-161 JSON transfer, spendable by anyone, replaces the payment's binary source.
      const json = `{"p":"bsv-20","op":"transfer","id":"${legacyId}","amt":"25"}`
      const source = new Transaction()
      source.addOutput({
        lockingScript: new LockingScript()
          .writeOpCode(OP.OP_FALSE)
          .writeOpCode(OP.OP_IF)
          .writeBin(toArray('ord', 'utf8'))
          .writeOpCode(OP.OP_1)
          .writeBin(toArray('application/bsv-20', 'utf8'))
          .writeOpCode(OP.OP_FALSE)
          .writeBin(toArray(json, 'utf8'))
          .writeOpCode(OP.OP_ENDIF)
          .writeOpCode(OP.OP_TRUE),
        satoshis: 1
      })
      tx.inputs[0].sourceTransaction = source
      provider.admit(legacyId, tx, 0)
      await expect(
        receipt(customInstructions, assetBasket(legacyId, 'value'), tx)
      ).resolves.toEqual(expect.objectContaining({ args: expect.anything() }))
    })

    it('rejects a receipt whose input does not unlock its source', async () => {
      const { tx, customInstructions } = await tokenPayment(new FakeWallet(), wallet, assetId, 25n)
      provider.admit(assetId, tx, 0)
      tx.inputs[0].unlockingScript = UnlockingScript.fromHex('00')
      await expect(receipt(customInstructions, undefined, tx)).rejects.toThrow(
        'Script evaluation error'
      )
    })

    it('rejects a receipt locked to another wallet or filed in the wrong basket', async () => {
      const { tx, customInstructions } = await tokenPayment(
        new FakeWallet(),
        new FakeWallet(),
        assetId,
        25n
      )
      provider.admit(assetId, tx, 0)
      await expect(receipt(customInstructions, undefined, tx)).rejects.toThrow(
        "not locked to this wallet's p color key"
      )
      const mine = await tokenPayment(new FakeWallet(), wallet, assetId, 25n)
      provider.admit(assetId, mine.tx, 0)
      await expect(
        receipt(mine.customInstructions, assetBasket(assetId, 'authority'), mine.tx)
      ).rejects.toThrow('basket does not match')
    })

    it('rejects embedded token proofs and unknown instruction members', async () => {
      const { tx, customInstructions } = await tokenPayment(new FakeWallet(), wallet, assetId, 25n)
      provider.admit(assetId, tx, 0)
      const withProofs = JSON.stringify({ ...JSON.parse(customInstructions), tokenProofs: [] })
      await expect(receipt(withProofs, undefined, tx)).rejects.toThrow('unknown member tokenProofs')
    })

    it('rejects an asset whose deploy requires a processing profile', async () => {
      const text = (value: string): number[] => [0x60 + value.length, ...toArray(value, 'utf8')]
      const requiresProfile = [0xa1, ...text('req'), 0xa1, ...text('x:y'), 0xf6]
      const profiled = await deployAsset(new FakeWallet(), provider, 10n, requiresProfile)
      const { tx, customInstructions } = await tokenPayment(
        new FakeWallet(),
        wallet,
        profiled.assetId,
        5n
      )
      provider.admit(profiled.assetId, tx, 0)
      await expect(
        receipt(customInstructions, assetBasket(profiled.assetId, 'value'), tx)
      ).rejects.toThrow('requires processing profiles')
    })
  })

  describe('send', () => {
    it('funds a send from the asset basket with token change, then signs and submits it', async () => {
      await holdTokens(wallet, provider, assetId, [60n, 300n])
      const recipient = new FakeWallet()
      const result = await send({
        outputs: [await recipientOutput(wallet, recipient, assetId, 100n)]
      })

      const tx = Transaction.fromAtomicBEEF(result.tx!)
      expect(tx.inputs).toHaveLength(1)
      expect(validInput(tx, 0)).toBe(true)
      expect(tx.outputs.map(output => OneColor.decode(output.lockingScript).amount)).toEqual([
        100n,
        200n
      ])
      expect(provider.submissions).toEqual([{ topics: [colorTopic(assetId)], txid: tx.id('hex') }])
      expect(prompts.map(prompt => prompt.request.type)).toEqual(['color_send'])
      expect(prompts[0].request).toMatchObject({
        assets: [{ assetId, inputAmount: '300', keptAmount: '200', outgoingAmount: '100' }],
        destinations: [{ outputIndex: 0, assetId, amount: '100' }],
        signatures: [{ inputIndex: 0, sighashType: 0x41 }]
      })
      const balance = (await module.handleRequest(
        {
          method: 'listOutputs',
          args: { basket: `p color balance ${assetTag(assetId)}` },
          originator: APP
        },
        async () => {
          throw new Error('not forwarded')
        }
      )) as ListOutputsResult
      expect(balance).toEqual({ totalOutputs: '260', outputs: [] })
    })

    it('asks for approval of the funded action and signs nothing when declined', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      module = createModule(wallet, provider, async () => false)
      await expect(
        send({ outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)] })
      ).rejects.toThrow('declined the color_send request')
      expect(provider.submissions).toEqual([])
    })

    it('reads custody only for the outputs it selects, and skips an unreadable one', async () => {
      const [largest, middle, smallest] = await holdTokens(wallet, provider, assetId, [
        300n,
        200n,
        50n
      ])
      for (const tx of [middle, smallest]) {
        const stored = wallet.outputs.get(`${tx.id('hex')}.0`)!
        stored.customInstructions = await encryptMetadata(
          wallet.asWallet(),
          stored.customInstructions!
        )
      }
      wallet.outputs.get(`${largest.id('hex')}.0`)!.customInstructions = await encryptMetadata(
        wallet.asWallet(),
        'not a custody record'
      )
      const decrypt = jest.spyOn(wallet, 'decrypt')
      const result = await send({
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
      })
      expect(
        Transaction.fromAtomicBEEF(result.tx!).inputs.map(input =>
          input.sourceTransaction!.id('hex')
        )
      ).toEqual([middle.id('hex')])
      // The unreadable record, then the 200-unit output to select; signing uses the bound record.
      // Never the 50.
      expect(decrypt).toHaveBeenCalledTimes(2)
    })

    it('skips outputs the overlay no longer reports and fails on an insufficient balance', async () => {
      const [stale] = await holdTokens(wallet, provider, assetId, [500n, 150n])
      provider.spend(`${stale.id('hex')}.0`)
      const result = await send({
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
      })
      expect(
        Transaction.fromAtomicBEEF(result.tx!).inputs[0].sourceTransaction!.id('hex')
      ).not.toBe(stale.id('hex'))
      await expect(
        send({ outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)] })
      ).rejects.toThrow('insufficient spendable balance')
    })

    it('resubmits a held output its overlay does not report, then spends it', async () => {
      const [held] = await holdTokens(wallet, provider, assetId, [300n])
      const outpoint = `${held.id('hex')}.0`
      provider.current.delete(outpoint)
      const result = await send({
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
      })
      expect(Transaction.fromAtomicBEEF(result.tx!).inputs[0].sourceTransaction!.id('hex')).toBe(
        held.id('hex')
      )
      expect(provider.submissions[0]).toEqual({
        topics: [colorTopic(assetId)],
        txid: held.id('hex')
      })
    })

    it('tries a failed submission again before reporting it', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      const submit = provider.submit
      let failures = 2
      provider.submit = async (topics, beef) => {
        if (failures-- > 0) throw new Error('overlay unavailable')
        return await submit(topics, beef)
      }
      const result = await send({
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
      })
      expect(provider.submissions.map(submission => submission.txid)).toEqual([
        Transaction.fromAtomicBEEF(result.tx!).id('hex')
      ])
      failures = 3
      await expect(
        send({ outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 50n)] })
      ).rejects.toThrow('overlay unavailable')
    })

    it('refuses to sign an input that stopped being spendable after createAction', async () => {
      const [held] = await holdTokens(wallet, provider, assetId, [300n])
      const funded = (
        await module.onRequest({
          method: 'createAction',
          args: {
            description: 'Send tokens',
            labels: transferPlan(assetId),
            outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)],
            options: { randomizeOutputs: false }
          },
          originator: APP
        })
      ).args as CreateActionArgs
      const created = (await module.onResponse(await wallet.createAction(funded), {
        method: 'createAction',
        originator: APP
      })) as CreateActionResult
      provider.spend(`${held.id('hex')}.0`)
      const action = signingAction(created)
      await expect(
        module.onRequest({
          method: 'signAction',
          args: { reference: action.reference, spends: {} },
          originator: APP,
          action
        })
      ).rejects.toThrow('no longer spendable')
    })

    it('completes a send its overlay accepts but does not admit; the change is held', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      provider.rejectSubmissions = true
      const { txid } = await send({
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
      })
      expect(provider.submissions).toEqual([{ topics: [colorTopic(assetId)], txid }])
      const inventory = (await module.handleRequest(
        {
          method: 'listOutputs',
          args: { basket: 'p color assets', includeTags: true },
          originator: APP
        },
        async () => {
          throw new Error('not forwarded')
        }
      )) as ListOutputsResult
      expect(inventory.outputs).toEqual([
        expect.objectContaining({ outpoint: `${txid}.1`, tags: ['color_state_available'] })
      ])
    })

    it('reports a provider that refuses the submission three times', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      let attempts = 0
      provider.submit = async () => {
        attempts++
        throw new Error('overlay unavailable')
      }
      await expect(
        send({ outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)] })
      ).rejects.toThrow('overlay unavailable')
      expect(attempts).toBe(3)
    })

    it('holds the outputs it chose while checking them, so a concurrent send cannot take them', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      let approve: (() => void) | undefined
      const spendability = provider.spendability
      provider.spendability = async (asset, outpoints) => {
        if (approve === undefined) await new Promise<void>(resolve => (approve = resolve))
        return await spendability(asset, outpoints)
      }
      const request = async () =>
        await module.onRequest({
          method: 'createAction',
          args: {
            description: 'Send tokens',
            labels: transferPlan(assetId),
            outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)],
            options: { randomizeOutputs: false }
          },
          originator: APP
        })
      const first = request()
      while (approve === undefined) await new Promise(resolve => setImmediate(resolve))
      await expect(request()).rejects.toThrow('insufficient spendable balance')
      approve()
      expect(((await first).args as CreateActionArgs).inputs).toHaveLength(1)
    })

    it('holds nothing once an action it funded is aborted', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      const funded = (
        await module.onRequest({
          method: 'createAction',
          args: {
            description: 'Send tokens',
            labels: transferPlan(assetId),
            outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)],
            options: { randomizeOutputs: false }
          },
          originator: APP
        })
      ).args as CreateActionArgs
      const created = (await module.onResponse(await wallet.createAction(funded), {
        method: 'createAction',
        originator: APP
      })) as CreateActionResult
      await wallet.abortAction({ reference: created.signableTransaction!.reference })
      const result = await send({
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
      })
      expect(validInput(Transaction.fromAtomicBEEF(result.tx!), 0)).toBe(true)
    })

    it('refuses a noSend action without a BRC-177 handoff label, and signs one with it unsubmitted', async () => {
      await holdTokens(wallet, provider, assetId, [100n])
      const outputs = [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
      await expect(send({ outputs, options: { noSend: true } })).rejects.toThrow(
        'noSend token actions require a BRC-177 p nosend expiry label'
      )
      expect(wallet.pending.size).toBe(0)
      const result = await send({
        labels: ['p nosend expiry seconds 30', ...transferPlan(assetId)],
        outputs,
        options: { noSend: true }
      })
      expect(validInput(Transaction.fromAtomicBEEF(result.tx!), 0)).toBe(true)
      expect(provider.submissions).toEqual([])
    })

    it('rejects plans that do not match the requested outputs', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      const output = await recipientOutput(wallet, new FakeWallet(), assetId, 100n)
      const burn = ColorPlan.toLabels({
        version: 1,
        assets: [assetId],
        ownedOutputs: [],
        operations: [{ assetId, operation: 'burn' }],
        inputPositions: [],
        changePositions: [],
        sighashTypes: []
      })
      await expect(
        module.onRequest({
          method: 'createAction',
          args: {
            description: 'Send tokens',
            labels: burn,
            outputs: [output],
            options: { randomizeOutputs: false }
          },
          originator: APP
        })
      ).rejects.toThrow('exceed the authenticated input balance')
      await expect(
        module.onRequest({
          method: 'createAction',
          args: { description: 'Send tokens', outputs: [output] },
          originator: APP
        })
      ).rejects.toThrow('requires a p color plan')
    })
  })

  describe('handoff', () => {
    it('splits off the exact amount before a BRC-177 protected transfer', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      const result = await send({
        labels: ['p nosend expiry seconds 30', ...transferPlan(assetId)],
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)],
        options: { noSend: true }
      })

      const handoff = Transaction.fromAtomicBEEF(result.tx!)
      const split = handoff.inputs[0].sourceTransaction!
      expect(handoff.inputs).toHaveLength(1)
      expect(handoff.outputs).toHaveLength(1)
      expect(validInput(handoff, 0)).toBe(true)
      expect(split.outputs.map(output => OneColor.decode(output.lockingScript).amount)).toEqual([
        100n,
        200n
      ])
      expect(provider.submissions).toEqual([
        { topics: [colorTopic(assetId)], txid: split.id('hex') }
      ])
      expect(prompts.map(prompt => prompt.request.type)).toEqual(['color_send'])
      const stored = wallet.outputs.get(`${split.id('hex')}.0`)?.customInstructions ?? ''
      expect(stored.startsWith('{')).toBe(false)
      expect(JSON.parse(await maybeDecryptMetadata(wallet.asWallet(), stored))).toMatchObject({
        version: 1,
        assetId
      })
    })

    const handoffLabels = (): string[] => ['p nosend expiry seconds 30', ...transferPlan(assetId)]
    const explicitInput = (tx: Transaction) => ({
      outpoint: `${tx.id('hex')}.0`,
      unlockingScriptLength: 108,
      inputDescription: 'Explicit token input'
    })

    it('uses a foreign explicit input as given in a handoff', async () => {
      const { tx: foreign } = await tokenPayment(new FakeWallet(), new FakeWallet(), assetId, 100n)
      provider.admit(assetId, foreign, 0)
      wallet.store(foreign, 0, 'foreign')
      const inputBEEF = new Beef()
      inputBEEF.mergeTransaction(foreign)
      const created = await module.onRequest({
        method: 'createAction',
        args: {
          description: 'Send tokens',
          labels: handoffLabels(),
          inputBEEF: inputBEEF.toBinary(),
          inputs: [explicitInput(foreign)],
          outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)],
          options: { noSend: true, randomizeOutputs: false }
        },
        originator: APP
      })
      expect((created.args as CreateActionArgs).inputs).toEqual([explicitInput(foreign)])
      expect((created.args as CreateActionArgs).outputs).toHaveLength(1)
      expect(prompts).toEqual([])
    })

    it('spends an exact-amount explicit input of this wallet in a handoff without a split', async () => {
      // The app names this input without its BEEF; the fake wallet resolves it from storage.
      wallet.requireInputBEEF = false
      const [held] = await holdTokens(wallet, provider, assetId, [100n])
      const result = await send({
        labels: handoffLabels(),
        inputs: [explicitInput(held)],
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)],
        options: { noSend: true }
      })
      const handoff = Transaction.fromAtomicBEEF(result.tx!)
      expect(handoff.inputs[0].sourceTransaction!.id('hex')).toBe(held.id('hex'))
      expect(handoff.outputs).toHaveLength(1)
      expect(validInput(handoff, 0)).toBe(true)
      expect(prompts.map(prompt => prompt.request.type)).toEqual(['color_send'])
      expect(provider.submissions).toEqual([])
    })

    it('treats excess explicit value in a handoff as an undeclared burn', async () => {
      const [held] = await holdTokens(wallet, provider, assetId, [300n])
      await expect(
        send({
          labels: handoffLabels(),
          inputs: [explicitInput(held)],
          outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)],
          options: { noSend: true }
        })
      ).rejects.toThrow('requires the operations [transfer, burn] but the plan declares [transfer]')
      expect(prompts).toEqual([])
    })

    it('builds and submits the split without a prompt, even when the user declines the handoff', async () => {
      const [held] = await holdTokens(wallet, provider, assetId, [300n])
      const declined: string[] = []
      module = createModule(wallet, provider, async (_app, message) => {
        declined.push(JSON.parse(message).type)
        return false
      })
      await expect(
        send({
          labels: ['p nosend expiry seconds 30', ...transferPlan(assetId)],
          outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)],
          options: { noSend: true }
        })
      ).rejects.toThrow('declined the color_send request')
      expect(declined).toEqual(['color_send'])
      expect(provider.submissions).toHaveLength(1)
      const split = wallet.outputs.get(`${provider.submissions[0].txid}.0`)!
      expect(OneColor.decode(split.tx.outputs[0].lockingScript).amount).toBe(100n)
      expect(wallet.outputs.get(`${held.id('hex')}.0`)?.spent).toBe(true)
    })

    it('aborts the split when signing it fails', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      wallet.signAction = async () => {
        throw new Error('signing failed')
      }
      await expect(
        send({
          labels: ['p nosend expiry seconds 30', ...transferPlan(assetId)],
          outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)],
          options: { noSend: true }
        })
      ).rejects.toThrow('signing failed')
      expect(wallet.pending.size).toBe(0)
      expect(provider.submissions).toEqual([])
    })
  })

  describe('input records bound to the action reference', () => {
    const internals = () =>
      module as unknown as {
        staged: Map<string, unknown>
        bound: Map<string, Array<{ outpoint: string }>>
        selected: Set<string>
      }
    const outpointOf = (tx: Transaction): string => `${tx.id('hex')}.0`

    async function fund(amount = 100n): Promise<CreateActionArgs> {
      return (
        await module.onRequest({
          method: 'createAction',
          args: {
            description: 'Send tokens',
            labels: transferPlan(assetId),
            outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, amount)],
            options: { randomizeOutputs: false }
          },
          originator: APP
        })
      ).args as CreateActionArgs
    }

    async function respond(funded: CreateActionArgs): Promise<CreateActionResult> {
      return (await module.onResponse(await wallet.createAction(funded), {
        method: 'createAction',
        originator: APP
      })) as CreateActionResult
    }

    async function fundAndCreate(
      amount = 100n
    ): Promise<{ funded: CreateActionArgs; created: CreateActionResult }> {
      const funded = await fund(amount)
      return { funded, created: await respond(funded) }
    }

    async function signHook(action: PermissionsModuleAction): Promise<SignActionArgs> {
      return (
        await module.onRequest({
          method: 'signAction',
          args: { reference: action.reference, spends: {} },
          originator: APP,
          action
        })
      ).args as SignActionArgs
    }

    it('binds the inputs of the returned transaction to its reference and signs them without listing', async () => {
      const [selected] = await holdTokens(wallet, provider, assetId, [300n])
      // The wallet hides the action's reserved inputs from every listing, as its auto mode does.
      wallet.hideReserved = true
      const { created } = await fundAndCreate()
      const reference = created.signableTransaction!.reference
      expect(internals().staged.size).toBe(0)
      expect([...internals().bound.keys()]).toEqual([reference])
      expect(
        internals()
          .bound.get(reference)!
          .map(input => input.outpoint)
      ).toEqual([outpointOf(selected)])
      wallet.listOutputsCalls.length = 0
      const signArgs = await signHook(signingAction(created))
      expect(wallet.listOutputsCalls).toEqual([])
      expect(Object.keys(signArgs.spends ?? {})).toEqual(['0'])
      const signed = await wallet.signAction(signArgs)
      expect(validInput(Transaction.fromAtomicBEEF(signed.tx!), 0)).toBe(true)
      expect(internals().bound.size).toBe(0)
    })

    it('never signs one action’s inputs under another reference', async () => {
      await holdTokens(wallet, provider, assetId, [300n, 200n])
      const first = await fundAndCreate()
      const second = await fundAndCreate()
      const firstAction = signingAction(first.created)
      // The second reference's records are not inputs of the first transaction.
      await expect(
        signHook({ ...firstAction, reference: second.created.signableTransaction!.reference })
      ).rejects.toThrow('BRC-207: the signable transaction omits a token input')
      // A reference with no records signs nothing; the wallet then refuses the unsigned input.
      const unbound = await signHook({ ...firstAction, reference: 'not-bound' })
      expect(unbound.spends).toEqual({})
      // The first action's records were untouched by both.
      const signArgs = await signHook(firstAction)
      expect(Object.keys(signArgs.spends ?? {})).toEqual(['0'])
    })

    it('leaves a never-signed reference’s records unused when its outputs are selected again', async () => {
      const [held] = await holdTokens(wallet, provider, assetId, [300n])
      const first = await fundAndCreate()
      const firstReference = first.created.signableTransaction!.reference
      // The action dies without signAction; storage lists its input as spendable again.
      await wallet.abortAction({ reference: firstReference })
      const second = await fundAndCreate()
      const secondReference = second.created.signableTransaction!.reference
      expect(
        internals()
          .bound.get(secondReference)!
          .map(input => input.outpoint)
      ).toEqual([outpointOf(held)])
      const signArgs = await signHook(signingAction(second.created))
      const signed = await wallet.signAction(signArgs)
      expect(validInput(Transaction.fromAtomicBEEF(signed.tx!), 0)).toBe(true)
      expect(prompts.map(prompt => prompt.request.type)).toEqual(['color_send'])
      expect([...internals().bound.keys()]).toEqual([firstReference])
    })

    it('binds nothing for a result without a signable transaction and unstages its inputs', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      const funded = await fund()
      expect(internals().staged.size).toBe(1)
      const created = await wallet.createAction(funded)
      await module.onResponse(
        { txid: 'a'.repeat(64), tx: created.signableTransaction!.tx },
        { method: 'createAction', originator: APP }
      )
      expect(internals().staged.size).toBe(0)
      expect(internals().bound.size).toBe(0)
    })

    it.each(['absent', 'malformed', 'unrelated'] as const)(
      'preserves staged inputs after an %s transaction response until the matching result arrives',
      async kind => {
        const [held] = await holdTokens(wallet, provider, assetId, [300n])
        const funded = await fund()
        const created = await wallet.createAction(funded)
        const unrelated = new Transaction()
        unrelated.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 1 })
        const result =
          kind === 'absent'
            ? { txid: 'a'.repeat(64) }
            : { tx: kind === 'malformed' ? [0] : unrelated.toAtomicBEEF() }

        await expect(
          module.onResponse(result, { method: 'createAction', originator: APP })
        ).resolves.toBe(result)
        expect([...internals().staged.keys()]).toEqual([outpointOf(held)])
        expect(internals().bound.size).toBe(0)

        await module.onResponse(created, { method: 'createAction', originator: APP })
        expect(internals().staged.size).toBe(0)
        const signed = await wallet.signAction(await signHook(signingAction(created)))
        expect(validInput(Transaction.fromAtomicBEEF(signed.tx!), 0)).toBe(true)
        expect(internals().bound.size).toBe(0)
      }
    )

    it('defers to storage once the createAction has come back', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      const { created } = await fundAndCreate()
      expect(internals().staged.size).toBe(0)
      // Storage reserves the input.
      await expect(fund()).rejects.toThrow('insufficient spendable balance')
      await wallet.abortAction({ reference: created.signableTransaction!.reference })
      expect((await fund()).inputs).toHaveLength(1)
    })

    it('releases the records when signing is refused', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      module = createModule(wallet, provider, async () => false)
      const { created } = await fundAndCreate()
      expect(internals().bound.size).toBe(1)
      await expect(signHook(signingAction(created))).rejects.toThrow(
        'declined the color_send request'
      )
      expect(internals().bound.size).toBe(0)
    })

    it('clears staged and bound records on dispose', async () => {
      await holdTokens(wallet, provider, assetId, [300n, 200n])
      await fundAndCreate()
      await fund()
      expect(internals().bound.size).toBe(1)
      expect(internals().staged.size).toBe(1)
      module.dispose()
      expect(internals().bound.size).toBe(0)
      expect(internals().staged.size).toBe(0)
    })

    it('keeps nothing from a createAction that fails', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      wallet.editBEEF = () => undefined
      await expect(fund()).rejects.toThrow('no source transaction for token input')
      expect(internals().staged.size).toBe(0)
      expect(internals().selected.size).toBe(0)
      wallet.editBEEF = undefined
      const { created } = await fundAndCreate()
      expect(created.signableTransaction).toBeDefined()
    })
  })

  describe('suffix tags on filed outputs', () => {
    const tagFor = (customInstructions: string | undefined): string =>
      derivationSuffixTag(
        (JSON.parse(customInstructions!) as { derivationSuffix: string }).derivationSuffix
      )

    it('tags token change with its derivation suffix', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      const funded = (
        await module.onRequest({
          method: 'createAction',
          args: {
            description: 'Send tokens',
            labels: transferPlan(assetId),
            outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)],
            options: { randomizeOutputs: false }
          },
          originator: APP
        })
      ).args as CreateActionArgs
      const change = funded.outputs![1]
      expect(change.basket).toBe(assetBasket(assetId, 'value'))
      expect(change.tags).toEqual([tagFor(change.customInstructions)])
    })

    it('tags a receipt with its derivation suffix', async () => {
      const { tx, customInstructions } = await tokenPayment(new FakeWallet(), wallet, assetId, 50n)
      provider.admit(assetId, tx, 0)
      const received = (
        await module.onRequest({
          method: 'internalizeAction',
          args: {
            tx: tx.toAtomicBEEF(),
            description: 'Receive tokens',
            outputs: [
              {
                outputIndex: 0,
                protocol: 'basket insertion',
                insertionRemittance: {
                  basket: assetBasket(assetId, 'value'),
                  customInstructions,
                  tags: ['app tag']
                }
              }
            ]
          },
          originator: APP
        })
      ).args as InternalizeActionArgs
      expect(received.outputs[0].insertionRemittance?.tags).toEqual([
        'app tag',
        tagFor(customInstructions)
      ])
    })

    it('tags both outputs of a handoff split', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      const created: CreateActionArgs[] = []
      const createAction = wallet.createAction.bind(wallet)
      wallet.createAction = async args => {
        created.push(args)
        return await createAction(args)
      }
      await send({
        labels: ['p nosend expiry seconds 30', ...transferPlan(assetId)],
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)],
        options: { noSend: true }
      })
      const split = created[0].outputs!
      expect(split).toHaveLength(2)
      for (const output of split) {
        const custody = await maybeDecryptMetadata(wallet.asWallet(), output.customInstructions!)
        expect(output.tags).toEqual([tagFor(custody)])
      }
    })
  })

  describe('input BEEF', () => {
    async function fund(args: Partial<CreateActionArgs>): Promise<CreateActionArgs> {
      return (
        await module.onRequest({
          method: 'createAction',
          args: {
            description: 'Send tokens',
            labels: transferPlan(assetId),
            ...args,
            options: { randomizeOutputs: false, ...args.options }
          },
          originator: APP
        })
      ).args as CreateActionArgs
    }

    const outpointOf = (tx: Transaction): string => `${tx.id('hex')}.0`
    const sourceOf = (tx: Transaction): Transaction => tx.inputs[0].sourceTransaction!
    const txids = (beef: number[] | Uint8Array | undefined): string[] =>
      Beef.fromBinary(beef!)
        .txs.map(tx => tx.txid)
        .sort()

    const tagOf = (tx: Transaction): string => {
      const { derivationSuffix } = JSON.parse(
        wallet.outputs.get(outpointOf(tx))!.customInstructions!
      ) as { derivationSuffix: string }
      return derivationSuffixTag(derivationSuffix)
    }

    it('supplies the selected inputs’ transactions with their proofs and nothing else', async () => {
      const [, selected] = await holdTokens(wallet, provider, assetId, [60n, 300n])
      const source = sourceOf(selected)
      source.merklePath = new MerklePath(1, [
        [
          { offset: 0, hash: source.id('hex'), txid: true },
          { offset: 1, duplicate: true }
        ]
      ])
      const funded = await fund({
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
      })

      expect(funded.inputs?.map(input => input.outpoint)).toEqual([outpointOf(selected)])
      const beef = Beef.fromBinary(funded.inputBEEF!)
      expect(txids(funded.inputBEEF)).toEqual([selected.id('hex'), source.id('hex')].sort())
      expect(beef.bumps).toHaveLength(1)
      expect(beef.findTxid(source.id('hex'))?.bumpIndex).toBe(0)
      expect(beef.isValid()).toBe(true)
    })

    const beefListings = () =>
      wallet.listOutputsCalls
        .filter(call => call.include === 'entire transactions')
        .map(({ basket, tags, tagQueryMode, limit, includeCustomInstructions }) => ({
          basket,
          tags,
          tagQueryMode,
          limit,
          includeCustomInstructions
        }))

    it('reads the selected inputs of one basket in one listing by their suffix tags', async () => {
      const [, first, second] = await holdTokens(wallet, provider, assetId, [60n, 300n, 200n, 20n])
      const output = await recipientOutput(wallet, new FakeWallet(), assetId, 400n)
      wallet.listOutputsCalls.length = 0
      const funded = await fund({ outputs: [output] })
      expect(funded.inputs?.map(input => input.outpoint)).toEqual([
        outpointOf(first),
        outpointOf(second)
      ])
      expect(beefListings()).toEqual([
        {
          basket: assetBasket(assetId, 'value'),
          tags: [tagOf(first), tagOf(second)],
          tagQueryMode: 'any',
          limit: 2,
          includeCustomInstructions: undefined
        }
      ])
      expect(txids(funded.inputBEEF)).toEqual(
        [first, second, sourceOf(first), sourceOf(second)].map(tx => tx.id('hex')).sort()
      )
    })

    it('reads each asset’s selected inputs in one listing per basket', async () => {
      const other = (await deployAsset(new FakeWallet(), provider, 1_000n)).assetId
      const [mine] = await holdTokens(wallet, provider, assetId, [300n])
      const [theirs] = await holdTokens(wallet, provider, other, [300n])
      wallet.listOutputsCalls.length = 0
      const funded = await fund({
        labels: ColorPlan.toLabels({
          version: 1,
          assets: [assetId, other],
          ownedOutputs: [],
          operations: [
            { assetId, operation: 'transfer' },
            { assetId: other, operation: 'transfer' }
          ],
          inputPositions: [],
          changePositions: [],
          sighashTypes: []
        }),
        outputs: [
          await recipientOutput(wallet, new FakeWallet(), assetId, 100n),
          await recipientOutput(wallet, new FakeWallet(), other, 100n)
        ]
      })
      expect(beefListings().map(({ basket, tags, limit }) => ({ basket, tags, limit }))).toEqual([
        { basket: assetBasket(assetId, 'value'), tags: [tagOf(mine)], limit: 1 },
        { basket: assetBasket(other, 'value'), tags: [tagOf(theirs)], limit: 1 }
      ])
      expect(txids(funded.inputBEEF)).toEqual(
        [mine, theirs, sourceOf(mine), sourceOf(theirs)].map(tx => tx.id('hex')).sort()
      )
    })

    it('spends verified receipts with a shared suffix and different payment prefixes', async () => {
      const sender = new FakeWallet()
      async function payment(amount: bigint, prefix: string) {
        const { tx, customInstructions } = await tokenPayment(sender, wallet, assetId, amount)
        const custody = {
          ...JSON.parse(customInstructions),
          derivationPrefix: prefix,
          derivationSuffix: 'Ag=='
        }
        const { publicKey } = await sender.getPublicKey({
          protocolID: colorProtocolID(assetId, prefix, custody.derivationSuffix),
          keyID: COLOR_KEY_ID,
          counterparty: wallet.identityKey
        })
        tx.outputs[0].lockingScript = new OneColor().lock(
          assetId,
          amount,
          hash160(toArray(publicKey, 'hex'))
        )
        return { tx, custody }
      }
      const small = await payment(100n, 'AQ==')
      let large = await payment(300n, 'Aw==')
      // Put the unselected receipt before the selected one in the wallet's canonical order.
      for (let nonce = 0; large.tx.id('hex') < small.tx.id('hex'); nonce++) {
        large = await payment(300n, `payment${nonce}`)
      }
      for (const { tx, custody } of [small, large]) {
        provider.admit(assetId, tx, 0)
        const received = await module.onRequest({
          method: 'internalizeAction',
          originator: APP,
          args: {
            tx: tx.toAtomicBEEF(),
            outputs: [
              {
                outputIndex: 0,
                protocol: 'basket insertion',
                insertionRemittance: {
                  basket: assetBasket(assetId, 'value'),
                  customInstructions: JSON.stringify(custody)
                }
              }
            ],
            description: 'Receive tokens'
          }
        })
        await expect(
          wallet.internalizeAction(received.args as InternalizeActionArgs)
        ).resolves.toEqual({ accepted: true })
      }
      expect(tagOf(small.tx)).toBe(tagOf(large.tx))
      const funded = await fund({
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 200n)]
      })
      expect(funded.inputs?.map(input => input.outpoint)).toEqual([outpointOf(large.tx)])
      expect(txids(funded.inputBEEF)).toEqual(
        [large.tx.id('hex'), sourceOf(large.tx).id('hex')].sort()
      )
      const created = await wallet.createAction(funded)
      await module.onResponse(created, { method: 'createAction', originator: APP })
      const signed = await wallet.signAction(
        (
          await module.onRequest({
            method: 'signAction',
            args: { reference: created.signableTransaction!.reference, spends: {} },
            action: signingAction(created),
            originator: APP
          })
        ).args as SignActionArgs
      )
      expect(validInput(Transaction.fromAtomicBEEF(signed.tx!), 0)).toBe(true)
    })

    it('does not select an untagged output', async () => {
      await holdTokens(wallet, provider, assetId, [300n], false)
      const output = await recipientOutput(wallet, new FakeWallet(), assetId, 100n)
      await expect(fund({ outputs: [output] })).rejects.toThrow('insufficient spendable balance')
      const [tagged] = await holdTokens(wallet, provider, assetId, [200n])
      expect((await fund({ outputs: [output] })).inputs?.map(input => input.outpoint)).toEqual([
        outpointOf(tagged)
      ])
    })

    it('refuses an untagged app-named input', async () => {
      const [untagged] = await holdTokens(wallet, provider, assetId, [100n], false)
      await expect(
        fund({
          inputs: [
            { outpoint: outpointOf(untagged), unlockingScriptLength: 108, inputDescription: 'Mine' }
          ],
          outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
        })
      ).rejects.toThrow(
        `BRC-207: token output ${outpointOf(untagged)} was filed without its suffix tag and is not spendable through the module`
      )
    })

    it.each(['reserved', 'staged'] as const)(
      'refuses an app-named input already %s by another action',
      async state => {
        const [held] = await holdTokens(wallet, provider, assetId, [300n])
        const output = await recipientOutput(wallet, new FakeWallet(), assetId, 100n)
        const first = await fund({ outputs: [output] })
        if (state === 'reserved') {
          const created = await wallet.createAction(first)
          await module.onResponse(created, { method: 'createAction', originator: APP })
        }
        await expect(
          fund({
            inputs: [
              { outpoint: outpointOf(held), unlockingScriptLength: 108, inputDescription: 'Mine' }
            ],
            outputs: [output]
          })
        ).rejects.toThrow('BRC-207: an explicit p color input is reserved by another action')
        expect(prompts).toEqual([])
      }
    )

    it('refuses an app-named token input whose wallet record has no custody instructions', async () => {
      const [held] = await holdTokens(wallet, provider, assetId, [300n])
      wallet.outputs.get(outpointOf(held))!.customInstructions = undefined
      await expect(
        fund({
          inputs: [
            { outpoint: outpointOf(held), unlockingScriptLength: 108, inputDescription: 'Mine' }
          ],
          outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
        })
      ).rejects.toThrow('BRC-207: an explicit p color input is not a managed token output')
      expect(prompts).toEqual([])
    })

    it('lists a selected output by the suffix tag it carries, whatever its value', async () => {
      const [retagged] = await holdTokens(wallet, provider, assetId, [300n, 200n])
      const tag = derivationSuffixTag('another suffix')
      wallet.outputs.get(outpointOf(retagged))!.tags = [tag]
      const funded = await fund({
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
      })
      expect(funded.inputs?.map(input => input.outpoint)).toEqual([outpointOf(retagged)])
      const listing = wallet.listOutputsCalls.find(call => call.include === 'entire transactions')
      expect(listing?.tags).toEqual([tag])
    })

    it('pages past nonselected same-tag outputs without merging or crediting them', async () => {
      // A suffix tag is an index, not an ownership or amount assertion. A matching unselected
      // output may be legitimate (different payments can share a suffix) or merely retagged.
      let selected: Transaction
      let intruder: Transaction
      do {
        wallet.outputs.clear()
        ;[selected, intruder] = await holdTokens(wallet, provider, assetId, [300n, 50n])
      } while (outpointOf(intruder) > outpointOf(selected))
      wallet.outputs.get(outpointOf(intruder))!.tags = [tagOf(selected)]
      const funded = await fund({
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
      })
      expect(funded.inputs?.map(input => input.outpoint)).toEqual([outpointOf(selected)])
      expect(txids(funded.inputBEEF)).toEqual(
        [selected.id('hex'), sourceOf(selected).id('hex')].sort()
      )
      expect(
        OneColor.decode(LockingScript.fromHex(funded.outputs!.at(-1)!.lockingScript)).amount
      ).toBe(200n)
      expect(
        wallet.listOutputsCalls
          .filter(call => call.include === 'entire transactions')
          .map(({ limit, offset }) => ({ limit, offset }))
      ).toEqual([
        { limit: 1, offset: undefined },
        { limit: 1, offset: 1 }
      ])
    })

    it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'])(
      'refuses an invalid matching source count %s',
      async count => {
        await holdTokens(wallet, provider, assetId, [300n])
        const listOutputs = wallet.listOutputs.bind(wallet)
        wallet.listOutputs = async args => {
          const result = await listOutputs(args)
          return args.include === 'entire transactions'
            ? { ...result, totalOutputs: count }
            : result
        }
        await expect(
          fund({ outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)] })
        ).rejects.toThrow('the matching output count is not a nonnegative safe integer')
        expect(prompts).toEqual([])
      }
    )

    it('stops once all selected sources are found, without fetching other same-tag receipts', async () => {
      const [held] = await holdTokens(wallet, provider, assetId, [300n])
      const listOutputs = wallet.listOutputs.bind(wallet)
      let sourceCalls = 0
      wallet.listOutputs = async args => {
        const result = await listOutputs(args)
        if (args.include !== 'entire transactions') return result
        sourceCalls++
        if (sourceCalls > 1) throw new Error('unnecessary source page')
        return { ...result, totalOutputs: 10_000 }
      }
      const funded = await fund({
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
      })
      expect(sourceCalls).toBe(1)
      expect(funded.inputs?.map(input => input.outpoint)).toEqual([outpointOf(held)])
      expect(txids(funded.inputBEEF)).toEqual([held.id('hex'), sourceOf(held).id('hex')].sort())
    })

    it.each([
      'changed count',
      'duplicate',
      'empty page',
      'oversized page',
      'missing selected'
    ] as const)('refuses contradictory source pagination: %s', async kind => {
      const [held] = await holdTokens(wallet, provider, assetId, [300n])
      const listOutputs = wallet.listOutputs.bind(wallet)
      let sourceCalls = 0
      wallet.listOutputs = async args => {
        if (args.include !== 'entire transactions') return await listOutputs(args)
        sourceCalls++
        // A coherent first page has one same-tag row, with one more matching row to inspect.
        const result = await listOutputs({ ...args, offset: 0 })
        const heldOutput = result.outputs[0]
        const other = { ...heldOutput, outpoint: `${'a'.repeat(64)}.0` }
        let outputs = sourceCalls === 1 ? [other] : [heldOutput]
        if (sourceCalls === 2) {
          switch (kind) {
            case 'empty page':
              outputs = []
              break
            case 'duplicate':
              outputs = [other]
              break
            case 'oversized page':
              outputs = [heldOutput, { ...other, outpoint: `${'b'.repeat(64)}.0` }]
              break
            case 'missing selected':
              outputs = [{ ...other, outpoint: `${'b'.repeat(64)}.0` }]
              break
          }
        }
        return {
          ...result,
          totalOutputs: sourceCalls === 2 && kind === 'changed count' ? 3 : 2,
          outputs
        }
      }
      await expect(
        fund({ outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)] })
      ).rejects.toThrow('BRC-207: the wallet returned other outputs than the selected token inputs')
      expect(sourceCalls).toBe(2)
      expect(prompts).toEqual([])
      wallet.listOutputs = listOutputs
      // Pagination failure returns the selection to the module's available pool.
      expect(
        (
          await fund({
            outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
          })
        ).inputs?.map(input => input.outpoint)
      ).toEqual([outpointOf(held)])
    })

    it('bounds source pages by the wallet limit and the initial matching count', async () => {
      const [held] = await holdTokens(wallet, provider, assetId, [300n])
      const listOutputs = wallet.listOutputs.bind(wallet)
      const pages: Array<{ limit?: number; offset?: number }> = []
      wallet.listOutputs = async args => {
        if (args.include !== 'entire transactions') return await listOutputs(args)
        pages.push({ limit: args.limit, offset: args.offset })
        const result = await listOutputs({ ...args, offset: 0 })
        return {
          ...result,
          totalOutputs: 10_002,
          outputs:
            pages.length === 3
              ? result.outputs
              : Array.from({ length: args.limit! }, (_, index) => ({
                  ...result.outputs[0],
                  outpoint: `${(index + (args.offset ?? 0)).toString(16).padStart(64, '0')}.0`
                }))
        }
      }
      const funded = await fund({
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
      })
      expect(pages).toEqual([
        { limit: 1, offset: undefined },
        { limit: 10_000, offset: 1 },
        { limit: 1, offset: 10_001 }
      ])
      expect(funded.inputs?.map(input => input.outpoint)).toEqual([outpointOf(held)])
      expect(txids(funded.inputBEEF)).toEqual([held.id('hex'), sourceOf(held).id('hex')].sort())
    })

    it.each(['missing', 'duplicate'] as const)(
      'refuses a source listing with a %s selected output even when no foreign output is returned',
      async kind => {
        const [held] = await holdTokens(wallet, provider, assetId, [300n])
        const listOutputs = wallet.listOutputs.bind(wallet)
        wallet.listOutputs = async args => {
          const result = await listOutputs(args)
          if (args.include === 'entire transactions') {
            result.outputs = kind === 'missing' ? [] : [...result.outputs, result.outputs[0]]
          }
          return result
        }
        await expect(
          fund({ outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)] })
        ).rejects.toThrow(
          `BRC-207: the wallet returned other outputs than the selected token inputs: missing ${
            kind === 'missing' ? outpointOf(held) : 'none'
          }; extra none`
        )
        expect(prompts).toEqual([])
        wallet.listOutputs = listOutputs
        // A refused listing must release the selection so a corrected response can fund it.
        expect(
          (
            await fund({
              outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
            })
          ).inputs?.map(input => input.outpoint)
        ).toEqual([outpointOf(held)])
      }
    )

    it('merges the caller’s inputBEEF with the module’s', async () => {
      const [selected] = await holdTokens(wallet, provider, assetId, [300n])
      const other = new Transaction()
      other.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 500 })
      wallet.store(other, 0, 'foreign')
      const funded = await fund({
        inputs: [
          { outpoint: outpointOf(other), unlockingScriptLength: 1, inputDescription: 'Fee' }
        ],
        inputBEEF: other.toBEEF(),
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
      })
      expect(funded.inputs?.map(input => input.outpoint)).toEqual([
        outpointOf(other),
        outpointOf(selected)
      ])
      expect(txids(funded.inputBEEF)).toEqual(
        [other.id('hex'), selected.id('hex'), sourceOf(selected).id('hex')].sort()
      )
      // The wallet, which requires every input's transaction in inputBEEF, accepts the action.
      await expect(wallet.createAction(funded)).resolves.toHaveProperty('signableTransaction')
    })

    it('names the input whose source transaction the wallet returns only by txid, or not at all', async () => {
      const [selected] = await holdTokens(wallet, provider, assetId, [300n])
      const output = await recipientOutput(wallet, new FakeWallet(), assetId, 100n)
      wallet.editBEEF = beef => {
        beef.makeTxidOnly(selected.id('hex'))
        return beef
      }
      await expect(fund({ outputs: [output] })).rejects.toThrow(
        `BRC-207: the wallet returned no source transaction for token input ${outpointOf(selected)}`
      )
      wallet.editBEEF = () => undefined
      await expect(fund({ outputs: [output] })).rejects.toThrow(outpointOf(selected))
    })

    it('supplies the selected input for a handoff’s split, then the split for the handoff', async () => {
      const [held] = await holdTokens(wallet, provider, assetId, [300n])
      const created: CreateActionArgs[] = []
      const createAction = wallet.createAction.bind(wallet)
      wallet.createAction = async args => {
        created.push(args)
        return await createAction(args)
      }
      const result = await send({
        labels: ['p nosend expiry seconds 30', ...transferPlan(assetId)],
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)],
        options: { noSend: true }
      })
      const split = Transaction.fromAtomicBEEF(result.tx!).inputs[0].sourceTransaction!
      expect(created).toHaveLength(2)
      expect(txids(created[0].inputBEEF)).toEqual([held.id('hex'), sourceOf(held).id('hex')].sort())
      expect(txids(created[1].inputBEEF)).toEqual(
        [split.id('hex'), held.id('hex'), sourceOf(held).id('hex')].sort()
      )
    })
  })

  describe('createSignature', () => {
    async function appBuiltSpend(
      sighashType = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
    ) {
      const sender = new FakeWallet()
      const { tx: source, customInstructions } = await tokenPayment(sender, wallet, assetId, 40n)
      provider.admit(assetId, source, 0)
      const custody = JSON.parse(customInstructions)
      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: source,
        sourceOutputIndex: 0,
        unlockingScript: new UnlockingScript()
      })
      tx.addOutput({
        lockingScript: LockingScript.fromHex(
          (await recipientOutput(wallet, new FakeWallet(), assetId, 40n)).lockingScript
        ),
        satoshis: 1
      })
      const args = {
        protocolID: colorProtocolID(assetId, custody.derivationPrefix, custody.derivationSuffix),
        keyID: COLOR_KEY_ID,
        counterparty: sender.identityKey,
        data: toArray(
          JSON.stringify({
            version: 1,
            tx: Array.from(tx.toAtomicBEEF()),
            inputIndex: 0,
            sighashType,
            ownedOutputs: []
          }),
          'utf8'
        )
      }
      return { tx, args, custody, sender }
    }

    it('signs the wallet-computed digest of an app-built transaction', async () => {
      const { tx, args, custody, sender } = await appBuiltSpend()
      const next = jest.fn(
        async (forwarded: object) => await wallet.createSignature(forwarded as never)
      )
      const { signature } = (await module.handleRequest(
        { method: 'createSignature', args, originator: APP },
        next
      )) as {
        signature: number[]
      }
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ hashToDirectlySign: expect.any(Array) })
      )
      expect((next.mock.calls[0][0] as { data?: unknown }).data).toBeUndefined()
      const { publicKey } = await wallet.getPublicKey({
        protocolID: colorProtocolID(assetId, custody.derivationPrefix, custody.derivationSuffix),
        keyID: COLOR_KEY_ID,
        counterparty: sender.identityKey,
        forSelf: true
      })
      const der = Signature.fromDER(signature)
      const checksig = new TransactionSignature(
        der.r,
        der.s,
        TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
      ).toChecksigFormat()
      tx.inputs[0].unlockingScript = new UnlockingScript([
        { op: checksig.length, data: checksig },
        { op: 33, data: toArray(publicKey, 'hex') }
      ])
      expect(validInput(tx, 0)).toBe(true)
      expect(prompts.map(prompt => prompt.request.type)).toEqual(['color_signature'])
      expect(prompts[0].request).toMatchObject({
        inputIndex: 0,
        assets: [
          { assetId, inputAmount: '40', foreignAmount: '0', keptAmount: '0', outgoingAmount: '40' }
        ],
        destinations: [{ outputIndex: 0, assetId, amount: '40' }],
        signatures: [
          {
            outpoint: `${tx.inputs[0].sourceTransaction!.id('hex')}.0`,
            inputIndex: 0,
            sighashType: 0x41
          }
        ]
      })
    })

    it('rejects a direct hash, SINGLE without a matching output, and a mismatched asset selector', async () => {
      const next = jest.fn(async () => ({ signature: [] }))
      const { args } = await appBuiltSpend()
      await expect(
        module.handleRequest(
          {
            method: 'createSignature',
            args: { ...args, hashToDirectlySign: [1] },
            originator: APP
          },
          next
        )
      ).rejects.toThrow('not hashToDirectlySign')
      const single = await appBuiltSpend(
        TransactionSignature.SIGHASH_SINGLE | TransactionSignature.SIGHASH_FORKID
      )
      const envelope = JSON.parse(new TextDecoder().decode(new Uint8Array(single.args.data)))
      // A satoshi input ahead of the token input, with its source: every input must be
      // authenticated before the SIGHASH scope is checked.
      const funding = new Transaction()
      funding.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 1000 })
      const swapped = Transaction.fromAtomicBEEF(envelope.tx)
      swapped.inputs.unshift({
        sourceTransaction: funding,
        sourceOutputIndex: 0,
        unlockingScript: new UnlockingScript(),
        sequence: 0xffffffff
      })
      const singleArgs = {
        ...single.args,
        data: toArray(
          JSON.stringify({ ...envelope, inputIndex: 1, tx: Array.from(swapped.toAtomicBEEF()) }),
          'utf8'
        )
      }
      await expect(
        module.handleRequest({ method: 'createSignature', args: singleArgs, originator: APP }, next)
      ).rejects.toThrow('SIGHASH_SINGLE')
      const other = await deployAsset(new FakeWallet(), provider, 5n)
      const wrongAsset = {
        ...args,
        protocolID: colorProtocolID(other.assetId, remittanceString(), remittanceString())
      }
      await expect(
        module.handleRequest({ method: 'createSignature', args: wrongAsset, originator: APP }, next)
      ).rejects.toThrow('asset selector does not match')
      expect(next).not.toHaveBeenCalled()
    })

    it('fails when another input is a valid output of an asset that requires a profile', async () => {
      const text = (value: string): number[] => [0x60 + value.length, ...toArray(value, 'utf8')]
      const requiresProfile = [0xa1, ...text('req'), 0xa1, ...text('x:y'), 0xf6]
      const profiled = await deployAsset(new FakeWallet(), provider, 10n, requiresProfile)
      // A valid BRC-162 output repeating the asset's req: a token this wallet cannot evaluate.
      const held = new Transaction()
      held.addOutput({
        lockingScript: new OneColor().lock(
          profiled.assetId,
          5n,
          Array(20).fill(0),
          requiresProfile
        ),
        satoshis: 1000
      })
      const { args } = await appBuiltSpend()
      const envelope = JSON.parse(new TextDecoder().decode(new Uint8Array(args.data)))
      const tx = Transaction.fromAtomicBEEF(envelope.tx)
      // Were the input taken for satoshis, its 5 tokens would be destroyed by the signature.
      tx.addInput({
        sourceTransaction: held,
        sourceOutputIndex: 0,
        unlockingScript: new UnlockingScript()
      })
      const next = jest.fn(async () => ({ signature: [] }))
      await expect(
        module.handleRequest(
          {
            method: 'createSignature',
            args: {
              ...args,
              data: toArray(
                JSON.stringify({ ...envelope, tx: Array.from(tx.toAtomicBEEF()) }),
                'utf8'
              )
            },
            originator: APP
          },
          next
        )
      ).rejects.toThrow('requires processing profiles')
      expect(next).not.toHaveBeenCalled()
      expect(prompts).toEqual([])
    })

    it('rejects cryptographic operations other than signing in the p color namespace', async () => {
      await expect(
        module.handleRequest({ method: 'encrypt', args: {}, originator: APP }, async () => ({}))
      ).rejects.toThrow('not available in the p color namespace')
    })
  })

  describe('legacy asset deployed at a nonzero output', () => {
    it('receives, sends and reports the balance of a BRC-161 asset deployed at output 1', async () => {
      const legacyId = legacyDeploy(provider, 1)
      const { tx, customInstructions } = await tokenPayment(
        new FakeWallet(),
        wallet,
        legacyId,
        300n
      )
      provider.admit(legacyId, tx, 0)
      const basket = assetBasket(legacyId, 'value')
      const received = await module.onRequest({
        method: 'internalizeAction',
        args: {
          tx: tx.toAtomicBEEF(),
          description: 'Receive tokens',
          outputs: [
            {
              outputIndex: 0,
              protocol: 'basket insertion',
              insertionRemittance: { basket, customInstructions }
            }
          ]
        },
        originator: APP
      })
      await wallet.internalizeAction(received.args as InternalizeActionArgs)

      const result = await send({
        labels: transferPlan(legacyId),
        outputs: [await recipientOutput(wallet, new FakeWallet(), legacyId, 100n)]
      })
      const sent = Transaction.fromAtomicBEEF(result.tx!)
      expect(validInput(sent, 0)).toBe(true)
      const decoded = sent.outputs.map(output => OneColor.decode(output.lockingScript))
      expect(decoded.map(output => output.amount)).toEqual([100n, 200n])
      expect(decoded.map(output => OneColor.tokenIdToString(output.tokenId!))).toEqual([
        legacyId,
        legacyId
      ])
      await expect(
        module.handleRequest(
          {
            method: 'listOutputs',
            args: { basket: `p color balance ${assetTag(legacyId)}` },
            originator: APP
          },
          async () => {
            throw new Error('not forwarded')
          }
        )
      ).resolves.toEqual({ totalOutputs: '200', outputs: [] })
    })
  })

  describe('read views', () => {
    const notForwarded = async (): Promise<never> => {
      throw new Error('not forwarded')
    }

    it('lists inventory with one computed state tag per record', async () => {
      const [available, unreported, reserved] = await holdTokens(wallet, provider, assetId, [
        5n,
        6n,
        7n
      ])
      // The overlay no longer reports this output; a read still lists it from the wallet.
      provider.spend(`${unreported.id('hex')}.0`)
      wallet.outputs.get(`${reserved.id('hex')}.0`)!.reservedBy = 'reference-x'
      const inventory = (await module.handleRequest(
        {
          method: 'listOutputs',
          args: { basket: 'p color assets', includeTags: true, include: 'locking scripts' },
          originator: APP
        },
        notForwarded
      )) as ListOutputsResult
      const byOutpoint = Object.fromEntries(
        inventory.outputs.map(output => [output.outpoint, output])
      )
      expect(inventory.totalOutputs).toBe(3)
      expect(byOutpoint[`${available.id('hex')}.0`]).toMatchObject({
        spendable: true,
        tags: ['color_state_available']
      })
      expect(byOutpoint[`${unreported.id('hex')}.0`]).toMatchObject({
        spendable: true,
        tags: ['color_state_available']
      })
      expect(byOutpoint[`${reserved.id('hex')}.0`]).toMatchObject({
        spendable: false,
        tags: ['color_state_reserved']
      })
      expect(inventory.outputs.every(output => output.lockingScript !== undefined)).toBe(true)

      const filtered = (await module.handleRequest(
        {
          method: 'listOutputs',
          args: { basket: 'p color assets', tags: ['color_state_reserved'] },
          originator: APP
        },
        notForwarded
      )) as ListOutputsResult
      expect(filtered.outputs.map(output => output.outpoint)).toEqual([`${reserved.id('hex')}.0`])
      expect(prompts.map(prompt => prompt.request)).toEqual([
        { type: 'color_access', basket: 'p color assets', seekPermission: true },
        { type: 'color_access', basket: 'p color assets', seekPermission: true }
      ])
    })

    it('reads wallet state only and never consult the overlay', async () => {
      await holdTokens(wallet, provider, assetId, [5n, 6n])
      const consulted = (): never => {
        throw new Error('the overlay was consulted by a read')
      }
      provider.spendability = async () => consulted()
      provider.admission = async () => consulted()
      provider.submit = async () => consulted()
      for (const basket of [
        'p color assets',
        `p color balance ${assetTag(assetId)}`,
        `p color balance ${assetTag(assetId)} authority`
      ]) {
        await expect(
          module.handleRequest(
            { method: 'listOutputs', args: { basket }, originator: APP },
            notForwarded
          )
        ).resolves.toBeDefined()
      }
      await expect(
        module.handleRequest(
          {
            method: 'listOutputs',
            args: { basket: `p color balance ${assetTag(assetId)}` },
            originator: APP
          },
          notForwarded
        )
      ).resolves.toEqual({ totalOutputs: '11', outputs: [] })
    })

    it('decrypts custody only for the inventory page it returns', async () => {
      const held = await holdTokens(wallet, provider, assetId, [30n, 20n, 10n])
      for (const tx of held) {
        const stored = wallet.outputs.get(`${tx.id('hex')}.0`)!
        stored.customInstructions = await encryptMetadata(
          wallet.asWallet(),
          stored.customInstructions!
        )
      }
      const decrypt = jest.spyOn(wallet, 'decrypt')
      const page = (await module.handleRequest(
        {
          method: 'listOutputs',
          args: { basket: 'p color assets', includeCustomInstructions: true, limit: 1 },
          originator: APP
        },
        notForwarded
      )) as ListOutputsResult
      expect(page.totalOutputs).toBe(3)
      expect(page.outputs).toHaveLength(1)
      expect(decrypt).toHaveBeenCalledTimes(1)
    })

    it('counts available authorities and rejects unknown selectors', async () => {
      const issuer = new FakeWallet()
      const { publicKey } = await wallet.getPublicKey({
        protocolID: colorProtocolID(assetId, 'a', 'b'),
        keyID: COLOR_KEY_ID,
        counterparty: issuer.identityKey,
        forSelf: true
      })
      const authority = new Transaction()
      authority.addOutput({
        lockingScript: new OneColor().lock(assetId, 0n, hash160(toArray(publicKey, 'hex'))),
        satoshis: 1
      })
      provider.admit(assetId, authority, 0)
      wallet.store(authority, 0, assetBasket(assetId, 'authority'))
      await expect(
        module.handleRequest(
          {
            method: 'listOutputs',
            args: { basket: `p color balance ${assetTag(assetId)} authority` },
            originator: APP
          },
          notForwarded
        )
      ).resolves.toEqual({ totalOutputs: '1', outputs: [] })
      await expect(
        module.handleRequest(
          { method: 'listOutputs', args: { basket: 'p color balance assets' }, originator: APP },
          notForwarded
        )
      ).rejects.toThrow('invalid asset tag')
      await expect(
        module.handleRequest(
          {
            method: 'relinquishOutput',
            args: { basket: 'p color assets', output: 'x' },
            originator: APP
          },
          notForwarded
        )
      ).rejects.toThrow('per-asset baskets')
    })
  })
})
