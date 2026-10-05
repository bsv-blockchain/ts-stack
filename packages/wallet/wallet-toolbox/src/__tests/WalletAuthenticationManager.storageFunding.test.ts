import * as WalletSdk from '@bsv/sdk'
import { MerklePath, PrivateKey, RPuzzle, Script, Transaction, WalletInterface } from '@bsv/sdk'
import { _tu, TestWalletNoSetup } from '../../test/utils/TestUtilsWalletStorage'
import { WalletAuthenticationManager } from '../WalletAuthenticationManager'
import { WalletPermissionsManager } from '../WalletPermissionsManager'

describe('faucet completion with empty wallet storage', () => {
  let ctx: TestWalletNoSetup
  beforeEach(async () => {
    ctx = await _tu.createSQLiteTestWallet({ databaseName: 'faucet-storage-funding', dropAll: true })
    ctx.activeStorage.feeModel = { model: 'sat/kb', value: 100 }
    ctx.activeStorage.commissionPubKeyHex = new PrivateKey(7).toPublicKey().toString()
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({ isValidRootForHeight: async () => true })
    jest.spyOn(ctx.services, 'postBeef').mockImplementation(async (_beef, txids) => [
      {
        name: 'offline-test',
        status: 'success',
        txidResults: txids.map(txid => ({ txid, status: 'success' }))
      }
    ])
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await ctx.wallet.destroy()
  })

  function manager(wallet: WalletInterface) {
    const key = new PrivateKey(2)
    let r = key.toPublicKey().getX().toArray()
    if (r[0] > 127) r = [0, ...r]
    const tx = new Transaction(1, [], [{ satoshis: 1000, lockingScript: new RPuzzle().lock(r) }], 0)
    tx.merklePath = new MerklePath(800000, [[{ offset: 0, hash: tx.id('hex'), txid: true }]])
    return new WalletAuthenticationManager(
      'admin.example',
      async () => wallet,
      undefined,
      async () => true,
      async () => 'password',
      {
        requestFaucet: jest.fn(async () => ({
          success: true,
          paymentData: {
            k: key.toString(16),
            txid: tx.id('hex'),
            tx: tx.toAtomicBEEF()
          }
        }))
      } as never
    )
  }

  async function fund(auth: WalletAuthenticationManager, wallet: WalletInterface) {
    const funder = (
      auth as unknown as {
        newWalletFunder: (key: number[], wallet: WalletInterface, originator: string) => Promise<void>
      }
    ).newWalletFunder
    await funder(Array(32).fill(1), wallet, 'admin.example')
  }

  it.each([false, true])('funds an empty wallet including its storage fee (permissions=%s)', async permissions => {
    ctx.activeStorage.commissionSatoshis = 200
    const wallet = permissions ? new WalletPermissionsManager(ctx.wallet, 'admin.example') : ctx.wallet
    const auth = manager(wallet)
    const sign = jest.spyOn(ctx.wallet, 'signAction')
    await fund(auth, wallet)
    const first = await wallet.listOutputs({ basket: 'default' }, 'admin.example')
    expect(first.outputs).toHaveLength(1)
    expect(first.outputs[0].satoshis).toBe(777)
    const commissions = await ctx.activeStorage.findCommissions({ partial: { userId: ctx.userId } })
    expect(commissions).toHaveLength(1)
    expect(commissions[0].satoshis).toBe(200)
    expect(sign).toHaveBeenCalledTimes(1)
  })

  it('rejects serialized results that did not retain local signer authority', async () => {
    ctx.activeStorage.commissionSatoshis = 200
    const create = ctx.wallet.createAction.bind(ctx.wallet)
    jest.spyOn(ctx.wallet, 'createAction').mockImplementation(async (args, originator) => {
      const result = await create(args, originator)
      return JSON.parse(JSON.stringify(result)) as typeof result
    })
    const sign = jest.spyOn(ctx.wallet, 'signAction')
    const abort = jest.spyOn(ctx.wallet, 'abortAction')
    await expect(fund(manager(ctx.wallet), ctx.wallet)).rejects.toThrow('unrequested output')
    expect(sign).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
    expect((await ctx.wallet.listOutputs({ basket: 'default' })).outputs).toHaveLength(0)
  })

  it.each(['script', 'amount'])('rejects a %s substitution after the local storage fee was approved', async field => {
    ctx.activeStorage.commissionSatoshis = 200
    const create = ctx.wallet.createAction.bind(ctx.wallet)
    jest.spyOn(ctx.wallet, 'createAction').mockImplementation(async (args, originator) => {
      const result = await create(args, originator)
      const transaction = Transaction.fromAtomicBEEF(result.signableTransaction!.tx)
      const commission = transaction.outputs.find(output => output.satoshis === 200)!
      if (field === 'script') commission.lockingScript = Script.fromHex('51')
      else commission.satoshis = 201
      // Keep the original result identity and its private approval. Altering the
      // transaction must still invalidate that approval before any signing.
      result.signableTransaction!.tx = transaction.toAtomicBEEF(true)
      return result
    })
    const sign = jest.spyOn(ctx.wallet, 'signAction')
    const abort = jest.spyOn(ctx.wallet, 'abortAction')
    await expect(fund(manager(ctx.wallet), ctx.wallet)).rejects.toThrow('authorized additional output')
    expect(sign).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
    expect((await ctx.wallet.listOutputs({ basket: 'default' })).outputs).toHaveLength(0)
  })

  it('omits the new policy option for a legacy SDK peer', async () => {
    const sdk = jest.requireActual<typeof WalletSdk>('../../../../sdk/src/wallet/completeBoundAction')
    jest.replaceProperty(sdk.completeBoundAction, 'outputAuthorizationVersion', 0 as 1)
    const complete = sdk.completeBoundAction
    const spy = jest.spyOn(sdk, 'completeBoundAction').mockImplementation(async (wallet, args, options, originator) => {
      expect(options).not.toHaveProperty('authorizeAdditionalOutputs')
      return await complete(wallet, args, options, originator)
    })
    ctx.activeStorage.commissionSatoshis = 0
    await fund(manager(ctx.wallet), ctx.wallet)
    expect(spy).toHaveBeenCalledTimes(1)
    expect((await ctx.wallet.listOutputs({ basket: 'default' })).outputs[0].satoshis).toBe(980)
  })

  it('continues to fund a commission-free empty wallet', async () => {
    ctx.activeStorage.commissionSatoshis = 0
    await fund(manager(ctx.wallet), ctx.wallet)
    const result = await ctx.wallet.listOutputs({ basket: 'default' })
    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0].satoshis).toBe(980)
  })
})
