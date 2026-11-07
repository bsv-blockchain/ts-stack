import { beforeEach, describe, expect, it } from '@jest/globals'
import {
  Transaction,
  type CreateActionArgs,
  type CreateActionResult,
  type InternalizeActionArgs,
  type SignActionArgs,
  type SignActionResult
} from '@bsv/sdk'
import { encodeStrictCbor } from '@bsv/templates'
import type { PermissionsModuleAction } from '@bsv/wallet-toolbox-client'
import { ColorPlan } from '../ColorPlan.js'
import { ColorPermissionModule } from '../ColorPermissionModule.js'
import { assetBasket, colorTopic } from '../identifiers.js'
import type { RequiredProfileHandler } from '../profiles.js'
import {
  createModule,
  deployAsset,
  FakeProvider,
  FakeWallet,
  holdTokens,
  tokenPayment
} from './fixtures.js'
import { FakeStore, issuerLikePayload, issuerLikeProfile } from './profileFixtures.js'

const APP = 'app.example'
const ISSUER = new FakeWallet()
const SIGNER = ISSUER.identityKey
/** A required profile that supplies BRC-22 off-chain values and sends ordinary broadcast actions. */
const DATA_ID = 'urn:example:color:data'
const DATA_BYTES = [1, 2, 3]

interface Bench {
  wallet: FakeWallet
  /** The routed provider of issuer-like assets. */
  ap: FakeProvider
  /** The default provider. */
  fallback: FakeProvider
  store: FakeStore
}

function bench(): Bench {
  return {
    wallet: new FakeWallet(),
    ap: new FakeProvider(),
    fallback: new FakeProvider(),
    store: new FakeStore()
  }
}

/** A module with `handlers` registered; `b.fallback` is its default provider. */
function moduleWith(b: Bench, handlers: RequiredProfileHandler[]): ColorPermissionModule {
  const profiles: Record<string, RequiredProfileHandler> = {}
  for (const handler of handlers) profiles[handler.id] = handler
  return new ColorPermissionModule({
    wallet: b.wallet.asWallet(),
    provider: b.fallback,
    requestTokenAccess: async () => true,
    profiles,
    store: b.store
  })
}

/** A profile with `submissionData` and no send policy: its actions broadcast with off-chain values. */
function dataProfile(): RequiredProfileHandler {
  return {
    id: DATA_ID,
    versions: [1],
    checkDescriptor: () => {},
    submissionData: async () => [...DATA_BYTES]
  }
}

function dataPayload(): number[] {
  return encodeStrictCbor({ req: { [DATA_ID]: { params: null, version: 1 } } })
}

