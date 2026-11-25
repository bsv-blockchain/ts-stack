import { describe, expect, it, jest } from '@jest/globals'
import {
  HTTPSOverlayLookupFacilitator,
  LockingScript,
  OP,
  PrivateKey,
  ProtoWallet,
  Spend,
  TopicBroadcaster,
  Transaction,
  UnlockingScript
} from '@bsv/sdk'
import type { CreateActionArgs, SignActionArgs, WalletInterface } from '@bsv/sdk'
import { AppCatalog } from './index.js'
import type { PublishedAppMetadata } from './types/index.js'

describe('AppCatalog lifecycle with SDK 4', () => {
  it('publishes, reads, replaces and removes a canonical app token', async () => {
    const identity = new ProtoWallet(new PrivateKey(7))
    const funding = new Transaction()
    funding.addOutput({ satoshis: 20, lockingScript: new LockingScript([{ op: OP.OP_TRUE }]) })
    let pending: Transaction | undefined
    const broadcast = jest
      .spyOn(TopicBroadcaster.prototype, 'broadcast')
      .mockImplementation(async tx => ({
        status: 'success',
        txid: tx.id('hex'),
        message: 'fixture accepted'
      }))

    const wallet = {
      getPublicKey: identity.getPublicKey.bind(identity),
      createSignature: identity.createSignature.bind(identity),
      async createAction(args: CreateActionArgs) {
        const previous = args.inputBEEF ? Transaction.fromBEEF(args.inputBEEF) : funding
        const tx = new Transaction()
        tx.addInput({
          sourceTransaction: previous,
          sourceOutputIndex: 0,
          sequence: 0xffffffff,
          unlockingScript: new UnlockingScript()
        })
        for (const output of args.outputs ?? []) {
          tx.addOutput({
            satoshis: output.satoshis,
            lockingScript: LockingScript.fromHex(output.lockingScript)
          })
        }
        if (args.inputs?.length) {
          expect(args.inputs[0].outpoint).toBe(`${previous.id('hex')}.0`)
          pending = tx
          return { signableTransaction: { tx: tx.toBEEF(), reference: 'fixture' } }
        }
        return { tx: tx.toAtomicBEEF() }
      },
      async signAction(args: SignActionArgs) {
        expect(args.reference).toBe('fixture')
        const tx = pending as Transaction
        const input = tx.inputs[0]
        const source = input.sourceTransaction as Transaction
        const unlockingScript = UnlockingScript.fromHex(args.spends[0].unlockingScript)
        expect(
          new Spend({
            sourceTXID: source.id('hex'),
            sourceOutputIndex: 0,
            sourceSatoshis: source.outputs[0].satoshis as number,
            lockingScript: source.outputs[0].lockingScript,
            transactionVersion: tx.version,
            otherInputs: [],
            outputs: tx.outputs,
            inputIndex: 0,
            unlockingScript,
            inputSequence: 0xffffffff,
            lockTime: tx.lockTime
          }).validate()
        ).toBe(true)
        input.unlockingScript = unlockingScript
        pending = undefined
        return { tx: tx.toAtomicBEEF() }
      }
    } as unknown as WalletInterface
    const catalog = new AppCatalog({ wallet, networkPreset: 'local' })
    const metadata: PublishedAppMetadata = {
      version: '0.1.0',
      name: 'Fixture app',
      description: 'Offline lifecycle fixture',
      icon: 'https://example.com/icon.png',
      domain: 'example.com',
      httpURL: 'https://example.com',
      release_date: '2026-11-22T00:00:00Z'
    }
    const findToken = async (tx: Transaction) => {
      const apps = await catalog.findApps(
        {},
        {
          hosts: ['https://overlay.example'],
          facilitator: new HTTPSOverlayLookupFacilitator(async (url, request) => {
            expect(String(url)).toBe('https://overlay.example/lookup')
            expect(request?.method).toBe('POST')
            expect(JSON.parse(String(request?.body))).toEqual({
              service: 'ls_apps',
              query: {}
            })
            return new Response(
              JSON.stringify({
                type: 'output-list',
                outputs: [{ beef: tx.toBEEF(), outputIndex: 0 }]
              }),
              { headers: { 'Content-Type': 'application/json' } }
            )
          })
        }
      )
      expect(apps).toHaveLength(1)
      expect(apps[0].metadata.publisher).toBe(
        (await identity.getPublicKey({ identityKey: true })).publicKey
      )
      expect(apps[0].token.txid).toBe(tx.id('hex'))
      return apps[0]
    }

    try {
      await expect(catalog.publishApp({ ...metadata })).resolves.toMatchObject({
        status: 'success'
      })
      const original = await findToken(broadcast.mock.calls[0][0])
      expect(original.metadata.name).toBe(metadata.name)
      await expect(
        catalog.updateApp(original, { ...metadata, name: 'Updated app' })
      ).resolves.toMatchObject({ status: 'success' })
      const replacement = await findToken(broadcast.mock.calls[1][0])
      expect(replacement.metadata.name).toBe('Updated app')
      const result = await catalog.removeApp(replacement)
      expect(result.status).toBe('success')
      expect(broadcast.mock.calls[2][0].outputs).toHaveLength(0)
    } finally {
      broadcast.mockRestore()
    }
  })
})
