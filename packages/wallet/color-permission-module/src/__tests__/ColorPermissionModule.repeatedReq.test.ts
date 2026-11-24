import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import {
  Beef,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  type CreateActionArgs,
  type CreateActionResult,
  type SignActionResult
} from '@bsv/sdk'
import { toArray } from '@bsv/sdk/primitives/utils'
import { encodeStrictCbor, OneColor } from '@bsv/templates'
import type { PermissionsModuleAction } from '@bsv/wallet-toolbox-client'
import { ColorPlan } from '../ColorPlan.js'
import { ColorPermissionModule } from '../ColorPermissionModule.js'
import { COLOR_KEY_ID, colorProtocolID } from '../identifiers.js'
import { deployAsset, FakeProvider, FakeWallet, holdTokens, tokenPayment } from './fixtures.js'
import { exampleProfile, FakeStore } from './profileFixtures.js'

const APP = 'app.example'
const REVISION = 'urn:example:color:revision'
/** The deploy's payload, which a later output may repeat verbatim (0162:188-192). */
const REQ = encodeStrictCbor({ req: { [REVISION]: { params: null, version: 1 } } })

/**
 * A profile asset's output that repeats the deploy's non-empty `req` is conforming (0162:188-192),
 * so every path that reads it to spend it uses the profile-aware reader, not the 0.1.0 reader that
 * refuses any `req` as unsupported.
 */
