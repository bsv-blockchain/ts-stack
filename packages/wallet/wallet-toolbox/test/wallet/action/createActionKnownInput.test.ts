import { Beef, ChainTracker, CreateActionArgs, CreateActionOutput, Validation } from '@bsv/sdk'
import { _tu, TestWallet } from '../../utils/TestUtilsWalletStorage'

/**
 * A caller may name an input the wallet holds, with unlockingScriptLength and
 * no inputBEEF (trustSelf 'known'). trustSelf is between the wallet and its
 * storage: every BEEF the wallet hands out must still validate on its own.
 * Storage merges the proven BEEF of such inputs into the input BEEF it
 * returns, and the signer takes source transactions from that BEEF.
 */
describe('createAction wallet-held declared input without inputBEEF', () => {
  jest.setTimeout(99999999)

  const testName = () => expect.getState().currentTestName || 'test'
  let ctx: TestWallet<object>
  let chainTracker: ChainTracker

  // A proven, spendable, non-change output in the legacy test wallet.
  const provenOutpoint = 'bd603c9da81355d853bae7a7e04860908aa213d8aff344a70455f99de775a442.0'
  const provenTxid = provenOutpoint.split('.')[0]

  beforeEach(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy(`${testName()}`)
    _tu.mockPostServicesAsSuccess([ctx])
    // Roots are checked against the wallet's own proven transactions: a BEEF
    // passes only if every transaction is anchored by a stored merkle proof.
    chainTracker = {
      isValidRootForHeight: async (root: string, height: number) => {
        const proven = await ctx.activeStorage.findProvenTxs({ partial: { height, merkleRoot: root } })
        return proven.length > 0
      },
      currentHeight: async () => 1_000_000
    }
  })

  afterEach(async () => {
    await ctx.storage.destroy()
  })

  const payTo = (satoshis: number): CreateActionOutput => ({
    satoshis,
    lockingScript: _tu.getLockP2PKH(_tu.getKeyPair().address).toHex(),
    outputDescription: 'pay test'
  })

  const expectValid = async (beefBytes: number[] | Uint8Array | undefined): Promise<Beef> => {
    expect(beefBytes).toBeDefined()
    const beef = Beef.fromBinary(Array.from(beefBytes!))
    expect(beef.txs.filter(btx => btx.isTxidOnly)).toHaveLength(0)
    expect(await beef.verify(chainTracker, false)).toBe(true)
    return beef
  }

  const storageCreate = async (args: CreateActionArgs) => {
    const vargs = Validation.validateCreateActionArgs(args)
    vargs.options.trustSelf ??= 'known'
    return await ctx.storage.createAction(vargs)
  }

  test('0_storage returns the proven transaction of a declared wallet input, not txid-only', async () => {
    const r = await storageCreate({
      description: 'spend known input',
      inputs: [{ outpoint: provenOutpoint, inputDescription: 'known input', unlockingScriptLength: 108 }],
      outputs: [payTo(1)],
      options: { randomizeOutputs: false, noSend: true, signAndProcess: false }
    })
    const beef = await expectValid(r.inputBeef)
    const btx = beef.findTxid(provenTxid)
    expect(btx?.isTxidOnly).toBe(false)
    expect(btx?.bumpIndex).toBeDefined()
    await ctx.wallet.abortAction({ reference: r.reference })
  })

  test('1_signable and signed BEEF are valid for a declared input from an unproven wallet transaction', async () => {
    const kp = _tu.getKeyPair()
    const satoshis = 1000
    // An unproven (noSend) wallet transaction whose output the wallet holds.
    const seed = await ctx.wallet.createAction({
      description: 'seed held output',
      outputs: [
        {
          satoshis,
          lockingScript: _tu.getLockP2PKH(kp.address).toHex(),
          outputDescription: 'held output',
          basket: 'known input test'
        }
      ],
      options: { randomizeOutputs: false, noSend: true }
    })
    const seedTxid = seed.txid!
    expect(seedTxid).toBeTruthy()

    const unlock = _tu.getUnlockP2PKH(kp.privateKey, satoshis)
    const cr = await ctx.wallet.createAction({
      description: 'spend held output',
      inputs: [
        {
          outpoint: `${seedTxid}.0`,
          inputDescription: 'held output',
          unlockingScriptLength: await unlock.estimateLength()
        }
      ],
      outputs: [payTo(500)],
      options: { randomizeOutputs: false, noSend: true }
    })
    const st = cr.signableTransaction!
    expect(st).toBeTruthy()

    const signable = await expectValid(st.tx)
    // Unproven: carried with its parents, which are proven.
    expect(signable.findTxid(seedTxid)?.bumpIndex).toBeUndefined()
    const tx = signable.findAtomicTransaction(signable.txs[signable.txs.length - 1].txid)!
    expect(tx.inputs[0].sourceTXID).toBe(seedTxid)

    tx.inputs[0].unlockingScriptTemplate = unlock
    await tx.sign()
    const sr = await ctx.wallet.signAction({
      reference: st.reference,
      spends: { 0: { unlockingScript: tx.inputs[0].unlockingScript!.toHex() } },
      options: { returnTXIDOnly: false, noSend: true }
    })
    const signed = await expectValid(sr.tx)
    expect(signed.findTxid(sr.txid!)).toBeDefined()
    expect(signed.findTxid(seedTxid)?.isTxidOnly).toBe(false)
  })

  test('2_caller inputBEEF wins over storage', async () => {
    const seed = await ctx.wallet.createAction({
      description: 'seed held output',
      outputs: [{ ...payTo(1000), basket: 'known input test' }],
      options: { randomizeOutputs: false, noSend: true }
    })
    const seedTxid = seed.txid!
    const callerBeef = Beef.fromBinary(seed.tx!)
    const spy = jest.spyOn(ctx.activeStorage, 'getBeefForTransactions')
    const r = await storageCreate({
      description: 'spend with caller beef',
      inputs: [{ outpoint: `${seedTxid}.0`, inputDescription: 'held output', unlockingScriptLength: 108 }],
      inputBEEF: seed.tx,
      outputs: [payTo(500)],
      options: { randomizeOutputs: false, noSend: true, signAndProcess: false }
    })
    const requested = spy.mock.calls.flatMap(call => call[0])
    expect(requested).not.toContain(seedTxid)
    const beef = await expectValid(r.inputBeef)
    for (const btx of callerBeef.txs) {
      expect(beef.findTxid(btx.txid)?.rawTx).toEqual(btx.rawTx)
    }
    await ctx.wallet.abortAction({ reference: r.reference })
  })

  test('3_wallet-only transaction: result and signable BEEF are valid', async () => {
    const cr = await ctx.wallet.createAction({
      description: 'wallet only',
      outputs: [payTo(10)],
      options: { randomizeOutputs: false, noSend: true }
    })
    await expectValid(cr.tx)

    const unsigned = await ctx.wallet.createAction({
      description: 'wallet only signable',
      outputs: [payTo(10)],
      options: { randomizeOutputs: false, noSend: true, signAndProcess: false }
    })
    const st = unsigned.signableTransaction!
    await expectValid(st.tx)
    const sr = await ctx.wallet.signAction({
      reference: st.reference,
      spends: {},
      options: { returnTXIDOnly: false, noSend: true }
    })
    await expectValid(sr.tx)
  })

  test('4_knownTxids still produce a txid-only entry for a declared wallet input', async () => {
    const r = await storageCreate({
      description: 'spend known input',
      inputs: [{ outpoint: provenOutpoint, inputDescription: 'known input', unlockingScriptLength: 108 }],
      outputs: [payTo(1)],
      options: { randomizeOutputs: false, noSend: true, signAndProcess: false, knownTxids: [provenTxid] }
    })
    const beef = Beef.fromBinary(Array.from(r.inputBeef!))
    expect(beef.findTxid(provenTxid)?.isTxidOnly).toBe(true)
    await ctx.wallet.abortAction({ reference: r.reference })
  })
})
