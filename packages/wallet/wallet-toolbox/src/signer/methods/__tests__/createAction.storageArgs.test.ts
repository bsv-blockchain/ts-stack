import { Beef, Script, Transaction, Validation } from '@bsv/sdk'
import { createAction } from '../createAction'
import type { Wallet } from '../../../Wallet'
import { transactionSize } from '../../../storage/methods/utils'

describe('signer createAction storage arguments', () => {
  test('sizes a provided hex unlocking script by its bytes, not its hex characters', async () => {
    const unlockingBytes = 36401
    const unlockingScript = '51'.repeat(unlockingBytes)
    const sourceTransaction = new Transaction()
    sourceTransaction.addOutput({ satoshis: 1000, lockingScript: Script.fromHex('75') })
    const inputBEEF = new Beef()
    inputBEEF.mergeTransaction(sourceTransaction)
    const vargs = Validation.validateCreateActionArgs({
      description: 'spend with a provided unlock',
      inputBEEF: inputBEEF.toBinary(),
      inputs: [
        {
          outpoint: `${sourceTransaction.id('hex')}.0`,
          inputDescription: 'provided unlocking script',
          unlockingScript
        }
      ],
      outputs: [{ lockingScript: '51', satoshis: 900, outputDescription: 'output' }],
      options: { noSend: true }
    })

    const received: Validation.ValidCreateActionArgs[] = []
    const planned = new Error('stop after the storage plan request')
    const wallet = {
      telemetry: { enabled: false },
      actionBatch: { plan: async () => undefined },
      storage: {
        createAction: async (args: Validation.ValidCreateActionArgs) => {
          received.push(args)
          throw planned
        }
      }
    } as unknown as Wallet

    await expect(createAction(wallet, { identityKey: `02${'11'.repeat(32)}`, userId: 1 }, vargs)).rejects.toBe(planned)

    const sent = received[0].inputs[0]
    expect(sent.unlockingScript).toBeUndefined()
    expect(sent.unlockingScriptLength).toBe(unlockingBytes)
    expect(vargs.inputs[0].unlockingScript).toBe(unlockingScript)

    // Storage sizes the transaction it funds and prices from these lengths.
    const signed = new Transaction()
    signed.addInput({
      sourceTXID: sourceTransaction.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: Script.fromHex(unlockingScript)
    })
    signed.addOutput({ satoshis: 900, lockingScript: Script.fromHex('51') })
    expect(
      transactionSize(
        received[0].inputs.map(input => input.unlockingScriptLength),
        received[0].outputs.map(output => output.lockingScript.length / 2)
      )
    ).toBe(signed.toBinary().length)
  })

  test('keeps a sign-later unlockingScriptLength beside a provided unlocking script', async () => {
    const unlockingScriptLength = 107
    const sourceTransaction = new Transaction()
    sourceTransaction.addOutput({ satoshis: 1000, lockingScript: Script.fromHex('75') })
    sourceTransaction.addOutput({ satoshis: 1000, lockingScript: Script.fromHex('75') })
    const inputBEEF = new Beef()
    inputBEEF.mergeTransaction(sourceTransaction)
    const vargs = Validation.validateCreateActionArgs({
      description: 'spend with mixed unlocks',
      inputBEEF: inputBEEF.toBinary(),
      inputs: [
        {
          outpoint: `${sourceTransaction.id('hex')}.0`,
          inputDescription: 'provided unlocking script',
          unlockingScript: '5151'
        },
        {
          outpoint: `${sourceTransaction.id('hex')}.1`,
          inputDescription: 'unlocking script length only',
          unlockingScriptLength
        }
      ],
      outputs: [{ lockingScript: '51', satoshis: 1900, outputDescription: 'output' }],
      options: { noSend: true }
    })

    const received: Validation.ValidCreateActionArgs[] = []
    const planned = new Error('stop after the storage plan request')
    const wallet = {
      telemetry: { enabled: false },
      actionBatch: { plan: async () => undefined },
      storage: {
        createAction: async (args: Validation.ValidCreateActionArgs) => {
          received.push(args)
          throw planned
        }
      }
    } as unknown as Wallet

    await expect(createAction(wallet, { identityKey: `02${'11'.repeat(32)}`, userId: 1 }, vargs)).rejects.toBe(planned)

    expect(received[0].inputs.map(input => input.unlockingScript)).toEqual([undefined, undefined])
    expect(received[0].inputs.map(input => input.unlockingScriptLength)).toEqual([2, unlockingScriptLength])
  })
})