describe('spending a profile asset output that repeats the deploy req', () => {
  let wallet: FakeWallet
  let provider: FakeProvider
  let module: ColorPermissionModule
  let assetId: string

  beforeEach(async () => {
    wallet = new FakeWallet()
    provider = new FakeProvider()
    const ex = exampleProfile()
    module = new ColorPermissionModule({
      wallet: wallet.asWallet(),
      provider,
      requestTokenAccess: async () => true,
      profiles: { [ex.id]: ex },
      store: new FakeStore()
    })
    assetId = (await deployAsset(new FakeWallet(), provider, 1_000n, REQ)).assetId
  })

  function transferPlan(inputPositions: ColorPlan['inputPositions'] = []): string[] {
    return ColorPlan.toLabels({
      version: 1,
      assets: [assetId],
      ownedOutputs: [],
      operations: [{ assetId, operation: 'transfer' }],
      inputPositions,
      changePositions: [],
      sighashTypes: []
    })
  }

  async function payment(amount: bigint, payload?: number[]) {
    const output = (await tokenPayment(wallet, new FakeWallet(), assetId, amount, payload)).tx
      .outputs[0]
    return { lockingScript: output.lockingScript.toHex(), satoshis: 1, outputDescription: 'Pay' }
  }

  async function createAction(args: Partial<CreateActionArgs>): Promise<CreateActionArgs> {
    return (
      await module.onRequest({
        method: 'createAction',
        args: {
          description: 'Send tokens',
          labels: transferPlan(),
          ...args,
          options: { randomizeOutputs: false, ...args.options }
        },
        originator: APP
      })
    ).args as CreateActionArgs
  }

  /** Funds, creates and signs through the module, as a WalletPermissionsManager does. */
  async function send(args: Partial<CreateActionArgs>): Promise<SignActionResult> {
    const funded = await createAction(args)
    const created = (await module.onResponse(await wallet.createAction(funded), {
      method: 'createAction',
      originator: APP
    })) as CreateActionResult
    const signable = created.signableTransaction!
    const action: PermissionsModuleAction = {
      reference: signable.reference,
      transaction: Transaction.fromAtomicBEEF(signable.tx),
      noSend: false,
      createArgs: wallet.pending.get(signable.reference)!.args
    }
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

  function amounts(result: SignActionResult): bigint[] {
    return Transaction.fromAtomicBEEF(result.tx!).outputs.map(
      output => OneColor.decode(output.lockingScript).amount
    )
  }

  it('a selected input passes createAction and signAction', async () => {
    await holdTokens(wallet, provider, assetId, [300n], REQ)
    const result = await send({ outputs: [await payment(100n)] })
    expect(amounts(result)).toEqual([100n, 200n])
  })

  it('a destination output that repeats the req passes createAction and signAction', async () => {
    await holdTokens(wallet, provider, assetId, [300n], REQ)
    const result = await send({ outputs: [await payment(100n, REQ)] })
    expect(amounts(result)).toEqual([100n, 200n])
  })

  it('an explicit managed input passes createAction and signAction', async () => {
    // The app names this input without its BEEF; the fake wallet resolves it from storage.
    wallet.requireInputBEEF = false
    const [held] = await holdTokens(wallet, provider, assetId, [300n], REQ)
    const outpoint = `${held.id('hex')}.0`
    const result = await send({
      inputs: [{ outpoint, unlockingScriptLength: 108, inputDescription: 'Mine' }],
      outputs: [await payment(300n)]
    })
    expect(amounts(result)).toEqual([300n])
  })

  it('an explicit foreign input from inputBEEF passes createAction and signAction', async () => {
    const pool = (await tokenPayment(new FakeWallet(), new FakeWallet(), assetId, 400n, REQ)).tx
    provider.admit(assetId, pool, 0)
    wallet.store(pool, 0, 'foreign')
    const outpoint = `${pool.id('hex')}.0`
    const inputBEEF = new Beef()
    inputBEEF.mergeTransaction(pool)
    const funded = await createAction({
      labels: transferPlan([{ outpoint, index: 0 }]),
      inputBEEF: inputBEEF.toBinary(),
      inputs: [{ outpoint, unlockingScriptLength: 1, inputDescription: 'Pool' }],
      outputs: [await payment(400n)]
    })
    const created = await wallet.createAction(funded)
    const signable = created.signableTransaction!
    const action: PermissionsModuleAction = {
      reference: signable.reference,
      transaction: Transaction.fromAtomicBEEF(signable.tx),
      noSend: false,
      createArgs: funded
    }
    const signed = (
      await module.onRequest({
        method: 'signAction',
        args: { reference: signable.reference, spends: {} },
        originator: APP,
        action
      })
    ).args as { spends: Record<number, unknown> }
    // The foreign input is the app's to unlock; the module signs nothing for it.
    expect(signed.spends).toEqual({})
  })

  it('a held output its overlay does not report is resubmitted at selection', async () => {
    const [held] = await holdTokens(wallet, provider, assetId, [300n], REQ)
    provider.current.delete(`${held.id('hex')}.0`)
    const funded = await createAction({ outputs: [await payment(100n)] })
    expect(funded.inputs!.map(input => input.outpoint)).toEqual([`${held.id('hex')}.0`])
    expect(provider.submissions.map(submission => submission.txid)).toContain(held.id('hex'))
  })

  it('createSignature signs a source and an owned output that repeat the req', async () => {
    const sender = new FakeWallet()
    const { tx: source, customInstructions } = await tokenPayment(sender, wallet, assetId, 40n, REQ)
    provider.admit(assetId, source, 0)
    const custody = JSON.parse(customInstructions)
    const owned = await tokenPayment(wallet, wallet, assetId, 40n, REQ)
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript()
    })
    tx.addOutput({ lockingScript: owned.tx.outputs[0].lockingScript, satoshis: 1 })
    const ownedCustody = JSON.parse(owned.customInstructions)
    const args = {
      protocolID: colorProtocolID(assetId, custody.derivationPrefix, custody.derivationSuffix),
      keyID: COLOR_KEY_ID,
      counterparty: sender.identityKey,
      data: toArray(
        JSON.stringify({
          version: 1,
          tx: Array.from(tx.toAtomicBEEF()),
          inputIndex: 0,
          sighashType: TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID,
          ownedOutputs: [
            {
              outputIndex: 0,
              assetId,
              derivationPrefix: ownedCustody.derivationPrefix,
              derivationSuffix: ownedCustody.derivationSuffix,
              senderIdentityKey: wallet.identityKey
            }
          ]
        }),
        'utf8'
      )
    }
    const next = jest.fn(
      async (forwarded: object) => await wallet.createSignature(forwarded as never)
    )
    await expect(
      module.handleRequest({ method: 'createSignature', args, originator: APP }, next)
    ).resolves.toMatchObject({ signature: expect.any(Array) })
    expect(next).toHaveBeenCalledTimes(1)
  })
})
