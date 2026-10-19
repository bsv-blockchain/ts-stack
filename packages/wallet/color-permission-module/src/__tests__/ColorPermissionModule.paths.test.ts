import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import {
  Beef,
  LockingScript,
  Transaction,
  UnlockingScript,
  type CreateActionArgs,
  type ListOutputsResult
} from '@bsv/sdk'
import { hash160 } from '@bsv/sdk/primitives/Hash'
import { toArray, toHex } from '@bsv/sdk/primitives/utils'
import { OneColor } from '@bsv/templates'
import { ColorPlan, type ColorPlan as Plan } from '../ColorPlan.js'
import { ColorPermissionModule } from '../ColorPermissionModule.js'
import { createColorModule } from '../index.js'
import { assetBasket, COLOR_KEY_ID, colorProtocolID, ISSUE } from '../identifiers.js'
import {
  createModule,
  deployAsset,
  FakeProvider,
  FakeWallet,
  holdTokens,
  remittanceString,
  tokenPayment
} from './fixtures.js'

const APP = 'app.example'

describe('ColorPermissionModule boundaries', () => {
  let wallet: FakeWallet
  let provider: FakeProvider
  let module: ColorPermissionModule
  let assetId: string
  const next = jest.fn(async (args: object) => ({ forwarded: args }))

  beforeEach(async () => {
    wallet = new FakeWallet()
    provider = new FakeProvider()
    module = createModule(wallet, provider)
    assetId = (await deployAsset(new FakeWallet(), provider, 1_000n)).assetId
    next.mockClear()
  })

  function plan(overrides: Partial<Plan> = {}): string[] {
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

  async function createAction(args: Partial<CreateActionArgs>): Promise<CreateActionArgs> {
    return (
      await module.onRequest({
        method: 'createAction',
        args: { description: 'Send tokens', labels: plan(), ...args },
        originator: APP
      })
    ).args as CreateActionArgs
  }

  async function ownedOutput(amount: bigint) {
    const custody = {
      outputIndex: 0,
      assetId,
      derivationPrefix: remittanceString(),
      derivationSuffix: remittanceString(),
      senderIdentityKey: wallet.identityKey
    }
    const { publicKey } = await wallet.getPublicKey({
      protocolID: colorProtocolID(assetId, custody.derivationPrefix, custody.derivationSuffix),
      keyID: COLOR_KEY_ID,
      counterparty: wallet.identityKey,
      forSelf: true
    })
    const lockingScript = new OneColor()
      .lock(assetId, amount, hash160(toArray(publicKey, 'hex')))
      .toHex()
    return { custody, output: { lockingScript, satoshis: 1, outputDescription: 'To myself' } }
  }

  it('is constructed only with its dependencies', () => {
    expect(() => new ColorPermissionModule({} as never)).toThrow('wallet is required')
    expect(() => new ColorPermissionModule({ wallet: wallet.asWallet() } as never)).toThrow(
      'provider is required'
    )
    expect(
      () => new ColorPermissionModule({ wallet: wallet.asWallet(), provider } as never)
    ).toThrow('requestTokenAccess is required')
    expect(
      createColorModule({
        wallet: wallet.asWallet(),
        provider,
        requestTokenAccess: async () => true
      })
    ).toBeInstanceOf(ColorPermissionModule)
  })

  it('passes public key operations and per-asset basket requests through after validation', async () => {
    const protocolID = colorProtocolID(assetId, 'a', 'b')
    await expect(
      module.handleRequest(
        { method: 'getPublicKey', args: { protocolID, keyID: COLOR_KEY_ID }, originator: APP },
        next
      )
    ).resolves.toEqual({ forwarded: { protocolID, keyID: COLOR_KEY_ID } })
    await expect(
      module.handleRequest(
        { method: 'verifySignature', args: { protocolID, keyID: 'other' }, originator: APP },
        next
      )
    ).rejects.toThrow('keyID "color"')
    const relinquish = { basket: assetBasket(assetId, 'value'), output: `${'ab'.repeat(32)}.0` }
    await expect(
      module.handleRequest({ method: 'relinquishOutput', args: relinquish, originator: APP }, next)
    ).resolves.toEqual({ forwarded: relinquish })
    await expect(
      module.handleRequest(
        { method: 'listOutputs', args: { basket: assetBasket(assetId, 'value') }, originator: APP },
        next
      )
    ).resolves.toEqual({ forwarded: { basket: assetBasket(assetId, 'value') } })
    await expect(
      module.handleRequest(
        { method: 'listOutputs', args: { basket: 'p color nonsense here x' }, originator: APP },
        next
      )
    ).rejects.toThrow('unknown p color basket selector')
    await expect(
      module.onRequest({ method: 'listActions', args: { labels: plan() }, originator: APP })
    ).resolves.toEqual({
      args: { labels: plan() }
    })
    await expect(
      module.onRequest({ method: 'relinquishCertificate', args: {}, originator: APP })
    ).rejects.toThrow('not available')
    expect(
      await module.onResponse({ untouched: true }, { method: 'listActions', originator: APP })
    ).toEqual({
      untouched: true
    })
  })

  it('denies reads the user declines and forgets grants on dispose', async () => {
    const answers = [true, false]
    const reader = createModule(wallet, provider, async () => answers.shift()!)
    const read = {
      method: 'listOutputs',
      args: { basket: assetBasket(assetId, 'value') },
      originator: APP
    }
    await expect(reader.handleRequest(read, next)).resolves.toBeDefined()
    await expect(reader.handleRequest(read, next)).resolves.toBeDefined()
    reader.dispose()
    await expect(reader.handleRequest(read, next)).rejects.toThrow(
      'declined the color_access request'
    )
  })

  it('keeps an owned output in its basket with its custody tuple', async () => {
    await holdTokens(wallet, provider, assetId, [50n])
    const { custody, output } = await ownedOutput(50n)
    const funded = await createAction({
      labels: plan({ ownedOutputs: [custody] }),
      outputs: [output]
    })
    expect(funded.outputs![0]).toMatchObject({ basket: assetBasket(assetId, 'value') })
    expect(JSON.parse(funded.outputs![0].customInstructions!)).toMatchObject({
      version: 1,
      assetId,
      derivationPrefix: custody.derivationPrefix
    })
    expect(funded.outputs).toHaveLength(1)
  })

  it.each([
    [
      'explicit inputs',
      async () => ({
        inputs: [
          {
            outpoint: `${'ab'.repeat(32)}.0`,
            unlockingScriptLength: 1,
            inputDescription: 'Explicit input'
          }
        ]
      }),
      'explicit inputs'
    ],
    [
      'plan constraints',
      async () => ({ labels: plan({ changePositions: [{ assetId: null, index: 0 }] }) }),
      'not supported'
    ],
    [
      'a remittance for a missing output',
      async () => ({
        labels: plan({ ownedOutputs: [{ ...(await ownedOutput(5n)).custody, outputIndex: 3 }] })
      }),
      'missing output'
    ],
    [
      'a remittance for a non-token output',
      async () => ({
        labels: plan({ ownedOutputs: [(await ownedOutput(5n)).custody] }),
        outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'Data output' }]
      }),
      'non-token output'
    ],
    [
      'a plain output into a p color basket',
      async () => ({
        outputs: [
          {
            lockingScript: '51',
            satoshis: 1,
            outputDescription: 'Data output',
            basket: assetBasket(assetId, 'value')
          }
        ]
      }),
      'only receive BRC-162'
    ],
    [
      'a token output into a basket without a remittance',
      async () => ({
        outputs: [{ ...(await ownedOutput(5n)).output, basket: assetBasket(assetId, 'value') }]
      }),
      'only outputs in plan.ownedOutputs'
    ],
    [
      'an owned output in the wrong basket',
      async () => {
        const { custody, output } = await ownedOutput(5n)
        return {
          labels: plan({ ownedOutputs: [custody] }),
          outputs: [{ ...output, basket: `p color ${'ee'.repeat(32)}v0` }]
        }
      },
      'wrong p color basket'
    ],
    [
      'issuance',
      async () => ({
        outputs: [
          {
            lockingScript: new OneColor().lock(null, 5n, Array(20).fill(0)).toHex(),
            satoshis: 1,
            outputDescription: 'Deploy'
          }
        ]
      }),
      'issuance is not supported'
    ],
    [
      'authority outputs',
      async () => ({
        outputs: [
          {
            lockingScript: new OneColor().lock(assetId, 0n, Array(20).fill(0)).toHex(),
            satoshis: 1,
            outputDescription: 'Authority'
          }
        ]
      }),
      'authority operations'
    ],
    [
      'an output asset missing from the plan',
      async () => ({
        outputs: [
          {
            lockingScript: new OneColor()
              .lock(`${'ee'.repeat(32)}_0`, 5n, Array(20).fill(0))
              .toHex(),
            satoshis: 1,
            outputDescription: 'Other asset'
          }
        ]
      }),
      'missing from plan.assets'
    ],
    ['a plan asset the action does not use', async () => ({ outputs: [] }), 'does not use']
  ])('rejects %s', async (_name, build, message) => {
    await holdTokens(wallet, provider, assetId, [50n])
    await expect(createAction(await build())).rejects.toThrow(message)
  })

  it('rejects receipts with action labels or a non-final transaction', async () => {
    const { tx, customInstructions } = await tokenPayment(new FakeWallet(), wallet, assetId, 5n)
    provider.admit(assetId, tx, 0)
    const outputs = [
      {
        outputIndex: 0,
        protocol: 'basket insertion' as const,
        insertionRemittance: { basket: assetBasket(assetId, 'value'), customInstructions }
      }
    ]
    await expect(
      module.onRequest({
        method: 'internalizeAction',
        args: { tx: tx.toAtomicBEEF(), outputs, description: 'Receive tokens', labels: plan() },
        originator: APP
      })
    ).rejects.toThrow('no meaning in internalizeAction')
    const nonFinal = new Transaction(1, [], [tx.outputs[0]], 500)
    nonFinal.addInput({
      sourceTransaction: tx,
      sourceOutputIndex: 0,
      sequence: 0,
      unlockingScript: new UnlockingScript()
    })
    await expect(
      module.onRequest({
        method: 'internalizeAction',
        args: { tx: nonFinal.toAtomicBEEF(), outputs, description: 'Receive tokens' },
        originator: APP
      })
    ).rejects.toThrow('non-final')
    await expect(
      module.onRequest({
        method: 'internalizeAction',
        args: {
          tx: tx.toAtomicBEEF(),
          outputs: [
            {
              ...outputs[0],
              insertionRemittance: {
                basket: `p color balance ${'ab'.repeat(32)}v0`,
                customInstructions
              }
            }
          ],
          description: 'Receive tokens'
        },
        originator: APP
      })
    ).rejects.toThrow('per-asset value or authority basket')
  })

  it('accepts a deploy receipt keyed by the ISSUE tuple', async () => {
    const issuer = new FakeWallet()
    const custody = {
      version: 1,
      assetId: ISSUE,
      derivationPrefix: 'p',
      derivationSuffix: 's',
      senderIdentityKey: issuer.identityKey
    }
    const { publicKey } = await issuer.getPublicKey({
      protocolID: colorProtocolID(ISSUE, 'p', 's'),
      keyID: COLOR_KEY_ID,
      counterparty: wallet.identityKey
    })
    const deploy = new Transaction()
    deploy.addOutput({
      lockingScript: new OneColor().lock(null, 9n, hash160(toArray(publicKey, 'hex'))),
      satoshis: 1
    })
    const deployed = `${deploy.id('hex')}_0`
    provider.admit(deployed, deploy, 0)
    await expect(
      module.onRequest({
        method: 'internalizeAction',
        args: {
          tx: deploy.toAtomicBEEF(),
          description: 'Receive a deploy',
          outputs: [
            {
              outputIndex: 0,
              protocol: 'basket insertion',
              insertionRemittance: {
                basket: assetBasket(deployed, 'value'),
                customInstructions: JSON.stringify(custody)
              }
            }
          ]
        },
        originator: APP
      })
    ).resolves.toBeDefined()
  })

  it('pages inventory backwards and returns complete transactions and custody instructions', async () => {
    const [first, second] = await holdTokens(wallet, provider, assetId, [5n, 6n])
    const page = (await module.handleRequest(
      {
        method: 'listOutputs',
        args: {
          basket: 'p color assets',
          include: 'entire transactions',
          includeCustomInstructions: true,
          limit: 1,
          offset: -1
        },
        originator: APP
      },
      next
    )) as ListOutputsResult
    const newest = [first, second].map(tx => `${tx.id('hex')}.0`).sort()[1]
    expect(page.totalOutputs).toBe(2)
    expect(page.outputs.map(output => output.outpoint)).toEqual([newest])
    expect(JSON.parse(page.outputs[0].customInstructions!)).toMatchObject({ assetId })
    expect(page.outputs[0].lockingScript).toBeUndefined()
    expect(Beef.fromBinary(page.BEEF!).findTxid(newest.split('.')[0])).toBeDefined()
  })

  it('leaves outputs of an unsupported asset out of inventory', async () => {
    const text = (value: string): number[] => [0x60 + value.length, ...toArray(value, 'utf8')]
    const profiled = await deployAsset(new FakeWallet(), provider, 10n, [
      0xa1,
      ...text('req'),
      0xa1,
      ...text('x:y'),
      0xf6
    ])
    await holdTokens(wallet, provider, profiled.assetId, [3n])
    await holdTokens(wallet, provider, assetId, [4n])
    const inventory = (await module.handleRequest(
      { method: 'listOutputs', args: { basket: 'p color assets' }, originator: APP },
      next
    )) as ListOutputsResult
    expect(inventory.totalOutputs).toBe(1)
  })

  async function receive(
    customInstructions: string,
    tx: Transaction,
    outputIndex = 0,
    basket = assetBasket(assetId, 'value')
  ) {
    return await module.onRequest({
      method: 'internalizeAction',
      args: {
        tx: tx.toAtomicBEEF(),
        description: 'Receive tokens',
        outputs: [
          {
            outputIndex,
            protocol: 'basket insertion',
            insertionRemittance: { basket, customInstructions }
          }
        ]
      },
      originator: APP
    })
  }

  it('rejects malformed receipt instructions and outputs', async () => {
    const { tx, customInstructions } = await tokenPayment(new FakeWallet(), wallet, assetId, 5n)
    provider.admit(assetId, tx, 0)
    const custody = JSON.parse(customInstructions)
    await expect(
      receive(JSON.stringify({ ...custody, derivationPrefix: 'x'.repeat(1000) }), tx)
    ).rejects.toThrow('exceeds 1000 bytes')
    await expect(
      receive(JSON.stringify({ ...custody, profileData: { 'x:y': {} } }), tx)
    ).rejects.toThrow('does not require')
    await expect(receive(JSON.stringify({ ...custody, assetId: ISSUE }), tx)).rejects.toThrow(
      'different asset'
    )
    await expect(receive(customInstructions, tx, 4)).rejects.toThrow('missing output')
    const data = new Transaction()
    data.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 1 })
    await expect(receive(customInstructions, data)).rejects.toThrow('not a BRC-162 token output')
  })

  it('validates envelope extras, sources, remittances and current spendability before signing', async () => {
    const sender = new FakeWallet()
    const { tx: source, customInstructions } = await tokenPayment(sender, wallet, assetId, 40n)
    const custody = JSON.parse(customInstructions)
    const spend = new Transaction()
    spend.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript()
    })
    const elsewhere = await tokenPayment(sender, new FakeWallet(), assetId, 40n)
    spend.addOutput({ lockingScript: elsewhere.tx.outputs[0].lockingScript, satoshis: 1 })
    const envelope = {
      version: 1,
      tx: Array.from(spend.toAtomicBEEF()),
      inputIndex: 0,
      sighashType: 0x41,
      ownedOutputs: [] as unknown[]
    }
    const request = (extra: object) => ({
      method: 'createSignature',
      originator: APP,
      args: {
        protocolID: colorProtocolID(assetId, custody.derivationPrefix, custody.derivationSuffix),
        keyID: COLOR_KEY_ID,
        counterparty: sender.identityKey,
        data: toArray(JSON.stringify({ ...envelope, ...extra }), 'utf8')
      }
    })
    await expect(
      module.handleRequest({ ...request({}), args: { ...request({}).args, data: undefined } }, next)
    ).rejects.toThrow('envelope is missing')
    await expect(
      module.handleRequest(
        request({ tokenProofs: [{ assetId, subjects: [`${source.id('hex')}.0`], beef: [1] }] }),
        next
      )
    ).rejects.toThrow('token proofs are not supported')
    await expect(
      module.handleRequest(request({ profileData: { 'x:y': {} } }), next)
    ).rejects.toThrow('does not require')
    await expect(module.handleRequest(request({ inputIndex: 1 }), next)).rejects.toThrow(
      'source transaction'
    )
    await expect(module.handleRequest(request({}), next)).rejects.toThrow(
      'not admitted and unspent'
    )
    provider.admit(assetId, source, 0)
    const foreign = { ...custody, outputIndex: 0 }
    delete foreign.version
    await expect(module.handleRequest(request({ ownedOutputs: [foreign] }), next)).rejects.toThrow(
      "not locked to this wallet's p color key"
    )
    await expect(
      module.handleRequest(request({ ownedOutputs: [{ ...foreign, outputIndex: 5 }] }), next)
    ).rejects.toThrow('does not match its output')
    expect(next).not.toHaveBeenCalled()
  })

  it('accepts binary outputs of an asset first deployed as BRC-161 JSON', async () => {
    const pushUtf8 = (text: string): string => {
      const bytes = toArray(text, 'utf8')
      return bytes.length.toString(16).padStart(2, '0') + toHex(bytes)
    }
    const deploy = new Transaction()
    deploy.addOutput({
      lockingScript: LockingScript.fromHex(
        '0063' +
          pushUtf8('ord') +
          '51' +
          pushUtf8('application/bsv-20') +
          '00' +
          pushUtf8('{"p":"bsv-20","op":"deploy+mint","amt":"1000","dec":"0"}') +
          '68' +
          '76a914' +
          '11'.repeat(20) +
          '88ac'
      ),
      satoshis: 1
    })
    const legacyId = `${deploy.id('hex')}_0`
    provider.admit(legacyId, deploy, 0)
    const payment = await tokenPayment(new FakeWallet(), wallet, legacyId, 5n)
    provider.admit(legacyId, payment.tx, 0)
    await expect(
      receive(payment.customInstructions, payment.tx, 0, assetBasket(legacyId, 'value'))
    ).resolves.toEqual({ args: expect.anything() })
  })

  it('rejects assets it cannot authenticate and overlay answers that do not match the wallet', async () => {
    await expect(
      module.handleRequest(
        {
          method: 'listOutputs',
          args: { basket: `p color balance ${'ee'.repeat(32)}v1` },
          originator: APP
        },
        next
      )
    ).rejects.toThrow('legacy nonzero-index assets')
    const unknown = `${'ee'.repeat(32)}_0`
    const missing = await tokenPayment(new FakeWallet(), wallet, unknown, 5n)
    provider.admit(unknown, missing.tx, 0)
    await expect(
      receive(missing.customInstructions, missing.tx, 0, assetBasket(unknown, 'value'))
    ).rejects.toThrow('no admitted deploy')
    const payment = await tokenPayment(new FakeWallet(), wallet, assetId, 5n)
    const notDeployed = `${payment.tx.id('hex')}_0`
    provider.admit(notDeployed, payment.tx, 0)
    const spoof = await tokenPayment(new FakeWallet(), wallet, notDeployed, 5n)
    provider.admit(notDeployed, spoof.tx, 0)
    await expect(
      receive(spoof.customInstructions, spoof.tx, 0, assetBasket(notDeployed, 'value'))
    ).rejects.toThrow('is not a token deploy')
    await holdTokens(wallet, provider, assetId, [50n])
    const misreporting = Object.create(wallet) as FakeWallet
    misreporting.listOutputs = async args => {
      const result = await wallet.listOutputs(args)
      return {
        ...result,
        outputs: result.outputs.map(output => ({ ...output, satoshis: output.satoshis + 1 }))
      }
    }
    const recipient = (await tokenPayment(wallet, new FakeWallet(), assetId, 5n)).tx.outputs[0]
    await expect(
      createModule(misreporting, provider).onRequest({
        method: 'createAction',
        args: {
          description: 'Send tokens',
          labels: plan(),
          outputs: [
            {
              lockingScript: recipient.lockingScript.toHex(),
              satoshis: 1,
              outputDescription: 'Token payment'
            }
          ]
        },
        originator: APP
      })
    ).rejects.toThrow('does not match its source output')
  })

  it('filters inventory on all tags and ignores stored state tags', async () => {
    const [held] = await holdTokens(wallet, provider, assetId, [5n])
    const spoofingWallet = Object.create(wallet) as FakeWallet
    spoofingWallet.listOutputs = async args => {
      const result = await wallet.listOutputs(args)
      return {
        ...result,
        outputs: result.outputs.map(output => ({
          ...output,
          tags: ['color_state_reserved', 'mine']
        }))
      }
    }
    const spoofed = createModule(spoofingWallet, provider)
    const inventory = (await spoofed.handleRequest(
      {
        method: 'listOutputs',
        args: {
          basket: 'p color assets',
          includeTags: true,
          tags: ['mine', 'color_state_available'],
          tagQueryMode: 'all'
        },
        originator: APP
      },
      next
    )) as ListOutputsResult
    expect(inventory.outputs).toEqual([
      {
        outpoint: `${held.id('hex')}.0`,
        satoshis: 1000,
        spendable: true,
        tags: ['mine', 'color_state_available']
      }
    ])
  })
})
