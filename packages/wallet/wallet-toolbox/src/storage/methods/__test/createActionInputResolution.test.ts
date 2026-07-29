import { Beef, MerklePath, Script, Transaction } from '@bsv/sdk'
import { _tu, TestWalletNoSetup } from '../../../../test/utils/TestUtilsWalletStorage'
import { setDisableDoubleSpendCheckForTest } from '../createAction'

describe('legacy createAction input-resolution compatibility', () => {
  jest.setTimeout(30000)

  let ctx: TestWalletNoSetup

  beforeEach(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy(
      expect.getState().currentTestName ?? 'createActionInputResolution',
      'legacy'
    )
  })

  afterEach(async () => {
    setDisableDoubleSpendCheckForTest(true)
    await ctx.wallet.destroy()
  })

  test('spends a locally stored unmanaged output without requiring inputBEEF', async () => {
    const funding = await ctx.wallet.createAction({
      outputs: [
        {
          satoshis: 100,
          lockingScript: '51',
          basket: 'legacy external outputs',
          outputDescription: 'locally stored unmanaged source'
        }
      ],
      description: 'stage locally stored unmanaged source',
      options: {
        noSend: true,
        randomizeOutputs: false
      }
    })

    const spending = await ctx.wallet.createAction({
      inputs: [
        {
          outpoint: `${funding.txid}.0`,
          unlockingScript: '00',
          inputDescription: 'spend locally stored unmanaged source'
        }
      ],
      outputs: [
        {
          satoshis: 50,
          lockingScript: '51',
          outputDescription: 'replacement output'
        }
      ],
      description: 'spend locally stored unmanaged source',
      options: {
        noSend: true,
        noSendChange: [],
        randomizeOutputs: false
      }
    })

    expect(spending.tx).toBeDefined()
    expect(spending.txid).toBeDefined()
  })

  test('resolves an external input from complete BEEF proof data', async () => {
    const source = makeProvenSourceTransaction()
    const beef = new Beef()
    beef.mergeTransaction(source)
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({
      isValidRootForHeight: async () => true
    })

    const spending = await ctx.wallet.createAction({
      inputs: [
        {
          outpoint: `${source.id('hex')}.0`,
          unlockingScript: '00',
          inputDescription: 'external proven source'
        }
      ],
      inputBEEF: beef.toBinary(),
      outputs: [
        {
          satoshis: 500,
          lockingScript: '51',
          outputDescription: 'external source replacement'
        }
      ],
      description: 'spend an external proven source',
      options: {
        noSend: true,
        noSendChange: [],
        randomizeOutputs: false
      }
    })

    expect(spending.tx).toBeDefined()
    expect(spending.txid).toBeDefined()
  })

  test('hydrates a trusted txid-only input from storage raw transaction data', async () => {
    const source = makeProvenSourceTransaction()
    const txid = source.id('hex')
    const beef = new Beef()
    beef.mergeTxidOnly(txid)
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({
      isValidRootForHeight: async () => true
    })
    jest.spyOn(ctx.activeStorage, 'verifyKnownValidTransaction').mockResolvedValue(true)
    jest.spyOn(ctx.activeStorage, 'getProvenOrRawTx').mockResolvedValue({
      proven: undefined,
      rawTx: source.toBinary()
    })

    const spending = await ctx.wallet.createAction({
      inputs: [
        {
          outpoint: `${txid}.0`,
          unlockingScript: '00',
          inputDescription: 'trusted txid-only source'
        }
      ],
      inputBEEF: beef.toBinary(),
      outputs: [
        {
          satoshis: 500,
          lockingScript: '51',
          outputDescription: 'trusted source replacement'
        }
      ],
      description: 'spend a trusted txid-only source',
      options: {
        noSend: true,
        noSendChange: [],
        randomizeOutputs: false,
        trustSelf: 'known'
      }
    })

    expect(spending.tx).toBeDefined()
    expect(ctx.activeStorage.getProvenOrRawTx).toHaveBeenCalledWith(txid)
  })

  test('continues to reject wallet-managed change as an explicit input', async () => {
    const managed = (
      await ctx.activeStorage.findOutputs({
        partial: {
          userId: ctx.userId,
          change: true,
          spendable: true
        }
      })
    ).find(output => output.txid != null && output.lockingScript != null && Number.isInteger(output.satoshis))
    expect(managed).toBeDefined()

    await expect(
      ctx.wallet.createAction({
        inputs: [
          {
            outpoint: `${managed!.txid}.${managed!.vout}`,
            unlockingScript: '00',
            inputDescription: 'managed change must remain managed'
          }
        ],
        outputs: [
          {
            satoshis: 1,
            lockingScript: '51',
            outputDescription: 'must not be created'
          }
        ],
        description: 'reject explicit managed change input',
        options: {
          noSend: true,
          noSendChange: [],
          randomizeOutputs: false
        }
      })
    ).rejects.toThrow('Change outputs are managed by your wallet')
  })

  test('continues to reject an already-spent stored input for a send action', async () => {
    setDisableDoubleSpendCheckForTest(false)
    const funding = await ctx.wallet.createAction({
      outputs: [
        {
          satoshis: 100,
          lockingScript: '51',
          basket: 'legacy spent inputs',
          outputDescription: 'stored source to mark spent'
        }
      ],
      description: 'stage stored source to mark spent',
      options: {
        noSend: true,
        randomizeOutputs: false
      }
    })
    const stored = (
      await ctx.activeStorage.findOutputs({
        partial: {
          userId: ctx.userId,
          txid: funding.txid,
          vout: 0
        }
      })
    )[0]
    await ctx.activeStorage.updateOutput(stored.outputId, {
      spendable: false
    })

    await expect(
      ctx.wallet.createAction({
        inputs: [
          {
            outpoint: `${funding.txid}.0`,
            unlockingScript: '00',
            inputDescription: 'already-spent stored source'
          }
        ],
        outputs: [
          {
            satoshis: 50,
            lockingScript: '51',
            outputDescription: 'must not be created'
          }
        ],
        description: 'reject already-spent stored source',
        options: {
          randomizeOutputs: false
        }
      })
    ).rejects.toThrow('spendable output unless noSend is true')
  })

  test('continues to reject incomplete stored output metadata', async () => {
    const source = makeProvenSourceTransaction()
    const beef = new Beef()
    beef.mergeTransaction(source)
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({
      isValidRootForHeight: async () => true
    })
    const template = (
      await ctx.activeStorage.findOutputs({
        partial: { userId: ctx.userId }
      })
    )[0]
    jest.spyOn(ctx.activeStorage, 'findOutputsByOutpoints').mockResolvedValue({
      [`${source.id('hex')}.0`]: {
        ...template,
        txid: source.id('hex'),
        vout: 0,
        change: false,
        spendable: true,
        satoshis: 1000,
        lockingScript: undefined
      }
    })

    await expect(
      ctx.wallet.createAction({
        inputs: [
          {
            outpoint: `${source.id('hex')}.0`,
            unlockingScript: '00',
            inputDescription: 'source with incomplete stored metadata'
          }
        ],
        inputBEEF: beef.toBinary(),
        outputs: [
          {
            satoshis: 500,
            lockingScript: '51',
            outputDescription: 'must not be created'
          }
        ],
        description: 'reject incomplete stored metadata',
        options: {
          noSend: true,
          noSendChange: [],
          randomizeOutputs: false
        }
      })
    ).rejects.toThrow('output with valid lockingScript and satoshis')
  })

  test('continues to reject txid-only proof data when storage has no raw transaction', async () => {
    const source = makeProvenSourceTransaction()
    const txid = source.id('hex')
    const beef = new Beef()
    beef.mergeTxidOnly(txid)
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({
      isValidRootForHeight: async () => true
    })
    jest.spyOn(ctx.activeStorage, 'verifyKnownValidTransaction').mockResolvedValue(true)
    jest.spyOn(ctx.activeStorage, 'getProvenOrRawTx').mockResolvedValue({
      proven: undefined,
      rawTx: undefined
    })

    await expect(
      ctx.wallet.createAction({
        inputs: [
          {
            outpoint: `${txid}.0`,
            unlockingScript: '00',
            inputDescription: 'txid-only source without raw transaction'
          }
        ],
        inputBEEF: beef.toBinary(),
        outputs: [
          {
            satoshis: 500,
            lockingScript: '51',
            outputDescription: 'must not be created'
          }
        ],
        description: 'reject txid-only source without raw transaction',
        options: {
          noSend: true,
          noSendChange: [],
          randomizeOutputs: false,
          trustSelf: 'known'
        }
      })
    ).rejects.toThrow('valid and contain proof data')
  })

  test('continues to reject an output index outside the source transaction', async () => {
    const source = makeProvenSourceTransaction()
    const beef = new Beef()
    beef.mergeTransaction(source)
    jest.spyOn(ctx.services, 'getChainTracker').mockResolvedValue({
      isValidRootForHeight: async () => true
    })

    await expect(
      ctx.wallet.createAction({
        inputs: [
          {
            outpoint: `${source.id('hex')}.1`,
            unlockingScript: '00',
            inputDescription: 'out-of-range source output'
          }
        ],
        inputBEEF: beef.toBinary(),
        outputs: [
          {
            satoshis: 500,
            lockingScript: '51',
            outputDescription: 'must not be created'
          }
        ],
        description: 'reject out-of-range source output',
        options: {
          noSend: true,
          noSendChange: [],
          randomizeOutputs: false
        }
      })
    ).rejects.toThrow('valid outpoint')
  })
})

function makeProvenSourceTransaction(): Transaction {
  const source = new Transaction()
  source.addOutput({
    satoshis: 1000,
    lockingScript: Script.fromHex('7551')
  })
  source.merklePath = new MerklePath(800000, [
    [
      {
        offset: 0,
        hash: source.id('hex'),
        txid: true
      }
    ]
  ])
  return source
}
