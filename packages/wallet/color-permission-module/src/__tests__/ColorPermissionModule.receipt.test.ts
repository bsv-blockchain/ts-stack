import { beforeEach, describe, expect, it } from '@jest/globals'
import { LockingScript, Transaction, type InternalizeActionArgs } from '@bsv/sdk'
import { ColorPermissionModule } from '../ColorPermissionModule.js'
import { assetBasket } from '../identifiers.js'
import type {
  ProfileAssetContext,
  ProfileReceipt,
  ReceiptAdmission,
  RequiredProfileHandler
} from '../profiles.js'
import type { ColorPermissionModuleOptions } from '../types.js'
import {
  createModule,
  deployAsset,
  FakeProvider,
  FakeWallet,
  suffixTagOf,
  tokenPayment
} from './fixtures.js'
import {
  A141A,
  exampleProfile,
  FakeStore,
  fixtureDeploy,
  ISSUER_LIKE_ID,
  issuerLikePayload,
  issuerLikeProfile
} from './profileFixtures.js'

const APP = 'app.example'

/** One `p color` receipt of output 0 of `paid` into the asset's value basket. */
function receiptArgs(
  paid: { tx: Transaction; customInstructions: string },
  assetId: string,
  tags?: string[]
): InternalizeActionArgs {
  return {
    tx: paid.tx.toAtomicBEEF(),
    description: 'Receive tokens',
    outputs: [
      {
        outputIndex: 0,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: assetBasket(assetId, 'value'),
          customInstructions: paid.customInstructions,
          ...(tags === undefined ? {} : { tags })
        }
      }
    ]
  }
}

function withInstructions(
  args: InternalizeActionArgs,
  customInstructions: string
): InternalizeActionArgs {
  const [output] = args.outputs
  return {
    ...args,
    outputs: [
      { ...output, insertionRemittance: { ...output.insertionRemittance!, customInstructions } }
    ]
  }
}

