import { Beef, Script, Transaction, UnlockingScript, Validation, type WalletInterface } from '@bsv/sdk'
import { StorageClientBase } from '../StorageClientBase'

class CapturingStorageClient extends StorageClientBase {
  calls: Array<{ method: string; params: unknown[] }> = []

  protected async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    this.calls.push({ method, params })
    return {} as T
  }
}

describe('StorageClientBase createAction inputBEEF pruning', () => {
  const auth = { identityKey: `02${'11'.repeat(32)}`, userId: 1 }

  test('sends only declared input transactions and their ancestors', async () => {
    const parent = makeTransaction(1000)
    const required = new Transaction()
    required.addInput({
      sourceTransaction: parent,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript()
    })
    required.addOutput({ satoshis: 900, lockingScript: Script.fromHex('51') })
    const unrelated = makeTransaction(2000)
    const beef = new Beef()
    beef.mergeTransaction(parent)
    beef.mergeTransaction(required)
    beef.mergeTransaction(unrelated)
    const originalInputBEEF = beef.toBinary()
    const args = Validation.validateCreateActionArgs({
      description: 'prune remote input proof data',
      inputs: [
        {
          outpoint: `${required.id('hex')}.0`,
          unlockingScript: '00',
          inputDescription: 'declared remote input'
        }
      ],
      inputBEEF: originalInputBEEF,
      outputs: [{ satoshis: 800, lockingScript: '51', outputDescription: 'replacement output' }]
    })
    const client = new CapturingStorageClient({} as WalletInterface, 'https://storage.example.test')

    await client.createAction(auth, args)

    const sentArgs = client.calls[0].params[1] as Validation.ValidCreateActionArgs
    const sentBeef = Beef.fromBinary(sentArgs.inputBEEF!)
    expect(client.calls[0].method).toBe('createAction')
    expect(sentBeef.findTxid(required.id('hex'))).toBeDefined()
    expect(sentBeef.findTxid(parent.id('hex'))).toBeDefined()
    expect(sentBeef.findTxid(unrelated.id('hex'))).toBeUndefined()
    expect(sentArgs.inputBEEF!.length).toBeLessThan(originalInputBEEF.length)
    expect(args.inputBEEF).toEqual(originalInputBEEF)
  })

  test('omits inputBEEF when the action declares no inputs', async () => {
    const beef = new Beef()
    beef.mergeTransaction(makeTransaction(1000))
    const args = Validation.validateCreateActionArgs({
      description: 'ignore proof data without inputs',
      inputBEEF: beef.toBinary(),
      outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'new output' }]
    })
    const client = new CapturingStorageClient({} as WalletInterface, 'https://storage.example.test')

    await client.createAction(auth, args)

    const sentArgs = client.calls[0].params[1] as Validation.ValidCreateActionArgs
    expect(sentArgs.inputBEEF).toBeUndefined()
    expect(args.inputBEEF).toBeDefined()
  })

  test('forwards malformed inputBEEF so the server preserves its validation error contract', async () => {
    const txid = '22'.repeat(32)
    const args = Validation.validateCreateActionArgs({
      description: 'forward malformed proof data',
      inputs: [
        {
          outpoint: `${txid}.0`,
          unlockingScript: '00',
          inputDescription: 'declared malformed input'
        }
      ],
      inputBEEF: [1, 2, 3],
      outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'replacement output' }]
    })
    const client = new CapturingStorageClient({} as WalletInterface, 'https://storage.example.test')

    await client.createAction(auth, args)

    expect(client.calls[0].params[1]).toBe(args)
  })
})

function makeTransaction(satoshis: number): Transaction {
  const transaction = new Transaction()
  transaction.addOutput({ satoshis, lockingScript: Script.fromHex('51') })
  return transaction
}