function planLabels(assetId: string): string[] {
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

async function paymentOutput(assetId: string, amount: bigint) {
  const { tx } = await tokenPayment(new FakeWallet(), new FakeWallet(), assetId, amount)
  return {
    lockingScript: tx.outputs[0].lockingScript.toHex(),
    satoshis: 1,
    outputDescription: 'Token payment'
  }
}

/** The module's createAction handler alone: the funded arguments. */
async function plan(
  module: ColorPermissionModule,
  assetId: string,
  extra: Partial<CreateActionArgs> = {}
): Promise<CreateActionArgs> {
  return (
    await module.onRequest({
      method: 'createAction',
      args: {
        description: 'Send tokens',
        labels: planLabels(assetId),
        outputs: [await paymentOutput(assetId, 200n)],
        ...extra,
        options: { randomizeOutputs: false, ...extra.options }
      } as CreateActionArgs,
      originator: APP
    })
  ).args as CreateActionArgs
}

/** The whole manager flow: module createAction, wallet, module signAction, wallet, onResponse. */
async function send(
  b: Bench,
  module: ColorPermissionModule,
  assetId: string,
  extra: Partial<CreateActionArgs> = {}
): Promise<SignActionResult> {
  const funded = await plan(module, assetId, extra)
  const created = (await module.onResponse(await b.wallet.createAction(funded), {
    method: 'createAction',
    originator: APP
  })) as CreateActionResult
  const signable = created.signableTransaction!
  const action: PermissionsModuleAction = {
    reference: signable.reference,
    transaction: Transaction.fromAtomicBEEF(signable.tx),
    noSend: funded.options?.noSend === true,
    createArgs: b.wallet.pending.get(signable.reference)!.args
  }
  const signArgs = (
    await module.onRequest({
      method: 'signAction',
      args: { reference: action.reference, spends: {} },
      originator: APP,
      action
    })
  ).args as SignActionArgs
  return (await module.onResponse(await b.wallet.signAction(signArgs), {
    method: 'signAction',
    originator: APP,
    action
  })) as SignActionResult
}

describe('spending profile assets', () => {
  let b: Bench

  beforeEach(() => {
    b = bench()
  })

  it('a pending receipt is spent only once its overlay lists it', async () => {
    const issuer = issuerLikeProfile({
      K: SIGNER,
      provider: b.ap,
      admit: async () => ({ credit: 'pending' })
    })
    const module = moduleWith(b, [issuer])
    const { assetId } = await deployAsset(ISSUER, b.fallback, 2000n, issuerLikePayload(SIGNER))
    const paid = await tokenPayment(ISSUER, b.wallet, assetId, 600n)
    const { args } = await module.onRequest({
      method: 'internalizeAction',
      args: {
        tx: paid.tx.toAtomicBEEF(),
        description: 'Receive tokens',
        outputs: [
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: assetBasket(assetId, 'value'),
              customInstructions: paid.customInstructions
            }
          }
        ]
      },
      originator: APP
    })
    await b.wallet.internalizeAction(args as InternalizeActionArgs)
    const noSend = { options: { noSend: true } }
    await expect(plan(module, assetId, noSend)).rejects.toThrow('insufficient spendable balance')
    // Never resubmitted by the module: the host submits it.
    expect(b.ap.calls.submit).toBe(0)
    expect(b.fallback.calls.submit).toBe(0)
    b.ap.admit(assetId, paid.tx, 0)
    const funded = await plan(module, assetId, noSend)
    expect(funded.inputs!.map(input => input.outpoint)).toEqual([`${paid.tx.id('hex')}.0`])
  })

  it('never resubmits a plain-nosend or submissionData asset from the wallet copy', async () => {
    const issuerModule = moduleWith(b, [issuerLikeProfile({ K: SIGNER, provider: b.ap })])
    const { assetId: issuerAsset } = await deployAsset(
      ISSUER,
      b.fallback,
      2000n,
      issuerLikePayload(SIGNER)
    )
    const [held] = await holdTokens(b.wallet, b.ap, issuerAsset, [600n])
    b.ap.current.delete(`${held.id('hex')}.0`)
    await expect(plan(issuerModule, issuerAsset, { options: { noSend: true } })).rejects.toThrow(
      'insufficient spendable balance'
    )
    expect(b.ap.calls.submit).toBe(0)

    const dataModule = moduleWith(b, [dataProfile()])
    const { assetId: dataAsset } = await deployAsset(
      new FakeWallet(),
      b.fallback,
      2000n,
      dataPayload()
    )
    const [dataHeld] = await holdTokens(b.wallet, b.fallback, dataAsset, [600n])
    b.fallback.current.delete(`${dataHeld.id('hex')}.0`)
    const submits = b.fallback.calls.submit
    await expect(plan(dataModule, dataAsset)).rejects.toThrow('insufficient spendable balance')
    expect(b.fallback.calls.submit).toBe(submits)
  })

  it('a broadcast action of a submissionData asset submits its off-chain values', async () => {
    const module = moduleWith(b, [dataProfile()])
    const { assetId } = await deployAsset(new FakeWallet(), b.fallback, 2000n, dataPayload())
    await holdTokens(b.wallet, b.fallback, assetId, [600n])
    const result = await send(b, module, assetId)
    expect(b.fallback.submissions.at(-1)).toEqual({
      topics: [colorTopic(assetId)],
      txid: result.txid!,
      offChainValues: DATA_BYTES
    })
    // Its change is admitted by that submission and spends without any resubmission.
    const submits = b.fallback.calls.submit
    const next = await plan(module, assetId, { outputs: [await paymentOutput(assetId, 100n)] })
    expect(next.inputs!.map(input => input.outpoint)).toEqual([`${result.txid!}.1`])
    expect(b.fallback.calls.submit).toBe(submits)
  })

  it('a profiled asset without send hooks is resubmitted from the wallet copy as in 0.1.0', async () => {
    const plainHandler: RequiredProfileHandler = {
      id: 'urn:example:color:plain',
      versions: [1],
      checkDescriptor: () => {}
    }
    const module = moduleWith(b, [plainHandler])
    const payload = encodeStrictCbor({
      req: { [plainHandler.id]: { params: null, version: 1 } }
    })
    const { assetId } = await deployAsset(new FakeWallet(), b.fallback, 2000n, payload)
    const [held] = await holdTokens(b.wallet, b.fallback, assetId, [600n])
    b.fallback.current.delete(`${held.id('hex')}.0`)
    const funded = await plan(module, assetId)
    expect(funded.inputs!.map(input => input.outpoint)).toEqual([`${held.id('hex')}.0`])
    expect(b.fallback.submissions.map(entry => entry.txid)).toContain(held.id('hex'))
  })

  it('profile-free spending is unchanged', async () => {
    const provider = new FakeProvider()
    const lengths: number[] = []
    const submit = provider.submit
    provider.submit = async (...args: Parameters<FakeProvider['submit']>) => {
      lengths.push(args.length)
      return await submit(...args)
    }
    const module = createModule(b.wallet, provider)
    const { assetId } = await deployAsset(new FakeWallet(), provider, 1000n)
    const [held] = await holdTokens(b.wallet, provider, assetId, [600n])
    // Unlisted: the wallet's own copy is resubmitted before it is selected.
    provider.current.delete(`${held.id('hex')}.0`)

    const result = await send(b, module, assetId)

    expect(lengths.length).toBeGreaterThanOrEqual(2)
    expect(lengths.every(length => length === 2)).toBe(true)
    expect(provider.submissions.every(entry => !('offChainValues' in entry))).toBe(true)
    expect(provider.submissions.at(-1)?.txid).toBe(result.txid)
    expect(b.store.writes).toEqual([])
  })
})
