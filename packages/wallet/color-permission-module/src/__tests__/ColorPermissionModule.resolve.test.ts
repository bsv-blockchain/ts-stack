import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import {
  Transaction,
  UnlockingScript,
  type CreateActionArgs,
  type CreateActionResult,
  type InternalizeActionArgs,
  type ListOutputsResult,
  type SignActionResult
} from '@bsv/sdk'
import { encodeStrictCbor, OneColor } from '@bsv/templates'
import type { PermissionsModuleAction } from '@bsv/wallet-toolbox-client'
import { ColorPlan } from '../ColorPlan.js'
import { ColorPermissionModule } from '../ColorPermissionModule.js'
import { assetBasket, assetTag, colorTopic } from '../identifiers.js'
import type { RequiredProfileHandler } from '../profiles.js'
import { readProfiledTokenOutput, type TokenOutput } from '../tokenOutputs.js'
import type { ColorPermissionModuleOptions } from '../types.js'
import { deployAsset, FakeProvider, FakeWallet, holdTokens, tokenPayment } from './fixtures.js'
import { A141A, exampleProfile, FakeStore, fixtureDeploy, TestModule } from './profileFixtures.js'

const APP = 'app.example'
const REVISION = 'urn:example:color:revision'
const next = async (args: unknown): Promise<unknown> => args
const deployKey = (assetId: string): string => `color.v1.deploy.${assetId}`
/** The payload `{"req":{}}`. */
const EMPTY_REQ = [0xa1, 0x63, 0x72, 0x65, 0x71, 0xa0]

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

/** A successor output of `assetId` carrying `payload`, read with the profile-aware reader. */
function successor(assetId: string, payload?: number[]): TokenOutput {
  const tx = new Transaction()
  tx.addOutput({
    lockingScript: new OneColor().lock(assetId, 5n, Array(20).fill(0x11), payload),
    satoshis: 1
  })
  return readProfiledTokenOutput(tx.outputs[0].lockingScript, { txid: tx.id('hex'), vout: 0 })!
}

/** A BRC-162 deploy whose payload is `map`, as its own one-output transaction. */
function payloadDeploy(map: Parameters<typeof encodeStrictCbor>[0]): {
  tx: Transaction
  assetId: string
} {
  const tx = new Transaction()
  tx.addOutput({
    lockingScript: new OneColor().lock(null, 100n, Array(20).fill(0x22), encodeStrictCbor(map)),
    satoshis: 1000
  })
  return { tx, assetId: `${tx.id('hex')}_0` }
}

