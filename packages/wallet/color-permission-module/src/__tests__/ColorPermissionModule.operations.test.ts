import { beforeEach, describe, expect, it } from '@jest/globals'
import {
  Beef,
  Transaction,
  type CreateActionArgs,
  type CreateActionOutput,
  type CreateActionResult,
  type ListOutputsResult,
  type SignActionResult
} from '@bsv/sdk'
import { hash160 } from '@bsv/sdk/primitives/Hash'
import { toArray } from '@bsv/sdk/primitives/utils'
import { OneColor } from '@bsv/templates'
import { maybeDecryptMetadata, type PermissionsModuleAction } from '@bsv/wallet-toolbox-client'
import { ColorPlan, type ColorOperation, type ColorRemittance } from '../ColorPlan.js'
import type { ColorPermissionModule } from '../ColorPermissionModule.js'
import {
  assetBasket,
  COLOR_KEY_ID,
  colorProtocolID,
  colorTopic,
  derivationSuffixTag,
  DISCOVERY_TOPIC,
  ISSUE
} from '../identifiers.js'
import {
  createModule,
  deployAsset,
  FakeProvider,
  FakeWallet,
  holdTokens,
  jsonTokenScript,
  legacyDeploy,
  remittanceString,
  tokenPayment,
  validInput
} from './fixtures.js'

const APP = 'app.example'