describe('receipts with profiles registered', () => {
  let wallet: FakeWallet
  let provider: FakeProvider
  let store: FakeStore
  /** The wallet-internalize calls the manager made after the module approved a receipt. */
  let walletCalls: number

  function moduleWith(options: Partial<ColorPermissionModuleOptions> = {}): ColorPermissionModule {
    const ex = exampleProfile()
    return new ColorPermissionModule({
      wallet: wallet.asWallet(),
      provider,
      requestTokenAccess: async () => true,
      profiles: { [ex.id]: ex },
      store,
      ...options
    })
  }

  /** The manager's flow: the module's onRequest, then the underlying wallet with the forwarded args. */
  async function receive(
    module: ColorPermissionModule,
    args: InternalizeActionArgs
  ): Promise<InternalizeActionArgs> {
    const { args: forwarded } = await module.onRequest({
      method: 'internalizeAction',
      args,
      originator: APP
    })
    walletCalls++
    await wallet.internalizeAction(forwarded as InternalizeActionArgs)
    return forwarded as InternalizeActionArgs
  }

  beforeEach(() => {
    wallet = new FakeWallet()
    provider = new FakeProvider()
    store = new FakeStore()
    walletCalls = 0
  })

  it('profile-free receipts gain only their suffix tag', async () => {
    const { assetId } = await deployAsset(new FakeWallet(), provider, 1000n)
    const paid = await tokenPayment(new FakeWallet(), wallet, assetId, 25n)
    provider.admit(assetId, paid.tx, 0)
    const args = receiptArgs(paid, assetId, ['color_offline'])
    const suffixTag = suffixTagOf(paid.customInstructions)
    const { args: forwarded } = await createModule(wallet, provider).onRequest({
      method: 'internalizeAction',
      args,
      originator: APP
    })
    expect(forwarded).toEqual({
      ...args,
      outputs: [
        {
          ...args.outputs[0],
          insertionRemittance: {
            ...args.outputs[0].insertionRemittance,
            tags: ['color_offline', suffixTag]
          }
        }
      ]
    })

    // With profiles registered, a profile-free asset forwards the 5-member custody without color_
    // tags, with its suffix tag.
    const viaProfiles = await receive(moduleWith(), args)
    expect(viaProfiles.outputs[0].insertionRemittance).toEqual({
      basket: assetBasket(assetId, 'value'),
      customInstructions: paid.customInstructions,
      tags: [suffixTag]
    })
    expect(store.writes).toEqual([`color.v1.deploy.${assetId}`])
  })

  it('strips caller color_* tags from insertions and leaves the caller args unchanged', async () => {
    const tags = ['color_offline', 'color_state_available', 'mine']
    const { assetId } = await deployAsset(new FakeWallet(), provider, 1000n)
    const paid = await tokenPayment(new FakeWallet(), wallet, assetId, 25n)
    provider.admit(assetId, paid.tx, 0)
    const args = receiptArgs(paid, assetId, tags)
    const forwarded = await receive(moduleWith(), args)
    expect(forwarded.outputs[0].insertionRemittance?.tags).toEqual([
      'mine',
      suffixTagOf(paid.customInstructions)
    ])
    expect(args.outputs[0].insertionRemittance?.tags).toEqual(tags)
  })

  it('a receipt carries custody only: any profileData is rejected', async () => {
    const { tx: deployTx, assetId } = fixtureDeploy(A141A.C)
    provider.admit(assetId, deployTx, 0)
    const paid = await tokenPayment(new FakeWallet(), wallet, assetId, 40n)
    provider.admit(assetId, paid.tx, 0)
    const custody = JSON.parse(paid.customInstructions) as Record<string, unknown>
    const leaf = { 'urn:example:color:revision': { [assetId]: { revision: 1 } } }
    const withLeaf = withInstructions(
      receiptArgs(paid, assetId),
      JSON.stringify({ ...custody, profileData: leaf })
    )
    await expect(receive(moduleWith(), withLeaf)).rejects.toMatchObject({
      name: 'Error',
      message:
        'BRC-207: receipt customInstructions.profileData names a profile the asset does not require'
    })
    expect(walletCalls).toBe(0)
    // An empty profileData carries nothing, as in 0.1.0; the wallet gets the 5-member custody.
    const empty = withInstructions(
      receiptArgs(paid, assetId),
      JSON.stringify({ ...custody, profileData: {} })
    )
    const forwarded = await receive(moduleWith(), empty)
    expect(forwarded.outputs[0].insertionRemittance?.customInstructions).toBe(
      paid.customInstructions
    )
  })

  it('without profiles a receipt profileData keeps the 0.1.0 refusal', async () => {
    const { assetId } = await deployAsset(new FakeWallet(), provider, 1000n)
    const paid = await tokenPayment(new FakeWallet(), wallet, assetId, 25n)
    provider.admit(assetId, paid.tx, 0)
    const custody = JSON.parse(paid.customInstructions) as Record<string, unknown>
    const args = withInstructions(
      receiptArgs(paid, assetId),
      JSON.stringify({ ...custody, profileData: { 'urn:x': { [assetId]: 1 } } })
    )
    const error = await createModule(wallet, provider)
      .onRequest({ method: 'internalizeAction', args, originator: APP })
      .catch((caught: unknown) => caught as Error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('Error')
    expect((error as Error).message).toBe(
      'BRC-207: receipt customInstructions.profileData names a profile the asset does not require'
    )
  })

  it('bounds receipt customInstructions at 1000 bytes', async () => {
    const { assetId } = await deployAsset(new FakeWallet(), provider, 1000n)
    const paid = await tokenPayment(new FakeWallet(), wallet, assetId, 25n)
    provider.admit(assetId, paid.tx, 0)
    const padded = (length: number): InternalizeActionArgs =>
      withInstructions(
        receiptArgs(paid, assetId),
        paid.customInstructions + ' '.repeat(length - paid.customInstructions.length)
      )
    await expect(receive(moduleWith(), padded(1001))).rejects.toThrow(
      'receipt customInstructions exceeds 1000 bytes'
    )
    // A multi-byte string within 1000 UTF-16 units can still exceed 1000 UTF-8 bytes.
    const multiByte = withInstructions(
      receiptArgs(paid, assetId),
      `${paid.customInstructions}${' '.repeat(600)}`
    )
    await expect(receive(moduleWith(), multiByte)).rejects.toThrow('exceeds 1000 bytes')
    await expect(receive(moduleWith(), padded(1000))).resolves.toBeDefined()
  })

  it('never stores or submits anything during internalization', async () => {
    const { assetId } = await deployAsset(new FakeWallet(), provider, 1000n)
    const paid = await tokenPayment(new FakeWallet(), wallet, assetId, 25n)
    provider.admit(assetId, paid.tx, 0)
    await receive(moduleWith(), receiptArgs(paid, assetId))
    expect(provider.calls.submit).toBe(0)
    expect(store.writes.filter(key => !key.startsWith('color.v1.deploy.'))).toEqual([])
  })

  it('applies the base receipt checks with profiles registered', async () => {
    const { tx: deployTx, assetId } = fixtureDeploy(A141A.C)
    provider.admit(assetId, deployTx, 0)
    const paid = await tokenPayment(new FakeWallet(), wallet, assetId, 40n)
    const module = moduleWith()
    const base = receiptArgs(paid, assetId)
    const variant = (
      output: Partial<InternalizeActionArgs['outputs'][number]>
    ): InternalizeActionArgs => ({ ...base, outputs: [{ ...base.outputs[0], ...output }] })
    // Without an admitReceipt hook, a receipt needs current spendability.
    await expect(receive(module, base)).rejects.toThrow('not admitted and unspent')
    provider.admit(assetId, paid.tx, 0)
    await expect(receive(module, variant({ outputIndex: 3 }))).rejects.toThrow(
      'names a missing output'
    )
    const plainTx = new Transaction()
    plainTx.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 1 })
    await expect(receive(module, { ...base, tx: plainTx.toAtomicBEEF() })).rejects.toThrow(
      'not a BRC-162 token output'
    )
    await expect(
      receive(
        module,
        variant({
          insertionRemittance: {
            basket: assetBasket(assetId, 'authority'),
            customInstructions: paid.customInstructions
          }
        })
      )
    ).rejects.toThrow('basket does not match')
    await expect(
      receive(
        module,
        variant({
          insertionRemittance: {
            basket: 'p color assets',
            customInstructions: paid.customInstructions
          }
        })
      )
    ).rejects.toThrow('per-asset value or authority basket')
    const otherId = `${'cd'.repeat(32)}_0`
    await expect(
      receive(
        module,
        withInstructions(
          base,
          JSON.stringify({
            ...(JSON.parse(paid.customInstructions) as object),
            assetId: otherId
          })
        )
      )
    ).rejects.toThrow('name a different asset than the output')
    // A receipt keyed to another wallet is not this wallet's output.
    const foreign = await tokenPayment(new FakeWallet(), new FakeWallet(), assetId, 40n)
    provider.admit(assetId, foreign.tx, 0)
    await expect(receive(module, receiptArgs(foreign, assetId))).rejects.toThrow(
      "not locked to this wallet's p color key"
    )
    expect(walletCalls).toBe(0)
    await expect(receive(module, base)).resolves.toBeDefined()
  })

  it('an unsupported required profile fails closed before anything is credited', async () => {
    const { tx: deployTx, assetId } = fixtureDeploy(A141A.U)
    provider.admit(assetId, deployTx, 0)
    const paid = await tokenPayment(new FakeWallet(), wallet, assetId, 40n)
    provider.admit(assetId, paid.tx, 0)
    await expect(receive(moduleWith(), receiptArgs(paid, assetId))).rejects.toMatchObject({
      name: 'UnsupportedProfileError'
    })
    expect(walletCalls).toBe(0)
  })
})

