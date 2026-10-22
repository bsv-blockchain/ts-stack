import { Beef, CreateActionArgs } from '@bsv/sdk'
import { _tu, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'

/**
 * A caller may name an input the wallet already knows, with
 * unlockingScriptLength and no inputBEEF (trustSelf 'known'). The signable
 * transaction must still carry that input's source transaction.
 */
describe('createAction known input without inputBEEF', () => {
  jest.setTimeout(99999999)

  const testName = () => expect.getState().currentTestName || 'test'
  let ctxs: TestWalletNoSetup[]

  beforeEach(async () => {
    ctxs = [await _tu.createLegacyWalletSQLiteCopy(`${testName()}`)]
    _tu.mockPostServicesAsSuccess(ctxs)
  })

  afterEach(async () => {
    for (const ctx of ctxs) await ctx.storage.destroy()
  })

  test('0_signableTransaction carries the source transaction of a named wallet input', async () => {
    for (const { wallet } of ctxs) {
      const lo = await wallet.listOutputs({ basket: 'tokens', limit: 1 })
      expect(lo.outputs).toHaveLength(1)
      const outpoint = lo.outputs[0].outpoint
      const [txid] = outpoint.split('.')

      const createArgs: CreateActionArgs = {
        description: 'spend known input',
        inputs: [{ outpoint, inputDescription: 'known input', unlockingScriptLength: 108 }],
        outputs: [
          {
            satoshis: 1,
            lockingScript: _tu.getLockP2PKH(_tu.getKeyPair().address).toHex(),
            outputDescription: 'pay test'
          }
        ],
        options: { randomizeOutputs: false, noSend: true }
      }

      const cr = await wallet.createAction(createArgs)
      const st = cr.signableTransaction!
      expect(st).toBeTruthy()
      const beef = Beef.fromBinary(st.tx)
      const tx = beef.txs[beef.txs.length - 1].tx!
      expect(tx.inputs[0].sourceTXID).toBe(txid)
      expect(beef.findTxid(txid)?.rawTx).toBeTruthy()

      await wallet.abortAction({ reference: st.reference })
    }
  })
})
