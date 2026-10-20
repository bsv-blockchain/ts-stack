import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import {
  LockingScript,
  Signature,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  type CreateActionArgs,
  type CreateActionResult,
  type InternalizeActionArgs,
  type ListOutputsResult,
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
import { assetBasket, assetTag, COLOR_KEY_ID, colorProtocolID } from '../identifiers.js'
import {
  createModule,
  deployAsset,
  FakeProvider,
  FakeWallet,
  holdTokens,
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
      noSend
    }
  }

  async function send(args: Partial<CreateActionArgs>): Promise<SignActionResult> {
    const funded = (
      await module.onRequest({
        method: 'createAction',
        args: { description: 'Send tokens', labels: transferPlan(assetId), ...args },
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
      await expect(receipt(customInstructions, undefined, tx)).rejects.toThrow(
        'not admitted and unspent'
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
      expect(provider.submissions).toEqual([{ assetIds: [assetId], txid: tx.id('hex') }])
      expect(prompts.map(prompt => prompt.request.type)).toEqual(['color_send'])
      expect(prompts[0].request).toMatchObject({
        assets: [{ assetId, amount: '100', inputAmount: '300' }],
        destinations: [{ outputIndex: 0, assetId, amount: '100' }]
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

    it('releases its selection when the user declines', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      const answers = [false, true]
      const sender = createModule(wallet, provider, async () => answers.shift()!)
      const output = await recipientOutput(wallet, new FakeWallet(), assetId, 100n)
      const args = { description: 'Send tokens', labels: transferPlan(assetId), outputs: [output] }
      await expect(
        sender.onRequest({ method: 'createAction', args, originator: APP })
      ).rejects.toThrow('declined')
      const retried = await sender.onRequest({ method: 'createAction', args, originator: APP })
      expect((retried.args as CreateActionArgs).inputs).toHaveLength(1)
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
      // The unreadable record, then the 200-unit output to select and to sign; never the 50.
      expect(decrypt).toHaveBeenCalledTimes(3)
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

    it('refuses to sign an input that stopped being spendable after createAction', async () => {
      const [held] = await holdTokens(wallet, provider, assetId, [300n])
      const funded = (
        await module.onRequest({
          method: 'createAction',
          args: {
            description: 'Send tokens',
            labels: transferPlan(assetId),
            outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
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

    it('reports an overlay that does not admit the processed transaction', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      provider.rejectSubmissions = true
      await expect(
        send({ outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)] })
      ).rejects.toThrow('needs reconciliation')
    })

    it('keeps its selection through a slow approval, so a concurrent send cannot take it', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      let approve: ((approved: boolean) => void) | undefined
      const gated = createModule(
        wallet,
        provider,
        async () => await new Promise<boolean>(resolve => (approve = resolve))
      )
      const request = async () =>
        await gated.onRequest({
          method: 'createAction',
          args: {
            description: 'Send tokens',
            labels: transferPlan(assetId),
            outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
          },
          originator: APP
        })
      const first = request()
      while (approve === undefined) await new Promise(resolve => setImmediate(resolve))
      await expect(request()).rejects.toThrow('insufficient spendable balance')
      approve(true)
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
            outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
          },
          originator: APP
        })
      ).args as CreateActionArgs
      const created = await wallet.createAction(funded)
      await wallet.abortAction({ reference: created.signableTransaction!.reference })
      const result = await send({
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)]
      })
      expect(validInput(Transaction.fromAtomicBEEF(result.tx!), 0)).toBe(true)
    })

    it('signs a noSend action without submitting it', async () => {
      await holdTokens(wallet, provider, assetId, [100n])
      const result = await send({
        outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)],
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
          args: { description: 'Send tokens', labels: burn, outputs: [output] },
          originator: APP
        })
      ).rejects.toThrow('exactly one transfer per asset')
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
      expect(provider.submissions).toEqual([{ assetIds: [assetId], txid: split.id('hex') }])
      expect(prompts.map(prompt => prompt.request.type)).toEqual(['color_send', 'color_split'])
      expect(prompts[1].request).toMatchObject({ assetId, amount: '100', change: '200' })
      const stored = wallet.outputs.get(`${split.id('hex')}.0`)?.customInstructions ?? ''
      expect(stored.startsWith('{')).toBe(false)
      expect(JSON.parse(await maybeDecryptMetadata(wallet.asWallet(), stored))).toMatchObject({
        version: 1,
        assetId
      })
    })

    it('aborts the split when the user declines its fee', async () => {
      await holdTokens(wallet, provider, assetId, [300n])
      const replies = [true, false]
      const declining = createModule(wallet, provider, async () => replies.shift()!)
      await expect(
        declining.onRequest({
          method: 'createAction',
          args: {
            description: 'Send tokens',
            labels: ['p nosend expiry seconds 30', ...transferPlan(assetId)],
            outputs: [await recipientOutput(wallet, new FakeWallet(), assetId, 100n)],
            options: { noSend: true }
          },
          originator: APP
        })
      ).rejects.toThrow('declined the token split')
      expect(wallet.pending.size).toBe(0)
      expect(provider.submissions).toEqual([])
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
      const twoInputs = Transaction.fromAtomicBEEF(envelope.tx)
      twoInputs.addInput({
        sourceTransaction: twoInputs.inputs[0].sourceTransaction,
        sourceOutputIndex: 0,
        unlockingScript: new UnlockingScript()
      })
      const swapped = Transaction.fromAtomicBEEF(envelope.tx)
      swapped.inputs.unshift({
        sourceTXID: 'ee'.repeat(32),
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

    it('rejects cryptographic operations other than signing in the p color namespace', async () => {
      await expect(
        module.handleRequest({ method: 'encrypt', args: {}, originator: APP }, async () => ({}))
      ).rejects.toThrow('not available in the p color namespace')
    })
  })

  describe('read views', () => {
    const notForwarded = async (): Promise<never> => {
      throw new Error('not forwarded')
    }

    it('lists inventory with one computed state tag per record', async () => {
      const [available, pending, reserved] = await holdTokens(wallet, provider, assetId, [
        5n,
        6n,
        7n
      ])
      provider.spend(`${pending.id('hex')}.0`)
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
      expect(byOutpoint[`${pending.id('hex')}.0`]).toMatchObject({
        spendable: false,
        tags: ['color_state_pending']
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
      expect(prompts.map(prompt => prompt.request.type)).toEqual(['color_access', 'color_access'])
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
