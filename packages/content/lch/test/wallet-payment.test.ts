import { describe, expect, it, jest } from '@jest/globals'
import { LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { createMultipayTransaction } from '../src/index.js'

describe('wallet multilateral payment integration', () => {
  it('finds Demand outputs after the wallet changes their order', async () => {
    const publicKeys = [
      new PrivateKey(11).toPublicKey().toString(),
      new PrivateKey(12).toPublicKey().toString()
    ]
    let key = 0
    const getPublicKey = jest.fn(async () => ({ publicKey: publicKeys[key++] }))
    const createAction = jest.fn(
      async (args: { outputs: Array<{ satoshis: number; lockingScript: string }> }) => {
        const reordered = [args.outputs[1], { satoshis: 1, lockingScript: '51' }, args.outputs[0]]
        const transaction = new Transaction(
          1,
          [],
          reordered.map(output => ({
            satoshis: output.satoshis,
            lockingScript: LockingScript.fromHex(output.lockingScript)
          }))
        )
        return { tx: transaction.toAtomicBEEF(true) }
      }
    )
    const result = await createMultipayTransaction(
      { getPublicKey, createAction } as never,
      [
        {
          demandId: new Uint8Array(32).fill(1),
          payee: new Uint8Array(33).fill(2),
          satoshis: 7n,
          derivationPrefix: new Uint8Array(32).fill(3),
          dutyUid: 'recording'
        },
        {
          demandId: new Uint8Array(32).fill(4),
          payee: new Uint8Array(33).fill(5),
          satoshis: 5n,
          derivationPrefix: new Uint8Array(32).fill(6),
          dutyUid: 'composition'
        }
      ],
      { random: length => new Uint8Array(length).fill(8) }
    )
    expect(result.remittances.map(item => item.outputIndex)).toEqual([2, 0])
    expect(createAction.mock.calls[0][0]).not.toHaveProperty('options.randomizeOutputs')
  })

  it('rejects a Payee-authorized script mismatch before creating a wallet action', async () => {
    const publicKeys = [new PrivateKey(21).toPublicKey(), new PrivateKey(22).toPublicKey()]
    let key = 0
    const getPublicKey = jest.fn(async () => ({ publicKey: publicKeys[key++]!.toString() }))
    const createAction = jest.fn()
    await expect(
      createMultipayTransaction({ getPublicKey, createAction } as never, [
        {
          demandId: new Uint8Array(32).fill(1),
          payee: new Uint8Array(33).fill(2),
          satoshis: 7n,
          derivationPrefix: new Uint8Array(32).fill(3),
          dutyUid: 'recording',
          authorizedOutput: {
            derivationSuffix: new Uint8Array(32).fill(4),
            lockingScript: new P2PKH().lock(publicKeys[1]!.toAddress()).toUint8Array()
          }
        },
        {
          demandId: new Uint8Array(32).fill(5),
          payee: new Uint8Array(33).fill(6),
          satoshis: 5n,
          derivationPrefix: new Uint8Array(32).fill(7),
          dutyUid: 'composition'
        }
      ])
    ).rejects.toThrow(/does not match the Payee Authorization/u)
    expect(createAction).not.toHaveBeenCalled()
  })
})
