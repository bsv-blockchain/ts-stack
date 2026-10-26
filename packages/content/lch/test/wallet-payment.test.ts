import { describe, expect, it, jest } from '@jest/globals'
import { LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { createMultipayTransaction } from '../src/index.js'

const identity = (value: number): Uint8Array =>
  Uint8Array.from(new PrivateKey(value).toPublicKey().encode(true) as number[])

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
          payee: identity(2),
          satoshis: 7n,
          derivationPrefix: new Uint8Array(32).fill(3),
          dutyUid: 'recording'
        },
        {
          demandId: new Uint8Array(32).fill(4),
          payee: identity(5),
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
          payee: identity(2),
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
          payee: identity(6),
          satoshis: 5n,
          derivationPrefix: new Uint8Array(32).fill(7),
          dutyUid: 'composition'
        }
      ])
    ).rejects.toThrow(/does not match the Payee Authorization/u)
    expect(createAction).not.toHaveBeenCalled()
  })

  it('rejects ambiguous destinations before crossing the wallet action boundary', async () => {
    const payee = identity(31)
    const publicKey = new PrivateKey(32).toPublicKey().toString()
    const createAction = jest.fn()
    const demands = [1, 2].map(value => ({
      demandId: new Uint8Array(32).fill(value),
      payee,
      satoshis: 7n,
      derivationPrefix: new Uint8Array(32).fill(3),
      dutyUid: `duty-${value}`
    }))
    await expect(
      createMultipayTransaction(
        { getPublicKey: async () => ({ publicKey }), createAction } as never,
        demands,
        { random: length => new Uint8Array(length).fill(4) }
      )
    ).rejects.toThrow(/ambiguous finalized outputs/u)
    expect(createAction).not.toHaveBeenCalled()
  })

  it('rejects malformed finalized wallet bytes without numeric coercion', async () => {
    const publicKeys = [
      new PrivateKey(41).toPublicKey().toString(),
      new PrivateKey(42).toPublicKey().toString()
    ]
    let key = 0
    await expect(
      createMultipayTransaction(
        {
          getPublicKey: async () => ({ publicKey: publicKeys[key++]! }),
          createAction: async () => ({ tx: [256] })
        } as never,
        [1, 2].map(value => ({
          demandId: new Uint8Array(32).fill(value),
          payee: identity(42 + value),
          satoshis: BigInt(value),
          derivationPrefix: new Uint8Array(32).fill(value + 2),
          dutyUid: `duty-${value}`
        })),
        { random: length => new Uint8Array(length).fill(9) }
      )
    ).rejects.toMatchObject({ code: 'ERR_LCH_PAYMENT' })
  })

  it('does not accept inherited wallet result fields', async () => {
    const publicKeys = [
      new PrivateKey(51).toPublicKey().toString(),
      new PrivateKey(52).toPublicKey().toString()
    ]
    const demands = [1, 2].map(value => ({
      demandId: new Uint8Array(32).fill(value),
      payee: identity(52 + value),
      satoshis: BigInt(value),
      derivationPrefix: new Uint8Array(32).fill(value + 2),
      dutyUid: `duty-${value}`
    }))
    let key = 0
    await expect(
      createMultipayTransaction(
        {
          getPublicKey: async () => Object.create({ publicKey: publicKeys[key++]! }),
          createAction: async () => ({ tx: [1] })
        } as never,
        demands
      )
    ).rejects.toMatchObject({ code: 'ERR_LCH_FRAMING' })

    key = 0
    await expect(
      createMultipayTransaction(
        {
          getPublicKey: async () => ({ publicKey: publicKeys[key++]! }),
          createAction: async () => Object.create({ tx: [1] })
        } as never,
        demands
      )
    ).rejects.toMatchObject({ code: 'ERR_LCH_FRAMING' })
  })
})
