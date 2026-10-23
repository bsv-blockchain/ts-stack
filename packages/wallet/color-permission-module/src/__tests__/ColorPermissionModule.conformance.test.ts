import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import {
  Beef,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  type CreateActionArgs,
  LockingScript,
  type CreateActionResult
} from '@bsv/sdk'
import { toArray } from '@bsv/sdk/primitives/utils'
import { encodeStrictCbor } from '@bsv/templates'
import type { PermissionsModuleAction } from '@bsv/wallet-toolbox-client'
import { ColorPlan } from '../ColorPlan.js'
import { ColorPermissionModule } from '../ColorPermissionModule.js'
import { ProfileParamsError } from '../errors.js'
import { assetBasket, COLOR_KEY_ID, colorProtocolID } from '../identifiers.js'
import type { RequiredProfileHandler } from '../profiles.js'
import {
  deployAsset,
  FakeProvider,
  FakeWallet,
  holdTokens,
  jsonTokenScript,
  tokenPayment
} from './fixtures.js'
import { exampleProfile, FakeStore } from './profileFixtures.js'

const APP = 'app.example'
const REVISION = 'urn:example:color:revision'
const REQ_MAP = { [REVISION]: { params: null, version: 1 } }
/** A conforming successor payload: the deploy's req repeated, no state. */
const REQ = encodeStrictCbor({ req: REQ_MAP })
/** The deploy's payload, and a conforming successor's: the req and revision state. */
const WITH_STATE = encodeStrictCbor({ req: REQ_MAP, ext: { [REVISION]: { revision: 1 } } })
/** A successor that repeats a different (empty) req: A.146. */
const OTHER_REQ = encodeStrictCbor({ req: {} })
/** A successor whose own ext entry the revision profile's checkExt rejects: A.151. */
const BAD_EXT = encodeStrictCbor({ ext: { [REVISION]: 'garbage' } })

/** The revision profile, but its state is required: an absent ext entry fails (A.151). */
function stateful(): RequiredProfileHandler {
  const base = exampleProfile()
  return {
    ...base,
    checkExt: value => {
      if (value === undefined) {
        throw new ProfileParamsError('BRC-207: the revision state is required')
      }
      base.checkExt!(value)
    }
  }
}

/**
 * Every path that reads a profile asset's tokens checks them against the deploy (0207:92-95,
 * A.146, A.151): a successor's req must be the deploy's, each required profile's own ext entry
 * must pass its checkExt, and a BRC-161 JSON leg supplies no ext state.
 */