describe('admitReceipt', () => {
  const issuer = new FakeWallet()
  const K = issuer.identityKey
  let wallet: FakeWallet
  let provider: FakeProvider
  let store: FakeStore
  let calls: Array<{ ctx: ProfileAssetContext; receipt: ProfileReceipt }>
  let answer: () => Promise<ReceiptAdmission>
  let walletCalls: number

  function issuerModule(handler?: RequiredProfileHandler): ColorPermissionModule {
    const profile =
      handler ??
      issuerLikeProfile({
        K,
        admit: async (ctx, receipt) => {
          calls.push({ ctx, receipt })
          return await answer()
        }
      })
    return new ColorPermissionModule({
      wallet: wallet.asWallet(),
      provider,
      requestTokenAccess: async () => true,
      profiles: { [profile.id]: profile },
      store
    })
  }

  async function receive(
    module: ColorPermissionModule,
    args: InternalizeActionArgs
  ): Promise<InternalizeActionArgs> {
    const { args: forwarded } = await module.onRequest({
      method: 'internalizeAction',
      args,
      originator: APP
    })
    walletCalls++
    await wallet.internalizeAction(forwarded as InternalizeActionArgs)
    return forwarded as InternalizeActionArgs
  }

  /** An issuer-like asset and a receipt of it that its overlay has not admitted. */
  async function issuerReceipt(
    tags?: string[]
  ): Promise<{ assetId: string; txid: string; args: InternalizeActionArgs }> {
    const { assetId } = await deployAsset(issuer, provider, 1000n, issuerLikePayload(K))
    const paid = await tokenPayment(issuer, wallet, assetId, 30n)
    return { assetId, txid: paid.tx.id('hex'), args: receiptArgs(paid, assetId, tags) }
  }

  beforeEach(() => {
    wallet = new FakeWallet()
    provider = new FakeProvider()
    store = new FakeStore()
    calls = []
    answer = async () => ({ credit: 'settled' })
    walletCalls = 0
  })

  it('settled: credits the receipt without color_offline and without the overlay check', async () => {
    const { assetId, txid, args } = await issuerReceipt(['mine'])
    const forwarded = await receive(issuerModule(), args)
    expect(forwarded.outputs[0].insertionRemittance?.tags).toEqual([
      'mine',
      suffixTagOf(args.outputs[0].insertionRemittance!.customInstructions!)
    ])
    expect(provider.calls.spendability).toBe(0)
    expect(provider.calls.submit).toBe(0)
    expect(wallet.outputs.has(`${txid}.0`)).toBe(true)
    expect(calls).toHaveLength(1)
    const [{ ctx, receipt }] = calls
    expect(receipt.assetId).toBe(assetId)
    expect(receipt.txid).toBe(txid)
    expect(receipt.outputIndex).toBe(0)
    expect(receipt.tx.id('hex')).toBe(txid)
    expect(receipt.beef).toEqual(args.tx)
    expect(ctx).toMatchObject({
      assetId,
      profileId: ISSUER_LIKE_ID,
      identityKey: wallet.identityKey,
      originator: APP
    })
    expect(ctx.wallet).toBe(wallet)
    expect(ctx.declarationTx.id('hex')).toBe(assetId.slice(0, 64))
    expect(ctx.descriptor).toEqual({ params: { identityKey: K }, version: 1 })
    expect([...ctx.req.keys()]).toEqual([ISSUER_LIKE_ID])
  })

  it('pending: credits the receipt tagged color_offline, after the caller tags', async () => {
    answer = async () => ({ credit: 'pending' })
    const { txid, args } = await issuerReceipt(['color_state_reserved', 'mine'])
    const forwarded = await receive(issuerModule(), args)
    const tags = [
      'mine',
      suffixTagOf(args.outputs[0].insertionRemittance!.customInstructions!),
      'color_offline'
    ]
    expect(forwarded.outputs[0].insertionRemittance?.tags).toEqual(tags)
    expect(wallet.outputs.get(`${txid}.0`)?.tags).toEqual(tags)
    expect(store.writes.filter(key => key.startsWith('color.v1.settled.'))).toEqual([])
  })

  it('a throw credits nothing and propagates', async () => {
    const refusal = new Error('the issuer has no record of this transaction')
    answer = async () => {
      throw refusal
    }
    const { args } = await issuerReceipt()
    await expect(receive(issuerModule(), args)).rejects.toBe(refusal)
    expect(walletCalls).toBe(0)
    expect(wallet.outputs.size).toBe(0)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an unknown credit', { credit: 'admitted' }],
    ['a legacy status answer', { status: 'admitted', attestations: [] }]
  ])('an answer of %s fails with ProfileDataError', async (_name, value) => {
    answer = async () => value as unknown as ReceiptAdmission
    const { args } = await issuerReceipt()
    await expect(receive(issuerModule(), args)).rejects.toMatchObject({
      name: 'ProfileDataError',
      message: `[ProfileDataError] BRC-207: ${ISSUER_LIKE_ID} admitReceipt gave no credit decision`
    })
    expect(walletCalls).toBe(0)
  })

  it('runs after the base checks: a receipt for another wallet never reaches the hook', async () => {
    const { assetId } = await deployAsset(issuer, provider, 1000n, issuerLikePayload(K))
    const foreign = await tokenPayment(issuer, new FakeWallet(), assetId, 30n)
    await expect(receive(issuerModule(), receiptArgs(foreign, assetId))).rejects.toThrow(
      "not locked to this wallet's p color key"
    )
    expect(calls).toHaveLength(0)
  })

  it('a receipt of a profile-free asset is still checked against the overlay beside it', async () => {
    const { assetId } = await deployAsset(new FakeWallet(), provider, 1000n)
    const paid = await tokenPayment(new FakeWallet(), wallet, assetId, 25n)
    await expect(receive(issuerModule(), receiptArgs(paid, assetId))).rejects.toThrow(
      'not admitted and unspent'
    )
    expect(calls).toHaveLength(0)
  })
})
