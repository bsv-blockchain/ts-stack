import { Beef, PrivateKey, SignActionResult } from '@bsv/sdk'
import { Setup, Wallet } from '../../out/src'
import { spendP2pkhOutpoint } from '../../examples/spendP2pkhOutpoint'

describe('external P2PKH spend example', () => {
  test('signs the exact supplied input and forwards its unlocking script', async () => {
    const unlockingScript = {
      toHex: () => '473044'
    }
    const input: {
      sourceOutputIndex: number
      unlockingScript: { toHex: () => string }
      unlockingScriptTemplate?: unknown
    } = {
      sourceOutputIndex: 0,
      unlockingScript
    }
    const transaction = {
      inputs: [input],
      sign: jest.fn().mockResolvedValue(undefined)
    }
    const fromBinary = jest.spyOn(Beef, 'fromBinary').mockReturnValue({
      findAtomicTransaction: jest.fn().mockReturnValue(transaction),
      txs: [{ txid: 'atomic-txid' }]
    } as never)
    const unlockingTemplate = { type: 'P2PKH' }
    const getUnlockP2PKH = jest.spyOn(Setup, 'getUnlockP2PKH').mockReturnValue(unlockingTemplate as never)
    const createAction = jest.fn().mockResolvedValue({
      signableTransaction: {
        reference: 'action-reference',
        tx: [1, 2, 3]
      }
    })
    const signed = {
      txid: 'ab'.repeat(32)
    } as SignActionResult
    const signAction = jest.fn().mockResolvedValue(signed)
    const wallet = {
      createAction,
      signAction
    } as unknown as Wallet
    const privateKey = PrivateKey.fromRandom()

    try {
      await expect(
        spendP2pkhOutpoint(wallet, {
          inputBeef: [9, 8, 7],
          outpoint: `${'cd'.repeat(32)}.4`,
          privateKey,
          satoshis: 1200
        })
      ).resolves.toBe(signed)
      expect(createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          inputBEEF: [9, 8, 7],
          inputs: [
            expect.objectContaining({
              outpoint: `${'cd'.repeat(32)}.4`,
              unlockingScriptLength: 108
            })
          ]
        })
      )
      expect(getUnlockP2PKH).toHaveBeenCalledWith(privateKey, 1200)
      expect(input.unlockingScriptTemplate).toBe(unlockingTemplate)
      expect(transaction.sign).toHaveBeenCalledTimes(1)
      expect(signAction).toHaveBeenCalledWith({
        reference: 'action-reference',
        spends: { 0: { unlockingScript: '473044' } },
        options: { acceptDelayedBroadcast: false }
      })
    } finally {
      fromBinary.mockRestore()
      getUnlockP2PKH.mockRestore()
    }
  })
})
