import { Beef, InternalizeOutput } from '@bsv/sdk'
import { sdk } from '../../../src/index.all'
import { _tu, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'

describe('internalizeAction operator coverage', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnvFlags('test')
  const ctxs: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('internalizeActionTests'))
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('internalizeActionTests'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  test('internalizes a real basket insertion', async () => {
    for (const { wallet, activeStorage: storage } of ctxs) {
      const txid = 'a3b2f0935c7b5bb7a841a09e535c13be86f4df0e7a91cebdc33812bfcc0eb9d7'
      const options: sdk.StorageGetBeefOptions = { ignoreServices: true }
      const beef = await storage.getBeefForTransaction(txid, options)

      expect(beef.txs).not.toHaveLength(0)
      expect(beef.txs[0].isValid).toBe(true)
      expect(beef.atomicTxid).toBeUndefined()

      const atomicTx = beef.toBinaryAtomic(txid)
      expect(Beef.fromBinary(atomicTx).atomicTxid).toBe(txid)

      const output: InternalizeOutput = {
        outputIndex: 0,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: 'babbage-token-access',
          tags: [
            'babbage_originator todo.babbage.systems',
            'babbage_action_originator projectbabbage.com',
            'babbage_protocolname todo list',
            'babbage_protocolsecuritylevel 2',
            'babbage_counterparty self'
          ]
        }
      }

      const result = await wallet.internalizeAction({
        tx: atomicTx,
        outputs: [output],
        description: 'Default basket insertion'
      })
      expect(result).toBeDefined()
    }
  })
})
