import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Beef, PrivateKey, ProtoWallet, Transaction, Utils, type CreateActionArgs } from '@bsv/sdk'
import { RevenueListing, REVENUE_LISTING_FAMILY, type RevenueListingDescriptor } from '@bsv/sdk/script/templates/RevenueListing'
import { RevenueListingSpend } from '@bsv/sdk/script/templates/RevenueListingSpend'
import type { RevenueListingAction } from '@bsv/sdk/script/templates/RevenueListingPlan'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { SQLiteActionRecoveryStore } from '../../../storage/actionRecovery/SQLiteActionRecoveryStore'
import { RecoverableActionController } from '../RecoverableActionController'

// Only public test keys and an isolated local wallet database. No broadcast or
// claim of selected-chain lineage/SPV qualification is made by this composition.
test('funds, signs and recovers all six listing routes through the actual local wallet', async () => {
  const context = await _tu.createLegacyWalletSQLiteCopy('recovery-six-revenue-routes', 'legacy')
  const protocolID: [2, string] = [2, 'revenue listing authority']
  const keyID = 'public-fixture-authority'
  const authorityWallets = [new ProtoWallet(new PrivateKey(41)), new ProtoWallet(new PrivateKey(42)), new ProtoWallet(new PrivateKey(43))]
  const authorities = await Promise.all(authorityWallets.map(async wallet => ({
    wallet, identity: (await wallet.getPublicKey({ protocolID, keyID, counterparty: 'self', forSelf: true })).publicKey
  })))
  const store = await SQLiteActionRecoveryStore.install(context.activeStorage)
  const controller = new RecoverableActionController(context.wallet, store, 'revenue-fixture.local')
  const options = { noSend: true, signAndProcess: false, randomizeOutputs: false, returnTXIDOnly: false }
  const family = new RevenueListing(gunzipSync(readFileSync(resolve(__dirname, 'fixtures/revenue-listing-program.bin.gz'))))
  try {
    const broadcast = jest.spyOn(context.activeStorage, 'attemptToPostReqsToNetwork').mockRejectedValue(new Error('No broadcast permitted'))
    const anchorArgs: CreateActionArgs = { description: 'Local revenue lineage anchor', outputs: [{ lockingScript: '7551', satoshis: 20000, outputDescription: 'Public test anchor', basket: 'revenue-test' }], options }
    const anchorPrepared = await controller.prepare('anchor', anchorArgs)
    const anchor = await controller.finalize('anchor', anchorArgs, { reference: anchorPrepared.signableTransaction!.reference, spends: {} })
    const chain = { network: 'wallet-test-fixture', genesisHash: '11'.repeat(32) }
    const descriptor: RevenueListingDescriptor = {
      version: 1, chain, assetId: '22'.repeat(32), seller: authorities[0].identity,
      lineageAnchor: { chain, txid: anchor.txid!, outputIndex: 0 }, purchasePrice: '1001', reserve: '1',
      termsDigest: '33'.repeat(32), metadataDigest: '44'.repeat(32), scriptFamily: REVENUE_LISTING_FAMILY,
      administration: 'seller-v1', initialRevenue: { revision: '0', recipients: authorities.slice(1).map((authority, index) => ({ identity: authority.identity, weight: index === 0 ? 7 : 3 })).sort((a, b) => a.identity.localeCompare(b.identity)) }
    }
    const genesisArgs: CreateActionArgs = { description: 'Local revenue listing genesis', inputBEEF: anchor.tx,
      inputs: [{ outpoint: `${anchor.txid}.0`, inputDescription: 'Public test anchor', unlockingScriptLength: 1 }],
      outputs: [{ lockingScript: family.lock(descriptor).toHex(), satoshis: 1, outputDescription: 'Initial listing', basket: 'revenue-test' }], options }
    const genesisPrepared = await controller.prepare('genesis', genesisArgs)
    const genesis = await controller.finalize('genesis', genesisArgs, { reference: genesisPrepared.signableTransaction!.reference, spends: { 0: { unlockingScript: '00' } } })
    let source = genesis.tx!, indices = [0]
    const nextState = { revision: '1', recipients: descriptor.initialRevenue.recipients.map(item => ({ ...item, weight: item.weight === 7 ? 4 : 3 })) }
    const actions: RevenueListingAction[] = [
      { operation: 'purchase', acquisitionId: '55'.repeat(32), requestDigest: '66'.repeat(32), recipient: context.identityKey },
      { operation: 'split', firstAmount: '500' }, { operation: 'merge' }, { operation: 'payout', units: '99' },
      { operation: 'amend', state: nextState }, { operation: 'retire' }
    ]
    for (const action of actions) {
      const previous = Transaction.fromAtomicBEEF(source)
      const spend = new RevenueListingSpend(family, descriptor, indices.map(outputIndex => ({ rawTransaction: previous.toHex(), outputIndex })), action)
      const plan = spend.plan()
      const request: CreateActionArgs = { description: `Local ${action.operation} fixture`, inputBEEF: source,
        inputs: plan.inputs.map((input, index) => ({ outpoint: `${input.txid}.${input.outputIndex}`, inputDescription: 'Listing predecessor', unlockingScriptLength: spend.estimateUnlockingLength(index) })),
        outputs: plan.outputs.map(output => ({ ...output, satoshis: Number(output.satoshis), outputDescription: 'Required listing output', basket: 'revenue-test' })), options }
      const original = await controller.prepare(action.operation, request)
      const reopened = new RecoverableActionController(context.wallet, await SQLiteActionRecoveryStore.open(context.activeStorage), 'revenue-fixture.local')
      expect(await reopened.recover(action.operation, request)).toEqual({ state: 'prepared', result: original })
      const funded = Transaction.fromAtomicBEEF(original.signableTransaction!.tx)
      const evidence = Beef.fromBinaryStrict(original.signableTransaction!.tx)
      funded.inputs.forEach(input => { input.sourceTransaction = evidence.findTransactionForSigning(input.sourceTXID!)! })
      const prepared = spend.prepare(funded)
      const signatures: { seller?: string; recipients: string[] }[] = plan.inputs.map(() => ({ recipients: [] }))
      for (const required of prepared.signingRequests()) {
        const authority = authorities.find(item => item.identity === required.identity)!
        expect((await authority.wallet.getPublicKey({ protocolID, keyID, counterparty: 'self', forSelf: true })).publicKey).toBe(required.identity)
        const signed = await authority.wallet.createSignature({ protocolID, keyID, counterparty: 'self', data: required.data })
        const transactionSignature = Utils.toHex(signed.signature) + '41'
        if (required.role === 'seller') signatures[required.inputIndex].seller = transactionSignature
        else signatures[required.inputIndex].recipients.push(transactionSignature)
      }
      const complete = prepared.complete(signatures)
      const final = await reopened.finalize(action.operation, request, { reference: original.signableTransaction!.reference,
        spends: Object.fromEntries(indices.map((_, index) => [index, { unlockingScript: complete.inputs[index].unlockingScript!.toHex() }])) })
      prepared.assertFinalLayout(Transaction.fromAtomicBEEF(final.tx!))
      expect(await reopened.recover(action.operation, request)).toEqual({ state: 'finalized', result: final })
      if (action.operation === 'payout') expect(Transaction.fromAtomicBEEF(final.tx!).outputs[0].satoshis).toBe(12)
      if (action.operation === 'amend') expect(prepared.signingRequests()).toHaveLength(3)
      if (action.operation === 'retire') expect(plan.retirementTopUp).toBe('2')
      source = final.tx!
      indices = action.operation === 'split' ? [0, 1] : [0]
    }
    expect(broadcast).not.toHaveBeenCalled()
  } finally {
    jest.restoreAllMocks()
    await context.wallet.destroy()
  }
}, 120000)