describe('asset resolution with profiles', () => {
  let wallet: FakeWallet
  let provider: FakeProvider
  let store: FakeStore
  let ex: RequiredProfileHandler

  function moduleWith(options: Partial<ColorPermissionModuleOptions> = {}): TestModule {
    return new TestModule({
      wallet: wallet.asWallet(),
      provider,
      requestTokenAccess: async () => true,
      profiles: { [ex.id]: ex },
      store,
      ...options
    })
  }

  beforeEach(() => {
    wallet = new FakeWallet()
    provider = new FakeProvider()
    store = new FakeStore()
    ex = exampleProfile()
  })

  async function balanceOf(module: ColorPermissionModule, assetId: string): Promise<unknown> {
    return await module.handleRequest(
      {
        method: 'listOutputs',
        originator: APP,
        args: { basket: `p color balance ${assetTag(assetId)}` }
      },
      next
    )
  }

  it('A.142/A.143 balance fails for an unsupported asset when profiles are registered', async () => {
    const module = moduleWith()
    for (const hex of [A141A.U, A141A.V]) {
      const { tx, assetId } = fixtureDeploy(hex)
      provider.admit(assetId, tx, 0)
      wallet.store(tx, 0, assetBasket(assetId, 'value'))
      await expect(balanceOf(module, assetId)).rejects.toMatchObject({
        name: 'UnsupportedProfileError'
      })
    }
    // The version mismatch is reported by resolution, before any output is read (A.143).
    const v = fixtureDeploy(A141A.V)
    await expect(balanceOf(module, v.assetId)).rejects.toThrow(
      'BRC-207: the required processing profile version is unsupported'
    )
  })

  it('balance of a supported profiled asset reads its outputs with the profile-aware reader', async () => {
    const module = moduleWith()
    const { tx, assetId } = fixtureDeploy(A141A.C)
    provider.admit(assetId, tx, 0)
    wallet.store(tx, 0, assetBasket(assetId, 'value'))
    const amount = OneColor.decode(tx.outputs[0].lockingScript).amount
    expect(amount).toBeGreaterThan(0n)
    await expect(balanceOf(module, assetId)).resolves.toEqual({
      totalOutputs: Number(amount),
      outputs: []
    })
  })

  it('resolution order: store, then default provider, then deployProviders', async () => {
    const { tx, assetId } = fixtureDeploy(A141A.C)
    const txid = tx.id('hex')

    // a: a cached deploy resolves with no provider call.
    await store.set(deployKey(assetId), tx.toHex())
    const a = await moduleWith().resolveAssetForTest(assetId)
    expect(provider.calls.admission).toBe(0)
    expect(a.declarationTx?.id('hex')).toBe(txid)
    expect([...a.req.keys()]).toEqual([REVISION])
    expect(a.handlers.map(({ handler }) => handler.id)).toEqual([REVISION])
    expect(a.attributes?.payload).toBe('map')
    expect(a.provider).toBe(provider)
    expect(await store.get(deployKey(assetId))).toBe(tx.toHex())

    // b: a second module sharing the store resolves from the cache.
    const b = await moduleWith().resolveAssetForTest(assetId)
    expect(b.declarationTx?.id('hex')).toBe(txid)
    expect(provider.calls.admission).toBe(0)

    // c: an empty store asks the default provider once, for the deploy outpoint, then caches.
    store.clear()
    provider.admit(assetId, tx, 0)
    const admission = jest.spyOn(provider, 'admission')
    await moduleWith().resolveAssetForTest(assetId)
    expect(admission).toHaveBeenCalledTimes(1)
    expect(admission).toHaveBeenCalledWith(assetId, [`${txid}.0`])
    expect(await store.get(deployKey(assetId))).toBe(tx.toHex())

    // d: the default provider has nothing, so each handler's deployProviders() is asked.
    store.clear()
    const fresh = fixtureDeploy(A141A.C.replace('a914fc', 'a914fd'))
    const p2 = new FakeProvider()
    p2.admit(fresh.assetId, fresh.tx, 0)
    ex = { ...exampleProfile(), deployProviders: () => [p2] }
    const before = provider.calls.admission
    const d = await moduleWith().resolveAssetForTest(fresh.assetId)
    expect(d.declarationTx?.id('hex')).toBe(fresh.tx.id('hex'))
    expect(provider.calls.admission).toBe(before + 1)
    expect(p2.calls.admission).toBe(1)
    // The deploy provider only supplied the deploy: routing stays on the default provider.
    expect(d.provider).toBe(provider)

    // None of them has it.
    const missing = fixtureDeploy(A141A.C.replace('a914fc', 'a914fe'))
    await expect(moduleWith().resolveAssetForTest(missing.assetId)).rejects.toThrow(
      /no admitted deploy/
    )
    expect(p2.calls.admission).toBe(2)
  })

  it('a provider failure falls through to the next source, and is reported when nothing verifies', async () => {
    const { tx, assetId } = fixtureDeploy(A141A.C)
    const p2 = new FakeProvider()
    p2.admit(assetId, tx, 0)
    ex = { ...exampleProfile(), deployProviders: () => [p2] }
    provider.admission = async () => {
      throw new Error('default provider unavailable')
    }
    await expect(moduleWith().resolveAssetForTest(assetId)).resolves.toMatchObject({ assetId })
    store.clear()
    p2.history.clear()
    await expect(moduleWith().resolveAssetForTest(assetId)).rejects.toThrow(
      'default provider unavailable'
    )
  })

  it('asks each distinct deploy provider once and survives a throwing deployProviders()', async () => {
    const { tx, assetId } = fixtureDeploy(A141A.C)
    const p2 = new FakeProvider()
    const broken = { ...exampleProfile(), id: 'urn:example:broken', checkExt: undefined }
    ex = { ...exampleProfile(), deployProviders: () => [provider, p2, p2] }
    const profiles = {
      [broken.id]: {
        ...broken,
        deployProviders: () => {
          throw new Error('no deploy providers configured')
        }
      },
      [ex.id]: ex
    }
    await expect(moduleWith({ profiles }).resolveAssetForTest(assetId)).rejects.toThrow(
      'no deploy providers configured'
    )
    expect(provider.calls.admission).toBe(1)
    expect(p2.calls.admission).toBe(1)
    p2.admit(assetId, tx, 0)
    await expect(moduleWith({ profiles }).resolveAssetForTest(assetId)).resolves.toMatchObject({
      assetId
    })
    expect(p2.calls.admission).toBe(2)
  })

  it('a non-canonical cached deploy is a miss, checked by txid hash', async () => {
    const { tx, assetId } = fixtureDeploy(A141A.C)
    provider.admit(assetId, tx, 0)
    for (const cached of [tx.toHex().toUpperCase(), `${tx.toHex()}00`, 'zz']) {
      const shared = new FakeStore()
      await shared.set(deployKey(assetId), cached)
      const before = provider.calls.admission
      await expect(
        moduleWith({ store: shared }).resolveAssetForTest(assetId)
      ).resolves.toMatchObject({ assetId })
      expect(provider.calls.admission).toBe(before + 1)
      expect(await shared.get(deployKey(assetId))).toBe(tx.toHex())
    }
  })

  it('a body with the asset txid whose output is not a deploy fails without falling back', async () => {
    // A transaction whose output 0 is a transfer of another asset: authentic bytes, no deploy.
    const tx = new Transaction()
    tx.addOutput({
      lockingScript: new OneColor().lock(`${'ab'.repeat(32)}_0`, 5n, Array(20).fill(0)),
      satoshis: 1
    })
    const assetId = `${tx.id('hex')}_0`
    const p2 = new FakeProvider()
    p2.admit(assetId, tx, 0)
    ex = { ...exampleProfile(), deployProviders: () => [p2] }
    await store.set(deployKey(assetId), tx.toHex())
    await expect(moduleWith().resolveAssetForTest(assetId)).rejects.toThrow(
      `BRC-207: ${assetId} is not a token deploy`
    )
    expect(p2.calls.admission).toBe(0)
  })

  it('tampered deploy cache is discarded', async () => {
    const { tx: deployTx, assetId } = fixtureDeploy(A141A.C)
    const otherTx = fixtureDeploy(A141A.D).tx
    provider.admit(assetId, deployTx, 0)
    await store.set(deployKey(assetId), otherTx.toHex())
    const module = moduleWith()
    await module.resolveAssetForTest(assetId)
    expect(await store.get(deployKey(assetId))).toBe(deployTx.toHex())
    expect(provider.calls.admission).toBe(1)
  })

  it('a garbage deploy cache entry is discarded, and a store read failure is a cache miss', async () => {
    const { tx, assetId } = fixtureDeploy(A141A.C)
    provider.admit(assetId, tx, 0)
    await store.set(deployKey(assetId), 'not hex')
    await moduleWith().resolveAssetForTest(assetId)
    expect(await store.get(deployKey(assetId))).toBe(tx.toHex())

    const failing = new FakeStore()
    failing.get = async () => {
      throw new Error('disk unavailable')
    }
    await expect(
      moduleWith({ store: failing }).resolveAssetForTest(assetId)
    ).resolves.toMatchObject({ assetId })
  })

  it('memoizes per asset and forgets failures', async () => {
    const { tx, assetId } = fixtureDeploy(A141A.C)
    const module = moduleWith()
    await expect(module.resolveAssetForTest(assetId)).rejects.toThrow(/no admitted deploy/)
    expect(provider.calls.admission).toBe(1)
    provider.admit(assetId, tx, 0)
    const [first, second] = await Promise.all([
      module.resolveAssetForTest(assetId),
      module.resolveAssetForTest(assetId)
    ])
    expect(first).toBe(second)
    expect(provider.calls.admission).toBe(2)
    await module.resolveAssetForTest(assetId)
    expect(provider.calls.admission).toBe(2)
    module.dispose()
    store.clear()
    await module.resolveAssetForTest(assetId)
    expect(provider.calls.admission).toBe(3)
  })

  it('derives sendPolicy and operations from the handlers', async () => {
    const plain = fixtureDeploy(A141A.C)
    provider.admit(plain.assetId, plain.tx, 0)
    const base = await moduleWith().resolveAssetForTest(plain.assetId)
    expect(base.sendPolicy).toBeUndefined()
    expect(base.operations).toBeUndefined()

    const a = { ...exampleProfile(), id: 'urn:example:a', checkExt: undefined }
    const b = { ...exampleProfile(), id: 'urn:example:b', checkExt: undefined }
    const req = {
      'urn:example:a': { params: null, version: 1 },
      'urn:example:b': { params: null, version: 1 }
    }
    const both = payloadDeploy({ req })
    provider.admit(both.assetId, both.tx, 0)
    const resolved = await moduleWith({
      profiles: {
        [a.id]: { ...a, sendPolicy: 'plain-nosend', operations: ['transfer', 'burn'] },
        [b.id]: { ...b, operations: ['transfer', 'mint'] }
      }
    }).resolveAssetForTest(both.assetId)
    expect(resolved.sendPolicy).toBe('plain-nosend')
    expect([...resolved.operations!]).toEqual(['transfer'])
    expect(resolved.handlers.map(({ handler }) => handler.id)).toEqual([a.id, b.id])

    const unrestricted = await moduleWith({
      store: new FakeStore(),
      profiles: { [a.id]: a, [b.id]: b }
    }).resolveAssetForTest(both.assetId)
    expect(unrestricted.sendPolicy).toBeUndefined()
    expect(unrestricted.operations).toBeUndefined()
  })

  it('routes spendability, admission and submit through the single handler provider', async () => {
    const { tx, assetId } = fixtureDeploy(A141A.C)
    const p2 = new FakeProvider()
    ex = { ...exampleProfile(), provider: () => p2 }
    await store.set(deployKey(assetId), tx.toHex())
    const module = moduleWith()
    expect(await module.providerForTest(assetId)).toBe(p2)

    // Receipt: its spendability is asked of p2.
    const { tx: paid, customInstructions } = await tokenPayment(
      new FakeWallet(),
      wallet,
      assetId,
      40n
    )
    p2.admit(assetId, paid, 0)
    const receipt: InternalizeActionArgs = {
      tx: paid.toAtomicBEEF(),
      description: 'Receive tokens',
      outputs: [
        {
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: { basket: assetBasket(assetId, 'value'), customInstructions }
        }
      ]
    }
    const { args: forwarded } = await module.onRequest({
      method: 'internalizeAction',
      args: receipt,
      originator: APP
    })
    // The wallet files what the module forwards: the receipt with its suffix tag.
    await wallet.internalizeAction(forwarded as InternalizeActionArgs)
    expect(p2.calls.spendability).toBe(1)

    // A held output p2 does not list is resubmitted to p2, then the send is submitted to p2.
    const [held] = await holdTokens(wallet, p2, assetId, [60n])
    p2.current.delete(`${held.id('hex')}.0`)
    const recipient = await tokenPayment(wallet, new FakeWallet(), assetId, 100n)
    const funded = (
      await module.onRequest({
        method: 'createAction',
        args: {
          description: 'Send tokens',
          labels: transferPlan(assetId),
          outputs: [
            {
              lockingScript: recipient.tx.outputs[0].lockingScript.toHex(),
              satoshis: 1,
              outputDescription: 'Token payment'
            }
          ],
          options: { randomizeOutputs: false }
        },
        originator: APP
      })
    ).args as CreateActionArgs
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
    const signed = (await module.onResponse(await wallet.signAction(signArgs), {
      method: 'signAction',
      originator: APP,
      action
    })) as SignActionResult
    const sent = Transaction.fromAtomicBEEF(signed.tx!).id('hex')
    expect(p2.submissions).toEqual([
      { topics: [colorTopic(assetId)], txid: held.id('hex') },
      { topics: [colorTopic(assetId)], txid: sent }
    ])
    expect(provider.calls).toEqual({ spendability: 0, admission: 0, submit: 0 })
  })

  it('routes the discovery topic to the default provider and asset topics by provider', async () => {
    const { tx, assetId } = fixtureDeploy(A141A.C)
    const p2 = new FakeProvider()
    ex = { ...exampleProfile(), provider: () => p2 }
    await store.set(deployKey(assetId), tx.toHex())
    const module = moduleWith()
    const plain = await deployAsset(new FakeWallet(), provider, 10n)
    // A deploy transaction that also moves the profiled asset and the plain one.
    const [moved] = await holdTokens(new FakeWallet(), p2, assetId, [5n])
    const batch = new Transaction()
    batch.addOutput({
      lockingScript: new OneColor().lock(null, 1n, Array(20).fill(0)),
      satoshis: 1
    })
    batch.addInput({
      sourceTransaction: moved,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript()
    })
    batch.addOutput({
      lockingScript: new OneColor().lock(plain.assetId, 1n, Array(20).fill(0)),
      satoshis: 1
    })
    await (
      module as unknown as {
        submit: (assetIds: string[], beef: number[], deploy: boolean) => Promise<void>
      }
    ).submit([assetId, plain.assetId], batch.toAtomicBEEF(), true)
    const txid = batch.id('hex')
    expect(provider.submissions).toEqual([
      { topics: ['tm_color', colorTopic(plain.assetId)], txid }
    ])
    expect(p2.submissions).toEqual([{ topics: [colorTopic(assetId)], txid }])
  })

  it('A.146/C04 a successor whose req differs from the deploy fails', async () => {
    const { tx, assetId } = fixtureDeploy(A141A.C)
    provider.admit(assetId, tx, 0)
    const module = moduleWith()
    await expect(
      module.assertConformingTokensForTest([successor(assetId, EMPTY_REQ)])
    ).rejects.toMatchObject({
      name: 'ProfileParamsError',
      message: '[ProfileParamsError] BRC-207: successor requirements differ from the deploy'
    })
    // Repeating the deploy's exact payload (its req and its valid own ext entry) conforms.
    const deployPayload = OneColor.decode(tx.outputs[0].lockingScript).payload
    await expect(
      module.assertConformingTokensForTest([successor(assetId, deployPayload)])
    ).resolves.toBeUndefined()
  })

  it("a successor's own ext entry is checked by its handler, or must be absent", async () => {
    const { tx, assetId } = fixtureDeploy(A141A.C)
    provider.admit(assetId, tx, 0)
    const badExt = encodeStrictCbor({ ext: { [REVISION]: { revision: 'x' } } })
    await expect(
      moduleWith().assertConformingTokensForTest([successor(assetId, badExt)])
    ).rejects.toMatchObject({ name: 'ProfileParamsError' })
    // Without a checkExt hook, a successor's own ext entry must be absent.
    ex = { ...exampleProfile(), checkExt: undefined }
    const noExt = payloadDeploy({ req: { [REVISION]: { params: null, version: 1 } } })
    provider.admit(noExt.assetId, noExt.tx, 0)
    const module = moduleWith({ store: new FakeStore() })
    await expect(
      module.assertConformingTokensForTest([successor(noExt.assetId)])
    ).resolves.toBeUndefined()
    const own = encodeStrictCbor({ ext: { [REVISION]: { revision: 1 } } })
    await expect(
      module.assertConformingTokensForTest([successor(noExt.assetId, own)])
    ).rejects.toThrow(`BRC-207: ${REVISION} defines no own ext entry`)
  })

  it('a successor of a deploy without req conforms only with an absent or empty req', async () => {
    const plain = payloadDeploy({ sym: 'P' })
    provider.admit(plain.assetId, plain.tx, 0)
    const module = moduleWith()
    await expect(
      module.assertConformingTokensForTest([
        successor(plain.assetId),
        successor(plain.assetId, EMPTY_REQ)
      ])
    ).resolves.toBeUndefined()
    const repeated = encodeStrictCbor({ req: { [REVISION]: { params: null, version: 1 } } })
    await expect(
      module.assertConformingTokensForTest([successor(plain.assetId, repeated)])
    ).rejects.toThrow('successor requirements differ from the deploy')
  })

  it('C03 a successor that omits req inherits the deploy policy', async () => {
    const { tx, assetId } = fixtureDeploy(A141A.C)
    provider.admit(assetId, tx, 0)
    await expect(
      moduleWith().assertConformingTokensForTest([successor(assetId)])
    ).resolves.toBeUndefined()
  })

  it('without profiles the 0.1.0 path is untouched', async () => {
    const get = jest.spyOn(store, 'get')
    const module = new TestModule({
      wallet: wallet.asWallet(),
      provider,
      requestTokenAccess: async () => true,
      store
    })
    const { assetId } = await deployAsset(new FakeWallet(), provider, 1000n)
    await holdTokens(wallet, provider, assetId, [7n, 8n])
    const balance = (await balanceOf(module, assetId)) as ListOutputsResult
    expect(balance.totalOutputs).toBe(15)
    expect(provider.calls.admission).toBe(0)
    expect(await module.providerForTest(assetId)).toBe(provider)
    expect(provider.calls.admission).toBe(0)

    const resolved = await module.resolveAssetForTest(assetId)
    expect(provider.calls.admission).toBe(1)
    expect(resolved).toEqual({ assetId, req: new Map(), handlers: [], provider })
    expect(resolved.req.size).toBe(0)
    expect(resolved.handlers).toEqual([])
    expect(resolved.declarationTx).toBeUndefined()
    await module.resolveAssetForTest(assetId)
    expect(provider.calls.admission).toBe(1)
    expect(get).not.toHaveBeenCalled()
    expect(store.writes).toEqual([])

    // The 0.1.0 reader still fails a profiled deploy, with its 0.1.0 message.
    const u = fixtureDeploy(A141A.U)
    provider.admit(u.assetId, u.tx, 0)
    await expect(module.resolveAssetForTest(u.assetId)).rejects.toThrow(
      'BRC-207: the asset requires processing profiles this wallet does not support'
    )
    const missing = fixtureDeploy(A141A.D)
    await expect(module.resolveAssetForTest(missing.assetId)).rejects.toThrow(
      `BRC-207: the overlay has no admitted deploy for ${missing.assetId}`
    )
  })
})
