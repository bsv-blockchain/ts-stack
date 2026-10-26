import { Beef, KeyDeriver, PrivateKey, Script, Transaction } from '@bsv/sdk'
import { ScriptTemplateBRC29, Setup } from '@bsv/wallet-toolbox'
import { inputBRC29, outputBRC29 } from '../src/brc29'
import { inputP2PKH, outputP2PKH } from '../src/p2pkh'

const senderKey = new PrivateKey(11)
const receiverKey = new PrivateKey(12)
const senderIdentity = senderKey.toPublicKey().toString()
const receiverIdentity = receiverKey.toPublicKey().toString()

function createSetup(createResult: Record<string, unknown>) {
  const wallet = {
    createAction: jest.fn(async () => createResult),
    signAction: jest.fn(),
    abortAction: jest.fn(async () => ({ aborted: true })),
    destroy: jest.fn(async () => undefined)
  }
  return {
    chain: 'test',
    rootKey: senderKey,
    keyDeriver: new KeyDeriver(senderKey),
    identityKey: senderIdentity,
    wallet
  }
}

function fakeBeef(): Beef {
  return { toBinary: () => [1] } as unknown as Beef
}

describe('P2PKH and BRC29 example boundaries', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([-1, 1.5, 21e14 + 1])('rejects unsafe P2PKH output amount %p', async satoshis => {
    const setup = createSetup({})
    await expect(outputP2PKH(setup as never, receiverIdentity, satoshis)).rejects.toThrow(
      'non-negative safe integer'
    )
    expect(setup.wallet.createAction).not.toHaveBeenCalled()
  })

  it.each([{}, { tx: [1] }, { txid: 'aa'.repeat(32) }])(
    'requires a complete P2PKH wallet result %#',
    async result => {
      const setup = createSetup(result)
      await expect(outputP2PKH(setup as never, receiverIdentity, 1)).rejects.toThrow(
        'did not return the P2PKH payment'
      )
    }
  )

  it('binds a P2PKH result to the exact wallet transaction output', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const setup = createSetup({})
    setup.wallet.createAction.mockImplementationOnce(async (...callArgs: unknown[]) => {
      const request = callArgs[0] as {
        outputs?: Array<{ lockingScript?: string; satoshis?: number }>
      }
      const output = request.outputs?.[0]
      const transaction = new Transaction()
      transaction.addOutput({
        lockingScript: Script.fromHex(output?.lockingScript ?? ''),
        satoshis: output?.satoshis ?? 0
      })
      return { tx: transaction.toAtomicBEEF(true), txid: transaction.id('hex').toUpperCase() }
    })

    const result = await outputP2PKH(setup as never, receiverIdentity, 42)
    expect(result).toMatchObject({
      outpoint: `${result.beef.atomicTxid}.0`,
      toIdentityKey: receiverIdentity,
      satoshis: 42
    })
  })

  it('requires a signable P2PKH transaction', async () => {
    jest.spyOn(Setup, 'getEnv').mockReturnValue({
      devKeys: { [receiverIdentity]: receiverKey.toString() }
    } as never)
    const setup = createSetup({})
    await expect(
      inputP2PKH(setup as never, {
        beef: fakeBeef(),
        outpoint: `${'aa'.repeat(32)}.0`,
        toIdentityKey: receiverIdentity,
        satoshis: 1
      })
    ).rejects.toThrow('did not return a signable P2PKH transaction')
    expect(setup.wallet.abortAction).not.toHaveBeenCalled()
  })

  it('aborts a malformed signable P2PKH transaction and preserves the parse failure', async () => {
    jest.spyOn(Setup, 'getEnv').mockReturnValue({
      devKeys: { [receiverIdentity]: receiverKey.toString() }
    } as never)
    const setup = createSetup({ signableTransaction: { reference: 'p2pkh-ref', tx: [1] } })
    setup.wallet.abortAction.mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(
      inputP2PKH(setup as never, {
        beef: fakeBeef(),
        outpoint: `${'aa'.repeat(32)}.0`,
        toIdentityKey: receiverIdentity,
        satoshis: 1
      })
    ).rejects.not.toThrow('cleanup failed')
    expect(setup.wallet.abortAction).toHaveBeenCalledWith({ reference: 'p2pkh-ref' })
  })

  it('signs the exact requested P2PKH input and accepts only the identical wallet result', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(Setup, 'getEnv').mockReturnValue({
      devKeys: { [receiverIdentity]: receiverKey.toString() }
    } as never)
    jest.spyOn(Setup, 'getUnlockP2PKH').mockReturnValue({
      sign: async () => Script.fromASM('OP_TRUE'),
      estimateLength: async () => 1
    } as never)
    const source = new Transaction()
    source.addOutput({ lockingScript: Script.fromASM('OP_TRUE'), satoshis: 42 })
    const spend = new Transaction()
    spend.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_0')
    })
    spend.addOutput({ lockingScript: Script.fromASM('OP_TRUE'), satoshis: 41 })
    const signable = spend.toAtomicBEEF(true)
    const setup = createSetup({ signableTransaction: { reference: 'p2pkh-ref', tx: signable } })
    setup.wallet.signAction.mockImplementationOnce(async request => {
      const signed = Transaction.fromAtomicBEEF(signable)
      const spends = request.spends ?? {}
      signed.inputs[0].unlockingScript = Script.fromHex(spends[0]?.unlockingScript ?? '') as never
      return { tx: signed.toAtomicBEEF() }
    })

    await expect(
      inputP2PKH(setup as never, {
        beef: Beef.fromBinary(source.toAtomicBEEF(true)),
        outpoint: `${source.id('hex')}.0`,
        toIdentityKey: receiverIdentity,
        satoshis: 42
      })
    ).resolves.toBeUndefined()
    expect(setup.wallet.abortAction).not.toHaveBeenCalled()
  })

  it.each([-1, 1.5, 21e14 + 1])('rejects unsafe BRC29 output amount %p', async satoshis => {
    const setup = createSetup({})
    await expect(outputBRC29(setup as never, receiverIdentity, satoshis)).rejects.toThrow(
      'non-negative safe integer'
    )
    expect(setup.wallet.createAction).not.toHaveBeenCalled()
  })

  it.each([{}, { tx: [1] }, { txid: 'aa'.repeat(32) }])(
    'requires a complete BRC29 wallet result %#',
    async result => {
      const setup = createSetup(result)
      await expect(outputBRC29(setup as never, receiverIdentity, 1)).rejects.toThrow(
        'did not return the BRC29 payment'
      )
    }
  )

  it('binds a BRC29 result to the exact wallet transaction output', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const setup = createSetup({})
    setup.wallet.createAction.mockImplementationOnce(async (...callArgs: unknown[]) => {
      const request = callArgs[0] as {
        outputs?: Array<{ lockingScript?: string; satoshis?: number }>
      }
      const output = request.outputs?.[0]
      const transaction = new Transaction()
      transaction.addOutput({
        lockingScript: Script.fromHex(output?.lockingScript ?? ''),
        satoshis: output?.satoshis ?? 0
      })
      return { tx: transaction.toAtomicBEEF(true), txid: transaction.id('hex').toUpperCase() }
    })

    const result = await outputBRC29(setup as never, receiverIdentity, 42)
    expect(result).toMatchObject({
      outpoint: `${result.beef.atomicTxid}.0`,
      fromIdentityKey: senderIdentity,
      satoshis: 42
    })
  })

  it('requires a signable BRC29 transaction', async () => {
    const setup = createSetup({})
    await expect(
      inputBRC29(setup as never, {
        beef: fakeBeef(),
        outpoint: `${'aa'.repeat(32)}.0`,
        fromIdentityKey: receiverIdentity,
        satoshis: 1,
        derivationPrefix: 'AQIDBAUGBwg=',
        derivationSuffix: 'CAcGBQQDAgE='
      })
    ).rejects.toThrow('did not return a signable BRC29 transaction')
    expect(setup.wallet.abortAction).not.toHaveBeenCalled()
  })

  it('aborts a malformed signable BRC29 transaction and preserves the parse failure', async () => {
    const setup = createSetup({ signableTransaction: { reference: 'brc29-ref', tx: [1] } })
    setup.wallet.abortAction.mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(
      inputBRC29(setup as never, {
        beef: fakeBeef(),
        outpoint: `${'aa'.repeat(32)}.0`,
        fromIdentityKey: receiverIdentity,
        satoshis: 1,
        derivationPrefix: 'AQIDBAUGBwg=',
        derivationSuffix: 'CAcGBQQDAgE='
      })
    ).rejects.not.toThrow('cleanup failed')
    expect(setup.wallet.abortAction).toHaveBeenCalledWith({ reference: 'brc29-ref' })
  })

  it('signs the exact requested BRC29 input and accepts only the identical wallet result', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(ScriptTemplateBRC29.prototype, 'unlock').mockReturnValue({
      sign: async () => Script.fromASM('OP_TRUE'),
      estimateLength: async () => 1
    } as never)
    const source = new Transaction()
    source.addOutput({ lockingScript: Script.fromASM('OP_TRUE'), satoshis: 42 })
    const spend = new Transaction()
    spend.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_0')
    })
    spend.addOutput({ lockingScript: Script.fromASM('OP_TRUE'), satoshis: 41 })
    const signable = spend.toAtomicBEEF(true)
    const setup = createSetup({ signableTransaction: { reference: 'brc29-ref', tx: signable } })
    setup.wallet.signAction.mockImplementationOnce(async request => {
      const signed = Transaction.fromAtomicBEEF(signable)
      const spends = request.spends ?? {}
      signed.inputs[0].unlockingScript = Script.fromHex(spends[0]?.unlockingScript ?? '') as never
      return { tx: signed.toAtomicBEEF() }
    })

    await expect(
      inputBRC29(setup as never, {
        beef: Beef.fromBinary(source.toAtomicBEEF(true)),
        outpoint: `${source.id('hex')}.0`,
        fromIdentityKey: senderIdentity,
        satoshis: 42,
        derivationPrefix: 'AQIDBAUGBwg=',
        derivationSuffix: 'CAcGBQQDAgE='
      })
    ).resolves.toBeUndefined()
    expect(setup.wallet.abortAction).not.toHaveBeenCalled()
  })
})