describe('ColorPermissionModule token operations', () => {
  let wallet: FakeWallet
  let provider: FakeProvider
  let prompts: Array<Record<string, unknown>>
  let module: ColorPermissionModule

  beforeEach(() => {
    wallet = new FakeWallet()
    provider = new FakeProvider()
    prompts = []
    module = createModule(wallet, provider, async (_app, message) => {
      prompts.push(JSON.parse(message))
      return true
    })
  })

  function labels(
    assets: string[],
    operations: ColorOperation[],
    ownedOutputs: ColorRemittance[] = []
  ): string[] {
    return ColorPlan.toLabels({
      version: 1,
      assets,
      ownedOutputs,
      operations,
      inputPositions: [],
      changePositions: [],
      sighashTypes: []
    })
  }

  /** A token output locked to this wallet's key for `selector` (`ISSUE` for a deploy), with its remittance. */
  async function owned(
    assetId: string,
    selector: string,
    amount: bigint,
    outputIndex: number
  ): Promise<{ remittance: ColorRemittance; output: CreateActionOutput[] }> {
    const remittance = {
      outputIndex,
      assetId: selector,
      derivationPrefix: remittanceString(),
      derivationSuffix: remittanceString(),
      senderIdentityKey: wallet.identityKey
    }
    const { publicKey } = await wallet.getPublicKey({
      protocolID: colorProtocolID(
        selector,
        remittance.derivationPrefix,
        remittance.derivationSuffix
      ),
      keyID: COLOR_KEY_ID,
      counterparty: wallet.identityKey,
      forSelf: true
    })
    const lockingScript = new OneColor()
      .lock(selector === ISSUE ? null : assetId, amount, hash160(toArray(publicKey, 'hex')))
      .toHex()
    return {
      remittance,
      output: [{ lockingScript, satoshis: 1, outputDescription: 'Kept' }]
    }
  }

  async function foreign(assetId: string, amount: bigint) {
    const { tx } = await tokenPayment(wallet, new FakeWallet(), assetId, amount)
    return {
      lockingScript: tx.outputs[0].lockingScript.toHex(),
      satoshis: 1,
      outputDescription: 'Out'
    }
  }

  async function createAction(args: Partial<CreateActionArgs>): Promise<CreateActionArgs> {
    return (
      await module.onRequest({
        method: 'createAction',
        args: {
          description: 'Token operation',
          ...args,
          options: { randomizeOutputs: false, ...args.options }
        },
        originator: APP
      })
    ).args as CreateActionArgs
  }

  /** Runs the createAction and signAction hooks around the fake wallet, as the permissions manager does. */
  async function run(args: Partial<CreateActionArgs>): Promise<Transaction> {
    const created = (await module.onResponse(await wallet.createAction(await createAction(args)), {
      method: 'createAction',
      originator: APP
    })) as CreateActionResult
    const signable = created.signableTransaction!
    const action: PermissionsModuleAction = {
      reference: signable.reference,
      transaction: Transaction.fromAtomicBEEF(signable.tx),
      noSend: args.options?.noSend === true,
      createArgs: wallet.pending.get(signable.reference)!.args
    }
    const signArgs = (
      await module.onRequest({
        method: 'signAction',
        args: { reference: signable.reference, spends: {} },
        originator: APP,
        action
      })
    ).args as { reference: string; spends: Record<number, { unlockingScript: string }> }
    const result = (await module.onResponse(await wallet.signAction(signArgs), {
      method: 'signAction',
      originator: APP,
      action
    })) as SignActionResult
    return Transaction.fromAtomicBEEF(result.tx!)
  }

  function amounts(tx: Transaction): bigint[] {
    return tx.outputs.map(output => OneColor.decode(output.lockingScript).amount)
  }

  describe('authority', () => {
    let assetId: string

    beforeEach(async () => {
      assetId = (await deployAsset(wallet, provider, 0n)).assetId
    })

    it('mints with a selected authority and keeps a replacement authority', async () => {
      const value = await owned(assetId, assetId, 2_500n, 0)
      const authority = await owned(assetId, assetId, 0n, 1)
      const tx = await run({
        labels: labels(
          [assetId],
          [
            { assetId, operation: 'mint' },
            { assetId, operation: 'authority-transfer' }
          ],
          [value.remittance, authority.remittance]
        ),
        outputs: [...value.output, ...authority.output]
      })

      expect(tx.inputs.map(input => input.sourceTransaction!.id('hex'))).toEqual([
        assetId.slice(0, 64)
      ])
      expect(validInput(tx, 0)).toBe(true)
      expect(amounts(tx)).toEqual([2_500n, 0n])
      expect(wallet.outputs.get(`${tx.id('hex')}.0`)?.basket).toBe(assetBasket(assetId, 'value'))
      expect(wallet.outputs.get(`${tx.id('hex')}.1`)?.basket).toBe(
        assetBasket(assetId, 'authority')
      )
      expect(provider.submissions).toEqual([{ topics: [colorTopic(assetId)], txid: tx.id('hex') }])
      expect(prompts[0]).toMatchObject({
        type: 'color_send',
        assets: [
          {
            assetId,
            operations: ['mint', 'authority-transfer'],
            minted: '2500',
            authorityInputs: 1,
            keptAmount: '2500',
            keptAuthorities: 1,
            outgoingAmount: '0'
          }
        ]
      })
    })

    it('splits one authority into two', async () => {
      const mine = await owned(assetId, assetId, 0n, 0)
      const tx = await run({
        labels: labels([assetId], [{ assetId, operation: 'authority-split' }], [mine.remittance]),
        outputs: [...mine.output, await foreign(assetId, 0n)]
      })
      expect(tx.inputs).toHaveLength(1)
      expect(amounts(tx)).toEqual([0n, 0n])
    })

    it('combines two selected authorities into one', async () => {
      await holdTokens(wallet, provider, assetId, [0n])
      const mine = await owned(assetId, assetId, 0n, 0)
      const tx = await run({
        labels: labels([assetId], [{ assetId, operation: 'authority-combine' }], [mine.remittance]),
        outputs: mine.output
      })
      expect(tx.inputs).toHaveLength(2)
      expect([0, 1].map(index => validInput(tx, index))).toEqual([true, true])
    })

    it('ends an authority and submits the spend to its asset topic', async () => {
      const tx = await run({
        labels: labels([assetId], [{ assetId, operation: 'authority-end' }]),
        outputs: [{ lockingScript: '006a', satoshis: 1, outputDescription: 'Data' }]
      })
      expect(tx.inputs).toHaveLength(1)
      expect(provider.submissions).toEqual([{ topics: [colorTopic(assetId)], txid: tx.id('hex') }])
    })

    it('rejects a mint without an authority operation and an authority the wallet lacks', async () => {
      const value = await owned(assetId, assetId, 5n, 0)
      await expect(
        createAction({
          labels: labels([assetId], [{ assetId, operation: 'mint' }], [value.remittance]),
          outputs: value.output
        })
      ).rejects.toThrow('exceed the authenticated input balance')
      const other = (await deployAsset(new FakeWallet(), provider, 0n)).assetId
      await expect(
        createAction({
          labels: labels([other], [{ assetId: other, operation: 'authority-end' }]),
          outputs: []
        })
      ).rejects.toThrow(`insufficient spendable authority of ${other}`)
    })
  })

  describe('burn', () => {
    let assetId: string
    let outpoint: string

    beforeEach(async () => {
      assetId = (await deployAsset(new FakeWallet(), provider, 10_000n)).assetId
      const [tx] = await holdTokens(wallet, provider, assetId, [1_000n])
      outpoint = `${tx.id('hex')}.0`
    })

    it('burns an explicit input without change', async () => {
      // The app names this input without its BEEF; the fake wallet resolves it from storage.
      wallet.requireInputBEEF = false
      const tx = await run({
        labels: labels([assetId], [{ assetId, operation: 'burn' }]),
        inputs: [{ outpoint, unlockingScriptLength: 108, inputDescription: 'Burned' }],
        outputs: [{ lockingScript: '006a', satoshis: 1, outputDescription: 'Data' }]
      })
      expect(tx.outputs).toHaveLength(1)
      expect(validInput(tx, 0)).toBe(true)
      expect(prompts[0]).toMatchObject({
        assets: [{ assetId, operations: ['burn'], burned: '1000', keptAmount: '0' }]
      })
    })

    it('burns the rest of an explicit input after a transfer', async () => {
      // The app names this input without its BEEF; the fake wallet resolves it from storage.
      wallet.requireInputBEEF = false
      const tx = await run({
        labels: labels(
          [assetId],
          [
            { assetId, operation: 'transfer' },
            { assetId, operation: 'burn' }
          ]
        ),
        inputs: [{ outpoint, unlockingScriptLength: 108, inputDescription: 'Spent' }],
        outputs: [await foreign(assetId, 300n)]
      })
      expect(amounts(tx)).toEqual([300n])
      expect(prompts[0]).toMatchObject({
        assets: [{ transferred: '300', burned: '700' }]
      })
    })

    it('rejects an undeclared burn', async () => {
      await expect(
        createAction({
          labels: labels([assetId], [{ assetId, operation: 'transfer' }]),
          inputs: [{ outpoint, unlockingScriptLength: 108, inputDescription: 'Spent' }],
          outputs: [{ lockingScript: '006a', satoshis: 1, outputDescription: 'Data' }]
        })
      ).rejects.toThrow('requires the operations [burn] but the plan declares [transfer]')
    })
  })

  describe('BRC-161 JSON inputs and outputs', () => {
    let assetId: string
    let held: Transaction
    let input: CreateActionArgs['inputs'] & object
    let inputBEEF: number[]

    /** This wallet holds a JSON transfer of `amount`, outside any p color basket. */
    function holdJson(
      amount: bigint,
      admitted = true,
      op: 'transfer' | 'mint' | 'auth' = 'transfer',
      envelopeFirst = true
    ): void {
      held = new Transaction()
      held.addOutput({
        lockingScript: jsonTokenScript(
          op === 'auth'
            ? { p: 'bsv-20', op, id: assetId }
            : { p: 'bsv-20', op, id: assetId, amt: `${amount}` },
          undefined,
          envelopeFirst
        ),
        satoshis: 1
      })
      if (admitted) provider.admit(assetId, held, 0)
      wallet.store(held, 0, 'bsv21')
      const beef = new Beef()
      beef.mergeTransaction(held)
      inputBEEF = beef.toBinary()
      input = [
        { outpoint: `${held.id('hex')}.0`, unlockingScriptLength: 1, inputDescription: 'JSON' }
      ]
    }

    beforeEach(() => {
      assetId = legacyDeploy(provider, 1)
    })

    it('migrates a JSON input into a BRC-162 output this wallet keeps', async () => {
      holdJson(100n)
      const mine = await owned(assetId, assetId, 100n, 0)
      const tx = await run({
        labels: labels([assetId], [{ assetId, operation: 'transfer' }], [mine.remittance]),
        inputBEEF,
        inputs: input,
        outputs: mine.output
      })
      expect(tx.inputs.map(i => i.sourceTransaction!.id('hex'))).toEqual([held.id('hex')])
      expect(wallet.outputs.get(`${tx.id('hex')}.0`)?.basket).toBe(assetBasket(assetId, 'value'))
      expect(prompts[0]).toMatchObject({
        assets: [{ assetId, operations: ['transfer'], foreignAmount: '100', keptAmount: '100' }]
      })
    })

    it('refuses a JSON input its overlay has not admitted', async () => {
      holdJson(100n, false)
      const mine = await owned(assetId, assetId, 100n, 0)
      await expect(
        createAction({
          labels: labels([assetId], [{ assetId, operation: 'transfer' }], [mine.remittance]),
          inputBEEF,
          inputs: input,
          outputs: mine.output
        })
      ).rejects.toThrow('not admitted and unspent')
    })

    it('reads an input whose envelope follows its lock, and a mint input as value', async () => {
      holdJson(100n, true, 'mint', false)
      const mine = await owned(assetId, assetId, 100n, 0)
      const tx = await run({
        labels: labels([assetId], [{ assetId, operation: 'transfer' }], [mine.remittance]),
        inputBEEF,
        inputs: input,
        outputs: mine.output
      })
      expect(tx.outputs).toHaveLength(1)
      expect(prompts[0]).toMatchObject({
        assets: [{ assetId, operations: ['transfer'], foreignAmount: '100', keptAmount: '100' }]
      })
    })

    it('refuses a burn output, and a mint output without an authority input', async () => {
      holdJson(100n)
      const burn = jsonTokenScript({ p: 'bsv-20', op: 'burn', id: assetId, amt: '40' })
      await expect(
        createAction({
          labels: labels(
            [assetId],
            [
              { assetId, operation: 'transfer' },
              { assetId, operation: 'burn' }
            ]
          ),
          inputBEEF,
          inputs: input,
          outputs: [{ lockingScript: burn.toHex(), satoshis: 1, outputDescription: 'Burn' }]
        })
      ).rejects.toThrow('BRC-161 burn is an operation this module does not support')
      const mint = jsonTokenScript({ p: 'bsv-20', op: 'mint', id: assetId, amt: '5' })
      await expect(
        createAction({
          labels: labels([assetId], [{ assetId, operation: 'mint' }]),
          outputs: [{ lockingScript: mint.toHex(), satoshis: 1, outputDescription: 'Mint' }]
        })
      ).rejects.toThrow('exceed the authenticated input balance')
    })

    it('mints a JSON output with an authority input', async () => {
      await deployAsset(wallet, provider, 0n)
      const authority = [...wallet.outputs.values()].find(o => o.basket?.endsWith('authority'))!
      const authorityId = `${authority.tx.id('hex')}_0`
      const mint = jsonTokenScript({ p: 'bsv-20', op: 'mint', id: authorityId, amt: '5' })
      const tx = await run({
        labels: labels(
          [authorityId],
          [
            { assetId: authorityId, operation: 'mint' },
            { assetId: authorityId, operation: 'authority-end' }
          ]
        ),
        outputs: [{ lockingScript: mint.toHex(), satoshis: 1, outputDescription: 'Mint' }]
      })
      expect(tx.outputs).toHaveLength(1)
      expect(prompts[0]).toMatchObject({
        assets: [{ assetId: authorityId, operations: ['mint', 'authority-end'], minted: '5' }]
      })
    })

    it('transfers a JSON auth input into a BRC-162 authority output', async () => {
      holdJson(0n, true, 'auth')
      const mine = await owned(assetId, assetId, 0n, 0)
      const tx = await run({
        labels: labels(
          [assetId],
          [{ assetId, operation: 'authority-transfer' }],
          [mine.remittance]
        ),
        inputBEEF,
        inputs: input,
        outputs: mine.output
      })
      expect(wallet.outputs.get(`${tx.id('hex')}.0`)?.basket).toBe(
        assetBasket(assetId, 'authority')
      )
      expect(prompts[0]).toMatchObject({
        assets: [
          {
            assetId,
            operations: ['authority-transfer'],
            foreignAuthorityInputs: 1,
            keptAuthorities: 1
          }
        ]
      })
    })

    it('mints a JSON output from a JSON auth input it transfers', async () => {
      holdJson(0n, true, 'auth')
      const mine = await owned(assetId, assetId, 0n, 0)
      const minted = jsonTokenScript({ p: 'bsv-20', op: 'mint', id: assetId, amt: '5' })
      const tx = await run({
        labels: labels(
          [assetId],
          [
            { assetId, operation: 'mint' },
            { assetId, operation: 'authority-transfer' }
          ],
          [mine.remittance]
        ),
        inputBEEF,
        inputs: input,
        outputs: [
          ...mine.output,
          { lockingScript: minted.toHex(), satoshis: 1, outputDescription: 'Mint' }
        ]
      })
      expect(tx.outputs).toHaveLength(2)
      expect(prompts[0]).toMatchObject({
        assets: [{ assetId, operations: ['mint', 'authority-transfer'], minted: '5' }]
      })
    })

    it('counts a JSON auth output to another party as an authority output', async () => {
      holdJson(0n, true, 'auth')
      const mine = await owned(assetId, assetId, 0n, 0)
      const theirs = jsonTokenScript({ p: 'bsv-20', op: 'auth', id: assetId })
      const tx = await run({
        labels: labels([assetId], [{ assetId, operation: 'authority-split' }], [mine.remittance]),
        inputBEEF,
        inputs: input,
        outputs: [
          ...mine.output,
          { lockingScript: theirs.toHex(), satoshis: 1, outputDescription: 'Auth' }
        ]
      })
      expect(tx.outputs).toHaveLength(2)
      expect(prompts[0]).toMatchObject({
        assets: [
          { assetId, operations: ['authority-split'], keptAuthorities: 1, outgoingAuthorities: 1 }
        ]
      })
    })

    it('counts JSON change to the counterparty as a transfer, not a burn', async () => {
      holdJson(100n)
      const mine = await owned(assetId, assetId, 60n, 0)
      const change = jsonTokenScript({ p: 'bsv-20', op: 'transfer', id: assetId, amt: '40' })
      const tx = await run({
        labels: labels([assetId], [{ assetId, operation: 'transfer' }], [mine.remittance]),
        inputBEEF,
        inputs: input,
        outputs: [
          ...mine.output,
          { lockingScript: change.toHex(), satoshis: 1, outputDescription: 'Their change' }
        ]
      })
      expect(tx.outputs).toHaveLength(2)
      expect(prompts[0]).toMatchObject({
        assets: [{ operations: ['transfer'], burned: '0', outgoingAmount: '40' }]
      })
    })

    it('refuses JSON outputs that only an authority could fund, and JSON issuance', async () => {
      await deployAsset(wallet, provider, 0n)
      const authorityAsset = [...wallet.outputs.values()].find(o =>
        o.basket?.endsWith('authority')
      )!
      const authorityId = `${authorityAsset.tx.id('hex')}_0`
      const minted = jsonTokenScript({ p: 'bsv-20', op: 'transfer', id: authorityId, amt: '5' })
      await expect(
        createAction({
          labels: labels(
            [authorityId],
            [
              { assetId: authorityId, operation: 'mint' },
              { assetId: authorityId, operation: 'authority-end' }
            ]
          ),
          outputs: [{ lockingScript: minted.toHex(), satoshis: 1, outputDescription: 'Mint' }]
        })
      ).rejects.toThrow('an authority cannot fund them')
      const issue = jsonTokenScript({ p: 'bsv-20', op: 'deploy+mint', amt: '5' })
      await expect(
        createAction({
          labels: labels([ISSUE], [{ assetId: ISSUE, operation: 'deploy-fixed' }]),
          outputs: [{ lockingScript: issue.toHex(), satoshis: 1, outputDescription: 'Deploy' }],
          options: { randomizeOutputs: false }
        })
      ).rejects.toThrow('must use BRC-162')
    })
  })

  describe('deploy', () => {
    it('deploys a fixed supply, submits it for discovery and checks its asset overlay', async () => {
      const deploy = await owned('', ISSUE, 1_000_000n, 0)
      const funded = await createAction({
        labels: labels(
          [ISSUE],
          [{ assetId: ISSUE, operation: 'deploy-fixed' }],
          [deploy.remittance]
        ),
        outputs: deploy.output,
        options: { randomizeOutputs: false }
      })
      const stored = funded.outputs![0].customInstructions!
      expect(funded.outputs![0].basket).toBeUndefined()
      expect(JSON.parse(await maybeDecryptMetadata(wallet.asWallet(), stored))).toMatchObject({
        assetId: ISSUE
      })
      expect(prompts).toEqual([])

      const tx = await run({
        labels: labels(
          [ISSUE],
          [{ assetId: ISSUE, operation: 'deploy-fixed' }],
          [deploy.remittance]
        ),
        outputs: deploy.output,
        options: { randomizeOutputs: false }
      })
      expect(provider.submissions).toEqual([{ topics: [DISCOVERY_TOPIC], txid: tx.id('hex') }])
      const filed = wallet.outputs.get(`${tx.id('hex')}.0`)!
      expect(filed.basket).toBe(assetBasket(`${tx.id('hex')}_0`, 'value'))
      expect(
        JSON.parse(await maybeDecryptMetadata(wallet.asWallet(), filed.customInstructions!))
      ).toMatchObject({
        assetId: ISSUE,
        derivationPrefix: deploy.remittance.derivationPrefix
      })
      expect(prompts[0]).toMatchObject({
        deploy: { operation: 'deploy-fixed', amount: '1000000', owned: true },
        assets: []
      })
    })

    it('files a deploy its asset overlay has not admitted yet; the inventory lists it', async () => {
      provider.seedDeploys = false
      const deploy = await owned('', ISSUE, 0n, 0)
      const tx = await run({
        labels: labels(
          [ISSUE],
          [{ assetId: ISSUE, operation: 'deploy-authority' }],
          [deploy.remittance]
        ),
        outputs: deploy.output,
        options: { randomizeOutputs: false }
      })
      expect(provider.submissions).toEqual([{ topics: [DISCOVERY_TOPIC], txid: tx.id('hex') }])
      const [outpoint, stored] = [...wallet.outputs].find(([, output]) => output.vout === 0)!
      expect(stored.basket).toBe(assetBasket(`${outpoint.slice(0, 64)}_0`, 'authority'))
      expect(stored.tags).toEqual([derivationSuffixTag(deploy.remittance.derivationSuffix)])
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
        expect.objectContaining({ outpoint, spendable: true, tags: ['color_state_available'] })
      ])
    })

    it('rejects a noSend deploy', async () => {
      const deploy = await owned('', ISSUE, 7n, 0)
      const plan = labels(
        [ISSUE],
        [{ assetId: ISSUE, operation: 'deploy-fixed' }],
        [deploy.remittance]
      )
      await expect(
        createAction({ labels: plan, outputs: deploy.output, options: { noSend: true } })
      ).rejects.toThrow('a deploy cannot be a noSend action')
      await expect(
        createAction({ labels: ['p nosend expiry seconds 30', ...plan], outputs: deploy.output })
      ).rejects.toThrow('a deploy cannot be a noSend action')
      expect(wallet.pending.size).toBe(0)
    })

    it('rejects a deploy with the wrong operation, order or basket', async () => {
      const deploy = await owned('', ISSUE, 5n, 0)
      const plan = labels(
        [ISSUE],
        [{ assetId: ISSUE, operation: 'deploy-authority' }],
        [deploy.remittance]
      )
      await expect(
        createAction({ labels: plan, outputs: deploy.output, options: { randomizeOutputs: false } })
      ).rejects.toThrow('requires the operations [deploy-fixed]')
      await expect(
        createAction({ labels: plan, outputs: deploy.output, options: { randomizeOutputs: true } })
      ).rejects.toThrow('a p color plan requires options.randomizeOutputs false')
      await expect(
        createAction({
          labels: plan,
          outputs: [{ ...deploy.output[0], basket: 'p color issue' }],
          options: { randomizeOutputs: false }
        })
      ).rejects.toThrow('assigned once its transaction is signed')
    })
  })

  it('rejects a plan that names an asset the action does not move', async () => {
    const assetId = (await deployAsset(new FakeWallet(), provider, 10n)).assetId
    const other = (await deployAsset(new FakeWallet(), provider, 10n)).assetId
    await holdTokens(wallet, provider, assetId, [10n])
    await expect(
      createAction({
        labels: labels([assetId, other], [{ assetId, operation: 'transfer' }]),
        outputs: [await foreign(assetId, 5n)]
      })
    ).rejects.toThrow('must name exactly the assets')
  })
})
