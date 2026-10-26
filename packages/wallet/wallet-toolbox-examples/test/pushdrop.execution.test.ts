import { Beef, PrivateKey, PushDrop, Script, Transaction } from '@bsv/sdk'
import { mintPushDropToken, redeemPushDropToken, type PushDropArgs } from '../src/pushdrop'

const identityKey = PrivateKey.fromHex('1'.padStart(64, '0')).toPublicKey().toString()
const noSendChange = `${'22'.repeat(32)}.0`

function args(): PushDropArgs {
  return {
    protocolID: [2, 'secure-example'],
    keyID: 'key-1',
    includeSignature: false,
    lockPosition: 'before',
    counterparty: 'self',
    fields: [[1, 2, 3]]
  }
}

function atomicTransaction(lockingScript: Script, satoshis: number): Transaction {
  const transaction = new Transaction()
  transaction.addOutput({ lockingScript, satoshis })
  return transaction
}

describe('PushDrop example execution', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('mints the exact requested output and owns wallet result arrays', async () => {
    const lock = Script.fromASM('OP_TRUE')
    jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue(lock as never)
    jest.spyOn(PushDrop, 'decode').mockReturnValue({
      lockingPublicKey: PrivateKey.fromHex('2'.padStart(64, '0')).toPublicKey(),
      fields: [[1, 2, 3]]
    })
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const returnedChange = [noSendChange]
    const wallet = {
      createAction: jest.fn(async (request: Record<string, unknown>) => {
        const output = (request.outputs as Array<Record<string, unknown>>)[0]
        const transaction = atomicTransaction(
          Script.fromHex(output.lockingScript as string),
          output.satoshis as number
        )
        return {
          tx: transaction.toAtomicBEEF(true),
          txid: transaction.id('hex').toUpperCase(),
          noSendChange: returnedChange
        }
      })
    }

    const token = await mintPushDropToken(
      { identityKey, wallet } as never,
      42,
      args(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
    returnedChange[0] = `${'33'.repeat(32)}.0`

    expect(token).toMatchObject({
      outpoint: `${token.beef.atomicTxid}.0`,
      fromIdentityKey: identityKey,
      satoshis: 42,
      noSendChange: [noSendChange]
    })
    expect(wallet.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'mintPushDropToken',
        labels: ['mintPushDropToken'],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
    )
    expect(console.log).toHaveBeenCalledTimes(1)
  })

  it('rejects incomplete, mismatched, and ambiguous mint results', async () => {
    const lock = Script.fromASM('OP_TRUE')
    jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue(lock as never)
    const transaction = atomicTransaction(lock, 42)
    const options = { noSend: true }
    const setup = (result: Record<string, unknown>) => ({
      identityKey,
      wallet: { createAction: jest.fn(async () => result) }
    })

    await expect(mintPushDropToken(setup({}) as never, 42, args(), options)).rejects.toThrow(
      'did not return the minted token'
    )
    await expect(
      mintPushDropToken(
        setup({ tx: transaction.toAtomicBEEF(true), txid: '11'.repeat(32) }) as never,
        42,
        args(),
        options
      )
    ).rejects.toThrow('transaction ID does not match')

    const duplicate = atomicTransaction(lock, 42)
    duplicate.addOutput({ lockingScript: lock, satoshis: 42 })
    await expect(
      mintPushDropToken(
        setup({ tx: duplicate.toAtomicBEEF(true), txid: duplicate.id('hex') }) as never,
        42,
        args(),
        options
      )
    ).rejects.toThrow('exactly once')
  })

  it('signs the requested redemption input and returns the wallet-signed transaction', async () => {
    const source = atomicTransaction(Script.fromASM('OP_TRUE'), 42)
    const token = {
      args: args(),
      beef: Beef.fromBinary(source.toAtomicBEEF(true)),
      outpoint: `${source.id('hex')}.0`,
      fromIdentityKey: identityKey,
      satoshis: 42,
      noSendChange: [noSendChange]
    }
    const spend = new Transaction()
    spend.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_0')
    })
    spend.addOutput({ lockingScript: Script.fromASM('OP_TRUE'), satoshis: 41 })
    const signableBytes = spend.toAtomicBEEF(true)
    const unlock = {
      sign: jest.fn(async () => Script.fromASM('OP_TRUE')),
      estimateLength: jest.fn(async () => 1)
    }
    jest.spyOn(PushDrop.prototype, 'unlock').mockReturnValue(unlock as never)
    const returnedChange = [`${'44'.repeat(32)}.0`]
    const wallet = {
      createAction: jest.fn(async () => ({
        signableTransaction: { reference: 'pushdrop-reference', tx: signableBytes },
        noSendChange: returnedChange
      })),
      signAction: jest.fn(async (request: Record<string, unknown>) => {
        const signed = Transaction.fromAtomicBEEF(signableBytes)
        const spends = request.spends as Record<string, { unlockingScript: string }>
        signed.inputs[0].unlockingScript = Script.fromHex(spends['0'].unlockingScript) as never
        return { tx: signed.toAtomicBEEF() }
      }),
      abortAction: jest.fn(async () => ({ aborted: true }))
    }

    const result = await redeemPushDropToken(
      { identityKey, wallet } as never,
      token,
      { noSend: true, sendWith: ['11'.repeat(32)] },
      'redeem description',
      ['redeem-label'],
      'token input'
    )
    returnedChange[0] = `${'55'.repeat(32)}.0`

    expect(result.beef.atomicTxid).toBeDefined()
    expect(result.noSendChange).toEqual([`${'44'.repeat(32)}.0`])
    expect(wallet.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: [
          expect.objectContaining({ outpoint: token.outpoint, inputDescription: 'token input' })
        ],
        description: 'redeem description',
        labels: ['redeem-label']
      })
    )
    expect(wallet.signAction).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: 'pushdrop-reference',
        options: {
          acceptDelayedBroadcast: undefined,
          returnTXIDOnly: false,
          noSend: true,
          sendWith: ['11'.repeat(32)]
        }
      })
    )
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('requires a signable result and aborts every failed signing attempt without masking it', async () => {
    const source = atomicTransaction(Script.fromASM('OP_TRUE'), 42)
    const token = {
      args: args(),
      beef: Beef.fromBinary(source.toAtomicBEEF(true)),
      outpoint: `${source.id('hex')}.0`,
      fromIdentityKey: identityKey,
      satoshis: 42
    }
    const missing = {
      createAction: jest.fn(async () => ({})),
      abortAction: jest.fn()
    }
    await expect(
      redeemPushDropToken({ identityKey, wallet: missing } as never, token, { noSend: true })
    ).rejects.toThrow('did not return a signable PushDrop transaction')
    expect(missing.abortAction).not.toHaveBeenCalled()

    const malformed = {
      createAction: jest.fn(async () => ({
        signableTransaction: { reference: 'bad-reference', tx: [1] }
      })),
      abortAction: jest.fn(async () => {
        throw new Error('cleanup failed')
      })
    }
    await expect(
      redeemPushDropToken({ identityKey, wallet: malformed } as never, token, { noSend: true })
    ).rejects.not.toThrow('cleanup failed')
    expect(malformed.abortAction).toHaveBeenCalledWith({ reference: 'bad-reference' })
  })
})
