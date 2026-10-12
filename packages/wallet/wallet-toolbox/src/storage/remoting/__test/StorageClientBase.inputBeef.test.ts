import { BEEF_V1, Beef, Script, Transaction, UnlockingScript, Validation, type WalletInterface } from '@bsv/sdk'
import { StorageClientBase } from '../StorageClientBase'
import { parseJsonRpc, stringifyJsonRpc } from '../BinaryJson'

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

  test('forwards the original bytes when every BEEF entry is required', async () => {
    const required = makeTransaction(1000)
    const beef = new Beef()
    beef.mergeTransaction(required)
    const args = Validation.validateCreateActionArgs({
      description: 'forward already minimal proof data',
      inputs: [
        {
          outpoint: `${required.id('hex')}.0`,
          unlockingScript: '00',
          inputDescription: 'declared minimal input'
        }
      ],
      inputBEEF: beef.toBinary(),
      outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'replacement output' }]
    })
    const originalBytes = args.inputBEEF
    const client = new CapturingStorageClient({} as WalletInterface, 'https://storage.example.test')

    await client.createAction(auth, args)

    const sentArgs = client.calls[0].params[1] as Validation.ValidCreateActionArgs
    expect(sentArgs.inputBEEF).toBeInstanceOf(Uint8Array)
    expect(Array.from(sentArgs.inputBEEF!)).toEqual(Array.from(originalBytes!))
    expect(args.inputBEEF).toBe(originalBytes)
  })

  test('passes inputBEEF that is already bytes through unchanged', async () => {
    const required = makeTransaction(1000)
    const beef = new Beef()
    beef.mergeTransaction(required)
    const args = Validation.validateCreateActionArgs({
      description: 'forward byte proof data',
      inputs: [
        {
          outpoint: `${required.id('hex')}.0`,
          unlockingScript: '00',
          inputDescription: 'declared byte input'
        }
      ],
      inputBEEF: beef.toUint8Array(),
      outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'replacement output' }]
    })
    const client = new CapturingStorageClient({} as WalletInterface, 'https://storage.example.test')

    await client.createAction(auth, args)

    expect(client.calls[0].params[1]).toBe(args)
  })

  test('sends pruned inputBEEF as bytes that negotiated binary JSON tags', async () => {
    const required = makeTransaction(1000)
    const beef = new Beef()
    beef.mergeTransaction(required)
    beef.mergeTransaction(makeTransaction(2000))
    const args = Validation.validateCreateActionArgs({
      description: 'prune and send bytes',
      inputs: [
        {
          outpoint: `${required.id('hex')}.0`,
          unlockingScript: '00',
          inputDescription: 'declared input'
        }
      ],
      inputBEEF: beef.toBinary(),
      outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'replacement output' }]
    })
    const client = new CapturingStorageClient({} as WalletInterface, 'https://storage.example.test')

    await client.createAction(auth, args)

    const sentArgs = client.calls[0].params[1] as Validation.ValidCreateActionArgs
    expect(sentArgs.inputBEEF).toBeInstanceOf(Uint8Array)
    const wire = JSON.parse(stringifyJsonRpc({ params: client.calls[0].params }, true))
    expect(wire.params[1].inputBEEF.$bsvBinary).toBe('base64')
  })

  test('sends no-send expiry inputBEEF as bytes', async () => {
    const required = makeTransaction(1000)
    const beef = new Beef()
    beef.mergeTransaction(required)
    const target = Validation.validateCreateActionArgs({
      description: 'expiry target with proof data',
      inputs: [
        {
          outpoint: `${required.id('hex')}.0`,
          unlockingScript: '00',
          inputDescription: 'declared input'
        }
      ],
      inputBEEF: beef.toBinary(),
      outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'replacement output' }]
    })
    const client = new CapturingStorageClient({} as WalletInterface, 'https://storage.example.test')

    await client.prepareNoSendExpiry(auth, target)
    await client.activateNoSendExpiry(auth, {
      target,
      fundingReference: 'ref',
      fundingTxid: '33'.repeat(32),
      anchorVout: 0
    })

    expect((client.calls[0].params[1] as Validation.ValidCreateActionArgs).inputBEEF).toBeInstanceOf(Uint8Array)
    expect((client.calls[1].params[1] as { target: Validation.ValidCreateActionArgs }).target.inputBEEF).toBeInstanceOf(
      Uint8Array
    )
    expect(target.inputBEEF).not.toBeInstanceOf(Uint8Array)
  })

  test.each([false, true])('preserves a large BEEF request with binary negotiation %s', async binary => {
    const required = makeTransaction(1000)
    required.addOutput({ satoshis: 0, lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${'ff'.repeat(150_000)}`) })
    const beef = new Beef()
    beef.mergeTransaction(required)
    const originalBytes = beef.toBinary()
    const args = Validation.validateCreateActionArgs({
      description: 'forward large proof data',
      inputs: [{ outpoint: `${required.id('hex')}.0`, unlockingScript: '00', inputDescription: 'large input' }],
      inputBEEF: originalBytes,
      outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'replacement output' }]
    })
    const client = new CapturingStorageClient({} as WalletInterface, 'https://storage.example.test')
    await client.createAction(auth, args)
    const envelope = { jsonrpc: '2.0', method: 'createAction', params: client.calls[0].params, id: 1 }
    const wire = stringifyJsonRpc(envelope, binary)
    const decoded = parseJsonRpc(wire, binary).params[1].inputBEEF
    expect(Array.from(decoded)).toEqual(originalBytes)
    expect(args.inputBEEF).toEqual(originalBytes)
    if (binary) {
      expect(JSON.parse(wire).params[1].inputBEEF.$bsvBinary).toBe('base64')
      expect(Buffer.byteLength(wire)).toBeLessThan(Buffer.byteLength(stringifyJsonRpc(envelope, false)) / 2)
    } else {
      expect(JSON.parse(wire).params[1].inputBEEF).toEqual(originalBytes)
    }
  })

  test('preserves BEEF V1 when client-side pruning is required', async () => {
    const required = makeTransaction(1000)
    const beef = new Beef(BEEF_V1)
    beef.mergeTransaction(required)
    beef.mergeTransaction(makeTransaction(2000))
    const args = Validation.validateCreateActionArgs({
      description: 'prune legacy proof data',
      inputs: [
        {
          outpoint: `${required.id('hex')}.0`,
          unlockingScript: '00',
          inputDescription: 'declared legacy input'
        }
      ],
      inputBEEF: beef.toBinary(),
      outputs: [{ satoshis: 1, lockingScript: '51', outputDescription: 'replacement output' }]
    })
    const client = new CapturingStorageClient({} as WalletInterface, 'https://storage.example.test')

    await client.createAction(auth, args)

    const sentArgs = client.calls[0].params[1] as Validation.ValidCreateActionArgs
    expect(Beef.fromBinary(sentArgs.inputBEEF!).version).toBe(BEEF_V1)
  })

  test('rejects malformed inputBEEF before an RPC can be attempted', () => {
    const txid = '22'.repeat(32)
    expect(() =>
      Validation.validateCreateActionArgs({
        description: 'reject malformed proof data',
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
    ).toThrow('complete, exactly framed BEEF envelope')
  })
})

function makeTransaction(satoshis: number): Transaction {
  const transaction = new Transaction()
  transaction.addOutput({ satoshis, lockingScript: Script.fromHex('51') })
  return transaction
}