describe('profile asset conformance on every path', () => {
  let wallet: FakeWallet
  let provider: FakeProvider
  let module: ColorPermissionModule
  let assetId: string

  function moduleWith(handler: RequiredProfileHandler): ColorPermissionModule {
    return new ColorPermissionModule({
      wallet: wallet.asWallet(),
      provider,
      requestTokenAccess: async () => true,
      profiles: { [handler.id]: handler },
      store: new FakeStore()
    })
  }

  beforeEach(async () => {
    wallet = new FakeWallet()
    provider = new FakeProvider()
    module = moduleWith(exampleProfile())
    assetId = (await deployAsset(new FakeWallet(), provider, 1_000n, WITH_STATE)).assetId
  })

  function transferPlan(overrides: Partial<ColorPlan> = {}): string[] {
    return ColorPlan.toLabels({
      version: 1,
      assets: [assetId],
      ownedOutputs: [],
      operations: [{ assetId, operation: 'transfer' }],
      inputPositions: [],
      changePositions: [],
      sighashTypes: [],
      ...overrides
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

  /** The module's createAction, the wallet's, then the module's signAction arguments. */
  async function sign(args: Partial<CreateActionArgs>): Promise<unknown> {
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
      createArgs: wallet.pending.get(signable.reference)?.args ?? funded
    }
    return (
      await module.onRequest({
        method: 'signAction',
        args: { reference: action.reference, spends: {} },
        originator: APP,
        action
      })
    ).args
  }

  /** A foreign pool output of 400 carrying `payload`, admitted and resolvable by the wallet. */
  async function pool(payload: number[]): Promise<{ outpoint: string; beef: number[] }> {
    const tx = (await tokenPayment(new FakeWallet(), new FakeWallet(), assetId, 400n, payload)).tx
    provider.admit(assetId, tx, 0)
    wallet.store(tx, 0, 'foreign')
    const beef = new Beef()
    beef.mergeTransaction(tx)
    return { outpoint: `${tx.id('hex')}.0`, beef: beef.toBinary() }
  }

  /** A createSignature over a received 40-unit source and one owned output `owned`. */
  async function signature(owned: LockingScript | number[], sourcePayload = REQ) {
    const sender = new FakeWallet()
    const { tx: source, customInstructions } = await tokenPayment(
      sender,
      wallet,
      assetId,
      40n,
      sourcePayload
    )
    provider.admit(assetId, source, 0)
    const custody = JSON.parse(customInstructions)
    const ownedPayment = await tokenPayment(
      wallet,
      wallet,
      assetId,
      40n,
      Array.isArray(owned) ? owned : undefined
    )
    const ownedCustody = JSON.parse(ownedPayment.customInstructions)
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript()
    })
    tx.addOutput({
      lockingScript: Array.isArray(owned) ? ownedPayment.tx.outputs[0].lockingScript : owned,
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
          sighashType: TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID,
          ownedOutputs: Array.isArray(owned)
            ? [
                {
                  outputIndex: 0,
                  assetId,
                  derivationPrefix: ownedCustody.derivationPrefix,
                  derivationSuffix: ownedCustody.derivationSuffix,
                  senderIdentityKey: wallet.identityKey
                }
              ]
            : []
        }),
        'utf8'
      )
    }
    const next = jest.fn(
      async (forwarded: object) => await wallet.createSignature(forwarded as never)
    )
    return {
      result: module.handleRequest({ method: 'createSignature', args, originator: APP }, next),
      next
    }
  }

  describe('createSignature', () => {
    it('A.146 refuses a successor whose req differs from the deploy, before signing', async () => {
      const { result, next } = await signature(OTHER_REQ)
      await expect(result).rejects.toThrow(/requirements differ from the deploy/)
      expect(next).not.toHaveBeenCalled()
    })

    it('A.151 refuses an owned output whose own ext entry fails checkExt, before signing', async () => {
      const { result, next } = await signature(BAD_EXT)
      await expect(result).rejects.toThrow(/revision ext entry/)
      expect(next).not.toHaveBeenCalled()
    })

    it('A.151 refuses a BRC-161 JSON output of a profile asset that requires ext state', async () => {
      module = moduleWith(stateful())
      const { result, next } = await signature(
        jsonTokenScript({ p: 'bsv-20', op: 'transfer', id: assetId, amt: '40' }),
        WITH_STATE
      )
      await expect(result).rejects.toThrow(/revision state is required/)
      expect(next).not.toHaveBeenCalled()
    })

    it('refuses assets whose profiles check transitions in checkPlanData', async () => {
      module = moduleWith({ ...exampleProfile(), checkPlanData: async () => {} })
      const { result, next } = await signature(REQ)
      await expect(result).rejects.toMatchObject({ name: 'ProfileParamsError' })
      await expect(result).rejects.toThrow(/do not allow app-built signatures/)
      expect(next).not.toHaveBeenCalled()
    })

    it('still signs a conforming transaction', async () => {
      const { result, next } = await signature(WITH_STATE)
      await expect(result).resolves.toMatchObject({ signature: expect.any(Array) })
      expect(next).toHaveBeenCalledTimes(1)
    })
  })

  describe('explicit inputs at createAction', () => {
    it('a conforming foreign input passes', async () => {
      const { outpoint, beef } = await pool(REQ)
      await expect(
        createAction({
          labels: transferPlan({ inputPositions: [{ outpoint, index: 0 }] }),
          inputBEEF: beef,
          inputs: [{ outpoint, unlockingScriptLength: 1, inputDescription: 'Pool' }],
          outputs: [await payment(400n)]
        })
      ).resolves.toBeDefined()
    })

    it.each([
      ['repeats a different req', OTHER_REQ, /requirements differ from the deploy/],
      ['carries an own ext entry checkExt rejects', BAD_EXT, /revision ext entry/]
    ])('a foreign input that %s fails', async (_name, payload, reason) => {
      const { outpoint, beef } = await pool(payload)
      await expect(
        createAction({
          labels: transferPlan({ inputPositions: [{ outpoint, index: 0 }] }),
          inputBEEF: beef,
          inputs: [{ outpoint, unlockingScriptLength: 1, inputDescription: 'Pool' }],
          outputs: [await payment(400n)]
        })
      ).rejects.toThrow(reason)
    })

    it('an explicit managed input whose own ext entry checkExt rejects fails', async () => {
      const [held] = await holdTokens(wallet, provider, assetId, [300n], BAD_EXT)
      const outpoint = `${held.id('hex')}.0`
      await expect(
        createAction({
          inputs: [{ outpoint, unlockingScriptLength: 108, inputDescription: 'Mine' }],
          outputs: [await payment(300n)]
        })
      ).rejects.toThrow(/revision ext entry/)
    })
  })

  describe('signAction', () => {
    it('checks a source the wallet resolved after createAction', async () => {
      await holdTokens(wallet, provider, assetId, [400n], REQ)
      const { outpoint } = await pool(BAD_EXT)
      // No inputBEEF: createAction cannot read the source, so signAction must; the fake wallet
      // resolves it from storage.
      wallet.requireInputBEEF = false
      await expect(
        sign({
          labels: transferPlan({ inputPositions: [{ outpoint, index: 0 }] }),
          inputs: [{ outpoint, unlockingScriptLength: 1, inputDescription: 'Pool' }],
          outputs: [await payment(400n)]
        })
      ).rejects.toThrow(/revision ext entry/)
    })

    it('signs a conforming send', async () => {
      await holdTokens(wallet, provider, assetId, [300n], WITH_STATE)
      await expect(sign({ outputs: [await payment(100n, WITH_STATE)] })).resolves.toMatchObject({
        spends: expect.any(Object)
      })
    })
  })

  describe('BRC-161 JSON legs', () => {
    it('A.151 a JSON destination supplies no ext state, which a stateful profile rejects', async () => {
      module = moduleWith(stateful())
      await holdTokens(wallet, provider, assetId, [300n], WITH_STATE)
      await expect(
        createAction({
          outputs: [
            {
              lockingScript: jsonTokenScript({
                p: 'bsv-20',
                op: 'transfer',
                id: assetId,
                amt: '100'
              }).toHex(),
              satoshis: 1,
              outputDescription: 'Pay'
            }
          ]
        })
      ).rejects.toThrow(/revision state is required/)
    })

    it('a profile that accepts absent ext state allows a JSON destination', async () => {
      await holdTokens(wallet, provider, assetId, [300n], REQ)
      await expect(
        createAction({
          outputs: [
            {
              lockingScript: jsonTokenScript({
                p: 'bsv-20',
                op: 'transfer',
                id: assetId,
                amt: '100'
              }).toHex(),
              satoshis: 1,
              outputDescription: 'Pay'
            }
          ]
        })
      ).resolves.toBeDefined()
    })
  })

  describe('receipts', () => {
    async function receipt(json: boolean): Promise<unknown> {
      module = moduleWith(stateful())
      const payment = await tokenPayment(new FakeWallet(), wallet, assetId, 40n, WITH_STATE)
      const { customInstructions } = payment
      // A plain anyone-can-spend source: the only token legs are the outputs.
      const source = new Transaction()
      source.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 1000 })
      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: source,
        sourceOutputIndex: 0,
        unlockingScript: new UnlockingScript()
      })
      tx.addOutput(payment.tx.outputs[0])
      if (json) {
        tx.addOutput({
          lockingScript: jsonTokenScript({ p: 'bsv-20', op: 'transfer', id: assetId, amt: '1' }),
          satoshis: 1
        })
      }
      provider.admit(assetId, tx, 0)
      return await module.onRequest({
        method: 'internalizeAction',
        args: {
          tx: tx.toAtomicBEEF(),
          description: 'Receive tokens',
          outputs: [
            {
              outputIndex: 0,
              protocol: 'basket insertion',
              insertionRemittance: { basket: assetBasket(assetId, 'value'), customInstructions }
            }
          ]
        },
        originator: APP
      })
    }

    it('A.151 a JSON output of the received asset supplies no ext state', async () => {
      await expect(receipt(false)).resolves.toBeDefined()
      await expect(receipt(true)).rejects.toThrow(/revision state is required/)
    })
  })

  describe('plan profileData', () => {
    it('A.157 a leaf for a required profile without checkPlanData fails', async () => {
      await holdTokens(wallet, provider, assetId, [300n], REQ)
      await expect(
        createAction({
          labels: transferPlan({
            profileData: {
              [REVISION]: { [assetId]: { grant: true, expectedRevision: 'not-an-int' } }
            }
          }),
          outputs: [await payment(100n)]
        })
      ).rejects.toMatchObject({ name: 'ProfileDataError' })
    })
  })
})
