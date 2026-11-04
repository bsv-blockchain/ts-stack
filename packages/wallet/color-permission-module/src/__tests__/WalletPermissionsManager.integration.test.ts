import { describe, expect, it } from '@jest/globals'
import { createServer } from 'node:http'
import {
  Beef,
  Transaction,
  WalletClient,
  WalletWireProcessor,
  WalletWireTransceiver,
  HTTPWalletJSON,
  type CreateActionArgs
} from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { maybeDecryptMetadata, WalletPermissionsManager } from '@bsv/wallet-toolbox-client'
import { ColorPermissionModule } from '../ColorPermissionModule.js'
import { ColorPlan } from '../ColorPlan.js'
import { assetBasket, assetTag } from '../identifiers.js'
import {
  createModule,
  deployAsset,
  FakeProvider,
  FakeWallet,
  holdTokens,
  suffixTagOf,
  tokenPayment,
  validInput
} from './fixtures.js'
import { FakeStore, issuerLikePayload, issuerLikeProfile } from './profileFixtures.js'

const ADMIN = 'admin.example'
const APP = 'app.example'

describe('color module registered on a WalletPermissionsManager', () => {
  it.each([
    { name: 'ordinary', amounts: [180n] },
    { name: 'rounded above 2^53', amounts: [2n ** 53n, 1n] },
    { name: 'above the binary uint64 limit', amounts: [2n ** 63n - 1n, 2n ** 63n - 1n, 3n] }
  ])('preserves numeric $name balances through the manager and transports', async ({ amounts }) => {
    const wallet = new FakeWallet()
    const provider = new FakeProvider()
    const color = createModule(wallet, provider, async () => true)
    const manager = new WalletPermissionsManager(wallet.asWallet(), ADMIN, {
      permissionModules: { color },
      seekSpendingPermissions: false
    })
    const { assetId } = await deployAsset(new FakeWallet(), provider, 1_000n)
    await holdTokens(wallet, provider, assetId, amounts)
    const args = { basket: `p color balance ${assetTag(assetId)}` }
    const expected = {
      totalOutputs: Number(amounts.reduce((sum, amount) => sum + amount, 0n)),
      outputs: []
    }
    const validated = new WalletClient(manager, APP)
    await expect(validated.listOutputs(args)).resolves.toEqual(expected)
    const wire = new WalletClient(new WalletWireTransceiver(new WalletWireProcessor(manager)), APP)
    if (expected.totalOutputs >= 2 ** 64) {
      await expect(wire.listOutputs(args)).rejects.toThrow('below 2^64')
    } else {
      await expect(wire.listOutputs(args)).resolves.toEqual(expected)
    }
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const result = await validated.listOutputs(JSON.parse(Buffer.concat(chunks).toString()))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ isError: true, message: 'Invalid wallet request', code: 1 }))
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Missing test listener')
      const json = new WalletClient(new HTTPWalletJSON(APP, `http://127.0.0.1:${address.port}`))
      await expect(json.listOutputs(args)).resolves.toEqual(expected)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    }
  })

  it('receives tokens, then sends them in one createAction signed through the signAction hook', async () => {
    const wallet = new FakeWallet()
    const provider = new FakeProvider()
    const prompts: string[] = []
    const color = createModule(wallet, provider, async (_app, message) => {
      prompts.push(JSON.parse(message).type)
      return true
    })
    const manager = new WalletPermissionsManager(wallet.asWallet(), ADMIN, {
      permissionModules: { color },
      seekSpendingPermissions: false,
      encryptWalletMetadata: true
    })
    const { assetId } = await deployAsset(new FakeWallet(), provider, 1_000n)

    const { tx: receipt, customInstructions } = await tokenPayment(
      new FakeWallet(),
      wallet,
      assetId,
      300n
    )
    provider.admit(assetId, receipt, 0)
    await manager.internalizeAction(
      {
        tx: receipt.toAtomicBEEF(),
        description: 'Receive tokens',
        outputs: [
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: { basket: assetBasket(assetId, 'value'), customInstructions }
          }
        ]
      },
      APP
    )
    // The manager stores the receipt's custody tuple encrypted; color decrypts it to sign.
    expect(wallet.outputs.get(`${receipt.id('hex')}.0`)?.customInstructions).not.toBe(
      customInstructions
    )

    const recipient = (await tokenPayment(wallet, new FakeWallet(), assetId, 120n)).tx.outputs[0]
    // The base wallet requires every input's source transaction in inputBEEF, as wallet-toolbox does.
    const received: CreateActionArgs[] = []
    const createAction = wallet.createAction.bind(wallet)
    wallet.createAction = async args => {
      received.push(args)
      return await createAction(args)
    }
    const sent = await manager.createAction(
      {
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
        outputs: [
          {
            lockingScript: recipient.lockingScript.toHex(),
            satoshis: 1,
            outputDescription: 'Token payment'
          }
        ],
        options: { randomizeOutputs: false }
      },
      APP
    )

    const tx = Transaction.fromAtomicBEEF(sent.tx!)
    expect(sent.signableTransaction).toBeUndefined()
    expect(validInput(tx, 0)).toBe(true)
    // The module supplied the selected input's transaction, with its source, and nothing else.
    expect(received).toHaveLength(1)
    expect(received[0].inputs?.map(input => input.outpoint)).toEqual([`${receipt.id('hex')}.0`])
    expect(
      Beef.fromBinary(received[0].inputBEEF!)
        .txs.map(beefTx => beefTx.txid)
        .sort()
    ).toEqual([receipt.id('hex'), receipt.inputs[0].sourceTransaction!.id('hex')].sort())
    expect(tx.outputs.map(output => OneColor.decode(output.lockingScript).amount)).toEqual([
      120n,
      180n
    ])
    expect(provider.submissions.map(submission => submission.txid)).toEqual([tx.id('hex')])
    expect(prompts).toEqual(['color_send'])
    // The manager encrypts the change custody tuple the module adds.
    const change = wallet.outputs.get(`${tx.id('hex')}.1`)?.customInstructions ?? ''
    expect(change.startsWith('{')).toBe(false)
    expect(JSON.parse(await maybeDecryptMetadata(wallet.asWallet(), change))).toMatchObject({
      version: 1,
      assetId
    })
    await expect(
      manager.listOutputs({ basket: `p color balance ${assetTag(assetId)}` }, APP)
    ).resolves.toEqual({ totalOutputs: 180, outputs: [] })
    expect((await manager.getVersion({}, APP)).version).toContain('brc207-color=4')
  })

  it('aborts a declined send, so the inputs it reserved are spendable again', async () => {
    const wallet = new FakeWallet()
    const provider = new FakeProvider()
    // Declines the send; the balance read afterwards is approved.
    const color = createModule(
      wallet,
      provider,
      async (_app, message) => JSON.parse(message).type !== 'color_send'
    )
    const manager = new WalletPermissionsManager(wallet.asWallet(), ADMIN, {
      permissionModules: { color },
      seekSpendingPermissions: false,
      encryptWalletMetadata: true
    })
    const { assetId } = await deployAsset(new FakeWallet(), provider, 1_000n)
    const [held] = await holdTokens(wallet, provider, assetId, [300n])
    const recipient = (await tokenPayment(wallet, new FakeWallet(), assetId, 120n)).tx.outputs[0]
    await expect(
      manager.createAction(
        {
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
          outputs: [
            {
              lockingScript: recipient.lockingScript.toHex(),
              satoshis: 1,
              outputDescription: 'Token payment'
            }
          ],
          options: { randomizeOutputs: false }
        },
        APP
      )
    ).rejects.toThrow('declined the color_send request')
    expect(provider.submissions).toEqual([])
    expect(wallet.pending.size).toBe(0)
    expect(wallet.outputs.get(`${held.id('hex')}.0`)).toMatchObject({
      spent: false,
      reservedBy: undefined
    })
    await expect(
      manager.listOutputs({ basket: `p color balance ${assetTag(assetId)}` }, APP)
    ).resolves.toEqual({ totalOutputs: 300, outputs: [] })
  })

  it('a pending profile receipt passes through WalletPermissionsManager tagged color_offline', async () => {
    const wallet = new FakeWallet()
    const issuer = new FakeWallet()
    const provider = new FakeProvider()
    const store = new FakeStore()
    const handler = issuerLikeProfile({
      K: issuer.identityKey,
      admit: async () => ({ credit: 'pending' })
    })
    const color = new ColorPermissionModule({
      wallet: wallet.asWallet(),
      provider,
      requestTokenAccess: async () => true,
      profiles: { [handler.id]: handler },
      store
    })
    const manager = new WalletPermissionsManager(wallet.asWallet(), ADMIN, {
      permissionModules: { color },
      seekSpendingPermissions: false,
      encryptWalletMetadata: true
    })
    const { assetId } = await deployAsset(
      issuer,
      provider,
      1_000n,
      issuerLikePayload(issuer.identityKey)
    )
    const { tx, customInstructions } = await tokenPayment(issuer, wallet, assetId, 300n)
    await expect(
      manager.internalizeAction(
        {
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
        APP
      )
    ).resolves.toMatchObject({ accepted: true })
    const stored = wallet.outputs.get(`${tx.id('hex')}.0`)
    expect(stored?.tags).toEqual([suffixTagOf(customInstructions), 'color_offline'])
    expect(stored?.customInstructions?.startsWith('{')).toBe(false)
    expect(await maybeDecryptMetadata(wallet.asWallet(), stored?.customInstructions ?? '')).toBe(
      customInstructions
    )
    await expect(
      manager.listOutputs(
        { basket: `p color balance ${assetTag(assetId)}`, tags: ['color_offline'] },
        APP
      )
    ).resolves.toEqual({ totalOutputs: 300, outputs: [] })
    await color.markSettled(tx.id('hex'))
    await expect(
      manager.listOutputs(
        { basket: `p color balance ${assetTag(assetId)}`, tags: ['color_offline'] },
        APP
      )
    ).resolves.toEqual({ totalOutputs: 0, outputs: [] })
  })
})
