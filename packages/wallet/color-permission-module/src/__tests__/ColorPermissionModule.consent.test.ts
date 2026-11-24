import { describe, expect, it } from '@jest/globals'
import {
  LockingScript,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  type CreateActionArgs,
  type CreateActionResult
} from '@bsv/sdk'
import { toArray } from '@bsv/sdk/primitives/utils'
import type { PermissionsModuleAction } from '@bsv/wallet-toolbox-client'
import { ColorPlan } from '../ColorPlan.js'
import type { ColorPermissionModule } from '../ColorPermissionModule.js'
import { assetBasket, COLOR_KEY_ID, colorProtocolID } from '../identifiers.js'
import {
  createModule,
  deployAsset,
  FakeProvider,
  FakeWallet,
  holdTokens,
  tokenPayment
} from './fixtures.js'

const APP = 'app.example'

type ConsentType = 'color_send' | 'color_signature' | 'color_relinquish' | 'color_access'

/** A module whose host records every request and approves it. */
function recording(
  build: (
    requestTokenAccess: (app: string, message: string) => Promise<boolean>
  ) => ColorPermissionModule
): { module: ColorPermissionModule; prompts: Array<Record<string, unknown>> } {
  const prompts: Array<Record<string, unknown>> = []
  const module = build(async (_app, message) => {
    prompts.push(JSON.parse(message) as Record<string, unknown>)
    return true
  })
  return { module, prompts }
}

async function paymentOutput(assetId: string, amount: bigint) {
  const { tx } = await tokenPayment(new FakeWallet(), new FakeWallet(), assetId, amount)
  return {
    lockingScript: tx.outputs[0].lockingScript.toHex(),
    satoshis: 1,
    outputDescription: 'Pay'
  }
}

/**
 * Drives one request that prompts `type`, with `seekPermission` false when `seek` is false and
 * absent otherwise, and returns the prompt of that type.
 */
async function prompted(type: ConsentType, seek: boolean): Promise<Record<string, unknown>> {
  const extension = seek ? {} : { seekPermission: false }
  const wallet = new FakeWallet()
  const provider = new FakeProvider()
  const { module, prompts } = recording(requestTokenAccess =>
    createModule(wallet, provider, requestTokenAccess)
  )
  const { assetId } = await deployAsset(new FakeWallet(), provider, 1000n)
  const next = async (forwarded: object): Promise<object> => forwarded

  if (type === 'color_send') {
    await holdTokens(wallet, provider, assetId, [100n])
    const funded = (
      await module.onRequest({
        method: 'createAction',
        args: {
          description: 'Send tokens',
          labels: ColorPlan.toLabels({
            version: 1,
            assets: [assetId],
            ownedOutputs: [],
            operations: [{ assetId, operation: 'transfer' }],
            inputPositions: [],
            changePositions: [],
            sighashTypes: []
          }),
          outputs: [await paymentOutput(assetId, 100n)],
          options: { randomizeOutputs: false },
          ...extension
        } as CreateActionArgs,
        originator: APP
      })
    ).args as CreateActionArgs
    const created: CreateActionResult = await wallet.createAction(funded)
    const signable = created.signableTransaction!
    const action: PermissionsModuleAction = {
      reference: signable.reference,
      transaction: Transaction.fromAtomicBEEF(signable.tx),
      noSend: false,
      createArgs: wallet.pending.get(signable.reference)!.args
    }
    await module.onRequest({
      method: 'signAction',
      args: { reference: action.reference, spends: {} },
      originator: APP,
      action
    })
  } else if (type === 'color_signature') {
    const sender = new FakeWallet()
    const payment = await tokenPayment(sender, wallet, assetId, 40n)
    provider.admit(assetId, payment.tx, 0)
    const custody = JSON.parse(payment.customInstructions)
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: payment.tx,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript()
    })
    tx.addOutput({
      lockingScript: LockingScript.fromHex((await paymentOutput(assetId, 40n)).lockingScript),
      satoshis: 1
    })
    await module.handleRequest(
      {
        method: 'createSignature',
        args: {
          protocolID: colorProtocolID(assetId, custody.derivationPrefix, custody.derivationSuffix),
          keyID: COLOR_KEY_ID,
          counterparty: sender.identityKey,
          data: toArray(
            JSON.stringify({
              version: 1,
              tx: Array.from(tx.toAtomicBEEF()),
              inputIndex: 0,
              sighashType: TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID,
              ownedOutputs: []
            }),
            'utf8'
          ),
          ...extension
        },
        originator: APP
      },
      next
    )
  } else if (type === 'color_relinquish') {
    await module.handleRequest(
      {
        method: 'relinquishOutput',
        args: {
          basket: assetBasket(assetId, 'value'),
          output: `${'ab'.repeat(32)}.0`,
          ...extension
        },
        originator: APP
      },
      next
    )
  } else {
    await module.handleRequest(
      {
        method: 'listOutputs',
        args: { basket: assetBasket(assetId, 'value'), ...extension },
        originator: APP
      },
      next
    )
  }
  return prompts.find(prompt => prompt.type === type)!
}

describe('consent seekPermission', () => {
  it.each<ConsentType>(['color_send', 'color_signature', 'color_relinquish', 'color_access'])(
    '%s carries seekPermission and honours false',
    async type => {
      const asked = await prompted(type, true)
      expect(asked).toBeDefined()
      expect(typeof asked.seekPermission).toBe('boolean')
      expect(asked.seekPermission).toBe(true)
      const declined = await prompted(type, false)
      expect(declined.seekPermission).toBe(false)
    }
  )

  it('places seekPermission after handoff in color_send and after inputIndex in color_signature', async () => {
    const send = await prompted('color_send', true)
    expect(Object.keys(send).slice(0, 3)).toEqual(['type', 'handoff', 'seekPermission'])
    const signature = await prompted('color_signature', true)
    expect(Object.keys(signature).slice(0, 3)).toEqual(['type', 'inputIndex', 'seekPermission'])
  })
})
