import { CachedKeyDeriver, PrivateKey, WalletInterface } from '@bsv/sdk'
import { createWalletPaymentAction, createWalletPaymentOutput } from '../../examples/walletPayment'

describe('wallet-payment example', () => {
  test('constructs a BRC-29 output for the exact sender and payee', () => {
    const sender = PrivateKey.fromRandom()
    const payee = PrivateKey.fromRandom().toPublicKey().toString()
    const output = createWalletPaymentOutput({
      fromRootKeyHex: sender.toHex(),
      toIdentityKey: payee
    })

    expect(output.senderIdentityKey).toBe(sender.toPublicKey().toString())
    expect(output.derivationPrefix).not.toBe('')
    expect(output.derivationSuffix).not.toBe('')
    expect(output.lockingScript).toMatch(/^[0-9a-f]+$/)
  })

  test('creates one explicit wallet-payment action and returns its remittance data', async () => {
    const sender = PrivateKey.fromRandom()
    const keyDeriver = new CachedKeyDeriver(sender)
    const payee = PrivateKey.fromRandom().toPublicKey().toString()
    const txid = 'ab'.repeat(32)
    const createAction = jest.fn().mockResolvedValue({
      txid,
      tx: [1, 2, 3]
    })
    const wallet = { createAction } as unknown as WalletInterface

    const action = await createWalletPaymentAction({
      keyDeriver,
      outputSatoshis: 42,
      toIdentityKey: payee,
      wallet
    })

    expect(action).toMatchObject({
      atomicBEEF: '010203',
      senderIdentityKey: keyDeriver.identityKey,
      txid,
      vout: 0
    })
    expect(action.derivationPrefix).not.toBe('')
    expect(action.derivationSuffix).not.toBe('')
    expect(action.lockingScript).toMatch(/^[0-9a-f]+$/)
    expect(createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        description: `pay ${payee}`.slice(0, 50),
        outputs: [
          expect.objectContaining({
            basket: 'wallet-payment',
            satoshis: 42
          })
        ],
        options: {
          randomizeOutputs: false,
          signAndProcess: true
        }
      })
    )
  })

  test('rejects invalid amounts and incomplete wallet results', async () => {
    const keyDeriver = new CachedKeyDeriver(PrivateKey.fromRandom())
    const payee = PrivateKey.fromRandom().toPublicKey().toString()
    const wallet = {
      createAction: jest.fn().mockResolvedValue({})
    } as unknown as WalletInterface

    await expect(
      createWalletPaymentAction({
        keyDeriver,
        outputSatoshis: 0,
        toIdentityKey: payee,
        wallet
      })
    ).rejects.toThrow('positive integer')
    await expect(
      createWalletPaymentAction({
        keyDeriver,
        outputSatoshis: 1,
        toIdentityKey: payee,
        wallet
      })
    ).rejects.toThrow('did not return a transaction ID and atomic BEEF')
  })
})
